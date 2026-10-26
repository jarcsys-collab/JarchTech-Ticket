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
let mongod, mongo, entra, app, betaApp, browser, profile, ws, cleaning, interrupted = false;
function cleanup() {
  return cleaning ??= (async () => {
    try { ws?.close(); } catch {}
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await new Promise(resolve => { const t = setTimeout(resolve, 5000); browser.once('exit', () => { clearTimeout(t); resolve(); }); browser.kill(); });
    }
    for (const step of [() => app?.shutdown(), () => betaApp?.shutdown(), () => entra?.close(), () => mongo?.close(), () => mongod?.stop()]) { try { await step(); } catch {} }
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
  await store.inviteUser({ email: 'owner@jarc.example', role: 'Developer', displayName: 'Olivia Owner' }, null);
  await store.inviteUser({ email: 'rita@jarc.example', role: 'Requestor', displayName: 'Rita Requestor' }, null);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'screens-check-client-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_auth_screens',
    AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'screens-check-client-secret', APP_BASE_URL: origin, SESSION_SECRET: 'screens-check-session-secret-0123456789abcdef'
  }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } });

  // Second scenario: ACCESS_POLICY=tenant-members (beta), its own server, database, and browser origin.
  const betaDb = mongo.db('jarctech_auth_screens_beta');
  await ensureSchema(betaDb);
  const betaStore = createStore(betaDb);
  await betaDb.collection('users').insertOne({ email: 'boss@jarc.example', role: 'Developer', status: 'active', displayName: 'Bea Boss', tenantId: TENANT, entraObjectId: account(31).oid, createdAt: new Date(), updatedAt: new Date() });
  const betaAdmin = await betaDb.collection('users').findOne({ email: 'boss@jarc.example' });
  await betaStore.inviteUser({ email: 'devon@jarc.example', role: 'Developer', displayName: 'Devon Developer' }, betaAdmin);
  await betaDb.collection('users').insertOne({ email: 'dora@jarc.example', role: 'Requestor', status: 'disabled', displayName: 'Dora Disabled', tenantId: TENANT, entraObjectId: account(34).oid, createdAt: new Date(), updatedAt: new Date() });
  const betaPort = await freePort();
  const betaOrigin = `http://localhost:${betaPort}`;
  betaApp = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(betaPort), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_auth_screens_beta', ACCESS_POLICY: 'tenant-members',
    AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'screens-check-client-secret', APP_BASE_URL: betaOrigin, SESSION_SECRET: 'screens-check-beta-session-secret-0123456789'
  }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  var beta = { db: betaDb, origin: betaOrigin };
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
    // The sign-in card is centered in the whole viewport (no sidebar offset) on desktop and phones, and a short screen scrolls.
    const card = () => js(`(()=>{const r=document.querySelector('.auth-card').getBoundingClientRect(),s=getComputedStyle(document.querySelector('.auth-card'));return {dx:Math.round(r.left+r.width/2-innerWidth/2),dy:Math.round(r.top+r.height/2-innerHeight/2),left:Math.round(r.left),right:Math.round(innerWidth-r.right),pad:s.paddingLeft,scroll:document.documentElement.scrollHeight>innerHeight,width:Math.round(r.width)}})()`);
    const desktop = await card();
    check('sign-in card is centered horizontally and vertically on desktop', Math.abs(desktop.dx) <= 1 && Math.abs(desktop.dy) <= 1 && desktop.pad === '36px', JSON.stringify(desktop));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const phone = await card();
    check('on a phone the card is centered with 16px side spacing and its own padding', Math.abs(phone.dx) <= 1 && Math.abs(phone.dy) <= 1 && phone.left === 16 && phone.right === 16 && phone.pad === '22px', JSON.stringify(phone));
    await shot('01b-sign-in-phone.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 240, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const short = await js(`(()=>{const r=document.querySelector('.auth-card').getBoundingClientRect();return {top:Math.round(r.top+scrollY),scroll:document.documentElement.scrollHeight>innerHeight}})()`);
    check('on a short screen the page scrolls and the top of the card stays visible', short.scroll && short.top >= 16, JSON.stringify(short));
    await send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    // Existing browser records on this origin must survive sign-in untouched.
    const stored = JSON.stringify({ tickets: [{ id: 'JRC-7001', title: 'Existing local record', name: 'Rita Requestor', department: 'Sales', category: 'Enhancement', date: '2026-12-01', priority: 'Low', status: 'Submitted', dev: '', description: 'Kept.', criteria: 'Kept.', tasks: [], history: [] }], changes: [], notices: [] });
    await js(`localStorage.setItem('jarc-helpdesk-v1', ${JSON.stringify(stored)}); true`);

    entra.signInNext(account(99, 'Uma Uninvited', 'uma@jarc.example'));
    await clickAndLoad('a.primary');
    check('an uninvited Microsoft account sees Access not granted (no app, no session)', await js(`document.body.textContent.includes('Access not granted') && !document.querySelector('#app')`));
    await shot('02-access-denied.png');
    check('denied sign-in left browser records untouched', await js(`localStorage.getItem('jarc-helpdesk-v1')`) === stored);

    // A browser that remembers an inspection view must still get the normal app when INSPECTION_MODE is not enabled.
    await js(`localStorage.setItem('jarc-inspection-view', 'Admin'); localStorage.setItem('jarc-inspection:jarc-helpdesk-v1', '{"tickets":[],"changes":[],"notices":[]}'); true`);
    entra.signInNext(account(2, 'Rita Requestor', 'rita@jarc.example'));
    await clickAndLoad('a.primary');
    check('invited Requestor lands in the app', await here() === '/' && await js(`!!document.querySelector('#app .stats')`));
    check('with INSPECTION_MODE off, a remembered inspection view is ignored (no banner, no Preview views, My workspace, real role)', await js(`typeof window.JARC_INSPECTION==='undefined' && !document.querySelector('#inspection-banner') && !document.querySelector('#preview-views') && !document.querySelector('[data-id="JRC-7001"]') && document.querySelector('.sidebar-bottom').textContent.includes('My workspace') && document.querySelector('#page-title').textContent==='My ticket'`));
    check('demo role selector is hidden; header shows name, role, and Sign out', await js(`document.querySelector('.demo-role-label').hidden && document.querySelector('.signed-in-as').textContent==='Rita Requestor · Requestor' && !!document.querySelector('#sign-out') && !document.querySelector('#manage-users')`));
    check('role comes from the server (Requestor view)', await js(`document.querySelector('#page-title').textContent==='My ticket' && document.querySelector('.record-count').textContent==='Your requests'`));
    check('existing browser record is kept unchanged in browser storage, apart from My workspace', await js(`!document.querySelector('[data-id="JRC-7001"]') && document.querySelector('.sidebar-bottom').textContent.includes('My workspace') && JSON.parse(localStorage.getItem('jarc-helpdesk-v1')).tickets[0].title==='Existing local record'`));
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
    check('invited Developer lands in the app with the Users button', await here() === '/' && await js(`!!document.querySelector('#manage-users') && document.querySelector('.signed-in-as').textContent==='Olivia Owner · Developer'`));
    await js(`document.querySelector('#manage-users').click(); true`); await sleep(600);
    check('Users screen lists people with their access', await js(`document.querySelector('.users-table').textContent.includes('rita@jarc.example') && document.querySelector('.users-table').textContent.includes('You')`));
    await js(`{const f=document.querySelector('#invite-form');f.querySelector('[name=email]').value='dev@jarc.example';f.querySelector('[name=displayName]').value='Dana Developer';f.querySelector('[name=role]').value='Developer';f.requestSubmit()} true`); await sleep(800);
    const dana = await db.collection('users').findOne({ email: 'dev@jarc.example' });
    check('a Developer can invite someone; they are listed as invited', dana?.status === 'invited' && await js(`[...document.querySelectorAll('.users-table tr')].some(r=>r.textContent.includes('dev@jarc.example') && r.querySelector('select[data-field=status]').selectedOptions[0].textContent==='Invited (not signed in yet)')`));
    await shot('06-users-screen.png');
    await js(`{const s=document.querySelector('select[data-user="${dana._id}"][data-field="status"]');s.value='disabled';s.dispatchEvent(new Event('change'))} true`); await sleep(800);
    check('a Developer can revoke a pending invitation', (await db.collection('users').findOne({ email: 'dev@jarc.example' })).status === 'disabled');
    const ritaId = String((await db.collection('users').findOne({ email: 'rita@jarc.example' }))._id);
    await js(`{const s=document.querySelector('select[data-user="${ritaId}"][data-field="role"]');s.value='Developer';s.dispatchEvent(new Event('change'))} true`); await sleep(800);
    check('Admin role change is saved on the server', (await db.collection('users').findOne({ email: 'rita@jarc.example' })).role === 'Developer');

    // ---------- Scenario 2: ACCESS_POLICY=tenant-members (beta) ----------
    const betaUsers = beta.db.collection('users');
    const signInAs = async claims => { entra.signInNext(claims); await clickAndLoad('a.primary'); };
    const signOutBeta = async () => { const l = event('Page.loadEventFired'); await js(`document.querySelector('#sign-out').click(); true`); await l; await sleep(300); await nav(`${beta.origin}/auth/signin`); };
    await nav(`${beta.origin}/`);
    check('beta: sign-in page explains that company members can sign in as Requestors', await here() === '/auth/signin' && await js(`document.body.textContent.includes('all company member accounts can sign in; new users start as Requestors')`));
    await shot('11-beta-sign-in.png');

    await signInAs(account(32, 'Mia Member', 'mia@jarc.example'));
    check('beta: a member with no invitation lands in the app as Requestor', await here() === '/' && await js(`document.querySelector('.signed-in-as').textContent==='Mia Member · Requestor' && document.querySelector('#page-title').textContent==='My ticket' && !document.querySelector('#manage-users') && document.querySelector('.demo-role-label').hidden`));
    const mia = await betaUsers.findOne({ email: 'mia@jarc.example' });
    check('beta: the new account was created as an active Requestor linked to the Entra account', mia?.role === 'Requestor' && mia.status === 'active' && mia.autoAdmitted === true && mia.entraObjectId === account(32).oid);
    await shot('12-beta-member-app.png');
    await signOutBeta();

    await signInAs({ ...account(33, 'Ari Admin-Claims', 'ari@jarc.example'), roles: ['Admin'], wids: ['62e90394-69f5-4237-9190-012177145e10'], groups: ['admins'] });
    check('beta: Admin role, group, and directory-role claims do not grant Admin', await js(`document.querySelector('.signed-in-as').textContent==='Ari Admin-Claims · Requestor' && !document.querySelector('#manage-users')`) && (await betaUsers.findOne({ email: 'ari@jarc.example' })).role === 'Requestor');
    check('beta: a member cannot call the admin API', await js(`fetch('/api/v1/users').then(r=>r.status)`) === 403);
    await signOutBeta();

    for (const [label, claims, text] of [
      ['a guest from another organization', { ...account(35, 'Gail Guest', 'gail@partner.example'), idp: 'https://sts.windows.net/99999999-9999-4999-8999-999999999999/' }, 'Guest accounts'],
      ['a personal Microsoft account', { ...account(36, 'Pat Personal', 'pat@outlook.example'), idp: 'live.com' }, 'Personal Microsoft accounts'],
      ['an account from another tenant', { ...account(37, 'Otto Other', 'otto@other.example'), tid: '99999999-9999-4999-8999-999999999999' }, 'different organization'],
      ['a disabled member', account(34, 'Dora Disabled', 'dora@jarc.example'), 'turned off']
    ]) {
      await signInAs(claims);
      check(`beta: ${label} is refused`, await js(`document.body.textContent.includes('Access not granted') && document.body.textContent.includes(${JSON.stringify(text)}) && !document.querySelector('#app')`));
      if (label === 'a guest from another organization') await shot('13-beta-guest-refused.png');
      await nav(`${beta.origin}/auth/signin`);
    }
    check('beta: no accounts were created for refused sign-ins', await betaUsers.countDocuments({ email: { $in: ['gail@partner.example', 'pat@outlook.example', 'otto@other.example'] } }) === 0 && await betaUsers.countDocuments({ email: 'dora@jarc.example' }) === 1);

    await signInAs(account(38, 'Devon Developer', 'devon@jarc.example'));
    check('beta: a Developer-invited Developer keeps the Developer role', await js(`document.querySelector('.signed-in-as').textContent==='Devon Developer · Developer'`) && (await betaUsers.findOne({ email: 'devon@jarc.example' })).role === 'Developer');
    await signOutBeta();

    await signInAs(account(31, 'Bea Boss', 'boss@jarc.example'));
    await js(`document.querySelector('#manage-users').click(); true`); await sleep(600);
    check('beta: the Developer Users screen explains the beta access policy and lists auto-admitted members', await js(`document.querySelector('.drawer').textContent.includes('Beta access: every member account of the company tenant can sign in and starts as a Requestor') && document.querySelector('.users-table').textContent.includes('mia@jarc.example')`));
    await shot('14-beta-users-screen.png');

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
