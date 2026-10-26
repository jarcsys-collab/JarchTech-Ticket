// Optional browser walkthrough of every prototype workflow in beta inspection mode (INSPECTION_MODE=enabled),
// plus sign-in, logout, recovery, and inspection-data isolation. Uses a MOCK Microsoft Entra provider and a
// temporary MongoDB, never Microsoft, Atlas, or .env, and a temporary browser profile. Ports are chosen automatically.
// Needs Node >=22 and Chrome or Edge (BROWSER_PATH to override). Not run by `npm test` or GitHub Actions.
// Exit codes: 0 all flows passed, 1 a check failed, 2 could not start, 130 cancelled.
//
//   npm run walkthrough:inspection
//   INSPECTION_SCREENSHOTS=tmp/inspection npm run walkthrough:inspection
//
// Everything checked here is browser-only sample data except sign-in, logout, the signed-in role, and the
// admin API, which are server-backed. Shared ticket APIs do not exist yet.
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
const { startMockEntra } = require('../tests/helpers/mock-entra.cjs');

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SAMPLE_KEY = 'jarc-inspection:jarc-helpdesk-v1';
const NORMAL_KEY = 'jarc-helpdesk-v1';
const SHOTS = process.env.INSPECTION_SCREENSHOTS ? path.resolve(process.env.INSPECTION_SCREENSHOTS) : null;
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

const FLOWS = {
  1: 'Requestor submission and progress tracking',
  2: 'Admin review, clarification, rejection, priority, and assignment',
  3: 'Developer requirements meetings and confirmation',
  4: 'Two-step project creation and date validation',
  5: 'Gantt editing, progress, and reload persistence',
  6: 'Testing, acceptance, corrections, release, and closure',
  7: 'Linked change assessment, agreement, approval, and delivery',
  8: 'Search, filters, notifications, and dialog controls',
  9: 'Sign-in, logout, recovery, and inspection-data isolation'
};
const results = [];
let flow = 0;
const check = (name, ok, info = '') => { results.push({ flow, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${flow}] ${name}${info ? '  -- ' + info : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// Everything this script starts, so cleanup (also on Ctrl+C) touches nothing else.
let mongod, mongo, entra, app, browser, profile, ws, cleaning, interrupted = false;
function cleanup() {
  return cleaning ??= (async () => {
    try { ws?.close(); } catch {}
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await new Promise(resolve => { const t = setTimeout(resolve, 5000); browser.once('exit', () => { clearTimeout(t); resolve(); }); browser.kill(); });
    }
    for (const step of [() => app?.shutdown(), () => entra?.close(), () => mongo?.close(), () => mongod?.stop()]) { try { await step(); } catch {} }
    for (let i = 0; profile && i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
    if (profile && fs.existsSync(profile)) console.error(`Could not delete the temporary browser profile: ${profile}`);
  })();
}
for (const sig of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { if (interrupted) return; interrupted = true; console.error(`\n${sig} received. Cleaning up...`); await cleanup(); process.exit(130); });
}

let id = 1; const pending = new Map(), waits = [], errors = [], dialogs = [];
const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== WebSocket.OPEN) return rej(new Error('Browser connection closed')); const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const event = method => new Promise(res => waits.push({ method, res }));
async function evaluate(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function nav(url) { const l = event('Page.loadEventFired'); await send('Page.navigate', { url }); await l; await sleep(300); }
async function reload() { const l = event('Page.loadEventFired'); await send('Page.reload', {}); await l; await sleep(300); }
async function loads(action) { const l = event('Page.loadEventFired'); await action(); await l; await sleep(300); }
async function shot(name) { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); }

// In-page helpers, installed before each step because reloads clear them.
const HELPERS = `window.__w={
  el(sel,root=document){const e=root.querySelector(sel);if(!e)throw new Error('missing '+sel);return e},
  set(sel,val,root=document){const e=__w.el(sel,root);if(e.type==='checkbox')e.checked=val;else e.value=val;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},
  click(sel){__w.el(sel).click()},
  submit(sel){__w.el(sel).requestSubmit()},
  view(r){__w.set('#demo-role',r)},
  open(id){__w.click('[data-id="'+id+'"]')},
  toast(){return document.querySelector('#toast').textContent},
  data(){return JSON.parse(localStorage.getItem(${JSON.stringify(SAMPLE_KEY)}))},
  ticket(id){return __w.data().tickets.find(t=>t.id===id)},
  change(id){return __w.data().changes.find(c=>c.id===id)},
  text(){return document.querySelector('#dialog-content').textContent},
  overlay(){return !document.querySelector('#overlay').hidden}
};true`;
const w = async js => { await evaluate(HELPERS); return evaluate(js); };
const account = (n, name, email) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, email, preferred_username: email });

