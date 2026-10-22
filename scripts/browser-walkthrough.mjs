// Optional browser walkthrough of the full ticket workflow and stored-data recovery.
// Needs Node >=22 and a local Chrome or Edge. Not run by `npm test` or GitHub Actions.
// Isolation: starts its own server on WALKTHROUGH_PORT, uses a temporary browser profile that is
// deleted afterwards, and refuses to run if any process already listens on either port. Your working
// records (other ports, your normal browser profile) are never opened or changed.
// Cleanup: on success, failure, or Ctrl+C it stops only the server and browser it started (and their
// child processes), then deletes the temporary profile. Exit codes: 0 pass, 1 check failed, 2 could not
// start, 130 interrupted.
//
//   npm run walkthrough
//   BROWSER_PATH=/path/to/chrome WALKTHROUGH_PORT=4190 WALKTHROUGH_SCREENSHOTS=./tmp npm run walkthrough
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WALKTHROUGH_PORT || 4190);
const DEBUG = Number(process.env.WALKTHROUGH_DEBUG_PORT || 9333);
const SERVER_TIMEOUT = 10000, BROWSER_TIMEOUT = 30000;
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

// ---------- Setup, owned processes, and cleanup ----------
class SetupError extends Error {}
const owned = []; // Only processes this script spawned. Cleanup never touches anything else.
let profile = null, cleaning = null, interrupted = false;
let ws, nextId = 1; const pending = new Map(); const listeners = [];
let dialogAccept = true; const dialogs = [];

// A port counts as busy if anything accepts a TCP connection on it (any protocol, IPv4 or IPv6
// loopback) or if it cannot be bound, for example a reserved or exclusively held port.
function accepts(host, port) {
  return new Promise(res => {
    const s = net.connect({ host, port });
    const done = v => { s.destroy(); res(v); };
    s.setTimeout(1000, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
  });
}
function bindError(port) {
  return new Promise(res => {
    const srv = net.createServer();
    srv.once('error', err => res(err.code || err.message));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => res(null)));
  });
}
async function portProblem(port) {
  for (const host of ['127.0.0.1', '::1']) if (await accepts(host, port)) return `another process is listening on ${host}:${port}`;
  const code = await bindError(port);
  return code ? `port ${port} cannot be used (${code})` : null;
}
const tail = s => s.trim() ? '\n--- output ---\n' + s.trim().split(/\r?\n/).slice(-8).join('\n') : '';
const running = child => child.pid && child.exitCode === null && child.signalCode === null;

// The walkthrough's server is always the browser-only prototype on 127.0.0.1: it never reads a local .env
// or inherits database or host settings, so it cannot connect to a real database.
function serverEnv() {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test', JARCTECH_ENV_FILE: 'none' };
  for (const name of ['MONGODB_URI', 'MONGODB_DB_NAME', 'HOST']) delete env[name];
  return env;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.cjs'], { cwd: REPO, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    owned.push(child);
    let out = '', ready = false;
    const timer = setTimeout(() => fail(`The walkthrough server did not report ready within ${SERVER_TIMEOUT / 1000} s.`), SERVER_TIMEOUT);
    function fail(msg) { if (ready) return; ready = true; clearTimeout(timer); reject(new SetupError(msg + tail(out))); }
    const read = d => { out = (out + d).slice(-4000); if (!ready && out.includes(`http://localhost:${PORT}`)) { ready = true; clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', err => fail(`Could not start the walkthrough server (${process.execPath} server.cjs): ${err.message}`));
    child.on('exit', (code, sig) => {
      if (!ready) fail(`The walkthrough server exited before it was ready (${sig || 'exit code ' + code}).`);
      else if (!cleaning) console.error(`The walkthrough server stopped unexpectedly (${sig || 'exit code ' + code}).${tail(out)}`);
    });
  });
}

