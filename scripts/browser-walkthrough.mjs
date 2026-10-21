// Optional browser walkthrough of the full ticket workflow and stored-data recovery.
// Needs Node >=22 and a local Chrome or Edge. Not run by `npm test` or GitHub Actions.
// Isolation: starts its own server on WALKTHROUGH_PORT, uses a temporary browser profile that is
// deleted afterwards, and refuses to run if either port is already in use. Your working records
// (other ports, your normal browser profile) are never opened or changed.
//
//   npm run walkthrough
//   BROWSER_PATH=/path/to/chrome WALKTHROUGH_PORT=4190 WALKTHROUGH_SCREENSHOTS=./tmp npm run walkthrough
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WALKTHROUGH_PORT || 4190);
const DEBUG = Number(process.env.WALKTHROUGH_DEBUG_PORT || 9333);
const SHOTS = process.env.WALKTHROUGH_SCREENSHOTS ? path.resolve(process.env.WALKTHROUGH_SCREENSHOTS) : null;
const BROWSER_CANDIDATES = {
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
const BROWSER = process.env.BROWSER_PATH || (BROWSER_CANDIDATES[process.platform] || []).find(p => p && fs.existsSync(p));

const results = []; const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, info = '') { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  -- ' + info : ''}`); }
async function portInUse(port) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } }

