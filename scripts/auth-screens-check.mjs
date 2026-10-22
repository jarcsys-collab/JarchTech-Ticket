// Optional browser check of signed-in mode (AUTH_MODE=entra) using a MOCK Microsoft Entra provider and a
// temporary MongoDB. Never contacts Microsoft or Atlas, never reads .env, and uses a temporary browser profile.
// Needs Node >=22 and Chrome or Edge (BROWSER_PATH to override). Not run by `npm test` or GitHub Actions.
// Ports are chosen automatically. Exit codes: 0 pass, 1 check failed, 2 could not start, 130 cancelled.
//
//   npm run walkthrough:auth
//   AUTH_CHECK_SCREENSHOTS=tmp/auth npm run walkthrough:auth
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
const { createStore } = require('../server/auth/store.cjs');
const { startMockEntra } = require('../tests/helpers/mock-entra.cjs');

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SHOTS = process.env.AUTH_CHECK_SCREENSHOTS ? path.resolve(process.env.AUTH_CHECK_SCREENSHOTS) : null;
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
const results = [];
const check = (name, ok, info = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  -- ' + info : ''}`); };

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

let id = 1; const pending = new Map(), waits = [], errors = [];
const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== WebSocket.OPEN) return rej(new Error('Browser connection closed')); const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const event = method => new Promise(res => waits.push({ method, res }));
async function js(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function nav(url) { const l = event('Page.loadEventFired'); await send('Page.navigate', { url }); await l; await sleep(300); }
async function clickAndLoad(selector) { const l = event('Page.loadEventFired'); await js(`document.querySelector(${JSON.stringify(selector)}).click();true`); await l; await sleep(300); }
async function shot(name) { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); }
const here = () => js('location.pathname');
const account = (n, name, email) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, email, preferred_username: email });