// The browser we started announces its DevTools port on its own stderr ("DevTools listening on
// ws://127.0.0.1:<port>/...") and some versions also write DevToolsActivePort into our private profile.
// Either signal proves the debugging port belongs to this browser, not another process.
function startBrowser() {
  return new Promise((resolve, reject) => {
    const child = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, '--window-size=1400,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    owned.push(child);
    let out = '', ready = false;
    const announced = port => {
      if (ready || !port) return;
      if (port !== DEBUG) return fail(`The browser opened DevTools on port ${port} instead of ${DEBUG}.`);
      ready = true; clearTimeout(timer); clearInterval(poll); resolve(child);
    };
    child.stderr.on('data', d => { out = (out + d).slice(-4000); const m = /DevTools listening on ws:\/\/[^\s/]+:(\d+)\//.exec(out); if (m) announced(Number(m[1])); });
    const timer = setTimeout(() => fail(`The browser did not open DevTools on port ${DEBUG} within ${BROWSER_TIMEOUT / 1000} s.`), BROWSER_TIMEOUT);
    const poll = setInterval(() => {
      try { announced(Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])); } catch {}
    }, 100);
    function fail(msg) { if (ready) return; ready = true; clearTimeout(timer); clearInterval(poll); reject(new SetupError(msg + tail(out))); }
    child.on('error', err => fail(`Could not start the browser at ${BROWSER}: ${err.message}. Set BROWSER_PATH to a Chrome or Edge executable.`));
    child.on('exit', (code, sig) => {
      if (!ready) fail(`The browser at ${BROWSER} exited before DevTools was ready (${sig || 'exit code ' + code}). Set BROWSER_PATH to a Chrome or Edge executable.`);
      else if (!cleaning) console.error(`The browser stopped unexpectedly (${sig || 'exit code ' + code}).`);
    });
  });
}

// Stops one owned process and its children. Skips processes that already exited so a reused PID
// can never be signalled.
function stop(child) {
  return new Promise(resolve => {
    if (!running(child)) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    else child.kill('SIGTERM');
  });
}
function cleanup() {
  return cleaning ??= (async () => {
    try { ws?.close(); } catch {}
    await Promise.all(owned.map(stop));
    if (!profile) return;
    for (let i = 0; i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
    if (fs.existsSync(profile)) console.error(`Could not delete the temporary browser profile: ${profile}`);
  })();
}
const SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const sig of SIGNALS) process.on(sig, async () => {
  if (interrupted) return;
  interrupted = true;
  console.error(`\n${sig} received. Stopping the walkthrough server and browser...`);
  await cleanup();
  console.error('Walkthrough cancelled. Owned processes stopped and temporary profile removed.');
  process.exit(130);
});

try {
  if (!BROWSER) throw new SetupError('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (!fs.existsSync(BROWSER)) throw new SetupError(`BROWSER_PATH does not exist: ${BROWSER}`);
  for (const [name, port] of [['WALKTHROUGH_PORT', PORT], ['WALKTHROUGH_DEBUG_PORT', DEBUG]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SetupError(`${name} must be a port number from 1 to 65535.`);
  }
  if (PORT === DEBUG) throw new SetupError('WALKTHROUGH_PORT and WALKTHROUGH_DEBUG_PORT must be different.');
  for (const [name, port] of [['WALKTHROUGH_PORT', PORT], ['WALKTHROUGH_DEBUG_PORT', DEBUG]]) {
    const problem = await portProblem(port);
    if (problem) throw new SetupError(`${problem}. Choose a free port with ${name}.`);
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-walkthrough-'));
  await startServer();
  await startBrowser();
} catch (err) {
  if (!interrupted) console.error(`Walkthrough could not start: ${err instanceof SetupError ? err.message : err.stack}`);
  await cleanup();
  process.exit(interrupted ? 130 : 2);
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const page = (await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()).find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error('The browser did not expose a page to automate.');
}
function send(method, params = {}) {
  if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser connection closed'));
  const id = nextId++; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
function waitEvent(method) { return new Promise((res, rej) => listeners.push({ method, res, rej })); }
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
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('Could not connect to the browser page.'))); });
  // A closed connection (browser crashed or was stopped) fails waiting steps instead of hanging.
  ws.addEventListener('close', () => {
    const err = new Error('Browser connection closed');
    for (const p of pending.values()) p.rej(err);
    pending.clear();
    for (const l of listeners.splice(0)) l.rej(err);
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: dialogAccept }); }
    for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].method === m.method) { listeners[i].res(m.params); listeners.splice(i, 1); }
  });
  await send('Page.enable'); await send('Runtime.enable');

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
  if (!interrupted) check('walkthrough crashed', false, err.stack);
} finally {
  await cleanup();
  if (interrupted) process.exit(130); // The signal handler reports the cancellation.
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
  process.exit(failed ? 1 : 0);
}