try {
  if (!BROWSER || !fs.existsSync(BROWSER)) throw new Error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  const db = mongo.db('jarctech_inspection_walkthrough');
  await ensureSchema(db);
  await db.collection('users').insertOne({ email: 'ada@jarc.example', role: 'Admin', status: 'active', displayName: 'Ada Admin', tenantId: TENANT, entraObjectId: account(2).oid, createdAt: new Date(), updatedAt: new Date() });
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'inspection-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_inspection_walkthrough', AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', INSPECTION_MODE: 'enabled',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'inspection-walkthrough-secret', APP_BASE_URL: origin, SESSION_SECRET: 'inspection-walkthrough-session-secret-0123456'
  }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-inspectcheck-'));
  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  browser.on('error', err => console.error(`Could not start the browser: ${err.message}`));
  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(200); }
  if (!wsUrl) throw new Error('The browser did not start.');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('Could not connect to the browser.'))); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
    for (let i = waits.length - 1; i >= 0; i--) if (waits[i].method === m.method) { waits[i].res(m.params); waits.splice(i, 1); }
  });
  await send('Page.enable'); await send('Runtime.enable');

  try {
    // ---------- 9 (part 1): sign-in, normal records, entering inspection ----------
    flow = 9;
    await nav(`${origin}/`);
    const normal = JSON.stringify({ tickets: [{ id: 'JRC-7001', title: 'My real local record', name: 'Rhea Requestor', department: 'Sales', category: 'Enhancement', date: '2026-12-01', priority: 'Low', status: 'Submitted', dev: '', description: 'Must stay untouched.', criteria: 'Untouched.', tasks: [], history: [] }], changes: [], notices: [] });
    await w(`localStorage.setItem(${JSON.stringify(NORMAL_KEY)}, ${JSON.stringify(normal)}); true`);
    entra.signInNext(account(1, 'Rhea Requestor', 'rhea@jarc.example'));
    await loads(() => w(`__w.click('a.primary'); true`));
    check('real Microsoft sign-in (mock) admits a tenant member as Requestor', await w(`location.pathname==='/' && document.querySelector('.signed-in-as').textContent==='Rhea Requestor · Requestor'`));
    check('normal mode shows the normal browser record and a Preview views button, no inspection banner', await w(`!!document.querySelector('[data-id="JRC-7001"]') && !!document.querySelector('#preview-views') && !document.querySelector('#inspection-banner') && document.querySelector('.demo-role-label').hidden`));
    await w(`__w.click('#preview-views'); true`); await sleep(200);
    check('Preview views explains sample data and offers Requestor, Admin, and Developer', await w(`__w.text().includes('sample data') && [...document.querySelectorAll('[data-preview]')].map(b=>b.dataset.preview).join()==='Requestor,Admin,Developer'`));
    await shot('01-preview-views.png');
    await loads(() => w(`document.querySelector('[data-preview="Requestor"]').click(); true`));
    check('inspection banner "Inspection mode — sample data" with Exit and Reset controls', await w(`(()=>{const b=document.querySelector('#inspection-banner');return !!b && b.textContent.includes('Inspection mode — sample data') && !!document.querySelector('#exit-inspection') && !!document.querySelector('#reset-sample')})()`));
    check('the "Preview views" switch is shown and the real identity and role stay in the header', await w(`!document.querySelector('.demo-role-label').hidden && document.querySelector('.demo-role-label').textContent.includes('Preview views') && document.querySelector('.signed-in-as').textContent==='Rhea Requestor · Requestor'`));
    check('sample data is separate: sample tickets load, the normal record is not shown or changed', await w(`!!document.querySelector('[data-id="JRC-1042"]') && !document.querySelector('[data-id="JRC-7001"]') && localStorage.getItem(${JSON.stringify(NORMAL_KEY)})===${JSON.stringify(normal)} && !!localStorage.getItem(${JSON.stringify(SAMPLE_KEY)})`));
    await shot('02-inspection-requestor.png');

    // ---------- 1: Requestor submission and progress ----------
    flow = 1;
    await w(`__w.click('#new-ticket'); true`); await sleep(200);
    check('request form keeps all current fields, with the sample requestor identity (editable in inspection)', await w(`['title','name','department','date','category','description','criteria'].every(n=>!!document.querySelector('#request-form [name='+n+']')) && document.querySelector('[name=name]').value==='Adriane Venzon' && !document.querySelector('[name=name]').readOnly`));
    await w(`__w.set('[name=title]','Inspection request');__w.set('[name=date]','2026-12-15');__w.set('[name=description]','Need a sample feature.');__w.set('[name=criteria]','Sample checks pass.');__w.submit('#request-form');true`);
    check('submission creates JRC-1043 as Submitted with a confirmation', await w(`__w.toast().includes('JRC-1043') && __w.ticket('JRC-1043').status==='Submitted' && __w.ticket('JRC-1043').priority==='Medium'`), await w(`__w.toast()`));
    check('the Requestor list shows only the requestor\’s own tickets, including the new one', await w(`!!document.querySelector('[data-id="JRC-1043"]') && document.querySelectorAll('#records [data-id]').length===__w.data().tickets.filter(t=>t.name==='Adriane Venzon').length`));
    check('progress is tracked from tasks (JRC-1042 shows 50%)', await w(`document.querySelector('tr[data-id="JRC-1042"]').textContent.includes('50%')`));
    await w(`__w.open('JRC-1042'); true`); await sleep(200);
    check('ticket detail shows status, milestones, and the shared activity history', await w(`__w.text().includes('Project milestones') && __w.text().includes('Shared conversation') && __w.text().includes('In progress')`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 2: Admin review, clarification, rejection, priority, assignment ----------
    flow = 2;
    await w(`__w.view('Admin'); true`); await sleep(200);
    check('switching the preview to Admin shows all requestors\’ tickets ("Tickets received")', await w(`document.querySelector('#page-title').textContent==='Tickets received' && document.querySelectorAll('#records [data-id]').length===__w.data().tickets.length && document.querySelector('#inspection-detail').textContent.includes('Admin view')`));
    await w(`__w.open('JRC-1043');__w.click('[data-action="Under review"]');true`);
    check('Admin moves the ticket to review', await w(`__w.ticket('JRC-1043').status==='Under review'`));
    await w(`__w.click('[data-reason="Waiting for information"]');__w.set('#reason-form [name=reason]','Which report columns are needed?');__w.submit('#reason-form');true`);
    check('Admin requests clarification with a reason (Waiting for information)', await w(`__w.ticket('JRC-1043').status==='Waiting for information' && __w.ticket('JRC-1043').history.some(h=>h.text.includes('Which report columns'))`));
    await w(`__w.view('Requestor');__w.open('JRC-1043');__w.set('#comment-form [name=comment]','Columns: date, amount, region.');__w.submit('#comment-form');true`);
    await w(`__w.click('[data-action="Under review"]');true`);
    check('Requestor answers in a comment and returns it to admin review', await w(`__w.ticket('JRC-1043').status==='Under review' && __w.ticket('JRC-1043').history.some(h=>h.text.includes('Columns: date'))`));
    await w(`__w.view('Admin');__w.open('JRC-1043');__w.set('#assignee','Miguel Santos');__w.set('#priority','High');__w.click('#assign');true`);
    check('Admin sets priority High and assigns the developer', await w(`(()=>{const t=__w.ticket('JRC-1043');return t.status==='Assigned'&&t.dev==='Miguel Santos'&&t.priority==='High'})()`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));__w.view('Requestor');__w.click('#new-ticket');__w.set('[name=title]','Duplicate request');__w.set('[name=date]','2026-12-20');__w.set('[name=description]','Same as JRC-1043.');__w.submit('#request-form');true`);
    await w(`__w.view('Admin');__w.open('JRC-1044');__w.click('[data-reason="Rejected"]');__w.set('#reason-form [name=reason]','Duplicate of JRC-1043.');__w.submit('#reason-form');true`);
    check('Admin rejects a duplicate with a reason', await w(`__w.ticket('JRC-1044').status==='Rejected' && __w.ticket('JRC-1044').history.some(h=>h.text.includes('Duplicate of JRC-1043'))`));
    await w(`__w.set('#assignee','Miguel Santos');__w.click('#assign');true`);
    check('a rejected ticket cannot be assigned', await w(`__w.toast().includes('no longer active') && __w.ticket('JRC-1044').dev===''`), await w(`__w.toast()`));
    await shot('03-admin-review.png');
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 3: Developer meetings and confirmation ----------
    flow = 3;
    await w(`__w.view('Developer'); true`); await sleep(200);
    check('Developer view lists only assigned tickets', await w(`document.querySelectorAll('#records [data-id]').length===__w.data().tickets.filter(t=>t.dev==='Miguel Santos').length && !!document.querySelector('[data-id="JRC-1043"]')`));
    await w(`__w.open('JRC-1043');__w.click('#schedule');__w.set('#meeting-form [name=meeting]','2026-11-03T10:00');__w.set('#meeting-form [name=location]','JARC meeting room');__w.submit('#meeting-form');true`);
    check('Developer schedules the requirements meeting inside ticket details', await w(`__w.ticket('JRC-1043').status==='Meeting scheduled' && __w.ticket('JRC-1043').meetingConfirmed===false`));
    await w(`__w.view('Requestor');__w.open('JRC-1043');__w.click('#confirm-meeting');true`);
    check('Requestor confirms the meeting', await w(`__w.ticket('JRC-1043').meetingConfirmed===true && __w.text().includes('Confirmed')`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 4: Two-step project creation and date validation ----------
    flow = 4;
    await w(`__w.view('Developer');__w.open('JRC-1043');__w.click('#create-project');true`);
    check('step 1 of 2: named scope, requirements, criteria, and target date', await w(`document.querySelector('.tagline').textContent.includes('STEP 1 OF 2')`));
    await w(`__w.set('#project-scope [name=projectName]','Inspection project');__w.set('#project-scope [name=requirements]','Build the report.');__w.set('#project-scope [name=criteria]','Totals match.');__w.set('#project-scope [name=date]','2026-12-15');__w.submit('#project-scope');true`);
    check('step 2 of 2: dated tasks and timeline', await w(`document.querySelector('.tagline').textContent.includes('STEP 2 OF 2')`));
    const fillTask = (i, t, s, e) => `{let f=document.querySelectorAll('.plan-task')[${i}];__w.set('[name=title]','${t}',f);__w.set('[name=requirement]','Req ${t}',f);__w.set('[name=criteria]','Crit ${t}',f);__w.set('[name=start]','${s}',f);__w.set('[name=end]','${e}',f);}`;
    await w(`${fillTask(0, 'Build', '2026-11-10', '2026-11-05')};__w.set('[name=agreed]',true);__w.submit('#project-tasks');true`);
    check('a task ending before it starts is rejected', await w(`!__w.ticket('JRC-1043').project`), await w(`__w.toast()`));
    await w(`${fillTask(0, 'Build', '2026-11-10', '2026-12-20')};__w.submit('#project-tasks');true`);
    check('a task ending after the target date is rejected', await w(`!__w.ticket('JRC-1043').project && __w.toast().includes('target')`), await w(`__w.toast()`));
    await w(`${fillTask(0, 'Build', '2026-11-10', '2026-11-20')};__w.click('#another-task');${fillTask(1, 'Test', '2026-11-21', '2026-12-01')};__w.submit('#project-tasks');true`);
    check('a valid project is linked once to the ticket and opens the Gantt view', await w(`__w.ticket('JRC-1043').project==='PRJ-1043' && __w.ticket('JRC-1043').status==='Planning' && document.querySelectorAll('.gantt-bar').length===2`));
    await shot('04-gantt.png');

    // ---------- 5: Gantt editing, progress, and reload persistence ----------
    flow = 5;
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));__w.click('[data-view="Projects"]');__w.open('JRC-1043');__w.click('.gantt-bar[data-project-task="0"]');__w.set('#dated-task-form [name=done]',true);__w.submit('#dated-task-form');true`);
    check('completing a task on the Gantt updates progress to 50%', await w(`__w.ticket('JRC-1043').tasks[0].done===true && document.querySelector('tr[data-id="JRC-1043"]')?.textContent.includes('50%')`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));__w.open('JRC-1043');__w.click('.gantt-bar[data-project-task="1"]');__w.set('#dated-task-form [name=end]','2026-12-02');__w.submit('#dated-task-form');true`);
    check('editing a task date on the Gantt is saved', await w(`__w.ticket('JRC-1043').tasks[1].end==='2026-12-02'`));
    await reload();
    check('after reload: still in inspection, Developer preview kept, Gantt edits persisted', await w(`!!document.querySelector('#inspection-banner') && document.querySelector('#demo-role').value==='Developer' && __w.ticket('JRC-1043').tasks[0].done===true && __w.ticket('JRC-1043').tasks[1].end==='2026-12-02'`));
    await w(`__w.view('Requestor');__w.click('[data-view="Projects"]');__w.open('JRC-1043');true`);
    check('the Requestor sees the Gantt read-only (no add or edit controls)', await w(`!!document.querySelector('.gantt') && !document.querySelector('#timeline-add') && !document.querySelector('#edit-scope')`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 6: Testing, acceptance, corrections, release, closure ----------
    flow = 6;
    await w(`__w.view('Developer');__w.open('JRC-1043');__w.click('#testing');true`);
    check('acceptance cannot be requested while tasks are open', await w(`__w.ticket('JRC-1043').status==='Planning' && __w.toast().includes('Complete all')`), await w(`__w.toast()`));
    await w(`__w.click('[data-task="1"]');true`);
    await w(`__w.click('#testing');__w.set('#test-form [name=summary]','Tested against criteria.');__w.set('#test-form input[type=checkbox]',true);__w.submit('#test-form');true`);
    check('Developer submits testing results for acceptance', await w(`__w.ticket('JRC-1043').status==='Awaiting acceptance'`));
    await w(`__w.view('Requestor');__w.open('JRC-1043');__w.click('[data-reason="In progress"]');__w.set('#reason-form [name=reason]','Region totals are wrong.');__w.submit('#reason-form');true`);
    check('Requestor returns a correction; it stays on the original ticket and reopens the last task', await w(`(()=>{const t=__w.ticket('JRC-1043');return t.status==='In progress'&&t.tasks[t.tasks.length-1].done===false&&t.history.some(h=>h.text.includes('Region totals'))})()`));
    await w(`__w.view('Developer');__w.open('JRC-1043');__w.click('[data-task="1"]');true`);
    await w(`__w.click('#testing');__w.set('#test-form [name=summary]','Fixed and retested.');__w.set('#test-form input[type=checkbox]',true);__w.submit('#test-form');true`);
    await w(`__w.view('Requestor');__w.open('JRC-1043');__w.click('[data-action="Ready for release"]');true`);
    check('Requestor accepts the corrected delivery', await w(`__w.ticket('JRC-1043').status==='Ready for release'`));
    await w(`__w.view('Developer');__w.open('JRC-1043');__w.click('[data-action="Released"]');true`);
    check('Developer confirms release', await w(`__w.ticket('JRC-1043').status==='Released'`));
    await w(`__w.view('Admin');__w.open('JRC-1043');__w.click('[data-action="Closed"]');true`);
    check('Admin closes the ticket (acceptance → release → closure order kept)', await w(`__w.ticket('JRC-1043').status==='Closed'`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 7: Linked change lifecycle ----------
    flow = 7;
    await w(`__w.view('Requestor');__w.open('JRC-1042');__w.click('#new-change');__w.set('#change-form [name=title]','Add region filter');__w.set('#change-form [name=reason]','Managers need it.');__w.set('#change-form [name=criteria]','Filter by region works.');__w.submit('#change-form');true`);
    const crId = await w(`__w.data().changes.find(c=>c.title==='Add region filter')?.id`);
    check('a scope change is requested from inside the original ticket', !!crId && await w(`__w.change('${crId}').status==='Submitted' && __w.change('${crId}').ticket==='JRC-1042'`), crId);
    const openChange = r => `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));__w.view('${r}');__w.open('JRC-1042');__w.click('[data-linked-change="${crId}"]');`;
    await w(`${openChange('Admin')}__w.click('[data-cstatus="Assessment"]');true`);
    check('Admin sends it for developer assessment', await w(`__w.change('${crId}').status==='Assessment'`));
    await w(`${openChange('Developer')}__w.set('#impact-form [name=impact]','Adds a filter to the report.');__w.set('#impact-form [name=effort]','2 working days');__w.set('#impact-form [name=date]','2026-11-15');__w.submit('#impact-form');true`);
    check('Developer records the impact assessment', await w(`__w.change('${crId}').status==='Awaiting approval' && __w.change('${crId}').effort==='2 working days'`));
    await w(`${openChange('Requestor')}__w.click('#agree-change');true`);
    check('Requestor agrees to the revised scope and estimate', await w(`__w.change('${crId}').requestorAgreed===true`));
    await w(`${openChange('Admin')}__w.click('#approve-change');true`);
    check('Admin approves; an unscheduled project task is added for the change', await w(`__w.change('${crId}').status==='Approved' && __w.ticket('JRC-1042').tasks.some(t=>t.title.startsWith('${crId}:') && !t.done && !t.start)`));
    await w(`${openChange('Developer')}__w.click('[data-cstatus="In progress"]');true`);
    await w(`__w.set('#change-test [name=results]','Filter tested.');__w.set('#change-test input[type=checkbox]',true);__w.submit('#change-test');true`);
    check('Developer implements and submits change testing (with the required testing confirmation)', await w(`__w.change('${crId}').status==='Awaiting acceptance'`));
    await w(`${openChange('Requestor')}__w.click('[data-cstatus="Accepted"]');true`);
    await w(`${openChange('Developer')}__w.click('[data-cstatus="Released"]');true`);
    check('Requestor accepts and Developer releases; the change task is completed', await w(`__w.change('${crId}').status==='Released' && __w.ticket('JRC-1042').tasks.find(t=>t.title.startsWith('${crId}:')).done===true`));
    await w(`${openChange('Admin')}__w.click('[data-cstatus="Closed"]');true`);
    check('Admin closes the change; approver and history are recorded', await w(`__w.change('${crId}').status==='Closed' && __w.change('${crId}').approvedBy==='Admin' && __w.change('${crId}').history.length>=7`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));__w.view('Admin');__w.open('JRC-1042');__w.click('[data-linked-change="CR-201"]');__w.click('[data-cstatus="Assessment"]');true`);
    await w(`__w.click('[data-decision="Rejected"]');__w.set('#decision-form [name=reason]','Out of scope for this quarter.');__w.submit('#decision-form');true`);
    check('Admin can reject a change with a recorded reason', await w(`__w.change('CR-201').status==='Rejected' && __w.change('CR-201').history.some(h=>h.text.includes('Out of scope'))`));
    await shot('05-linked-change.png');
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

    // ---------- 8: Search, filters, notifications, dialog controls ----------
    flow = 8;
    await w(`__w.view('Admin');__w.set('.search','inventory');true`);
    check('search narrows the list', await w(`[...document.querySelectorAll('#records [data-id]')].map(r=>r.dataset.id).join()==='JRC-1040'`), await w(`[...document.querySelectorAll('#records [data-id]')].map(r=>r.dataset.id).join()`));
    await w(`__w.set('.search','');__w.set('#status-filter','Closed');true`);
    check('the status filter shows only matching tickets', await w(`(()=>{const ids=[...document.querySelectorAll('#records [data-id]')].map(r=>r.dataset.id);return ids.length>=2&&ids.every(id=>__w.ticket(id).status==='Closed')})()`));
    await w(`__w.set('#status-filter','');__w.click('#notifications');true`);
    check('notifications list workflow activity', await w(`__w.overlay() && __w.text().includes('Notifications') && __w.text().includes('JRC-1043')`));
    await w(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));true`);
    check('Escape closes a dialog', await w(`!__w.overlay()`));
    await w(`__w.open('JRC-1041');__w.click('.close');true`);
    check('the close button closes a dialog', await w(`!__w.overlay()`));
    await w(`__w.open('JRC-1041');document.querySelector('#overlay').click();true`);
    check('clicking outside closes a dialog', await w(`!__w.overlay()`));
    check('the sidebar has only Tickets and Projects', await w(`JSON.stringify([...document.querySelectorAll('#nav button')].map(b=>b.textContent.replace(/[0-9▤▦]/g,'').trim()))==='["Tickets received","Projects"]'`));

    // ---------- 9 (part 2): privilege boundary, recovery, reset, exit, logout ----------
    flow = 9;
    check('previewing Admin never grants real user management (no Users button; admin API refuses)', await w(`!document.querySelector('#manage-users') && fetch('/api/v1/users').then(r=>r.status===403)`));
    check('the server still reports the real role while previewing Admin', await w(`fetch('/api/v1/me').then(r=>r.json()).then(j=>j.user.role==='Requestor')`));
    check('normal browser records were never touched by the workflows', await w(`localStorage.getItem(${JSON.stringify(NORMAL_KEY)})===${JSON.stringify(normal)} && !Object.keys(localStorage).some(k=>k.startsWith('jarc-helpdesk-v1-backup-'))`));
    await w(`localStorage.setItem(${JSON.stringify(SAMPLE_KEY)},'{"tickets":[');true`);
    await reload();
    check('corrupted sample data opens the recovery screen for the sample copy only, with its own backup', await w(`!!document.querySelector('#recovery') && !!document.querySelector('#inspection-banner') && Object.keys(localStorage).some(k=>k.startsWith('jarc-inspection:jarc-helpdesk-v1-backup-')) && localStorage.getItem(${JSON.stringify(NORMAL_KEY)})===${JSON.stringify(normal)}`));
    await shot('06-sample-recovery.png');
    await loads(() => w(`__w.click('#reset-sample'); true`));
    check('Reset sample data (confirmed) reloads fresh sample data', dialogs.some(d => d.includes('Reset all inspection sample data')) && await w(`!document.querySelector('#recovery') && !!__w.ticket('JRC-1042') && !__w.ticket('JRC-1043') && !Object.keys(localStorage).some(k=>k.startsWith('jarc-inspection:jarc-helpdesk-v1-backup-'))`));
    await loads(() => w(`__w.click('#exit-inspection'); true`));
    check('Exit inspection returns to normal records and the real role, with no banner', await w(`!document.querySelector('#inspection-banner') && !!document.querySelector('[data-id="JRC-7001"]') && !document.querySelector('[data-id="JRC-1042"]') && document.querySelector('.demo-role-label').hidden && document.querySelector('#page-title').textContent==='My ticket'`));
    await loads(() => w(`__w.click('#sign-out'); true`));
    check('logout ends the session (signed-out page; the app is closed again)', await w(`location.pathname==='/auth/signed-out'`) && (await (async () => { await nav(`${origin}/`); return w(`location.pathname==='/auth/signin'`); })()));
    entra.signInNext(account(2, 'Ada Admin', 'ada@jarc.example'));
    await loads(() => w(`__w.click('a.primary'); true`));
    check('a real Admin has Users outside inspection, but not while inspecting', await w(`!!document.querySelector('#manage-users')`) && await (async () => { await w(`localStorage.setItem('jarc-inspection-view','Developer'); true`); await reload(); return w(`!!document.querySelector('#inspection-banner') && !document.querySelector('#manage-users') && document.querySelector('.signed-in-as').textContent==='Ada Admin · Admin'`); })());
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    if (!interrupted) check('walkthrough crashed', false, err.stack);
  }
} catch (err) {
  if (!interrupted) { console.error(`Inspection walkthrough could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);

console.log('\nFlow results (browser-only sample data unless noted):');
for (const [n, title] of Object.entries(FLOWS)) {
  const mine = results.filter(r => r.flow === Number(n));
  const status = !mine.length ? 'NOT RUN' : mine.every(r => r.ok) ? 'PASSED' : 'FAILED';
  console.log(`  ${n}. ${title}: ${status} (${mine.filter(r => r.ok).length}/${mine.length})`);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} inspection walkthrough checks passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);
