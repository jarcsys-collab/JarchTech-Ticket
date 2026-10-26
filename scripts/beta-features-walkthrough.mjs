// Optional real-browser walkthrough of beta attachments, in-app notifications, and search/filters
// (BETA_SIMULATION=enabled). Uses a MOCK Microsoft Entra provider and a temporary MongoDB (never Microsoft, Atlas, or .env),
// one headless Chrome or Edge with a temporary profile, and two separate browser contexts signed in as two testers.
// Covers uploads (progress, refusals, retry), downloads and access, notifications (delivery, own actions, links,
// per-tester read state, failures), and combined search/filters with pages, empty states, and failures.
// Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled. Not run by npm test or CI.
//
//   npm run walkthrough:features
//   BETA_SCREENSHOTS=tmp/features npm run walkthrough:features
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { startMockEntra } = require('../tests/helpers/mock-entra.cjs');

const TENANT = '44444444-5555-4666-8777-888888888888';
const CLIENT = 'dddddddd-eeee-4fff-8000-111111111111';
const SHOTS = process.env.BETA_SCREENSHOTS ? path.resolve(process.env.BETA_SCREENSHOTS) : null;
const CANDIDATES = {
  win32: [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
};
const BROWSER = process.env.BROWSER_PATH || (CANDIDATES[process.platform] || []).find(p => p && fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const results = []; let section = '';
const check = (name, ok, info = '') => { results.push({ section, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${info ? '  -- ' + info : ''}`); };

let mongod, mongo, entra, app, browser, profile, cleaning, interrupted = false;
const sockets = [];
function cleanup() {
  return cleaning ??= (async () => {
    for (const s of sockets) { try { s.close(); } catch {} }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await new Promise(resolve => { const t = setTimeout(resolve, 5000); browser.once('exit', () => { clearTimeout(t); resolve(); }); browser.kill(); });
    }
    for (const step of [() => app?.shutdown(), () => entra?.close(), () => mongo?.close(), () => mongod?.stop()]) { try { await step(); } catch {} }
    for (let i = 0; profile && i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
  })();
}
for (const sig of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { if (interrupted) return; interrupted = true; await cleanup(); process.exit(130); });
}

// One DevTools connection (a page or the browser itself).
async function connect(url) {
  const ws = new WebSocket(url); sockets.push(ws);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('DevTools connection failed'))); });
  let id = 1; const pending = new Map(), handlers = new Map(), waits = [], errors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    handlers.get(m.method)?.(m.params);
    for (let i = waits.length - 1; i >= 0; i--) if (waits[i].method === m.method) { waits[i].res(m.params); waits.splice(i, 1); }
  });
  const send = (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, errors, on: (method, fn) => handlers.set(method, fn), off: method => handlers.delete(method), event: method => new Promise(res => waits.push({ method, res })) };
}

const HELPERS = `window.__w={
  el(sel,root=document){const e=root.querySelector(sel);if(!e)throw new Error('missing '+sel);return e},
  set(sel,val,root=document){const e=__w.el(sel,root);if(e.type==='checkbox')e.checked=val;else e.value=val;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},
  click(sel){__w.el(sel).click()},
  submit(sel){__w.el(sel).requestSubmit()},
  view(r){__w.set('#demo-role',r)},
  open(id){__w.click('[data-id="'+id+'"]')},
  esc(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))},
  toast(){return document.querySelector('#toast').textContent},
  saveState(){return document.querySelector('.save').dataset.state||''},
  text(){return document.querySelector('#dialog-content').textContent},
  async server(){const r=await fetch('/api/v1/beta/workspace');return r.json()},
  async ticket(id){return (await __w.server()).tickets.find(t=>t.id===id)},
  async change(id){return (await __w.server()).changes.find(c=>c.id===id)}
};true`;
function pageApi(cdp) {
  const evaluate = async expr => { const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const w = async js => { await evaluate(HELPERS); return evaluate(js); };
  // Waits until no save or refresh is in flight and the shared records are loaded.
  const settle = async () => { for (let i = 0; i < 80; i++) { const s = await w(`[!!window.JARC_BETA&&window.JARC_BETA.ready, __w.saveState()]`).catch(() => [false, '']); if (s[0] && s[1] !== 'saving') break; await sleep(100); } await sleep(250); };
  const loads = async action => { const l = cdp.event('Page.loadEventFired'); await action(); await l; await sleep(400); };
  const nav = url => loads(() => cdp.send('Page.navigate', { url }));
  const shot = async name => { if (!SHOTS) return; const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); };
  return { cdp, w, settle, loads, nav, shot, do: async js => { await w(js + ';true'); await settle(); } };
}
const account = (n, name) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, email: `member${n}@jarc.example`, preferred_username: `member${n}@jarc.example` });

try {
  if (!BROWSER || !fs.existsSync(BROWSER)) throw new Error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  const db = mongo.db('jarctech_beta_features_walkthrough');
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'beta-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_beta_features_walkthrough', AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled', INSPECTION_MODE: 'enabled',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'beta-walkthrough-secret', APP_BASE_URL: origin, SESSION_SECRET: 'beta-walkthrough-session-secret-0123456789ab'
  }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-betacheck-'));
  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let pageWs, browserWs;
  for (let i = 0; i < 150 && !(pageWs && browserWs); i++) {
    try {
      pageWs = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl;
      browserWs = (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {}
    if (!(pageWs && browserWs)) await sleep(200);
  }
  if (!pageWs) throw new Error('The browser did not start.');
  const bcdp = await connect(browserWs);
  const { browserContextId } = await bcdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const P1 = pageApi(await connect(pageWs));
  const P2 = pageApi(await connect(`ws://127.0.0.1:${debug}/devtools/page/${targetId}`));
  for (const P of [P1, P2]) { await P.cdp.send('Page.enable'); await P.cdp.send('Runtime.enable'); }
  const signIn = async (P, n, name) => { await P.nav(`${origin}/auth/signin`); entra.signInNext(account(n, name)); await P.loads(() => P.w(`__w.click('a.primary')`)); await chooseBeta(P); };
  // My workspace is the default after sign-in; these checks use the beta simulation, chosen in the Workspace switch.
  const chooseBeta = async P => { await P.w(`localStorage.getItem('jarc-workspace')==='beta'||(localStorage.setItem('jarc-workspace','beta'),location.reload(),true)`); await sleep(600); await P.settle(); };
  const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-files-'));
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
  fs.writeFileSync(path.join(dir, 'wt-screenshot.png'), PNG);
  fs.writeFileSync(path.join(dir, 'wt-steps.txt'), 'Step 1: open the report\nStep 2: totals differ\n');
  fs.writeFileSync(path.join(dir, 'wt-tool.exe'), 'MZ not allowed');
  fs.writeFileSync(path.join(dir, 'wt-fake.png'), '<html><script>alert(1)</script></html>');
  const setFiles = async (P, selector, names) => {
    const { root } = await P.cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await P.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await P.cdp.send('DOM.setFileInputFiles', { nodeId, files: names.map(n => path.join(dir, n)) });
  };
  const uploadsDone = P => waitFor(P, `document.querySelectorAll('.upload.uploading').length===0 && document.querySelectorAll('.upload').length>0`);
  const badge = P => P.w(`document.querySelector('#notice-count').textContent`);
  const reload = async P => { await P.nav(origin + '/'); await P.settle(); await sleep(400); };
  const failing = async (P, pattern) => { await P.cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern }] }); P.cdp.on('Fetch.requestPaused', p => P.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' })); };
  const restore = async P => { await P.cdp.send('Fetch.disable'); P.cdp.off('Fetch.requestPaused'); };
  let ticketId = '';

  try {
    section = 'sign-in';
    await signIn(P1, 1, 'Tester One');
    await signIn(P2, 2, 'Tester Two');
    check('two testers signed in to separate browser contexts', await P1.w(`JARC_SESSION.displayName`) === 'Tester One' && await P2.w(`JARC_SESSION.displayName`) === 'Tester Two');

    // ---------- Attachments ----------
    section = 'attachments';
    await P1.do(`__w.view('Requestor')`);
    await P1.w(`__w.click('#new-ticket');true`);
    await P1.w(`__w.set('#request-form [name=title]','FEATURE-WT printer request');__w.set('#request-form [name=department]','Operations');__w.set('#request-form [name=date]','2026-12-18');__w.set('#request-form [name=description]','FEATURE-WT walkthrough request with screenshots.');true`);
    await setFiles(P1, '#request-form input[type=file]', ['wt-screenshot.png', 'wt-tool.exe', 'wt-fake.png', 'wt-steps.txt']);
    await uploadsDone(P1);
    await waitFor(P1, `[...document.querySelectorAll('.upload')].filter(e=>!e.classList.contains('uploading')).length===4 && document.querySelectorAll('.upload.done').length===2`);
    check('valid files upload with name, size, and Uploaded state', await P1.w(`[...document.querySelectorAll('.upload.done')].map(e=>e.querySelector('.upload-name').textContent+' '+e.querySelector('small').textContent).join('|')`) === `wt-screenshot.png ${(PNG.length / 1024).toFixed(1)} KB|wt-steps.txt ${fs.statSync(path.join(dir, 'wt-steps.txt')).size} B`, await P1.w(`[...document.querySelectorAll('.upload.done')].map(e=>e.querySelector('.upload-name').textContent+' '+e.querySelector('small').textContent).join('|')`));
    check('an executable is refused before upload with a clear message', await P1.w(`[...document.querySelectorAll('.upload.error')].some(e=>e.textContent.includes('wt-tool.exe')&&e.textContent.includes('not allowed'))`));
    check('a file whose content does not match its type is refused by the server', await P1.w(`[...document.querySelectorAll('.upload.error')].some(e=>e.textContent.includes('wt-fake.png')&&e.textContent.includes('does not look like'))`));
    await P1.shot('features-1-uploads.png');
    for (let i = 0; i < 2; i++) await P1.w(`document.querySelector('.upload.error [data-remove]').click();true`); // one at a time: each removal redraws the list
    check('refused files can be removed, leaving the uploaded ones', await P1.w(`document.querySelectorAll('.upload').length===2 && document.querySelectorAll('.upload.done').length===2`));
    await P1.do(`__w.submit('#request-form')`);
    ticketId = await P1.w(`__w.server().then(w=>w.tickets.find(t=>t.title==='FEATURE-WT printer request')?.id||'')`);
    check('the request is created with its two attachments', Boolean(ticketId) && await P1.w(`__w.ticket('${ticketId}').then(t=>t.history[0].attachments.map(a=>a.name).join(','))`) === 'wt-screenshot.png,wt-steps.txt', ticketId);
    await P2.do(`__w.view('Admin')`);
    await reload(P2);
    await P2.do(`__w.open('${ticketId}')`);
    check('another tester sees the attachments with names, sizes, and download links', await P2.w(`document.querySelectorAll('.ticket-files .file-links a').length===2 && __w.text().includes('${(PNG.length / 1024).toFixed(1)} KB')`));
    const dl = await P2.w(`fetch(document.querySelector('.ticket-files a').href).then(async r=>[r.status,r.headers.get('content-disposition'),r.headers.get('content-security-policy'),(await r.arrayBuffer()).byteLength])`);
    check('download works for a signed-in tester, as an attachment with a sandbox CSP', dl[0] === 200 && /^attachment; filename="wt-screenshot.png"/.test(dl[1]) && /sandbox/.test(dl[2]) && dl[3] === PNG.length, JSON.stringify(dl));
    check('download without the session cookie is refused', await P2.w(`fetch(document.querySelector('.ticket-files a').href,{credentials:'omit'}).then(r=>r.status)`) === 401);
    await setFiles(P2, '#comment-form input[type=file]', ['wt-steps.txt']);
    await uploadsDone(P2);
    await P2.do(`__w.submit('#comment-form')`);
    check('a comment can carry files only, and shows them in the activity', await P2.w(`__w.text().includes('Admin: Shared 1 attachment.') && document.querySelectorAll('.timeline .file-links a').length===3`));
    await failing(P2, '*/api/v1/beta/attachments');
    await setFiles(P2, '#comment-form input[type=file]', ['wt-screenshot.png']);
    await waitFor(P2, `document.querySelector('.upload.error [data-retry]')`);
    check('a failed upload shows a useful error with Retry', await P2.w(`document.querySelector('.upload.error').textContent.includes('could not reach the server')`));
    await restore(P2);
    await P2.w(`__w.click('[data-retry]');true`);
    await uploadsDone(P2);
    check('Retry uploads the file once the connection returns', await waitFor(P2, `document.querySelectorAll('.upload.done').length===1`));
    await P2.w(`__w.set('#comment-form [name=comment]','FEATURE-WT retry upload worked');true`);
    await P2.do(`__w.submit('#comment-form')`);
    await reload(P1);
    await P1.do(`__w.open('${ticketId}')`);
    check('after a refresh, all files are still listed for the requestor', await P1.w(`document.querySelectorAll('.ticket-files .file-links a').length===4`));
    await P1.w(`__w.esc();true`);

    // ---------- Notifications ----------
    section = 'notifications';
    await reload(P2);
    check('the admin view shows an unread badge for another tester\'s new request', Number(await badge(P2)) >= 1 && /unread/.test(await P2.w(`__w.el('#notifications').getAttribute('aria-label')`)), await badge(P2));
    await P1.do(`__w.view('Admin')`);
    await waitFor(P1, `JARC_BETA.ready`);
    await sleep(500);
    check('no unread alert for a tester\'s own action', await badge(P1) === '', await badge(P1));
    await P1.do(`__w.view('Requestor')`);
    const before2 = Number(await badge(P2));
    await P2.w(`__w.click('#notifications');true`);
    await waitFor(P2, `document.querySelector('#notification-list[aria-busy]')===null && document.querySelector('.notification')`);
    await P2.shot('features-2-notifications.png');
    check('the panel labels the simulated inbox and lists the new request as unread', await P2.w(`__w.text().includes('Admin inbox (simulated)') && [...document.querySelectorAll('.notification.unread')].some(n=>n.textContent.includes('New request submitted')&&n.textContent.includes('${ticketId}'))`));
    await P2.w(`[...document.querySelectorAll('.notification.unread')].find(n=>n.textContent.includes('${ticketId}')).querySelector('[data-open]').click();true`);
    await P2.settle();
    check('clicking a notification opens its ticket', await P2.w(`document.querySelector('#dialog-content .tagline').textContent.startsWith('${ticketId}')`));
    check('opening it marks it read and lowers the badge', await waitFor(P2, `(Number(document.querySelector('#notice-count').textContent)||0) < ${before2}`));
    await P2.do(`__w.set('#assignee','Miguel Santos');__w.set('#priority','High');__w.click('#assign')`);
    await reload(P1);
    check('the requestor receives the assignment and comments as unread', Number(await badge(P1)) >= 2, await badge(P1));
    await P1.w(`__w.click('#notifications');true`);
    await waitFor(P1, `document.querySelector('.notification')`);
    check('assignment and comment notifications are listed', await P1.w(`__w.text().includes('Developer assigned') && __w.text().includes('New comment')`));
    await P1.w(`__w.click('#mark-all');true`);
    check('Mark all as read clears the badge', await waitFor(P1, `document.querySelector('#notice-count').textContent==='' && !document.querySelector('.notification.unread')`));
    await P2.do(`__w.esc();__w.view('Requestor')`);
    await P2.w(`__w.click('#notifications');true`);
    await waitFor(P2, `document.querySelector('#notification-list[aria-busy]')===null`);
    check('another tester cannot see this tester\'s own requestor inbox', await P2.w(`!document.querySelector('#notification-list').textContent.includes('${ticketId}')`));
    await P2.do(`__w.esc();__w.view('Developer')`);
    await P2.w(`__w.click('#notifications');true`);
    await waitFor(P2, `document.querySelector('.notification')`);
    await P2.w(`[...document.querySelectorAll('.notification')].find(n=>n.textContent.includes('Assigned to you')&&n.textContent.includes('${ticketId}')).querySelector('[data-open]').click();true`);
    await P2.settle();
    check('the sample developer inbox gets the assignment and it opens the ticket', await P2.w(`document.querySelector('#dialog-content .tagline').textContent.startsWith('${ticketId}')`));
    await P2.w(`__w.esc();true`);
    await failing(P1, '*/api/v1/beta/notifications*');
    await P1.w(`__w.esc();__w.click('#notifications');true`);
    check('a failed notification load shows an error with Try again', await waitFor(P1, `document.querySelector('#retry-notifications')`));
    await restore(P1);
    await P1.w(`__w.click('#retry-notifications');true`);
    check('Try again loads the notifications', await waitFor(P1, `document.querySelector('.notification')`));
    await reload(P1);
    check('read state persists after a refresh', await badge(P1) === '');
    await P2.do(`__w.view('Admin')`);
    check('each tester\'s read state is separate', await P2.w(`fetch('/api/v1/beta/notifications?view=Requestor').then(r=>r.json()).then(d=>!d.items.some(n=>n.record==='${ticketId}'))`) && await P1.w(`fetch('/api/v1/beta/notifications?view=Requestor').then(r=>r.json()).then(d=>d.items.filter(n=>n.record==='${ticketId}').every(n=>n.read))`));

    // ---------- Search and filters ----------
    section = 'search';
    await P2.w(`Promise.all(Array.from({length:26},(_,i)=>new Promise(r=>setTimeout(r,i*40)).then(()=>fetch('/api/v1/beta/tickets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:'Requestor',requestId:'wt-bulk-'+i+'-'+Date.now(),input:{title:'FEATURE-WT bulk '+i,department:i%2?'IT':'Finance',date:'2026-12-20',category:'Enhancement',description:'Bulk search record '+i,criteria:''}})}).then(r=>{if(!r.ok)throw new Error('bulk create '+r.status)}))))`);
    await reload(P2);
    const typeSearch = async (P, text) => { await P.w(`__w.set('.search',${JSON.stringify(text)});true`); await sleep(500); await waitFor(P, `!document.querySelector('#records[aria-busy]')`); };
    await typeSearch(P2, 'FEATURE-WT bulk');
    check('search finds every matching shared record, with a result count', await P2.w(`document.querySelector('#result-count').textContent`) === '26 matching tickets · showing 1–25', await P2.w(`document.querySelector('#result-count').textContent`));
    await P2.shot('features-3-search.png');
    check('results are paged', await P2.w(`document.querySelector('.pager span').textContent==='Page 1 of 2' && document.querySelectorAll('#records tr[data-id]').length===25`));
    await P2.w(`__w.click('#next-page');true`); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`);
    check('the next page shows the rest', await P2.w(`document.querySelector('.pager span').textContent==='Page 2 of 2' && document.querySelectorAll('#records tr[data-id]').length===1`));
    await P2.w(`__w.set('#department-filter','Finance');true`); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`); await sleep(200);
    await P2.w(`__w.set('#dev-filter','Unassigned');true`); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`); await sleep(200);
    check('combined search, department, and Unassigned filters', await P2.w(`document.querySelector('#result-count').textContent`) === '13 matching tickets', await P2.w(`document.querySelector('#result-count').textContent`));
    await P2.w(`__w.set('#status-filter','Closed');true`); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`); await sleep(200);
    check('no matches shows a helpful empty state with Clear filters', await P2.w(`document.querySelector('#records').textContent.includes('No tickets match these filters') && !!document.querySelector('#empty-clear')`));
    await P2.w(`__w.click('#empty-clear');true`); await sleep(300); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`);
    check('Clear filters resets every filter', await P2.w(`__w.el('.search').value==='' && __w.el('#status-filter').value==='' && __w.el('#department-filter').value==='' && __w.el('#dev-filter').value==='' && __w.el('#clear-filters').disabled`));
    await typeSearch(P2, 'FEATURE-WT printer');
    await P2.w(`__w.set('#priority-filter','High');true`); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`); await sleep(200);
    await P2.do(`__w.open('${ticketId}')`);
    await P2.do(`__w.set('#comment-form [name=comment]','FEATURE-WT filters kept');__w.submit('#comment-form')`);
    await P2.w(`__w.esc();true`); await sleep(300); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`);
    check('filters stay set after opening details, saving, and closing', await P2.w(`__w.el('.search').value==='FEATURE-WT printer' && __w.el('#priority-filter').value==='High' && document.querySelectorAll('#records tr[data-id]').length===1`));
    await P1.do(`__w.view('Requestor')`);
    await typeSearch(P1, 'FEATURE-WT bulk');
    check('the Requestor view searches only its own and sample requests', await P1.w(`document.querySelector('#records').textContent.includes('No tickets match')`));
    await P1.do(`__w.view('Admin')`);
    check('switching the simulation view starts from an unfiltered list', await P1.w(`__w.el('.search').value===''`));
    await typeSearch(P1, 'FEATURE-WT bulk');
    check('the other tester\'s Admin view finds the same shared records', await P1.w(`document.querySelector('#result-count').textContent.startsWith('26 matching')`));
    await P1.do(`__w.view('Developer')`);
    check('the Developer view is staff: it has the assignee filter like Admin', await P1.w(`!!document.querySelector('#dev-filter')`));
    await P1.w(`__w.click('[data-view="Projects"]');true`); await P1.settle();
    await typeSearch(P1, 'PRJ-');
    check('Projects can be searched by project ID', await P1.w(`document.querySelectorAll('#records tr[data-id]').length>0 && [...document.querySelectorAll('#records .ticket-id')].every(e=>e.textContent.includes('PRJ-'))`));
    await failing(P1, '*/api/v1/beta/search*');
    await typeSearch(P1, 'PRJ-1');
    check('a failed search shows an error with Try again', await waitFor(P1, `document.querySelector('#retry-list')`));
    await restore(P1);
    await P1.w(`__w.click('#retry-list');true`);
    check('Try again searches again', await waitFor(P1, `document.querySelectorAll('#records tr[data-id]').length>0`));
    check('no page errors in either context', P1.cdp.errors.length === 0 && P2.cdp.errors.length === 0, [...P1.cdp.errors, ...P2.cdp.errors].join(' | '));
  } catch (err) {
    if (!interrupted) check('walkthrough crashed', false, err.stack);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} catch (err) {
  if (!interrupted) { console.error(`Beta features walkthrough could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);
const sections = [...new Set(results.map(r => r.section))];
console.log('\nResults by area:');
for (const s of sections) { const mine = results.filter(r => r.section === s); console.log(`  ${s}: ${mine.every(r => r.ok) ? 'PASSED' : 'FAILED'} (${mine.filter(r => r.ok).length}/${mine.length})`); }
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} beta features walkthrough checks passed`);
process.exit(failed ? 1 : 0);
