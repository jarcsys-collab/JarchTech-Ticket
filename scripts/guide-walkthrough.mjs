// Real-browser walkthrough of guided next actions: the "Needs your action" home queues, the next-step panel and
// progress tracker, keyboard use, "Show me", guided validation (field errors, linked summary, preserved entries),
// separate worker/Requestor/Admin stages, a Ticket with a correction, a Project agreement, a scope change, Admin
// self-assignment, simulation handoffs (and none in My workspace), stale updates, mobile layout, and reduced motion.
// MOCK Microsoft Entra and a temporary MongoDB only. Screenshots go to GUIDE_SCREENSHOTS when it is set.
// Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled. Not run by npm test or CI.
//   npm run walkthrough:guide
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
const SHOTS = process.env.GUIDE_SCREENSHOTS ? path.resolve(process.env.GUIDE_SCREENSHOTS) : null;
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
  esc(){for(let i=0;i<2;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))},
  toast(){return document.querySelector('#toast').textContent},
  saveState(){return document.querySelector('.save').dataset.state||''},
  text(){return document.querySelector('#dialog-content').textContent},
  async server(){const r=await fetch('/api/v1/beta/workspace?view=Admin');return r.json()},
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
  const db = mongo.db('jarctech_guide_walkthrough');
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'beta-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_guide_walkthrough', AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled', INSPECTION_MODE: 'enabled',
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

  try {
    const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
    const CODES = { Tab: 9, Enter: 13 };
    const press = async (P, key) => { const k = { key, code: key, windowsVirtualKeyCode: CODES[key], nativeVirtualKeyCode: CODES[key] }; await P.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, ...(key === 'Enter' ? { text: '\r' } : {}) }); await P.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }); await sleep(200); await P.settle(); };
    const active = P => P.w(`(()=>{const a=document.activeElement;return a?(a.id||a.name||a.className||a.tagName):''})()`);
    const panel = P => P.w(`(()=>{const p=document.querySelector('#next-step');return p?{mine:p.classList.contains('mine'),title:p.querySelector('#ns-title').textContent,who:(p.querySelector('.ns-who')||{}).textContent||'',text:p.textContent,primary:(p.querySelector('#ns-primary')||{}).textContent||''}:null})()`);
    const switchTo = async (P, view, id) => { await P.w(`document.querySelector('[data-switch-view="${view}"]').click();true`); await waitFor(P, `JARC_BETA.view==='${view}' && !document.querySelector('#overlay').hidden && document.querySelector('#dialog-content .tagline')?.textContent.startsWith('${id}') && !!document.querySelector('#next-step[data-guide-view="${view}"]')`); await P.settle(); };
    const primary = P => P.do(`__w.click('#ns-primary')`);
    await P1.cdp.send('Page.bringToFront');

    // ---------- Home: "Needs your action" ----------
    section = 'home';
    await signIn(P1, 1, 'Member One');
    check('the Beta simulation is visually distinct', await P1.w(`document.body.classList.contains('simulated') && getComputedStyle(document.querySelector('header')).boxShadow!=='none'`));
    check('Requestor home leads with "Needs your action", separate from notifications', await P1.w(`document.querySelector('.home h2').textContent==='Needs your action' && document.querySelector('.home').textContent.includes('The bell shows what changed') && [...document.querySelectorAll('.queue h3')].map(h=>h.firstChild.textContent.trim()).join('|')==='Needs your action'`));
    check('an older record without evidence is guided back to the worker', await P1.w(`[...document.querySelectorAll('.queue-item')].some(b=>b.dataset.openTicket==='JRC-1039'&&b.textContent.includes('Return it so the worker can add evidence'))`));
    await P1.do(`__w.view('Admin')`);
    await waitFor(P1, `JARC_BETA.view==='Admin' && document.querySelectorAll('.queue').length===2`);
    check('Admin home has separate queues for administrative reviews and their own assigned work', await P1.w(`[...document.querySelectorAll('.queue h3')].map(h=>h.firstChild.textContent.trim()).join('|')==='Administrative reviews|Your assigned work'`));
    check('reviews and scope changes waiting for an Admin are listed; the empty work queue says so', await P1.w(`(()=>{const q=document.querySelectorAll('.queue');return [...q[0].querySelectorAll('.queue-item')].some(b=>b.dataset.openTicket==='JRC-1040'&&b.textContent.includes('Review the request')) && [...q[0].querySelectorAll('.queue-item')].some(b=>b.dataset.openChange==='CR-201') && q[1].textContent.includes('Nothing assigned to you needs action')})()`));
    check('the Admin overview and list remain below the queues', await P1.w(`!!document.querySelector('.home ~ .overview') && !!document.querySelector('#records')`));
    await P1.shot('01-home-admin-desktop.png');

    // ---------- A Ticket, guided, with the keyboard ----------
    section = 'ticket (keyboard)';
    await P1.do(`document.querySelector('.home [data-open-ticket="JRC-1040"]').click()`);
    let p = await panel(P1);
    check('details lead with the next step: action, responsible person, explanation, one primary button', p && p.mine && p.title === 'Review the request' && p.who.includes('You (as Admin)') && p.primary === 'Start the review' && await P1.w(`document.querySelectorAll('#next-step .primary').length===1 && document.querySelectorAll('#dialog-content .primary:not(form .primary)').length===1`), JSON.stringify(p));
    check('a short progress tracker marks the current step in text, not only color', await P1.w(`(()=>{const c=document.querySelector('.tracker [aria-current=step]');return !!c && c.textContent.includes('Assigned') && c.textContent.includes('current step')})()`));
    check('focus starts on the next-step heading', await active(P1) === 'ns-title');
    await press(P1, 'Tab');
    check('Tab reaches the primary action', await active(P1) === 'ns-primary', await active(P1));
    await press(P1, 'Enter');
    check('Enter takes the action; the server saves it', await P1.w(`__w.ticket('JRC-1040').then(t=>t.status==='Under review')`));
    p = await panel(P1);
    check('the panel moves on to "Assign a worker"', p.title === 'Assign a worker' && p.primary === 'Choose an assignee', JSON.stringify(p));
    await press(P1, 'Tab'); await press(P1, 'Enter');
    check('"Choose an assignee" shows the section and focuses the field', await active(P1) === 'assignee' && await P1.w(`document.querySelector('#work-area').contains(document.querySelector('#assignee'))`), await active(P1));
    await P1.do(`__w.set('#assignee','Miguel Santos');__w.set('#priority','High');__w.click('#assign')`);
    p = await panel(P1);
    check('a waiting state explains who acts next and that nothing is needed from you', !p.mine && p.title === 'Start the work' && p.who.includes('Miguel Santos (worker)') && p.text.includes('Nothing is needed from you right now'), JSON.stringify(p));
    check('the simulation suggests the handoff', p.text.includes('Simulation: switch to the Developer view to start the work'));
    await P1.shot('02-waiting-handoff-desktop.png');
    await switchTo(P1, 'Developer', 'JRC-1040');
    p = await panel(P1);
    check('switching views reopens the request as the worker, with the step now theirs', p.mine && p.title === 'Start the work', JSON.stringify(p));
    await primary(P1);
    p = await panel(P1);
    check('next: add evidence; the evidence section is the working area', p.title === 'Add completion evidence' && await P1.w(`!!document.querySelector('#work-area [data-section="evidence"]')`));
    await primary(P1);
    check('"Add evidence" focuses the link field', await active(P1) === 'url0', await active(P1));

    // ---------- Validation ----------
    section = 'validation';
    check('no errors are shown before submitting', await P1.w(`!document.querySelector('.error-summary') && !document.querySelector('.field-error')`));
    await P1.do(`__w.set('#evidence-form [name=url0]','javascript:alert(1)');__w.submit('#evidence-form')`);
    check('an unsafe link gets a field-level error and a linked summary; nothing is saved', await P1.w(`(()=>{const s=document.querySelector('#evidence-form .error-summary');const f=document.querySelector('#evidence-form [name=url0]');return !!s && s.getAttribute('role')==='alert' && f.getAttribute('aria-invalid')==='true' && document.getElementById(f.id+'-error').textContent.includes('https://') && f.getAttribute('aria-describedby').includes(f.id+'-error')})()`) && await P1.w(`__w.ticket('JRC-1040').then(t=>!(t.evidence||[]).length)`));
    await P1.w(`document.querySelector('#evidence-form .error-summary a').click();true`);
    check('the summary link focuses the field (entry kept)', await P1.w(`document.activeElement.name==='url0'`) && await P1.w(`__w.el('#evidence-form [name=url0]').value==='javascript:alert(1)'`));
    await P1.do(`__w.set('#evidence-form [name=url0]','https://reports.example.com/printer');__w.submit('#evidence-form')`);
    p = await panel(P1);
    check('a valid link is saved and the next step is "Mark your work done"', p.title === 'Mark your work done' && await P1.w(`__w.ticket('JRC-1040').then(t=>t.evidence.length===1)`));
    await primary(P1);
    await P1.do(`__w.submit('#complete-form')`);
    check('submitting an empty form lists each problem, with required fields labelled', await P1.w(`document.querySelectorAll('#complete-form .error-summary li').length===2 && document.activeElement.classList.contains('error-summary') && !!document.querySelector('#complete-form .form-note') && document.querySelector('#complete-form .req .sr-only').textContent.includes('required')`));
    await P1.do(`__w.set('#complete-form [name=summary]','Printer reset and tested.');__w.submit('#complete-form')`);
    check('fixed fields lose their error; the entry is preserved; the remaining problem is named', await P1.w(`document.querySelectorAll('#complete-form .error-summary li').length===1 && document.querySelector('#complete-form .error-summary').textContent.includes('Confirm') && __w.el('#complete-form [name=summary]').value==='Printer reset and tested.'`) && await P1.w(`__w.ticket('JRC-1040').then(t=>t.status==='In progress')`));
    await P1.shot('03-validation-desktop.png');
    await P1.do(`__w.set('#complete-form input[type=checkbox]',true);__w.submit('#complete-form')`);
    check('the worker marks the work done', await P1.w(`__w.ticket('JRC-1040').then(t=>t.status==='Awaiting acceptance')`));

    // ---------- Separate confirmations, a correction, and closure ----------
    section = 'confirmation and correction';
    p = await panel(P1);
    check('the worker now waits for the Requestor, with a handoff', !p.mine && p.title === 'Review the evidence and confirm completion' && p.who.includes('Adriane Venzon (Requestor)') && p.text.includes('switch to the Requestor view'), JSON.stringify(p));
    check('worker completion, Requestor confirmation, and Admin closure are separate stages with states in words', await P1.w(`[...document.querySelectorAll('.stages .stage')].map(s=>s.querySelector('b').textContent+':'+s.querySelector('.stage-state').textContent.trim()).join('|')==='Worker completion:✓ Done|Requestor confirmation:● Waiting|Admin closure:○ Not yet'`), await P1.w(`[...document.querySelectorAll('.stages .stage')].map(s=>s.textContent).join(' | ')`));
    await switchTo(P1, 'Requestor', 'JRC-1040');
    await primary(P1);
    check('"Review the evidence" keeps the evidence in view and focuses the confirm button', await active(P1) === 'requestor-confirm' && await P1.w(`(()=>{const w=document.querySelector('#work-area');const e=w.querySelector('[data-section="evidence"]');return !!e && w.firstElementChild===e && !e.closest('details') && e.textContent.includes('reports.example.com')})()`));
    check('switching views from the panel keeps the page on the request list', await P1.w(`document.querySelector('#page-title').textContent==='My ticket'`), await P1.w(`document.querySelector('#page-title').textContent`));
    await P1.shot('04-review-evidence-desktop.png');
    await P1.do(`__w.click('[data-section="confirmations"] [data-reason="In progress"]')`);
    await P1.do(`__w.submit('#reason-form')`);
    check('the correction reason is required, with a field error', await P1.w(`!!document.querySelector('#reason-form .field-error')`));
    await P1.do(`__w.set('#reason-form [name=reason]','The tray still jams.');__w.submit('#reason-form')`);
    p = await panel(P1);
    check('after a correction the Requestor waits for the worker to complete again', !p.mine && p.title === 'Mark your work done' && await P1.w(`__w.ticket('JRC-1040').then(t=>t.status==='In progress'&&!t.completion.worker&&t.corrections.length===1)`));
    await switchTo(P1, 'Developer', 'JRC-1040');
    await primary(P1);
    await P1.do(`__w.set('#complete-form [name=summary]','Tray replaced and tested.');__w.set('#complete-form input[type=checkbox]',true);__w.submit('#complete-form')`);
    await switchTo(P1, 'Requestor', 'JRC-1040');
    await primary(P1); await P1.do(`__w.click('#requestor-confirm')`);
    p = await panel(P1);
    check('after the Requestor confirms, the Admin closes (and is named)', !p.mine && p.title === 'Close the request' && p.who.includes('An Admin'));
    await switchTo(P1, 'Admin', 'JRC-1040');
    await primary(P1);
    p = await panel(P1);
    check('the Admin closes it; nothing more to do, and the tracker is complete', p.title === 'Nothing more to do' && await P1.w(`__w.ticket('JRC-1040').then(t=>t.status==='Closed')`) && await P1.w(`[...document.querySelectorAll('.tracker li')].every(l=>l.classList.contains('done'))`));

    // ---------- A Project: agreement confirmation with the requirements in view ----------
    section = 'project';
    await P1.do(`__w.esc();__w.view('Requestor')`);
    await P1.w(`__w.click('#new-ticket');true`); await sleep(200);
    await P1.do(`__w.submit('#request-form')`);
    check('an empty request form lists the missing required fields and saves nothing', await P1.w(`document.querySelectorAll('#request-form .error-summary li').length>=4 && document.querySelector('#request-form .error-summary').textContent.includes('Choose request type')`) && await P1.w(`__w.server().then(w=>w.tickets.length===6)`));
    await P1.do(`__w.set('[name=title]','Guided report project');__w.set('[name=type]','Project');__w.set('[name=date]','2026-12-15');__w.set('[name=description]','Monthly report.');__w.submit('#request-form')`);
    const pid = await P1.w(`__w.server().then(w=>w.tickets.find(t=>t.title==='Guided report project').id)`);
    await P1.do(`__w.esc();__w.view('Admin')`);
    await waitFor(P1, `!!document.querySelector('.home [data-open-ticket="${pid}"]')`);
    await P1.do(`document.querySelector('.home [data-open-ticket="${pid}"]').click()`);
    await primary(P1);
    await P1.do(`__w.set('#assignee','Miguel Santos');__w.click('#assign')`);
    await switchTo(P1, 'Developer', pid);
    p = await panel(P1);
    check('a Project guides the worker to the mandatory requirements meeting', p.mine && p.title === 'Schedule the requirements meeting');
    await primary(P1);
    await P1.do(`__w.set('#meeting-form [name=meeting]','2026-11-04T10:00');__w.submit('#meeting-form')`);
    await switchTo(P1, 'Requestor', pid);
    await primary(P1);
    await switchTo(P1, 'Developer', pid);
    await primary(P1);
    await P1.do(`__w.set('#agreement-form [name=notes]','Met in room 2.');__w.set('#agreement-form [name=requirements]','Monthly sales report with region filter.');__w.set('#agreement-form [name=criteria]','Totals match the ledger.');__w.submit('#agreement-form')`);
    p = await panel(P1);
    check('the worker is guided to review and confirm the agreement', p.title === 'Confirm the agreement' && p.primary === 'Review and confirm');
    await primary(P1);
    check('"Review and confirm" focuses the confirm button below the requirements', await active(P1) === 'confirm-agreement');
    await P1.do(`__w.click('#confirm-agreement')`);
    await switchTo(P1, 'Requestor', pid);
    p = await panel(P1);
    check('the Requestor confirms with the requirements visible in the working area of a spacious page', p.mine && p.title === 'Confirm the agreement' && await P1.w(`document.querySelector('.drawer').classList.contains('wide-drawer') && document.querySelector('#work-area [data-section="agreement"]').textContent.includes('Monthly sales report with region filter.')`));
    await P1.shot('05-agreement-desktop.png');
    await primary(P1); await P1.do(`__w.click('#confirm-agreement')`);
    p = await panel(P1);
    check('once locked, the worker is next: create the timeline', !p.mine && p.title === 'Create the project timeline' && await P1.w(`__w.ticket('${pid}').then(t=>t.agreements.length===1)`));

    // ---------- Scope change and Admin self-assignment ----------
    section = 'scope change and self-assignment';
    await P1.do(`__w.esc();__w.view('Admin')`);
    await waitFor(P1, `!!document.querySelector('.home [data-open-change="CR-201"]')`);
    await P1.do(`document.querySelector('.home [data-open-change="CR-201"]').click()`);
    check('a scope change opens with its own next step', await P1.w(`document.querySelector('#next-step').classList.contains('mine') && document.querySelector('#ns-title').textContent==='Send the scope change for assessment'`));
    await P1.do(`__w.esc();__w.open('JRC-1041')`);
    p = await panel(P1);
    check('when no simulated view acts as the worker, the handoff says how to continue', !p.mine && p.text.includes('no view acts as Elyza Cruz'));
    await P1.do(`__w.set('#assignee','Alex Admin');__w.click('#assign')`);
    p = await panel(P1);
    check('after self-assignment the Admin is the worker', p.mine && p.who.includes('You (as the worker)') && p.title === 'Schedule the requirements meeting');
    await P1.do(`__w.esc()`);
    check('the Admin home lists it under "Your assigned work"', await P1.w(`[...document.querySelectorAll('.queue')[1].querySelectorAll('.queue-item')].some(b=>b.dataset.openTicket==='JRC-1041')`));

    // ---------- Stale and concurrent updates ----------
    section = 'concurrent';
    await signIn(P2, 2, 'Member Two');
    await P2.do(`__w.view('Admin')`);
    await P1.do(`__w.open('JRC-1042')`);
    await P2.do(`__w.open('JRC-1042');__w.set('#comment-form [name=comment]','Second session saved first.');__w.submit('#comment-form')`);
    await P1.do(`__w.set('#comment-form [name=comment]','My stale comment');__w.submit('#comment-form')`);
    check('a stale save explains what happened in the next-step panel and keeps the typed text', await P1.w(`document.querySelector('#ns-notice').textContent.includes('Someone else changed this request') && __w.el('#comment-form [name=comment]').value==='My stale comment'`));
    await P1.do(`__w.click('#ns-latest')`);
    check('"Show the latest version" shows the other session’s change', await P1.w(`__w.text().includes('Second session saved first.')`));

    // ---------- Mobile layout and reduced motion ----------
    section = 'mobile';
    await P1.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await P1.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await P1.loads(() => P1.cdp.send('Page.reload', {})); await P1.settle();
    check('mobile home: no horizontal scrolling', await P1.w(`document.documentElement.scrollWidth<=window.innerWidth+1 && !!document.querySelector('.home')`), await P1.w(`document.documentElement.scrollWidth+'/'+window.innerWidth`));
    await P1.shot('06-home-mobile.png');
    await P1.do(`document.querySelector('.home [data-open-ticket]')?.click() || __w.open('JRC-1042')`);
    check('mobile details fit the screen, single column', await P1.w(`(()=>{const d=document.querySelector('.drawer');return d.scrollWidth<=d.clientWidth+1 && getComputedStyle(document.querySelector('.req-layout')).gridTemplateColumns.split(' ').length===1})()`));
    await P1.shot('07-detail-mobile.png');
    check('reduced motion is respected', await P1.w(`matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.documentElement).scrollBehavior==='auto'`));
    await P1.cdp.send('Emulation.clearDeviceMetricsOverride');
    await P1.cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // ---------- My workspace: no simulation guidance ----------
    section = 'my workspace';
    await P1.w(`localStorage.setItem('jarc-workspace','mine');location.reload();true`); await sleep(1200);
    await waitFor(P1, `!!window.JARC_SERVER && JARC_SERVER.ready && !JARC_SERVER.simulated && !!document.querySelector('.home')`);
    check('My workspace has the same home, without simulation styling', await P1.w(`!document.body.classList.contains('simulated') && document.querySelector('.home h2').textContent==='Needs your action'`));
    await P1.w(`__w.click('#new-ticket');__w.set('[name=title]','Real guided request');__w.set('[name=type]','Ticket');__w.set('[name=date]','2026-12-20');__w.set('[name=description]','A real request.');__w.submit('#request-form');true`);
    await waitFor(P1, `fetch('/api/v1/work/search?q=Real%20guided').then(r=>r.json()).then(d=>d.total===1)`);
    const rid = await P1.w(`fetch('/api/v1/work/search?q=Real%20guided').then(r=>r.json()).then(d=>d.items[0].id)`);
    await P1.w(`__w.esc();true`); await waitFor(P1, `!!document.querySelector('[data-id="${rid}"]')`);
    await P1.w(`__w.open('${rid}');true`); await waitFor(P1, `!!document.querySelector('#next-step')`);
    p = await panel(P1);
    check('a real request waits for an Admin, with no view-switching advice', !p.mine && p.title === 'Review the request' && p.who.includes('An Admin') && !p.text.includes('Simulation') && !await P1.w(`!!document.querySelector('[data-switch-view]')`), JSON.stringify(p));
    await P1.shot('08-my-workspace-waiting-desktop.png');
    check('simulation never changed the real role', await P1.w(`fetch('/api/v1/me').then(r=>r.json()).then(j=>j.user.role==='Requestor')`));
    check('no page errors in either context', P1.cdp.errors.length === 0 && P2.cdp.errors.length === 0, [...P1.cdp.errors, ...P2.cdp.errors].join(' | '));
  } catch (err) {
    if (!interrupted) check('walkthrough crashed', false, err.stack);
  }
} catch (err) {
  if (!interrupted) { console.error(`Guided walkthrough could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);
const sections = [...new Set(results.map(r => r.section))];
console.log('\nResults by area (shared beta records, server-backed):');
for (const s of sections) { const mine = results.filter(r => r.section === s); console.log(`  ${s}: ${mine.every(r => r.ok) ? 'PASSED' : 'FAILED'} (${mine.filter(r => r.ok).length}/${mine.length})`); }
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} guided next actions checks passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);
