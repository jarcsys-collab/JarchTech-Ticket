// Optional real-browser walkthrough of the shared beta simulation workspace (BETA_SIMULATION=enabled).
// Uses a MOCK Microsoft Entra provider and a temporary MongoDB (never Microsoft, Atlas, or .env), one headless
// Chrome or Edge with a temporary profile, and two separate browser contexts signed in as two different members.
// Covers a Project (mandatory meeting, locked agreement, timeline, approved scope change producing agreement v2,
// evidence with a link and a file, a returned correction, dual confirmation, handover, closure), a Ticket with Admin
// self-assignment, the Admin overview drill-through, comments,
// persistence after refresh and sign-in, cross-context sharing, conflicts, failed saves, session loss,
// unauthorized requests, the load-error state, reset, and isolation from normal browser records.
// Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled. Not run by npm test or CI.
//
//   npm run walkthrough:beta
//   BETA_SCREENSHOTS=tmp/beta npm run walkthrough:beta
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
  const signIn = async (P, n, name) => { await P.nav(`${origin}/auth/signin`); entra.signInNext(account(n, name)); await P.loads(() => P.w(`__w.click('a.primary')`)); await chooseBeta(P); };
  // My workspace is the default after sign-in; these checks use the beta simulation, chosen in the Workspace switch.
  const chooseBeta = async P => { await P.w(`localStorage.getItem('jarc-workspace')==='beta'||(localStorage.setItem('jarc-workspace','beta'),location.reload(),true)`); await sleep(600); await P.settle(); };

  try {
    // ---------- Shared workspace, labels, isolation from normal records ----------
    section = 'workspace';
    await P1.nav(`${origin}/auth/signin`);
    const normal = JSON.stringify({ tickets: [{ id: 'JRC-7001', title: 'Normal browser record', name: 'Member One', department: 'Sales', category: 'Enhancement', date: '2026-12-01', priority: 'Low', status: 'Submitted', dev: '', description: 'Untouched.', criteria: 'Untouched.', tasks: [], history: [] }], changes: [], notices: [] });
    await P1.w(`localStorage.setItem('jarc-helpdesk-v1', ${JSON.stringify(normal)}); true`);
    await signIn(P1, 1, 'Member One');
    check('signed-in member lands in the shared beta workspace with clear labels', await P1.w(`document.querySelector('#beta-banner').textContent.includes('Beta simulation — test data') && document.querySelector('.demo-role-label').textContent.includes('Simulation view') && !document.querySelector('.demo-role-label').hidden && document.querySelector('.sidebar-bottom').textContent.includes('Shared beta workspace') && document.querySelector('.save').textContent.includes('Saved to shared beta')`));
    check('records come from the server: shared sample requests shown, not the normal browser record', await P1.w(`!!document.querySelector('[data-id="JRC-1042"]') && !document.querySelector('[data-id="JRC-7001"]')`));
    check('the banner names the same view as the Simulation view selector', await P1.w(`document.querySelector('#demo-role').value==='Requestor' && document.querySelector('#beta-detail').textContent.includes('simulating the Requestor view')`), await P1.w(`document.querySelector('#beta-detail').textContent`));
    check('the real role stays Requestor while views are simulated', await P1.w(`document.querySelector('.signed-in-as').textContent==='Member One · Requestor' && fetch('/api/v1/me').then(r=>r.json()).then(j=>j.user.role==='Requestor')`));
    await P1.shot('01-beta-requestor.png');

    // ---------- Project: meeting, locked agreement, timeline, scope change, evidence, correction, dual confirmation ----------
    section = 'project';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-proof-'));
    fs.writeFileSync(path.join(dir, 'wt-proof.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024, 5)]));
    const setFiles = async (P, selector, names) => {
      const { root } = await P.cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await P.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await P.cdp.send('DOM.setFileInputFiles', { nodeId, files: names.map(n => path.join(dir, n)) });
    };
    const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
    const as = async (P, r, id) => { await P.do(`__w.esc();__w.view('${r}')`); if (id) await P.do(`__w.open('${id}')`); };
    await P1.w(`__w.click('#new-ticket'); true`); await sleep(200);
    check('request form: requester name comes from the signed-in profile (read-only), with a required request type', await P1.w(`__w.el('[name=name]').value==='Member One' && __w.el('[name=name]').readOnly && __w.el('[name=type]').required && [...__w.el('[name=type]').options].map(o=>o.value).join()===',Ticket,Project'`));
    await P1.do(`__w.set('[name=title]','Beta shared request');__w.set('[name=date]','2026-12-15');__w.set('[name=description]','Need shared data.');__w.set('[name=criteria]','Visible to everyone.');__w.submit('#request-form')`);
    check('a request without a type is not submitted', await P1.w(`__w.ticket('JRC-1043').then(t=>!t)`));
    await P1.do(`__w.set('[name=type]','Project');__w.submit('#request-form')`);
    check('Requestor submits a Project; stored on the server with actor, view, type, and its separate category', await P1.w(`__w.ticket('JRC-1043').then(t=>!!t&&t.status==='Submitted'&&t.type==='Project'&&t.category==='New feature'&&t.requester.name==='Member One'&&t.history[0].actor==='Member One'&&t.history[0].view==='Requestor')`) && await P1.w(`__w.toast().includes('JRC-1043 created')`));
    await as(P1, 'Admin', 'JRC-1043');
    await P1.do(`__w.click('[data-action="Under review"]')`);
    await P1.do(`__w.click('[data-reason="Waiting for information"]');__w.set('#reason-form [name=reason]','Which columns?');__w.submit('#reason-form')`);
    await as(P1, 'Requestor', 'JRC-1043');
    await P1.do(`__w.set('#comment-form [name=comment]','Date, amount, region.');__w.submit('#comment-form')`);
    await P1.do(`__w.click('[data-action="Under review"]')`);
    check('Admin requests information; Requestor answers and returns it for review', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Under review'&&t.history.some(h=>h.text==='Requestor: Date, amount, region.'))`));
    await as(P1, 'Admin', 'JRC-1043');
    check('the Admin assigns to a sample developer or to themselves', await P1.w(`[...document.querySelectorAll('#assignee option')].map(o=>o.textContent).includes('Alex Admin (Admin · yourself)')`));
    await P1.do(`__w.set('#assignee','Miguel Santos');__w.set('#priority','High');__w.click('#assign')`);
    check('Admin sets priority and assigns sample developer Miguel Santos', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Assigned'&&t.dev==='Miguel Santos'&&t.priority==='High')`));
    await as(P1, 'Developer', 'JRC-1043');
    check('a Project offers the mandatory requirements meeting, not a project yet', await P1.w(`__w.el('#schedule').textContent==='Schedule requirements meeting' && !document.querySelector('#create-project') && !document.querySelector('[data-action="In progress"]')`));
    await P1.do(`__w.click('#schedule');__w.set('#meeting-form [name=meeting]','2026-11-03T10:00');__w.set('#meeting-form [name=location]','JARC room');__w.submit('#meeting-form')`);
    check('no agreement can be recorded before the Requestor confirms the meeting', await P1.w(`!document.querySelector('#record-agreement') && __w.text().includes('Waiting for the Requestor to confirm the meeting')`));
    await as(P1, 'Requestor', 'JRC-1043');
    await P1.do(`__w.click('#confirm-meeting')`);
    await as(P1, 'Developer', 'JRC-1043');
    await P1.w(`__w.click('#record-agreement');true`); await sleep(150);
    await P1.do(`__w.set('#agreement-form [name=notes]','Met in the JARC room.');__w.set('#agreement-form [name=requirements]','Monthly report with region filter.');__w.set('#agreement-form [name=criteria]','Totals match source data.');__w.submit('#agreement-form')`);
    await P1.do(`__w.click('#confirm-agreement')`);
    check('the worker records the agreement and confirms it; it stays unlocked until the Requestor confirms', await P1.w(`__w.ticket('JRC-1043').then(t=>!t.agreements&&t.agreementDraft.worker.name==='Miguel Santos'&&!t.agreementDraft.requestor)`) && await P1.w(`__w.text().includes('Awaiting confirmation') && __w.text().includes('Pending')`));
    await as(P1, 'Requestor', 'JRC-1043');
    await P1.do(`__w.click('#confirm-agreement')`);
    check('both confirmations lock agreement v1, with who confirmed shown', await P1.w(`__w.ticket('JRC-1043').then(t=>t.agreements.length===1&&t.agreements[0].requestor.name==='Member One')`) && await P1.w(`__w.text().includes('Agreement v1') && __w.text().includes('Locked') && __w.text().includes('✓ Miguel Santos') && __w.text().includes('✓ Member One')`));
    await P1.shot('02-beta-agreement.png');
    await as(P1, 'Developer', 'JRC-1043');
    check('after locking, the worker can no longer edit the agreement and creates the timeline from it', await P1.w(`!document.querySelector('#record-agreement') && !!document.querySelector('#create-project')`));
    await P1.w(`__w.click('#create-project');true`); await sleep(150);
    check('the timeline form shows the locked requirements read-only', await P1.w(`__w.text().includes('Agreed requirements (locked)') && !document.querySelector('#project-scope [name=requirements]')`));
    await P1.w(`__w.set('#project-scope [name=projectName]','Shared project');__w.set('#project-scope [name=date]','2026-12-15');__w.submit('#project-scope');true`);
    const fillTask = (i, t, s, e) => `{let f=document.querySelectorAll('.plan-task')[${i}];__w.set('[name=title]','${t}',f);__w.set('[name=requirement]','Req ${t}',f);__w.set('[name=criteria]','Crit ${t}',f);__w.set('[name=start]','${s}',f);__w.set('[name=end]','${e}',f);}`;
    await P1.w(`${fillTask(0, 'Build', '2026-11-10', '2026-11-05')};__w.set('[name=agreed]',true);__w.submit('#project-tasks');true`);
    check('invalid task dates are rejected before saving', await P1.w(`__w.ticket('JRC-1043').then(t=>!t.project)`) && await P1.w(`__w.toast().includes('end date')`));
    await P1.do(`${fillTask(0, 'Build', '2026-11-10', '2026-11-20')};__w.click('#another-task');${fillTask(1, 'Test', '2026-11-21', '2026-12-01')};__w.submit('#project-tasks')`);
    check('the worker creates the timeline with dated tasks and a delivery target; Gantt opens without scope editing', await P1.w(`__w.ticket('JRC-1043').then(t=>t.project==='PRJ-1043'&&t.tasks.length===2&&t.dueDate==='2026-12-15')`) && await P1.w(`document.querySelectorAll('.gantt-bar').length===2 && !document.querySelector('#edit-scope') && __w.text().includes('v1 · locked')`));
    await P1.shot('03-beta-gantt.png');
    await P1.do(`__w.click('.gantt-bar[data-project-task="0"]');__w.set('#dated-task-form [name=done]',true);__w.submit('#dated-task-form')`);
    await P1.do(`__w.click('.gantt-bar[data-project-task="1"]');__w.set('#dated-task-form [name=end]','2026-12-02');__w.submit('#dated-task-form')`);
    check('task progress and dates update through the Gantt view, and the date change is audited', await P1.w(`__w.ticket('JRC-1043').then(t=>t.tasks[0].done===true&&t.tasks[1].end==='2026-12-02'&&t.history.some(h=>h.text.includes('Schedule changed from 2026-11-21 → 2026-12-01 to 2026-11-21 → 2026-12-02')))`));
    await P1.do(`__w.esc();__w.open('JRC-1043');__w.click('[data-action="In progress"]')`);
    check('development starts after the agreement and timeline', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='In progress')`));

    section = 'scope change';
    await as(P1, 'Requestor', 'JRC-1043');
    await P1.do(`__w.click('#new-change');__w.set('#change-form [name=title]','Add PDF export');__w.set('#change-form [name=reason]','Managers need it.');__w.set('#change-form [name=criteria]','PDF matches the screen.');__w.submit('#change-form')`);
    check('Requestor requests a scope change from inside the request', await P1.w(`__w.change('CR-202').then(c=>!!c&&c.status==='Submitted'&&c.ticket==='JRC-1043')`));
    const onChange = async (r, js) => { await as(P1, r, 'JRC-1043'); await P1.do(`__w.click('[data-linked-change="CR-202"]');${js}`); };
    await onChange('Admin', `__w.click('[data-cstatus="Assessment"]')`);
    await onChange('Developer', `__w.set('#impact-form [name=impact]','Adds an export.');__w.set('#impact-form [name=effort]','2 days');__w.set('#impact-form [name=date]','2026-12-20');__w.submit('#impact-form')`);
    await onChange('Requestor', `__w.click('#agree-change')`);
    await onChange('Admin', `__w.click('#approve-change')`);
    check('the approved change creates agreement v2, keeps v1, and moves the delivery target with an audit note', await P1.w(`Promise.all([__w.change('CR-202'),__w.ticket('JRC-1043')]).then(([c,t])=>c.status==='Approved'&&t.agreements.length===2&&t.agreements[0].requirements==='Monthly report with region filter.'&&t.agreements[1].source==='CR-202'&&t.dueDate==='2026-12-20'&&t.history.some(h=>h.text.includes('Delivery target changed from 2026-12-15 to 2026-12-20'))&&t.tasks.some(x=>x.title.startsWith('CR-202:')))`));
    await P1.do(`__w.click('#linked-ticket')`);
    check('details show agreement v2 with the earlier version kept', await P1.w(`__w.text().includes('Agreement v2') && __w.text().includes('Earlier versions (1)')`));

    section = 'completion';
    await as(P1, 'Developer', 'JRC-1043');
    await P1.do(`__w.click('#worker-complete')`);
    check('the worker cannot mark work done while tasks are open', await P1.w(`__w.toast().includes('Complete all')`));
    await P1.do(`__w.click('[data-task="1"]')`); await P1.do(`__w.click('[data-task="2"]')`);
    await P1.do(`__w.click('#worker-complete')`);
    check('nor without evidence', await P1.w(`__w.toast().includes('evidence')`));
    await P1.do(`__w.set('#evidence-form [name=url0]','javascript:alert(1)');__w.submit('#evidence-form')`);
    check('unsafe links are refused', await P1.w(`__w.toast().includes('http')`) && await P1.w(`__w.ticket('JRC-1043').then(t=>!t.evidence.length)`));
    await setFiles(P1, '#evidence-form input[type=file]', ['wt-proof.png']);
    await waitFor(P1, `document.querySelectorAll('#evidence-form .upload.done').length===1`);
    await P1.do(`__w.set('#evidence-form [name=label0]','Test run 42');__w.set('#evidence-form [name=url0]','https://reports.example.com/run/42');__w.submit('#evidence-form')`);
    check('the worker adds a deliverable link and an uploaded file as evidence', await P1.w(`__w.ticket('JRC-1043').then(t=>t.evidence.map(x=>x.kind).join()==='link,file')`) && await P1.w(`!!document.querySelector('.evidence-list a[href="https://reports.example.com/run/42"][rel~="noopener"][target="_blank"]') && !!document.querySelector('.evidence-list a[download="wt-proof.png"]')`));
    await P1.do(`__w.click('#worker-complete');__w.set('#complete-form [name=summary]','Tested against the criteria.');__w.set('#complete-form input[type=checkbox]',true);__w.submit('#complete-form')`);
    check('the worker marks the work done; the Requestor confirmation is still pending', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Awaiting acceptance'&&t.completion.worker.name==='Miguel Santos'&&!t.completion.requestor)`));
    await as(P1, 'Admin', 'JRC-1043');
    check('the Admin sees who confirmed and what is pending, and has no Close button', await P1.w(`!document.querySelector('#workflow-panels [data-action="Closed"]') && __w.text().includes('✓ Miguel Santos') && __w.text().includes('Waiting for the Requestor to review the evidence and confirm')`));
    await as(P1, 'Requestor', 'JRC-1043');
    check('the Requestor sees the evidence and the delivery summary', await P1.w(`__w.text().includes('Test run 42') && __w.text().includes('wt-proof.png') && __w.text().includes('Tested against the criteria.')`));
    await P1.do(`__w.click('#workflow-panels [data-reason="In progress"]');__w.set('#reason-form [name=reason]','Totals are wrong.');__w.submit('#reason-form')`);
    check('returning for correction clears the worker confirmation and keeps the reason', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='In progress'&&!t.completion.worker&&t.corrections[0].reason==='Totals are wrong.'&&t.completion.log.length===1)`));
    await as(P1, 'Developer', 'JRC-1043');
    check('the worker sees the correction history', await P1.w(`__w.text().includes('Corrections (1)') && __w.text().includes('Totals are wrong.')`));
    await P1.do(`__w.click('[data-task="2"]')`);
    await P1.do(`__w.click('#worker-complete');__w.set('#complete-form [name=summary]','Fixed the totals.');__w.set('#complete-form input[type=checkbox]',true);__w.submit('#complete-form')`);
    await as(P1, 'Requestor', 'JRC-1043');
    await P1.do(`__w.click('#requestor-confirm')`);
    check('the Requestor confirms independently', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Ready for release'&&t.completion.requestor.name==='Member One'&&t.completion.worker.name==='Miguel Santos')`));
    await as(P1, 'Admin', 'JRC-1043');
    check('a Project still needs its release or handover before closure', await P1.w(`!document.querySelector('[data-action="Closed"]') && __w.text().includes('Waiting for the worker to confirm the release or handover')`));
    await as(P1, 'Developer', 'JRC-1043');
    await P1.do(`__w.click('[data-action="Released"]')`);
    await as(P1, 'Admin', 'JRC-1043');
    await P1.do(`__w.click('[data-action="Closed"]')`);
    check('after both confirmations and the handover, the Admin closes it', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Closed')`));
    check('activity history shows the signed-in actor and the simulated view', await P1.w(`__w.text().includes('Member One (Admin view)') && __w.text().includes('Member One (Developer view)')`));
    await P1.shot('04-beta-closed.png');

    // ---------- Ticket with Admin self-assignment ----------
    section = 'ticket and self-assignment';
    await as(P1, 'Requestor');
    await P1.w(`__w.click('#new-ticket'); true`); await sleep(200);
    await P1.do(`__w.set('[name=title]','Printer reset');__w.set('[name=type]','Ticket');__w.set('[name=category]','Bug / issue');__w.set('[name=date]','2026-12-01');__w.set('[name=description]','Printer jams.');__w.submit('#request-form')`);
    await as(P1, 'Admin', 'JRC-1044');
    await P1.do(`__w.set('#assignee','Alex Admin');__w.set('#priority','Low');__w.click('#assign')`);
    check('the Admin assigns the Ticket to themselves', await P1.w(`__w.ticket('JRC-1044').then(t=>t.dev==='Alex Admin'&&t.history.some(h=>h.text.includes('assigned it to themselves')))`));
    check('a Ticket needs no meeting or project: the worker can start at once', await P1.w(`!!document.querySelector('[data-action="In progress"]') && __w.el('#schedule').textContent.includes('optional') && !document.querySelector('#create-project')`));
    await P1.do(`__w.click('[data-action="In progress"]')`);
    await P1.do(`__w.set('#evidence-form [name=url0]','http://intranet.example/printer-log');__w.submit('#evidence-form')`);
    await P1.do(`__w.click('#worker-complete');__w.set('#complete-form [name=summary]','Printer reset and tested.');__w.set('#complete-form input[type=checkbox]',true);__w.submit('#complete-form')`);
    check('the self-assigned Admin marks the work done but cannot confirm for the Requestor', await P1.w(`__w.ticket('JRC-1044').then(t=>t.completion.worker.name==='Alex Admin')`) && await P1.w(`!document.querySelector('#requestor-confirm') && !document.querySelector('#workflow-panels [data-action="Closed"]')`));
    await as(P1, 'Developer');
    check('the Developer view does not list the Admin’s own assignment', await P1.w(`!document.querySelector('[data-id="JRC-1044"]') && !!document.querySelector('[data-id="JRC-1042"]')`));
    await as(P1, 'Requestor', 'JRC-1044');
    await P1.do(`__w.click('#requestor-confirm')`);
    await as(P1, 'Admin', 'JRC-1044');
    await P1.do(`__w.click('[data-action="Closed"]')`);
    check('after the independent Requestor confirmation the Admin closes the Ticket (no release step)', await P1.w(`__w.ticket('JRC-1044').then(t=>t.status==='Closed'&&t.completion.requestor.name==='Member One')`));

    section = 'admin overview';
    await P1.do(`__w.esc()`);
    check('the Admin overview counts Tickets and Projects by stage', await P1.w(`!!document.querySelector('.overview') && document.querySelector('[data-overview-stage="closed"][data-overview-type="Ticket"]').textContent==='1' && document.querySelector('[data-overview-stage="closed"][data-overview-type="Project"]').textContent==='2'`), await P1.w(`document.querySelector('.overview')?.textContent`));
    await P1.do(`__w.click('[data-overview-stage="closed"][data-overview-type="Ticket"]')`);
    check('choosing a count drills through to those records, with type and confirmations in the list', await P1.w(`!!document.querySelector('[data-id="JRC-1044"]') && !document.querySelector('[data-id="JRC-1043"]') && document.querySelector('[data-id="JRC-1044"]').textContent.includes('✓ Worker')`));
    await P1.shot('05-admin-overview.png');
    await P1.do(`__w.click('#clear-filters')`);
    await as(P1, 'Requestor');
    check('the overview is for Admins only', await P1.w(`!document.querySelector('.overview') && !!document.querySelector('.stats')`));
    await as(P1, 'Admin');

    // ---------- Persistence ----------
    section = 'persistence';
    await P1.loads(() => P1.cdp.send('Page.reload', {})); await P1.settle();
    check('after refresh: shared records reload from the server and the simulation view is remembered', await P1.w(`document.querySelector('#demo-role').value==='Admin' && !!document.querySelector('[data-id="JRC-1043"]')`) && await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Closed')`));
    await P1.loads(() => P1.w(`__w.click('#sign-out')`));
    await signIn(P1, 1, 'Member One');
    check('after signing out and in again: records are still there', await P1.w(`__w.ticket('JRC-1043').then(t=>t.status==='Closed')`) && await P1.w(`__w.change('CR-202').then(c=>c.status==='Approved')`));

    // ---------- Two browser contexts ----------
    section = 'two contexts';
    await signIn(P2, 2, 'Member Two');
    await P2.do(`__w.view('Admin')`);
    check('a second member in a separate browser context sees the same records', await P2.w(`!!document.querySelector('[data-id="JRC-1043"]')`) && await P2.w(`__w.ticket('JRC-1043').then(t=>t.status==='Closed'&&t.requester.name==='Member One')`));
    await P2.do(`__w.open('JRC-1042');__w.set('#comment-form [name=comment]','Seen from the second context.');__w.submit('#comment-form')`);
    await P1.do(`__w.view('Developer')`); await P1.do(`__w.view('Admin')`);
    await P1.do(`__w.open('JRC-1042')`);
    check('the first member sees the second member\u2019s comment after switching views (refresh)', await P1.w(`__w.text().includes('Seen from the second context.') && __w.text().includes('Member Two (Admin view)')`));
    await P2.shot('04-second-context.png');

    // ---------- Conflicting update ----------
    section = 'conflict';
    await P1.do(`__w.esc();__w.open('JRC-1041')`);
    await P2.do(`__w.esc();__w.open('JRC-1041');__w.set('#comment-form [name=comment]','Second context saved first.');__w.submit('#comment-form')`);
    await P1.do(`__w.set('#comment-form [name=comment]','My stale comment');__w.submit('#comment-form')`);
    check('a stale save is refused with a clear message, and the typed text is kept', await P1.w(`__w.toast().includes('changed in another session') && __w.el('#comment-form [name=comment]').value==='My stale comment'`), await P1.w(`__w.toast()`));
    await P1.do(`__w.esc();__w.open('JRC-1041');__w.set('#comment-form [name=comment]','My stale comment');__w.submit('#comment-form')`);
    check('retrying on the latest version saves without losing the other member\u2019s comment', await P1.w(`__w.ticket('JRC-1041').then(t=>t.history.some(h=>h.text.endsWith('Second context saved first.'))&&t.history.some(h=>h.text.endsWith('My stale comment')))`));

    // ---------- Failed saves ----------
    section = 'failed saves';
    await P1.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/beta/tickets/*/actions*' }] });
    P1.cdp.on('Fetch.requestPaused', p => P1.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }));
    await P1.do(`__w.esc();__w.open('JRC-1040');__w.set('#comment-form [name=comment]','Typed while offline');__w.submit('#comment-form')`);
    check('a failed save is reported honestly, shown as Not saved, and the text is kept', await P1.w(`__w.toast().includes('Could not reach the shared beta workspace') && __w.saveState()==='error' && __w.el('#comment-form [name=comment]').value==='Typed while offline'`), await P1.w(`__w.toast()`));
    check('nothing was written to browser storage as a fallback', await P1.w(`localStorage.getItem('jarc-helpdesk-v1')===${JSON.stringify(normal)} && !Object.keys(localStorage).some(k=>k.startsWith('jarc-helpdesk-v1-backup-'))`));
    await P1.cdp.send('Fetch.disable'); P1.cdp.off('Fetch.requestPaused');
    await P1.do(`__w.submit('#comment-form')`);
    check('retrying after the connection returns saves the same text', await P1.w(`__w.ticket('JRC-1040').then(t=>t.history.some(h=>h.text==='Admin: Typed while offline'))`) && await P1.w(`__w.saveState()==='saved'`));
    await P1.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/beta/workspace*' }] });
    P1.cdp.on('Fetch.requestPaused', p => P1.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }));
    await P1.loads(() => P1.cdp.send('Page.reload', {})); await sleep(500);
    check('if the shared records cannot load, an error with Try again is shown (no local fallback)', await P1.w(`!!document.querySelector('#beta-status .banner') && !!document.querySelector('#beta-retry') && !document.querySelector('[data-id="JRC-7001"]')`));
    await P1.shot('05-load-error.png');
    await P1.cdp.send('Fetch.disable'); P1.cdp.off('Fetch.requestPaused');
    await P1.do(`__w.click('#beta-retry')`);
    check('Try again loads the shared records', await P1.w(`!!document.querySelector('[data-id="JRC-1043"]')`));

    // ---------- Unauthorized requests ----------
    section = 'authorization';
    check('a view-restricted action is refused by the server (Requestor view cannot assign)', await P1.w(`__w.ticket('JRC-1040').then(t=>fetch('/api/v1/beta/tickets/JRC-1040/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:'Requestor',version:t.version,action:'assign',input:{dev:'Miguel Santos',priority:'High'}})}).then(r=>r.status===403))`));
    check('simulated Admin view never reaches real user management', await P1.w(`fetch('/api/v1/users').then(r=>r.status===403) && !document.querySelector('#manage-users')`));
    await bcdp.send('Storage.clearCookies', { browserContextId });
    await P2.do(`__w.esc();__w.open('JRC-1039');__w.set('#comment-form [name=comment]','After my session ended');__w.submit('#comment-form')`);
    check('after the session ends, saving asks to sign in again and keeps the text', await P2.w(`__w.toast().includes('session has ended') && __w.el('#comment-form [name=comment]').value==='After my session ended'`), await P2.w(`__w.toast()`));
    check('the unauthenticated save did not change the record', await P1.w(`__w.ticket('JRC-1039').then(t=>!t.history.some(h=>h.text.includes('After my session ended')))`));

    // ---------- Local inspection stays separate ----------
    section = 'inspection';
    await P1.w(`__w.esc();__w.click('#preview-views');true`); await sleep(200);
    check('local sample preview is clearly separate from the shared beta workspace', await P1.w(`__w.text().includes('local sample data') && __w.text().includes('shared beta workspace')`));
    await P1.w(`__w.esc();true`);

    // ---------- Reset ----------
    section = 'reset';
    await P1.w(`__w.click('#reset-beta');true`); await sleep(200);
    await P1.do(`__w.set('#beta-reset-form [name=confirm]','reset');__w.submit('#beta-reset-form')`);
    check('reset requires typing RESET exactly', await P1.w(`__w.toast().includes('Type RESET') && __w.ticket('JRC-1043').then(t=>!!t)`));
    await P1.do(`__w.set('#beta-reset-form [name=confirm]','RESET');__w.submit('#beta-reset-form')`);
    check('confirmed reset restores the sample records for everyone', await P1.w(`__w.server().then(w=>w.tickets.length===6&&!w.tickets.some(t=>t.id==='JRC-1043')&&w.changes.length===1)`) && await P1.w(`!document.querySelector('[data-id="JRC-1043"]')`));
    check('reset left normal browser records and the account untouched', await P1.w(`localStorage.getItem('jarc-helpdesk-v1')===${JSON.stringify(normal)} && fetch('/api/v1/me').then(r=>r.status===200)`));
    check('no page errors in either context', P1.cdp.errors.length === 0 && P2.cdp.errors.length === 0, [...P1.cdp.errors, ...P2.cdp.errors].join(' | '));
  } catch (err) {
    if (!interrupted) check('walkthrough crashed', false, err.stack);
  }
} catch (err) {
  if (!interrupted) { console.error(`Beta walkthrough could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);
const sections = [...new Set(results.map(r => r.section))];
console.log('\nResults by area (shared beta records, server-backed):');
for (const s of sections) { const mine = results.filter(r => r.section === s); console.log(`  ${s}: ${mine.every(r => r.ok) ? 'PASSED' : 'FAILED'} (${mine.filter(r => r.ok).length}/${mine.length})`); }
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} beta walkthrough checks passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);
