// Optional real-browser walkthrough of My workspace: real app roles and ticket ownership, assignment to Developer
// accounts, requested vs agreed dates, due-date reminders, role changes, disabled accounts, and separation from the
// beta simulation. MOCK Microsoft Entra and a temporary MongoDB only; two browser contexts, several accounts.
// Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled. Not run by npm test or CI.
//   npm run walkthrough:work
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
const DeadlineCore = require('../public/deadline-core.js');

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
  const db = mongo.db('jarctech_beta_walkthrough');
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'beta-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_beta_walkthrough', AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled', INSPECTION_MODE: 'enabled',
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
  // Signing in as someone else in the same browser context signs the current person out first.
  const signIn = async (P, n, name) => { if (await P.w(`!!document.querySelector('#sign-out')`).catch(() => false)) await P.loads(() => P.w(`document.querySelector('#sign-out').click();true`)); await P.nav(`${origin}/auth/signin`); entra.signInNext(account(n, name)); await P.loads(() => P.w(`__w.click('a.primary')`)); await P.settle(); };
  const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
  const reload = async P => { await P.nav(origin + '/'); await P.settle(); await waitFor(P, `!!window.JARC_SERVER && JARC_SERVER.ready && !document.querySelector('#records[aria-busy]')`); await sleep(300); };
  const users = mongo.db('jarctech_beta_walkthrough').collection('users');
  const api = (P, method, url, body) => P.w(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,json:await r.json().catch(()=>null)}))`);
  const today = DeadlineCore.today(new Date(), 'Asia/Manila'), tomorrow = DeadlineCore.addDays(today, 1);
  let ticketId = '', adminTicket = '';

  try {
    section = 'roles';
    await signIn(P1, 1, 'Owner Admin');
    check('the first person to sign in is a Requestor, not an Admin', await P1.w(`JARC_SESSION.role==='Requestor' && !document.querySelector('#manage-users')`));
    await users.updateOne({ email: 'member1@jarc.example' }, { $set: { role: 'Admin' } }); // as admin:bootstrap --promote-existing does
    await reload(P1);
    check('after the owner\'s bootstrap the account is Admin, with Users and the Workspace switch', await P1.w(`JARC_SESSION.role==='Admin' && !!document.querySelector('#manage-users') && document.querySelector('#workspace-switch').value==='mine' && document.querySelector('.sidebar-bottom').textContent.includes('My workspace')`));
    check('My workspace has no simulation view selector or beta banner', await P1.w(`document.querySelector('.demo-role-label').hidden && !document.querySelector('#beta-banner')`));
    await P1.w(`__w.click('#manage-users');true`);
    await waitFor(P1, `!!document.querySelector('#invite-form')`);
    await P1.do(`__w.set('#invite-form [name=email]','member3@jarc.example');__w.set('#invite-form [name=role]','Developer');__w.submit('#invite-form')`);
    check('an Admin invites a Developer from the Users screen', await waitFor(P1, `__w.text().includes('member3@jarc.example')`) && (await users.findOne({ email: 'member3@jarc.example' })).role === 'Developer');
    await P1.w(`__w.esc();true`);

    section = 'ownership';
    await signIn(P2, 2, 'Rita Requestor');
    await reload(P2);
    await P2.w(`__w.click('#new-ticket');true`);
    await P2.w(`__w.set('#request-form [name=title]','WORK-WT payroll export');__w.set('#request-form [name=department]','Finance');__w.set('#request-form [name=date]','${DeadlineCore.addDays(today, 30)}');__w.set('#request-form [name=description]','WORK-WT owned by Rita.');true`);
    check('the request form asks for a requested target date', await P2.w(`__w.text().includes('Requested target date')`));
    await P2.do(`__w.submit('#request-form')`);
    ticketId = await P2.w(`fetch('/api/v1/work/search?q=WORK-WT').then(r=>r.json()).then(d=>d.items[0]?.id||'')`);
    check('the request is saved to My workspace, owned by the signed-in person', /^JRC-2\d{3}$/.test(ticketId) && await P2.w(`fetch('/api/v1/work/tickets/${ticketId}').then(r=>r.json()).then(d=>d.tickets[0].name==='Rita Requestor')`), ticketId);
    await reload(P2);
    check('the list shows the requested date (no agreed delivery yet)', await P2.w(`document.querySelector('[data-id="${ticketId}"]').textContent.includes('Requested')`));
    adminTicket = (await api(P1, 'POST', '/api/v1/work/tickets', { requestId: 'wt-admin-' + Date.now(), input: { title: 'WORK-WT admin own request', department: 'IT', date: today, category: 'Bug / issue', description: 'Admin request.', criteria: '' } })).json.created;
    await reload(P2);
    check('a Requestor never sees another person\'s ticket: list, search, or direct URL', await P2.w(`!document.querySelector('[data-id="${adminTicket}"]')`) && (await api(P2, 'GET', `/api/v1/work/search?q=${adminTicket}`)).json.total === 0 && (await api(P2, 'GET', `/api/v1/work/tickets/${adminTicket}`)).status === 404);
    await reload(P1);
    check('the Admin sees every ticket and an unread notification for the new request', await P1.w(`!!document.querySelector('[data-id="${ticketId}"]') && Number(document.querySelector('#notice-count').textContent)>=1`));

    section = 'assignment';
    await signIn(P2, 3, 'Dana Developer');
    await reload(P2);
    check('the invited Developer is active with the Developer role', await P2.w(`JARC_SESSION.role==='Developer'`));
    await reload(P1);
    await P1.do(`__w.open('${ticketId}')`);
    check('assignment lists active Developer accounts, never sample people', await P1.w(`[...document.querySelectorAll('#assignee option')].map(o=>o.textContent).join('|')==='Choose developer|Dana Developer'`));
    await P1.do(`__w.set('#assignee',document.querySelector('#assignee option:last-child').value);__w.set('#priority','High');__w.click('#assign')`);
    check('the ticket is assigned to the Developer account', await P1.w(`fetch('/api/v1/work/tickets/${ticketId}').then(r=>r.json()).then(d=>d.tickets[0].dev==='Dana Developer'&&/^[0-9a-f]{24}$/.test(d.tickets[0].devId))`));
    await P1.w(`__w.esc();true`);
    await reload(P2);
    check('the Developer sees only assigned work (and not the Admin\'s own request)', await P2.w(`!!document.querySelector('[data-id="${ticketId}"]') && !document.querySelector('[data-id="${adminTicket}"]')`) && (await api(P2, 'GET', `/api/v1/work/tickets/${adminTicket}`)).status === 404);
    const project = await api(P2, 'POST', `/api/v1/work/tickets/${ticketId}/actions`, { version: (await api(P2, 'GET', `/api/v1/work/tickets/${ticketId}`)).json.tickets[0].version, action: 'create-project', input: { projectName: 'WORK-WT project', requirements: 'Export payroll.', criteria: 'Totals match.', date: tomorrow, tasks: [{ title: 'Build export', requirement: 'R', criteria: 'C', start: today, end: tomorrow, owner: 'Dana Developer' }] } });
    check('the Developer confirms scope with an agreed delivery date', project.status === 200 && project.json.tickets[0].dueDate === tomorrow, JSON.stringify(project.json && project.json.message));
    await reload(P2);
    check('the list shows the agreed delivery date with a due-soon label', await P2.w(`document.querySelector('[data-id="${ticketId}"] .deadline.due-soon')?.textContent==='Due in 1 day'`));
    check('the attention summary counts work due soon', await P2.w(`document.querySelector('[data-attention="Due soon"] strong').textContent==='1'`));
    await P2.w(`__w.click('[data-attention="Due soon"]');true`); await P2.settle(); await waitFor(P2, `!document.querySelector('#records[aria-busy]')`);
    check('clicking it filters the list (server search)', await P2.w(`document.querySelectorAll('#records tr[data-id]').length===1 && __w.el('#attention-filter').value==='Due soon'`));
    await P2.do(`__w.open('${ticketId}')`);
    check('details show requested and agreed dates separately', await P2.w(`__w.text().includes('Requested date') && __w.text().includes('Agreed delivery') && __w.text().includes('Due in 1 day')`));
    await P2.w(`__w.esc();true`);

    section = 'reminders';
    await app.reminders.runOnce();
    await reload(P2);
    await P2.w(`__w.click('#notifications');true`);
    await waitFor(P2, `!!document.querySelector('.notification')`);
    check('the server scheduler sends the Developer a due-date reminder', await P2.w(`[...document.querySelectorAll('.notification')].some(n=>n.textContent.includes('Delivery due in 1 day')&&n.textContent.includes('Automatic reminder'))`));
    check('the panel says email is not enabled', await P2.w(`__w.text().includes('not enabled, so notifications are in-app only')`));
    await P2.w(`__w.esc();__w.click('#settings');true`);
    await waitFor(P2, `!!document.querySelector('#prefs-form')`);
    check('Settings explains that email delivery is not enabled', await P2.w(`__w.text().includes('Email delivery is not enabled')`));
    await P2.do(`__w.set('#prefs-form [name=emailReminders]',true);__w.submit('#prefs-form')`);
    check('the email preference is saved for when email is enabled', (await users.findOne({ email: 'member3@jarc.example' })).emailReminders === true);

    section = 'simulation';
    await P2.w(`__w.set('#workspace-switch','beta');true`);
    await sleep(800); await P2.settle(); await waitFor(P2, `!!window.JARC_SERVER && JARC_SERVER.ready`);
    check('switching to Beta simulation shows the beta banner and the Simulation view selector', await P2.w(`!!document.querySelector('#beta-banner') && !document.querySelector('.demo-role-label').hidden && JARC_SERVER.simulated`));
    await P2.do(`__w.view('Admin')`);
    check('the simulated Admin view shows only beta test records', await P2.w(`!document.querySelector('[data-id="${ticketId}"]') && !document.querySelector('[data-id="${adminTicket}"]') && !!document.querySelector('[data-id="JRC-1042"]')`));
    check('a simulated Admin view gives no access to My workspace', (await api(P2, 'GET', `/api/v1/work/tickets/${adminTicket}`)).status === 404 && (await api(P2, 'GET', '/api/v1/users')).status === 403);
    await P2.w(`__w.set('#workspace-switch','mine');true`);
    await sleep(800); await reload(P2);
    check('switching back returns to My workspace as the real Developer', await P2.w(`!JARC_SERVER.simulated && JARC_SESSION.role==='Developer' && !!document.querySelector('[data-id="${ticketId}"]')`));

    section = 'role changes';
    const devId = String((await users.findOne({ email: 'member3@jarc.example' }))._id);
    check('an Admin changes the role from the Users screen', (await api(P1, 'PATCH', `/api/v1/users/${devId}`, { role: 'Requestor' })).status === 200);
    await P2.w(`document.dispatchEvent(new Event('visibilitychange'));true`);
    await sleep(1500); await P2.settle(); await waitFor(P2, `!!window.JARC_SERVER && JARC_SERVER.ready`);
    check('the open page reloads with the new role, and the assignment disappears', await P2.w(`JARC_SESSION.role==='Requestor' && !document.querySelector('[data-id="${ticketId}"]')`));
    check('the server refuses the old role at once', (await api(P2, 'GET', `/api/v1/work/tickets/${ticketId}`)).status === 404);
    check('an Admin cannot change their own role (the last Admin stays)', (await api(P1, 'PATCH', `/api/v1/users/${String((await users.findOne({ email: 'member1@jarc.example' }))._id)}`, { role: 'Requestor' })).status === 403);
    check('disabling the account signs it out everywhere', (await api(P1, 'PATCH', `/api/v1/users/${devId}`, { status: 'disabled' })).status === 200 && (await api(P2, 'GET', '/api/v1/work/workspace')).status === 401);
    await P1.shot('work-1-admin.png');
    check('no page errors in either context', P1.cdp.errors.length === 0 && P2.cdp.errors.length === 0, [...P1.cdp.errors, ...P2.cdp.errors].join(' | '));
  } catch (err) {
    if (!interrupted) check('walkthrough crashed', false, err.stack);
  }
} catch (err) {
  if (!interrupted) { console.error(`My workspace walkthrough could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);
const sections = [...new Set(results.map(r => r.section))];
console.log('\nResults by area:');
for (const s of sections) { const mine = results.filter(r => r.section === s); console.log(`  ${s}: ${mine.every(r => r.ok) ? 'PASSED' : 'FAILED'} (${mine.filter(r => r.ok).length}/${mine.length})`); }
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} My workspace walkthrough checks passed`);
process.exit(failed ? 1 : 0);