let db;
try {
  if (!BROWSER || !fs.existsSync(BROWSER)) throw new Error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db('jarctech_auth_screens');
  await ensureSchema(db);
  const store = createStore(db);
  await store.inviteUser({ email: 'owner@jarc.example', role: 'Admin', displayName: 'Olivia Owner' }, null);
  await store.inviteUser({ email: 'rita@jarc.example', role: 'Requestor', displayName: 'Rita Requestor' }, null);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'screens-check-client-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_auth_screens',
    AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'screens-check-client-secret', APP_BASE_URL: origin, SESSION_SECRET: 'screens-check-session-secret-0123456789abcdef'
  }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-authcheck-'));
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
    for (let i = waits.length - 1; i >= 0; i--) if (waits[i].method === m.method) { waits[i].res(m.params); waits.splice(i, 1); }
  });
  await send('Page.enable'); await send('Runtime.enable');

  try {
    await nav(`${origin}/`);
    check('opening the app without a session shows the sign-in page', await here() === '/auth/signin' && await js(`document.body.textContent.includes('Sign in with Microsoft')`));
    await shot('01-sign-in.png');
    // Existing browser records on this origin must survive sign-in untouched.
    const stored = JSON.stringify({ tickets: [{ id: 'JRC-7001', title: 'Existing local record', name: 'Rita Requestor', department: 'Sales', category: 'Enhancement', date: '2026-12-01', priority: 'Low', status: 'Submitted', dev: '', description: 'Kept.', criteria: 'Kept.', tasks: [], history: [] }], changes: [], notices: [] });
    await js(`localStorage.setItem('jarc-helpdesk-v1', ${JSON.stringify(stored)}); true`);

    entra.signInNext(account(99, 'Uma Uninvited', 'uma@jarc.example'));
    await clickAndLoad('a.primary');
    check('an uninvited Microsoft account sees Access not granted (no app, no session)', await js(`document.body.textContent.includes('Access not granted') && !document.querySelector('#app')`));
    await shot('02-access-denied.png');
    check('denied sign-in left browser records untouched', await js(`localStorage.getItem('jarc-helpdesk-v1')`) === stored);

    entra.signInNext(account(2, 'Rita Requestor', 'rita@jarc.example'));
    await clickAndLoad('a.primary');
    check('invited Requestor lands in the app', await here() === '/' && await js(`!!document.querySelector('#app .stats')`));
    check('demo role selector is hidden; header shows name, role, and Sign out', await js(`document.querySelector('.demo-role-label').hidden && document.querySelector('.signed-in-as').textContent==='Rita Requestor · Requestor' && !!document.querySelector('#sign-out') && !document.querySelector('#manage-users')`));
    check('role comes from the server (Requestor view)', await js(`document.querySelector('#page-title').textContent==='My ticket' && document.querySelector('.record-count').textContent==='Rita Requestor · My workspace'`));
    check('existing browser record is shown and unchanged', await js(`!!document.querySelector('[data-id="JRC-7001"]') && JSON.parse(localStorage.getItem('jarc-helpdesk-v1')).tickets[0].title==='Existing local record'`));
    await shot('03-requestor-app.png');
    await js(`document.querySelector('#new-ticket').click(); true`); await sleep(300);
    check('requestor name is prefilled from the signed-in profile and read-only', await js(`(()=>{const i=document.querySelector('[name=name]');return i.value==='Rita Requestor'&&i.readOnly})()`));
    await shot('04-request-form.png');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);
    check('a Requestor cannot use the admin API from the browser', await js(`fetch('/api/v1/users').then(r=>r.status)`) === 403);
    const signedOut = event('Page.loadEventFired');
    await js(`document.querySelector('#sign-out').click(); true`); await signedOut; await sleep(400);
    check('Sign out ends on the signed-out page (via Microsoft sign-out)', await here() === '/auth/signed-out' && await js(`document.body.textContent.includes('You have signed out')`));
    await shot('05-signed-out.png');
    await nav(`${origin}/`);
    check('after sign-out the app is closed again', await here() === '/auth/signin');

    entra.signInNext(account(1, 'Olivia Owner', 'owner@jarc.example'));
    await clickAndLoad('a.primary');
    check('invited Admin lands in the app with the Users button', await here() === '/' && await js(`!!document.querySelector('#manage-users') && document.querySelector('.signed-in-as').textContent==='Olivia Owner · Admin'`));
    await js(`document.querySelector('#manage-users').click(); true`); await sleep(600);
    check('Users screen lists people with their access', await js(`document.querySelector('.users-table').textContent.includes('rita@jarc.example') && document.querySelector('.users-table').textContent.includes('You')`));
    await js(`{const f=document.querySelector('#invite-form');f.querySelector('[name=email]').value='dev@jarc.example';f.querySelector('[name=displayName]').value='Dana Developer';f.querySelector('[name=role]').value='Developer';f.requestSubmit()} true`); await sleep(800);
    const dana = await db.collection('users').findOne({ email: 'dev@jarc.example' });
    check('Admin can invite someone; they are listed as invited', dana?.status === 'invited' && await js(`[...document.querySelectorAll('.users-table tr')].some(r=>r.textContent.includes('dev@jarc.example') && r.querySelector('select[data-field=status]').selectedOptions[0].textContent==='Invited (not signed in yet)')`));
    await shot('06-users-screen.png');
    await js(`{const s=document.querySelector('select[data-user="${dana._id}"][data-field="status"]');s.value='disabled';s.dispatchEvent(new Event('change'))} true`); await sleep(800);
    check('Admin can revoke a pending invitation', (await db.collection('users').findOne({ email: 'dev@jarc.example' })).status === 'disabled');
    const ritaId = String((await db.collection('users').findOne({ email: 'rita@jarc.example' }))._id);
    await js(`{const s=document.querySelector('select[data-user="${ritaId}"][data-field="role"]');s.value='Developer';s.dispatchEvent(new Event('change'))} true`); await sleep(800);
    check('Admin role change is saved on the server', (await db.collection('users').findOne({ email: 'rita@jarc.example' })).role === 'Developer');
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    if (!interrupted) check('check crashed', false, err.stack);
  }
} catch (err) {
  if (!interrupted) { console.error(`Auth screen check could not start: ${err.message}`); await cleanup(); process.exit(2); }
}
await cleanup();
if (interrupted) process.exit(130);
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} signed-in screen checks passed (mock Entra, temporary database)${SHOTS ? ` · screenshots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);