if (!BROWSER) { console.error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.'); process.exit(2); }
for (const port of [PORT, DEBUG]) {
  if (await portInUse(port)) { console.error(`Port ${port} is already in use. Choose free ports with WALKTHROUGH_PORT / WALKTHROUGH_DEBUG_PORT.`); process.exit(2); }
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-walkthrough-'));
const server = spawn(process.execPath, ['server.cjs'], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });

let ws, nextId = 1; const pending = new Map(); const listeners = [];
let dialogAccept = true; const dialogs = [];
async function connect() {
  for (let i = 0; i < 150; i++) {
    try { const page = (await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()).find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error('Browser did not start');
}
function send(method, params = {}) { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); return new Promise(res => pending.set(id, res)); }
function waitEvent(method) { return new Promise(res => listeners.push({ method, res })); }
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function go(url) { const loaded = waitEvent('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; await sleep(150); }
async function reload() { const loaded = waitEvent('Page.loadEventFired'); await send('Page.reload', {}); await loaded; await sleep(150); }
async function shot(name) { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); }

// In-page helpers, installed before each step because reloads clear them.
const HELPERS = `window.__w={
  set(sel,val,root=document){const el=root.querySelector(sel);if(!el)throw new Error('missing '+sel);if(el.type==='checkbox')el.checked=val;else el.value=val;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},
  click(sel){const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click();},
  submit(sel){const f=document.querySelector(sel);if(!f)throw new Error('missing '+sel);f.requestSubmit();},
  role(r){__w.set('#demo-role',r);},
  toast(){return document.querySelector('#toast').textContent},
  store(){return JSON.parse(localStorage.getItem('jarc-helpdesk-v1'))},
  ticket(id){return __w.store().tickets.find(t=>t.id===id)},
  backups(){return Object.keys(localStorage).filter(k=>k.startsWith('jarc-helpdesk-v1-backup-'))}
};true`;
const w = async js => { await evaluate(HELPERS); return evaluate(js); };

try {
  ws = new WebSocket(await connect());
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: dialogAccept }); }
    for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].method === m.method) { listeners[i].res(m.params); listeners.splice(i, 1); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  for (let i = 0; i < 50 && !(await portInUse(PORT)); i++) await sleep(100);

  // ---------- A. Full workflow on a fresh origin: http://localhost:PORT ----------
  await go(`http://localhost:${PORT}/`);
  check('A1 fresh origin starts from sample data', await w(`!!__w.ticket('JRC-1042') && !document.querySelector('#recovery')`));
  check('A2 navigation is Tickets + Projects only', await w(`JSON.stringify([...document.querySelectorAll('#nav button')].map(b=>b.textContent.replace(/[0-9▤▦]/g,'').trim()))==='["Tickets received","Projects"]'`));
  check('A3 sample project tasks carry illustrative demo dates', await w(`__w.ticket('JRC-1042').tasks.every(t=>t.scheduleSource==='demo'&&t.start)`));

  await w(`__w.role('Requestor');__w.click('#new-ticket');__w.set('[name=title]','Walkthrough request');__w.set('[name=date]','2026-12-15');__w.set('[name=description]','Need a walkthrough feature.');__w.set('[name=criteria]','Walkthrough passes.');__w.submit('#request-form');true`);
  check('A4 requestor submits ticket JRC-1043', await w(`__w.toast().includes('JRC-1043') && __w.ticket('JRC-1043').status==='Submitted'`), await w(`__w.toast()`));
  check('A5 requestor list shows own tickets only', await w(`document.querySelectorAll('#records [data-id]').length===__w.store().tickets.filter(t=>t.name==='Adriane Venzon').length`));

  await w(`__w.role('Admin');__w.click('[data-id="JRC-1043"]');__w.set('#assignee','Miguel Santos');__w.set('#priority','High');__w.click('#assign');true`);
  check('A6 admin assigns developer and priority', await w(`let t=__w.ticket('JRC-1043');t.status==='Assigned'&&t.dev==='Miguel Santos'&&t.priority==='High'`));

  await w(`__w.role('Developer');__w.click('[data-id="JRC-1043"]');__w.click('#schedule');__w.set('[name=meeting]','2026-11-03T10:00');__w.submit('#meeting-form');true`);
  check('A7 developer schedules planning meeting in ticket details', await w(`__w.ticket('JRC-1043').status==='Meeting scheduled'`));
  await w(`__w.role('Requestor');__w.click('[data-id="JRC-1043"]');__w.click('#confirm-meeting');true`);
  check('A8 requestor confirms meeting', await w(`__w.ticket('JRC-1043').meetingConfirmed===true`));

  await w(`__w.role('Developer');__w.click('[data-id="JRC-1043"]');__w.click('#create-project');true`);
  check('A9 step 1 of 2 shows scope form', await w(`document.querySelector('.tagline').textContent.includes('STEP 1 OF 2')`));
  await w(`__w.set('#project-scope [name=projectName]','Walkthrough project');__w.set('#project-scope [name=requirements]','Build walkthrough.');__w.set('#project-scope [name=criteria]','All checks pass.');__w.set('#project-scope [name=date]','2026-12-15');__w.submit('#project-scope');true`);
  check('A10 step 2 of 2 shows task timeline form', await w(`document.querySelector('.tagline').textContent.includes('STEP 2 OF 2')`));
  const fillTask = (i, t, s, e) => `{let f=document.querySelectorAll('.plan-task')[${i}];__w.set('[name=title]','${t}',f);__w.set('[name=requirement]','Req ${t}',f);__w.set('[name=criteria]','Crit ${t}',f);__w.set('[name=start]','${s}',f);__w.set('[name=end]','${e}',f);}`;
  await w(`${fillTask(0, 'Build', '2026-11-10', '2026-11-05')};__w.set('[name=agreed]',true);__w.submit('#project-tasks');true`);
  check('A11 reversed task dates are rejected', await w(`!__w.ticket('JRC-1043').project`), await w(`__w.toast()`));
  await w(`${fillTask(0, 'Build', '2026-11-10', '2026-12-20')};__w.submit('#project-tasks');true`);
  check('A12 task ending after target date is rejected', await w(`!__w.ticket('JRC-1043').project && __w.toast().includes('target')`), await w(`__w.toast()`));
  await w(`${fillTask(0, 'Build', '2026-11-10', '2026-11-20')};__w.click('#another-task');${fillTask(1, 'Test', '2026-11-21', '2026-12-01')};__w.submit('#project-tasks');true`);
  check('A13 valid project created and Gantt opens', await w(`__w.ticket('JRC-1043').project==='PRJ-1043' && document.querySelectorAll('.gantt-bar').length===2`));
  await shot('gantt.png');

  await reload();
  check('A14 project and exact task dates persist after reload', await w(`let t=__w.ticket('JRC-1043');JSON.stringify(t.tasks.map(x=>[x.start,x.end]))==='[["2026-11-10","2026-11-20"],["2026-11-21","2026-12-01"]]'&&t.projectName==='Walkthrough project'`));

  await w(`__w.role('Developer');__w.click('[data-view="Projects"]');__w.click('#records [data-id="JRC-1043"]');__w.click('.gantt-bar[data-project-task="0"]');__w.set('#dated-task-form [name=done]',true);__w.submit('#dated-task-form');true`);
  await reload();
  check('A15 Gantt task completion saved and reloaded', await w(`__w.ticket('JRC-1043').tasks[0].done===true && __w.ticket('JRC-1043').tasks[1].done===false`));

  await w(`__w.role('Requestor');__w.click('[data-view="Projects"]');__w.click('#records [data-id="JRC-1043"]');true`);
  check('A16 requestor Gantt has no add/edit controls', await w(`!!document.querySelector('.gantt') && !document.querySelector('#timeline-add') && !document.querySelector('#edit-scope')`));
  await w(`__w.click('[data-project-task="1"]');true`);
  check('A17 requestor task detail is read-only', await w(`[...document.querySelectorAll('#dated-task-form input,#dated-task-form textarea,#dated-task-form select')].every(x=>x.disabled) && !document.querySelector('#dated-task-form .primary')`));

  await w(`__w.role('Developer');__w.click('[data-id="JRC-1043"]');__w.click('#testing');true`);
  check('A18 cannot submit for acceptance with open tasks', await w(`__w.ticket('JRC-1043').status==='Planning' && __w.toast().includes('Complete all')`));
  await w(`__w.click('[data-task="1"]');true`);
  await w(`__w.click('#testing');__w.set('#test-form [name=summary]','Tested on staging.');__w.set('#test-form input[type=checkbox]',true);__w.submit('#test-form');true`);
  check('A19 developer submits for acceptance', await w(`__w.ticket('JRC-1043').status==='Awaiting acceptance'`));
  check('A20 linked change entry stays inside ticket details', await w(`!!document.querySelector('#new-change')`));

  await w(`__w.role('Requestor');__w.click('[data-id="JRC-1043"]');__w.click('[data-action="Ready for release"]');true`);
  check('A21 requestor accepts delivery', await w(`__w.ticket('JRC-1043').status==='Ready for release'`));
  await w(`__w.role('Developer');__w.click('[data-id="JRC-1043"]');__w.click('[data-action="Released"]');true`);
  check('A22 developer confirms release', await w(`__w.ticket('JRC-1043').status==='Released'`));
  await w(`__w.role('Admin');__w.click('[data-id="JRC-1043"]');__w.click('[data-action="Closed"]');true`);
  check('A23 admin closes ticket', await w(`__w.ticket('JRC-1043').status==='Closed'`));
  await reload();
  check('A24 closed state persists after reload', await w(`__w.ticket('JRC-1043').status==='Closed' && __w.ticket('JRC-1043').history.length>=10`));

  const before = await w(`localStorage.getItem('jarc-helpdesk-v1')`);
  await w(`window.__orig=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')};__w.click('[data-id="JRC-1042"]');__w.set('#comment-form [name=comment]','unsaved comment');__w.submit('#comment-form');true`);
  check('A25 write failure warns and keeps last saved value', await w(`__w.toast().includes('Could not save')`) && before === await w(`localStorage.getItem('jarc-helpdesk-v1')`), await w(`__w.toast()`));
  await w(`Storage.prototype.setItem=window.__orig;true`);

  // ---------- B. Recovery on a separate origin: http://127.0.0.1:PORT ----------
  await go(`http://127.0.0.1:${PORT}/`);
  const BAD = '{"tickets":[{"id":"JRC-1","title":"half-written';
  await w(`localStorage.clear();localStorage.setItem('jarc-helpdesk-v1',${JSON.stringify(BAD)});true`);
  await reload();
  check('B1 unreadable data shows recovery screen', await w(`!!document.querySelector('#recovery') && document.querySelector('#page-title').textContent==='Stored records need recovery'`));
  check('B2 original value untouched', await w(`localStorage.getItem('jarc-helpdesk-v1')===${JSON.stringify(BAD)}`));
  check('B3 exact raw value backed up under a unique key', await w(`let k=__w.backups();k.length===1&&localStorage.getItem(k[0])===${JSON.stringify(BAD)}`));
  check('B4 no sample data, new request disabled, nav empty, saving shown as paused', await w(`document.querySelector('#new-ticket').disabled && !document.querySelector('#nav button') && !document.querySelector('#records') && document.querySelector('.save').textContent.includes('paused')`));
  await shot('recovery.png');
  await w(`__w.role('Developer');true`);
  check('B5 role switch stays in recovery and writes nothing', await w(`!!document.querySelector('#recovery') && localStorage.getItem('jarc-helpdesk-v1')===${JSON.stringify(BAD)}`));
  await reload();
  check('B6 reload reuses backup (no duplicate copies)', await w(`__w.backups().length===1`));
  dialogAccept = false; await w(`__w.click('#reset-storage');true`); await sleep(300);
  check('B7 cancelling reset changes nothing', dialogs.length === 1 && await w(`localStorage.getItem('jarc-helpdesk-v1')===${JSON.stringify(BAD)} && !!document.querySelector('#recovery') && __w.backups().length===1`));
  dialogAccept = true; const loaded = waitEvent('Page.loadEventFired'); await w(`__w.click('#reset-storage');true`); await loaded; await sleep(200);
  check('B8 confirmed reset loads samples and keeps the backup', await w(`!document.querySelector('#recovery') && !!__w.ticket('JRC-1042') && __w.backups().length===1`));

  await w(`localStorage.setItem('jarc-helpdesk-v1','{"tickets":[]}');true`); await reload();
  check('B9 structurally invalid data enters recovery', await w(`!!document.querySelector('#recovery') && document.querySelector('#recovery').textContent.includes('missing required') && localStorage.getItem('jarc-helpdesk-v1')==='{"tickets":[]}'`));

  let inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const o=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(String(k).includes('-backup-'))throw new DOMException('quota','QuotaExceededError');return o.call(this,k,v)}}` });
  await w(`__w.backups().forEach(k=>localStorage.removeItem(k));localStorage.setItem('jarc-helpdesk-v1','not json at all');true`);
  await reload();
  check('B10 failed backup: original kept, message shown, download offered', await w(`localStorage.getItem('jarc-helpdesk-v1')==='not json at all' && document.querySelector('#recovery').textContent.includes('could not be created') && !!document.querySelector('#download-raw') && __w.backups().length===0`));
  await shot('recovery-no-backup.png');
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });

  inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Storage.prototype.getItem=function(){throw new DOMException('blocked','SecurityError')}` });
  await reload();
  check('B11 unreadable storage enters recovery without a download or backup', await w(`!!document.querySelector('#recovery') && document.querySelector('#recovery').textContent.includes('No backup was made because nothing could be read') && !document.querySelector('#download-raw')`));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });

  check('Z no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('walkthrough crashed', false, err.stack);
} finally {
  try { ws?.close(); } catch {}
  browser.kill(); server.kill();
  for (let i = 0; i < 20; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(250); } }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
  process.exit(failed ? 1 : 0);
}
