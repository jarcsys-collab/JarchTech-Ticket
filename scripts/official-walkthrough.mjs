// Real-browser walkthrough of the official configuration, with separate Admin, Developer, and Requestor accounts, each
// in its own browser context: first sign-in as Requestor, the Users screen and role changes, a Ticket and a Project
// through every gate, Admin self-assignment, demotion and disabling while a page is open, failure recovery and
// persistence, keyboard use, phone-width layouts, and no simulation or preview anywhere on the page.
// MOCK Microsoft Entra and a temporary MongoDB only. Not run by npm test or CI (it needs Chrome or Edge).
// Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled.
//   npm run walkthrough:official            BETA_SCREENSHOTS=<folder> also saves screenshots
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
const { BETA_NAMES, fingerprint } = require('./db-snapshot.cjs');

const TENANT = '55555555-6666-4777-8888-999999999999';
const CLIENT = 'eeeeeeee-ffff-4000-8111-222222222222';
const SHOTS = process.env.BETA_SCREENSHOTS ? path.resolve(process.env.BETA_SCREENSHOTS) : null;
const DB = 'jarctech_official_walkthrough';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
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
const check = (name, ok, info = '') => { results.push({ section, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${info && !ok ? '  -- ' + info : ''}`); };

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

async function connect(url) {
  const ws = new WebSocket(url); sockets.push(ws);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('DevTools connection failed'))); });
  let id = 1; const pending = new Map(), handlers = new Map(), waits = [], errors = [], violations = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && /Content Security Policy/i.test(m.params.entry.text || '')) violations.push(m.params.entry.text);
    handlers.get(m.method)?.(m.params);
    for (let i = waits.length - 1; i >= 0; i--) if (waits[i].method === m.method) { waits[i].res(m.params); waits.splice(i, 1); }
  });
  const send = (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, errors, violations, on: (method, fn) => handlers.set(method, fn), event: method => new Promise(res => waits.push({ method, res })) };
}

const HELPERS = `window.__w={
  el(sel,root=document){const e=root.querySelector(sel);if(!e)throw new Error('missing '+sel);return e},
  set(sel,val,root=document){const e=__w.el(sel,root);if(e.type==='checkbox')e.checked=val;else e.value=val;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},
  click(sel){__w.el(sel).click()},
  submit(sel){__w.el(sel).requestSubmit()},
  text(){return document.querySelector('#dialog-content').textContent},
  page(){return document.body.innerText},
  toast(){return document.querySelector('#toast').textContent},
  overflow(){return document.documentElement.scrollWidth-document.documentElement.clientWidth}
};true`;
function pageApi(cdp) {
  const evaluate = async expr => { const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const w = async js => { await evaluate(HELPERS); return evaluate(js); };
  const settle = async () => { for (let i = 0; i < 80; i++) { const s = await w(`[!!window.JARC_SERVER&&JARC_SERVER.ready,(document.querySelector('.save')||{dataset:{}}).dataset.state||'']`).catch(() => [false, '']); if (s[0] && s[1] !== 'saving') break; await sleep(100); } await sleep(250); };
  const loads = async action => { const l = cdp.event('Page.loadEventFired'); await action(); await l; await sleep(300); };
  const nav = url => loads(() => cdp.send('Page.navigate', { url }));
  const shot = async name => { if (!SHOTS) return; const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); };
  const key = async (key, code = key, modifiers = 0) => { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: { Tab: 9, Escape: 27, Enter: 13, ' ': 32 }[key] }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); await sleep(120); };
  return { cdp, w, settle, loads, nav, shot, key, do: async js => { await w(js + ';true'); await settle(); } };
}
const account = (n, name) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`, name, email: `staff${n}@jarc.example`, preferred_username: `staff${n}@jarc.example` });

let exitCode = 0;
try {
  if (!BROWSER || !fs.existsSync(BROWSER)) throw new Error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  const db = mongo.db(DB);
  await ensureSchema(db);
  await seedWorkspace(db); // beta records exist in this database, as they do in the deployed one
  const betaBefore = await fingerprint(db, BETA_NAMES);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'official-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  const env = {
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'official-walkthrough-secret', APP_BASE_URL: origin, SESSION_SECRET: 'official-walkthrough-session-secret-0123456789'
  };
  const options = { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } };
  app = await start(loadConfig(env), options);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-official-'));
  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1280,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, 'about:blank'], { stdio: 'ignore' });
  let browserWs;
  for (let i = 0; i < 150 && !browserWs; i++) { try { browserWs = (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl; } catch {} if (!browserWs) await sleep(200); }
  if (!browserWs) throw new Error('The browser did not start.');
  const bcdp = await connect(browserWs);
  // A separate browser context per person: nothing is shared between them.
  async function person() {
    const { browserContextId } = await bcdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const P = pageApi(await connect(`ws://127.0.0.1:${debug}/devtools/page/${targetId}`));
    await P.cdp.send('Page.enable'); await P.cdp.send('Runtime.enable'); await P.cdp.send('Log.enable');
    P.cdp.on('Page.javascriptDialogOpening', () => P.cdp.send('Page.handleJavaScriptDialog', { accept: true }));
    return P;
  }
  const ADMIN = await person(), DEV = await person(), REQ = await person(), OTHER = await person();
  const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
  const signIn = async (P, n, name) => { await P.nav(`${origin}/auth/signin`); entra.signInNext(account(n, name)); await P.loads(() => P.w(`document.querySelector('a.primary').click();true`)); await P.settle(); await waitFor(P, `!!window.JARC_SERVER && JARC_SERVER.ready && !document.querySelector('#records[aria-busy]')`); };
  const reload = async P => { await P.nav(origin + '/'); await P.settle(); await waitFor(P, `!!window.JARC_SERVER && JARC_SERVER.ready && !document.querySelector('#records[aria-busy]')`); await sleep(200); };
  const api = (P, method, url, body) => P.w(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,json:await r.json().catch(()=>null)}))`);
  const users = db.collection('users'), tickets = db.collection('tickets');
  const ticket = id => tickets.findOne({ id });
  const idOf = async n => String((await users.findOne({ email: `staff${n}@jarc.example` }))._id);
  const openTicket = async (P, id) => { await P.do(`detail(${JSON.stringify(id)})`); await waitFor(P, `!document.querySelector('#overlay').hidden`); };
  // Fills and sends the new request form as a person would.
  const submitRequest = async (P, title, type) => {
    await P.do(`__w.click('#new-ticket')`);
    await P.do(`__w.set('#request-form [name=title]',${JSON.stringify(title)});__w.set('#request-form [name=date]','2030-06-30');__w.set('#request-form [name=type]',${JSON.stringify(type)});__w.set('#request-form [name=description]','Needs doing.');__w.set('#request-form [name=criteria]','It works.');__w.submit('#request-form')`);
    await waitFor(P, `document.querySelector('#overlay').hidden`);
    const doc = await tickets.findOne({ title });
    return doc && doc.id;
  };
  const addEvidence = async (P, id) => { await openTicket(P, id); await P.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#evidence-form [name=label0]','Report');__w.set('#evidence-form [name=url0]','https://example.com/report');__w.submit('#evidence-form')`); };
  const markDone = async (P, id) => { await openTicket(P, id); await P.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#worker-complete')`); await P.do(`__w.set('#complete-form [name=summary]','Delivered and tested.');__w.set('#complete-form [type=checkbox]',true);__w.submit('#complete-form')`); };
  const clickIn = async (P, sel) => { await P.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click(${JSON.stringify(sel)})`); };
  const confirmUserChange = async (P, id, field, value) => {
    await P.do(`__w.click('#manage-users')`);
    await waitFor(P, `!!document.querySelector('#invite-form')`);
    await P.w(`__w.set('select[data-user="${id}"][data-field="${field}"]',${JSON.stringify(value)});true`);
    await waitFor(P, `!!document.querySelector('#user-confirm-yes')`);
    await P.do(`__w.click('#user-confirm-yes')`);
    await sleep(300);
  };

  try {
    section = '1 first sign-in';
    await signIn(ADMIN, 1, 'Alma Admin');
    await signIn(DEV, 2, 'Dante Developer');
    await signIn(REQ, 3, 'Rosa Requestor');
    await signIn(OTHER, 4, 'Omar Other');
    check('a new account starts as Requestor', await REQ.w(`JARC_SESSION.role==='Requestor' && document.querySelector('.signed-in-as').textContent==='Rosa Requestor · Requestor'`));
    check('a Requestor has no Users screen', await REQ.w(`!document.querySelector('#manage-users')`) && (await api(REQ, 'GET', '/api/v1/users')).status === 403);
    await users.updateOne({ email: 'staff1@jarc.example' }, { $set: { role: 'Admin' } }); // the owner's account is Admin, as admin:bootstrap made it
    await reload(ADMIN);

    section = 'official screens';
    const FORBIDDEN = /beta|simulat|prototype|sample|demo\b|inspection|preview view|saved locally|miguel santos|alex admin/i;
    for (const [P, who] of [[ADMIN, 'Admin'], [REQ, 'Requestor']]) {
      const text = await P.w(`__w.page()`);
      check(`${who}: no beta, sample, simulation, or prototype wording on the page`, !FORBIDDEN.test(text), (FORBIDDEN.exec(text) || [])[0]);
      check(`${who}: no role selector, workspace switch, or preview control`, await P.w(`!document.querySelector('#demo-role') && !document.querySelector('.demo-role-label') && !document.querySelector('#workspace-switch') && !document.querySelector('#preview-views') && !document.querySelector('#beta-banner') && !document.querySelector('#inspection-banner')`));
      check(`${who}: no demo scripts loaded`, await P.w(`!window.SampleData && !window.JARC_INSPECTION && !window.JARC_BETA`));
    }
    const stale = await REQ.w(`localStorage.setItem('jarc-workspace','beta');localStorage.setItem('jarc-inspection-view','Admin');true`);
    await reload(REQ);
    check('leftover browser settings from the beta have no effect', stale && await REQ.w(`!JARC_SERVER.simulated && !window.JARC_INSPECTION && JARC_SERVER.base==='/api/v1/work'`));
    check('simulation endpoints answer 404 to a signed-in Admin', (await api(ADMIN, 'GET', '/api/v1/beta/workspace?view=Admin')).status === 404 && (await api(ADMIN, 'POST', '/api/v1/beta/reset', { confirm: 'RESET', view: 'Admin' })).status === 404);
    check('preview and sample scripts answer 404', await ADMIN.w(`Promise.all(['/inspection.js','/sample-data.js'].map(u=>fetch(u).then(r=>r.status))).then(s=>s.every(x=>x===404))`));
    await ADMIN.shot('official-01-admin-home.png');
    await ADMIN.nav(`${origin}/auth/signin`).catch(() => {});
    await reload(ADMIN);

    section = 'empty and guided states';
    check('the Requestor sees an empty, guided home', await REQ.w(`__w.page().includes('Needs your action') && __w.page().includes('None of your requests needs anything from you')`));

    section = '2 Users screen';
    await ADMIN.do(`__w.click('#manage-users')`);
    await waitFor(ADMIN, `!!document.querySelector('#invite-form')`);
    const screen = await ADMIN.w(`__w.text()`);
    check('explains a colleague must sign in before their account appears', screen.includes('must sign in once with their company Microsoft account before their account appears here'));
    check('an existing invitation capability remains, and says no email is sent', screen.includes('Invite someone before their first sign-in') && screen.includes('No email is sent'));
    check('shows attachment storage in use', screen.includes('Attachment storage:'));
    await ADMIN.shot('official-02-users.png');
    const devId = await idOf(2), reqId = await idOf(3), adminId = await idOf(1), otherId = await idOf(4);
    await ADMIN.w(`__w.set('select[data-user="${devId}"][data-field="role"]','Developer');true`);
    check('a role change is confirmed first and explains its effect', await waitFor(ADMIN, `__w.text().includes('Confirm: make Dante Developer a Developer?') && __w.text().includes('cannot assign work or manage users')`));
    check('nothing has changed until it is confirmed', (await users.findOne({ email: 'staff2@jarc.example' })).role === 'Requestor');
    await ADMIN.do(`__w.click('#user-confirm-no')`);
    await waitFor(ADMIN, `!!document.querySelector('#invite-form')`);
    check('cancel leaves the role as it was', (await users.findOne({ email: 'staff2@jarc.example' })).role === 'Requestor' && await ADMIN.w(`document.querySelector('select[data-user="${devId}"][data-field="role"]').value==='Requestor'`));
    await confirmUserChange(ADMIN, devId, 'role', 'Developer');
    check('an Admin makes another account a Developer', (await users.findOne({ email: 'staff2@jarc.example' })).role === 'Developer');
    check('the change is in the account activity with who made it', await waitFor(ADMIN, `!!document.querySelector('#account-activity') && document.querySelector('#account-activity').textContent.includes('Dante Developer') && document.querySelector('#account-activity').textContent.includes('Requestor → Developer') && document.querySelector('#account-activity').textContent.includes('by Alma Admin')`));
    check('the Admin cannot change their own role or access here', await ADMIN.w(`!document.querySelector('select[data-user="${adminId}"]')`));
    await ADMIN.do(`close()`);
    await reload(DEV);
    check('the Developer now sees their role, with no Users screen or overview', await DEV.w(`JARC_SESSION.role==='Developer' && !document.querySelector('#manage-users') && !document.querySelector('.overview')`));

    section = '3 access';
    const ticketId = await submitRequest(REQ, 'Fix the payroll export', 'Ticket');
    check('the Requestor submits a Ticket', Boolean(ticketId) && (await ticket(ticketId)).requester.id === reqId);
    await reload(ADMIN);
    check('the Admin sees it in the review queue', await waitFor(ADMIN, `document.querySelector('.home').textContent.includes(${JSON.stringify(ticketId)})`));
    await openTicket(ADMIN, ticketId);
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#assignee',${JSON.stringify(devId)});__w.set('#priority','High');__w.click('#assign')`);
    check('the Admin assigns the Developer', (await ticket(ticketId)).devId === devId);
    await reload(DEV); await reload(OTHER);
    check('the Developer sees the assigned work and a next step', await DEV.w(`!!document.querySelector('[data-id="${ticketId}"]')`) && await DEV.w(`document.querySelector('.home').textContent.includes('Start the work')`));
    check('an unrelated Requestor does not see it anywhere', await OTHER.w(`!document.querySelector('[data-id="${ticketId}"]') && !__w.page().includes('payroll')`));
    check('an unrelated Requestor gets 404 at its direct address', (await api(OTHER, 'GET', `/api/v1/work/tickets/${ticketId}`)).status === 404);
    check('and search finds nothing', (await api(OTHER, 'GET', '/api/v1/work/search?q=payroll')).json.total === 0);

    section = '4 Ticket gates';
    await openTicket(DEV, ticketId);
    check('the next-step panel names the action', await DEV.w(`document.querySelector('#next-step').textContent.includes('your action') && !!document.querySelector('#ns-primary')`));
    await DEV.shot('official-03-next-step.png');
    await DEV.do(`__w.click('#ns-primary')`);
    check('the Developer starts the work', (await ticket(ticketId)).status === 'In progress');
    await addEvidence(DEV, ticketId);
    check('evidence is added', (await ticket(ticketId)).evidence.length === 1);
    await markDone(DEV, ticketId);
    check('the worker marks it done', (await ticket(ticketId)).status === 'Awaiting acceptance');
    const closeTooEarly = await api(ADMIN, 'POST', `/api/v1/work/tickets/${ticketId}/actions`, { version: (await ticket(ticketId)).version, action: 'status', input: { status: 'Closed' } });
    check('an Admin cannot close before the Requestor confirms', closeTooEarly.status === 409);
    await reload(REQ);
    await openTicket(REQ, ticketId);
    check('the Requestor is told to review the evidence', await REQ.w(`document.querySelector('#next-step').textContent.includes('Review the evidence and confirm completion')`));
    await clickIn(REQ, '#requestor-confirm');
    check('the Requestor confirms independently', (await ticket(ticketId)).completion.requestor.id === reqId);
    await reload(ADMIN);
    await openTicket(ADMIN, ticketId);
    await clickIn(ADMIN, '[data-action="Closed"]');
    check('the Admin closes the Ticket', (await ticket(ticketId)).status === 'Closed');
    await reload(REQ);
    await openTicket(REQ, ticketId);
    check('after a reload the Requestor sees the closed request with its history', await REQ.w(`__w.text().includes('Nothing more to do') && __w.text().includes('Requestor reviewed the evidence')`));
    await REQ.do(`close()`);

    section = '4 Project gates';
    const projectId = await submitRequest(REQ, 'New sales dashboard', 'Project');
    await reload(ADMIN);
    await openTicket(ADMIN, projectId);
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#assignee',${JSON.stringify(devId)});__w.click('#assign')`);
    await reload(DEV);
    await openTicket(DEV, projectId);
    check('a Project offers no Start before its agreement', await DEV.w(`document.querySelector('#next-step').textContent.includes('Schedule the requirements meeting') && !document.querySelector('[data-section="planning"] [data-action="In progress"]')`));
    await DEV.do(`__w.click('#ns-primary')`);
    check('the meeting form says no invitation or Teams meeting is created', await DEV.w(`__w.text().includes('does not send calendar invitations or create Teams meetings')`));
    await DEV.do(`__w.set('#meeting-form [name=meeting]','2030-01-10T10:00');__w.set('#meeting-form [name=location]','Room 2');__w.submit('#meeting-form')`);
    check('the worker proposes the meeting', (await ticket(projectId)).meeting === '2030-01-10T10:00');
    await reload(REQ);
    await openTicket(REQ, projectId);
    await REQ.do(`__w.click('#ns-primary')`);
    check('the Requestor confirms the meeting', (await ticket(projectId)).meetingConfirmed === true);
    await reload(DEV);
    await openTicket(DEV, projectId);
    await DEV.do(`__w.click('#ns-primary')`);
    await DEV.do(`__w.set('#agreement-form [name=notes]','Met.');__w.set('#agreement-form [name=requirements]','A dashboard by region.');__w.set('#agreement-form [name=criteria]','Totals match finance.');__w.submit('#agreement-form')`);
    await DEV.do(`__w.click('#confirm-agreement')`);
    check('the worker records and confirms the agreement', (await ticket(projectId)).agreementDraft.worker.id === devId);
    await reload(REQ);
    await openTicket(REQ, projectId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#confirm-agreement')`);
    check('the Requestor confirms and it locks', (await ticket(projectId)).agreements[0].version === 1);
    await reload(DEV);
    await openTicket(DEV, projectId);
    await DEV.do(`__w.click('#ns-primary')`);
    await DEV.do(`__w.set('#project-scope [name=date]','2030-06-30');__w.submit('#project-scope')`);
    await DEV.do(`__w.set('.plan-task [name=title]','Build it');__w.set('.plan-task [name=requirement]','Dashboard');__w.set('.plan-task [name=criteria]','Totals match');__w.set('.plan-task [name=start]','2030-02-01');__w.set('.plan-task [name=end]','2030-03-01');__w.set('#project-tasks [name=agreed]',true);__w.submit('#project-tasks')`);
    check('the timeline is created and the Gantt view opens', (await ticket(projectId)).project === `PRJ-${projectId.split('-')[1]}` && await DEV.w(`!!document.querySelector('.gantt')`));
    await DEV.shot('official-04-gantt.png');
    await reload(DEV);
    check('the Gantt view persists after a reload', await DEV.w(`projectView(${JSON.stringify(projectId)});document.querySelector('.gantt').textContent.includes('Build it')`));
    await DEV.do(`close()`);
    await openTicket(DEV, projectId);
    await DEV.do(`__w.click('#ns-primary')`);
    check('development starts', (await ticket(projectId)).status === 'In progress');
    // A scope change: requested, assessed, agreed, approved: a new agreement version.
    await reload(REQ);
    await openTicket(REQ, projectId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#new-change')`);
    await REQ.do(`__w.set('#change-form [name=title]','Add a CSV export');__w.set('#change-form [name=reason]','Finance needs it.');__w.set('#change-form [name=criteria]','Export opens in Excel.');__w.submit('#change-form')`);
    const change = await db.collection('ticket_changes').findOne({ ticket: projectId });
    check('the Requestor submits a linked scope change', change && change.status === 'Submitted');
    await reload(ADMIN);
    await ADMIN.do(`changeDetail(${JSON.stringify(change.id)})`);
    await ADMIN.do(`__w.click('[data-cstatus="Assessment"]')`);
    await reload(DEV);
    await DEV.do(`changeDetail(${JSON.stringify(change.id)})`);
    await DEV.do(`__w.set('#impact-form [name=impact]','Small.');__w.set('#impact-form [name=effort]','1 day');__w.set('#impact-form [name=date]','2030-07-15');__w.submit('#impact-form')`);
    await reload(REQ);
    await REQ.do(`changeDetail(${JSON.stringify(change.id)})`);
    await REQ.do(`__w.click('#agree-change')`);
    await reload(ADMIN);
    await ADMIN.do(`changeDetail(${JSON.stringify(change.id)})`);
    await ADMIN.do(`__w.click('#approve-change')`);
    const versioned = await ticket(projectId);
    check('approval adds agreement v2 and moves the target; v1 is kept', versioned.agreements.length === 2 && versioned.agreements[0].requirements === 'A dashboard by region.' && versioned.dueDate === '2030-07-15');
    await reload(DEV);
    await DEV.do(`changeDetail(${JSON.stringify(change.id)})`);
    await DEV.do(`__w.click('[data-cstatus="In progress"]')`);
    await DEV.do(`__w.set('#change-test [name=results]','Passed.');__w.set('#change-test [type=checkbox]',true);__w.submit('#change-test')`);
    await reload(REQ);
    await REQ.do(`changeDetail(${JSON.stringify(change.id)})`);
    await REQ.do(`__w.click('[data-cstatus="Accepted"]')`);
    await reload(DEV);
    await DEV.do(`changeDetail(${JSON.stringify(change.id)})`);
    await DEV.do(`__w.click('[data-cstatus="Released"]')`);
    check('the change is delivered', (await db.collection('ticket_changes').findOne({ id: change.id })).status === 'Released');
    await DEV.do(`close()`);
    await reload(DEV);
    await openTicket(DEV, projectId);
    await DEV.do(`for(const d of document.querySelectorAll('details'))d.open=true;for(const b of document.querySelectorAll('[data-task]:not(:checked)')){b.checked=true;b.dispatchEvent(new Event('change'));break}`);
    for (let i = 0; i < 3 && (await ticket(projectId)).tasks.some(x => !x.done); i++) {
      await openTicket(DEV, projectId);
      await DEV.do(`for(const d of document.querySelectorAll('details'))d.open=true;const b=document.querySelector('[data-task]:not(:checked)');if(b){b.checked=true;b.dispatchEvent(new Event('change'))}`);
    }
    check('all tasks are done', (await ticket(projectId)).tasks.every(x => x.done));
    await addEvidence(DEV, projectId);
    await markDone(DEV, projectId);
    await reload(REQ);
    await openTicket(REQ, projectId);
    await clickIn(REQ, '#requestor-confirm');
    check('both confirmations are recorded', Boolean((await ticket(projectId)).completion.worker && (await ticket(projectId)).completion.requestor));
    const noHandover = await api(ADMIN, 'POST', `/api/v1/work/tickets/${projectId}/actions`, { version: (await ticket(projectId)).version, action: 'status', input: { status: 'Closed' } });
    check('a Project cannot close before its handover', noHandover.status === 409);
    await reload(DEV);
    await openTicket(DEV, projectId);
    await clickIn(DEV, '[data-action="Released"]');
    await reload(ADMIN);
    await openTicket(ADMIN, projectId);
    await clickIn(ADMIN, '[data-action="Closed"]');
    check('the Admin closes the Project', (await ticket(projectId)).status === 'Closed');
    await ADMIN.do(`close()`);

    section = '5 Admin self-assignment';
    const selfId = await submitRequest(REQ, 'Rotate the printer keys', 'Ticket');
    await reload(ADMIN);
    await openTicket(ADMIN, selfId);
    check('the assignee list offers the Admin themselves', await ADMIN.w(`[...document.querySelectorAll('#assignee option')].some(o=>o.textContent.includes('yourself'))`));
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#assignee',${JSON.stringify(adminId)});__w.click('#assign')`);
    await reload(ADMIN);
    await openTicket(ADMIN, selfId);
    await ADMIN.do(`__w.click('#ns-primary')`);
    await addEvidence(ADMIN, selfId);
    await markDone(ADMIN, selfId);
    check('the Admin as worker cannot confirm for the Requestor', await ADMIN.w(`!document.querySelector('#requestor-confirm')`) && (await api(ADMIN, 'POST', `/api/v1/work/tickets/${selfId}/actions`, { version: (await ticket(selfId)).version, action: 'requestor-confirm', input: {} })).status === 403);
    await reload(REQ);
    await openTicket(REQ, selfId);
    await clickIn(REQ, '#requestor-confirm');
    await reload(ADMIN);
    await openTicket(ADMIN, selfId);
    await clickIn(ADMIN, '[data-action="Closed"]');
    const closedSelf = await ticket(selfId);
    check('the Requestor confirms independently and the Admin closes', closedSelf.status === 'Closed' && closedSelf.completion.worker.id === adminId && closedSelf.completion.requestor.id === reqId);
    await ADMIN.do(`close()`);

    section = 'failure recovery';
    const failId = await submitRequest(REQ, 'Replace the scanner', 'Ticket');
    await reload(REQ);
    await openTicket(REQ, failId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#comment-form textarea','An important comment I typed.')`);
    await REQ.cdp.send('Network.enable');
    await REQ.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await REQ.do(`__w.submit('#comment-form')`);
    await sleep(300);
    check('offline: the save fails visibly and the typed text stays', await REQ.w(`document.querySelector('#comment-form textarea').value==='An important comment I typed.' && __w.toast().includes('Your entry is still here')`), await REQ.w(`__w.toast()`));
    await REQ.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await REQ.do(`__w.submit('#comment-form')`);
    check('back online: the same entry saves once', (await ticket(failId)).history.filter(h => h.text.includes('An important comment')).length === 1);
    // Accidental closing protects typed text.
    await openTicket(REQ, failId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#comment-form textarea','Do not lose this.')`);
    await REQ.key('Escape');
    check('Esc with typed text does not discard it, and says why', await REQ.w(`!document.querySelector('#overlay').hidden && document.querySelector('#comment-form textarea').value==='Do not lose this.' && __w.toast().includes('not saved')`));
    await REQ.key('Escape');
    check('a second Esc closes it', await REQ.w(`document.querySelector('#overlay').hidden`));
    // Two people on one record.
    await reload(ADMIN);
    await openTicket(ADMIN, failId);
    await reload(REQ);
    await openTicket(REQ, failId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#comment-form textarea','Saved first.');__w.submit('#comment-form')`);
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#comment-form textarea','My text after a conflict.');__w.submit('#comment-form')`);
    check('a conflict keeps the second person\'s text and offers the latest version', await ADMIN.w(`document.querySelector('#comment-form textarea').value==='My text after a conflict.' && document.querySelector('#ns-notice').textContent.includes('Someone else changed this request')`));
    await ADMIN.do(`__w.click('#ns-latest')`);
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true`);
    check('the latest version then shows the other comment', await ADMIN.w(`__w.text().includes('Saved first.')`));
    await ADMIN.do(`close()`); await REQ.do(`close()`);
    // A failed load offers a retry.
    await REQ.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await REQ.do(`JARC_SERVER.search({q:'x',scope:'tickets',page:1,pageSize:25,view:role}).then(r=>{window.__r=r})`);
    check('a failed search reports a readable message', await REQ.w(`window.__r.ok===false && window.__r.message.includes('Check your connection')`));
    await REQ.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // A server restart: sessions, records, and the next save carry on.
    const before = await ticket(failId);
    await app.shutdown();
    app = await start(loadConfig(env), options);
    await reload(REQ);
    check('after a server restart the person stays signed in and sees the same records', await REQ.w(`JARC_SESSION.role==='Requestor' && !!document.querySelector('[data-id="${failId}"]')`) && (await ticket(failId)).version === before.version);

    section = 'attachments';
    await openTicket(REQ, failId);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;
      const bytes=Uint8Array.from(atob(${JSON.stringify(PNG)}),c=>c.charCodeAt(0));
      const dt=new DataTransfer();dt.items.add(new File([bytes],'screenshot.png',{type:'image/png'}));
      const input=document.querySelector('#comment-form input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change'))`);
    check('a file uploads with its state shown', await waitFor(REQ, `document.querySelector('#comment-form .upload.done') && document.querySelector('#comment-form .upload.done').textContent.includes('Uploaded')`));
    await REQ.do(`__w.submit('#comment-form')`);
    await sleep(300);
    const fileEntry = (await ticket(failId)).history.find(h => h.attachments);
    check('it is attached to the comment', Boolean(fileEntry));
    const fileUrl = `/api/v1/work/attachments/${fileEntry.attachments[0].id}/download`;
    const fetched = await REQ.w(`fetch(${JSON.stringify(fileUrl)}).then(r=>({status:r.status,cd:r.headers.get('content-disposition'),csp:r.headers.get('content-security-policy')}))`);
    check('the Requestor downloads it, always as an attachment, in a sandbox', fetched.status === 200 && fetched.cd.startsWith('attachment;') && fetched.csp.includes('sandbox'));
    check('an unrelated Requestor gets 404', await OTHER.w(`fetch(${JSON.stringify(fileUrl)}).then(r=>r.status)`) === 404);
    check('and so does the unassigned Developer', await DEV.w(`fetch(${JSON.stringify(fileUrl)}).then(r=>r.status)`) === 404);
    await REQ.do(`close()`);

    section = 'notifications';
    await reload(REQ);
    await REQ.do(`__w.click('#notifications')`);
    await waitFor(REQ, `!document.querySelector('#notification-list[aria-busy]')`);
    check('the bell lists the Requestor\'s notifications and says email is off', await REQ.w(`document.querySelector('#notification-list').textContent.includes('Worker marked') || document.querySelector('#notification-list').textContent.includes('please review')`) && await REQ.w(`document.querySelector('#inbox-label').textContent.includes('not enabled, so notifications are in-app only')`));
    await REQ.do(`close()`);
    await REQ.do(`__w.click('#settings')`);
    await waitFor(REQ, `!!document.querySelector('#prefs-form')`);
    check('Settings label email as not available, without an option to turn on', await REQ.w(`__w.text().includes('Not available') && document.querySelector('#prefs-form [name=emailReminders]').disabled && !document.querySelector('#prefs-form button.primary')`));
    await REQ.do(`close()`);

    section = '6 demotion and disabling';
    const liveId = await submitRequest(REQ, 'Migrate the NAS', 'Ticket');
    await reload(ADMIN);
    await openTicket(ADMIN, liveId);
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.set('#assignee',${JSON.stringify(devId)});__w.click('#assign')`);
    await ADMIN.do(`close()`);
    await reload(DEV);
    await openTicket(DEV, liveId);
    await confirmUserChange(ADMIN, devId, 'role', 'Requestor');
    check('demoted: the same session loses the record at once', (await api(DEV, 'GET', `/api/v1/work/tickets/${liveId}`)).status === 404);
    await DEV.do(`__w.click('#ns-primary')`);
    check('the open page reports it clearly instead of failing silently', await DEV.w(`__w.toast().includes('not available to you')`), await DEV.w(`__w.toast()`));
    check('nothing was changed by the attempt', (await ticket(liveId)).status === 'Assigned');
    await DEV.do(`close()`);
    await reload(DEV);
    check('after a reload the screens match the new role', await DEV.w(`JARC_SESSION.role==='Requestor' && !document.querySelector('[data-id="${liveId}"]')`));
    await ADMIN.do(`close()`);
    await reload(ADMIN);
    check('the Admin is asked to reassign the stranded work', await ADMIN.w(`document.querySelector('.home').textContent.includes('Reassign this work')`));
    await openTicket(ADMIN, liveId);
    check('its details say why', await ADMIN.w(`__w.text().includes('can no longer act on it')`));
    await ADMIN.do(`close()`);
    // Restored for the disabling check.
    await confirmUserChange(ADMIN, devId, 'role', 'Developer');
    await ADMIN.do(`close()`);
    await confirmUserChange(ADMIN, otherId, 'status', 'disabled');
    check('disabled: the session is over at once', (await api(OTHER, 'GET', '/api/v1/me')).status === 401);
    await OTHER.nav(origin + '/');
    check('the app sends them to sign-in', await OTHER.w(`location.pathname==='/auth/signin'`));
    entra.signInNext(account(4, 'Omar Other'));
    await OTHER.loads(() => OTHER.w(`document.querySelector('a.primary').click();true`));
    check('and Microsoft sign-in no longer admits them', await OTHER.w(`document.body.innerText.includes('Access not granted') && document.body.innerText.includes('has been turned off')`));
    await ADMIN.do(`close()`);
    await confirmUserChange(ADMIN, otherId, 'status', 'active');
    await ADMIN.do(`close()`);
    const lastAdmin = await api(ADMIN, 'PATCH', `/api/v1/users/${adminId}`, { role: 'Requestor' });
    check('the last active Admin is protected', lastAdmin.status === 403);

    section = 'keyboard';
    await reload(ADMIN);
    check('list rows take keyboard focus and open with Enter', await ADMIN.w(`{const r=document.querySelector('#records tr[data-id]');r.focus();document.activeElement===r}`));
    await ADMIN.key('Enter');
    check('Enter opened the request, and focus moved into it', await waitFor(ADMIN, `!document.querySelector('#overlay').hidden && document.querySelector('.drawer').contains(document.activeElement)`));
    for (let i = 0; i < 60; i++) await ADMIN.key('Tab');
    check('Tab stays inside the open dialog', await ADMIN.w(`document.querySelector('.drawer').contains(document.activeElement)`));
    await ADMIN.key('Tab', 'Tab', 8);
    check('Shift+Tab stays inside it too', await ADMIN.w(`document.querySelector('.drawer').contains(document.activeElement)`));
    await ADMIN.key('Escape');
    await sleep(150);
    check('Esc closes it and focus returns to the row', await ADMIN.w(`document.querySelector('#overlay').hidden && document.activeElement && document.activeElement.matches('#records tr[data-id]')`), await ADMIN.w(`document.activeElement && document.activeElement.tagName`));
    check('the next-step heading is announced as a heading inside a labelled dialog', await ADMIN.w(`document.querySelector('.drawer').getAttribute('role')==='dialog' && document.querySelector('.drawer').getAttribute('aria-modal')==='true'`));

    section = 'phone width';
    const phone = async (P, width = 390) => P.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await phone(ADMIN);
    await reload(ADMIN);
    check('home and list: no sideways page scroll', await ADMIN.w(`__w.overflow()<=1`), String(await ADMIN.w(`__w.overflow()`)));
    await ADMIN.shot('official-05-phone-home.png');
    await ADMIN.do(`__w.click('#manage-users')`);
    await waitFor(ADMIN, `!!document.querySelector('#invite-form')`);
    check('Users screen fits', await ADMIN.w(`__w.overflow()<=1 && document.querySelector('.drawer').scrollWidth-document.querySelector('.drawer').clientWidth<=1`), String(await ADMIN.w(`document.querySelector('.drawer').scrollWidth-document.querySelector('.drawer').clientWidth`)));
    await ADMIN.w(`__w.set('select[data-user="${devId}"][data-field="role"]','Admin');true`);
    await waitFor(ADMIN, `!!document.querySelector('#user-confirm-yes')`);
    check('the role confirmation fits and its buttons are reachable', await ADMIN.w(`{const b=document.querySelector('#user-confirm-yes').getBoundingClientRect();b.left>=0&&b.right<=innerWidth}`));
    await ADMIN.shot('official-06-phone-users.png');
    await ADMIN.do(`__w.click('#user-confirm-no')`);
    await ADMIN.do(`close()`);
    await openTicket(ADMIN, projectId);
    check('request details fit', await ADMIN.w(`__w.overflow()<=1 && document.querySelector('.drawer').scrollWidth-document.querySelector('.drawer').clientWidth<=1`), String(await ADMIN.w(`document.querySelector('.drawer').scrollWidth-document.querySelector('.drawer').clientWidth`)));
    await ADMIN.shot('official-07-phone-detail.png');
    await ADMIN.do(`projectView(${JSON.stringify(projectId)})`);
    check('the Gantt chart scrolls inside its own area, not the page', await ADMIN.w(`__w.overflow()<=1 && document.querySelector('.gantt-scroll').scrollWidth>document.querySelector('.gantt-scroll').clientWidth`));
    await ADMIN.shot('official-08-phone-gantt.png');
    await ADMIN.do(`close()`);
    await ADMIN.cdp.send('Emulation.clearDeviceMetricsOverride');

    section = '8 beta data';
    check('beta records are untouched by all of this', JSON.stringify(await fingerprint(db, BETA_NAMES)) === JSON.stringify(betaBefore));
    check('no real record is a beta record', (await tickets.countDocuments({ workspace: { $ne: 'main' } })) === 0);

    section = 'page health';
    for (const [P, who] of [[ADMIN, 'Admin'], [DEV, 'Developer'], [REQ, 'Requestor'], [OTHER, 'other']]) {
      check(`${who}: no script errors`, P.cdp.errors.length === 0, P.cdp.errors.slice(0, 3).join(' | '));
      check(`${who}: nothing blocked by the Content Security Policy`, P.cdp.violations.length === 0, P.cdp.violations.slice(0, 3).join(' | '));
    }
  } catch (err) {
    check('walkthrough finished', false, err.message);
    exitCode = 1;
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length) { exitCode = 1; for (const f of failed) console.log(`FAILED [${f.section}] ${f.name}`); }
} catch (err) {
  console.error(err.message);
  exitCode = 2;
}
await cleanup();
process.exit(exitCode);
