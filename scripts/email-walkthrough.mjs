// Real-browser walkthrough of email notifications: each email's link is followed by the person it was sent to, who must land
// on the right request with the right next action. Covers a signed-out person returning through Microsoft sign-in, a
// forwarded link, reassignment, archive, deletion, and the Admin delivery status and retry.
// MOCK Microsoft Entra, a temporary MongoDB, and a stand-in for the email provider: nothing is ever sent. Not run by npm test
// or CI (it needs Chrome or Edge). Exit codes: 0 all passed, 1 a check failed, 2 could not start, 130 cancelled.
//   npm run walkthrough:email            BETA_SCREENSHOTS=<folder> also saves screenshots
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

const TENANT = '55555555-6666-4777-8888-999999999999';
const CLIENT = 'eeeeeeee-ffff-4000-8111-222222222222';
const SHOTS = process.env.BETA_SCREENSHOTS ? path.resolve(process.env.BETA_SCREENSHOTS) : null;
const DB = 'jarctech_email_walkthrough';
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
  submit(sel){if(sel==='#request-form')for(const [n,v] of [['department','SALES'],['category','MONDAY']]){const e=document.querySelector('#request-form [name='+n+']');if(e&&!e.value)__w.set('#request-form [name='+n+']',v)}__w.el(sel).requestSubmit()},
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
  const key = async (key, code = key, modifiers = 0) => { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: { Tab: 9, Escape: 27, Enter: 13, ' ': 32 }[key], ...(key === 'Enter' ? { text: '\r' } : {}) }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); await sleep(120); };
  return { cdp, w, settle, loads, nav, shot, key, do: async js => { await w(js + ';true'); await settle(); } };
}
const account = (n, name) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-d000-${String(n).padStart(12, '0')}`, name, email: `staff${n}@jarc.example`, preferred_username: `staff${n}@jarc.example` });

let exitCode = 0;
try {
  if (!BROWSER || !fs.existsSync(BROWSER)) throw new Error('No Chrome or Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  const db = mongo.db(DB);
  await ensureSchema(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'email-walkthrough-secret' });
  const port = await freePort(), debug = await freePort();
  const origin = `http://localhost:${port}`;
  const env = {
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'email-walkthrough-secret', APP_BASE_URL: origin, SESSION_SECRET: 'email-walkthrough-session-secret-0123456789',
    EMAIL_DELIVERY: 'resend', EMAIL_FROM: 'tickets@jarc.example', RESEND_API_KEY: 're_stub_not_real', EMAIL_REPLY_TO: 'support@jarc.example'
  };
  // The provider is a stand-in: nothing leaves this machine. Messages go straight away, as they do when deployed.
  const mail = [];
  let provider = () => ({ status: 200, json: async () => ({ id: `stub-${mail.length}` }) });
  const options = { log: { log() {}, error(...a) { if (!a.join(' ').includes('could not be delivered')) console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true }, emailFetch: async (url, opts) => { mail.push(JSON.parse(opts.body)); return provider(); } };
  app = await start(loadConfig(env), options);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-email-'));
  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1280,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, 'about:blank'], { stdio: 'ignore' });
  let browserWs;
  for (let i = 0; i < 150 && !browserWs; i++) { try { browserWs = (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl; } catch {} if (!browserWs) await sleep(200); }
  if (!browserWs) throw new Error('The browser did not start.');
  const bcdp = await connect(browserWs);
  async function person() {
    const { browserContextId } = await bcdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const P = pageApi(await connect(`ws://127.0.0.1:${debug}/devtools/page/${targetId}`));
    await P.cdp.send('Page.enable'); await P.cdp.send('Runtime.enable'); await P.cdp.send('Log.enable');
    return P;
  }
  const ADMIN = await person(), DEV = await person(), REQ = await person(), OTHER = await person(), OUTSIDE = await person();
  const waitFor = async (P, js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await P.w(js).catch(() => false)) return true; await sleep(100); } return false; };
  const signIn = async (P, n, name) => { await P.nav(`${origin}/auth/signin`); entra.signInNext(account(n, name)); await P.loads(() => P.w(`document.querySelector('a.primary').click();true`)); await P.settle(); };
  const reload = async P => { await P.nav(origin + '/'); await P.settle(); };
  const api = (P, method, url, body) => P.w(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,json:await r.json().catch(()=>null)}))`);
  const tickets = db.collection('tickets'), users = db.collection('users'), outbox = db.collection('email_outbox');
  const ticket = id => tickets.findOne({ id });
  const act = async (P, id, action, input = {}) => { const res = await api(P, 'POST', `/api/v1/work/tickets/${id}/actions`, { version: (await ticket(id)).version, action, input }); if (res.status !== 200) throw new Error(`${action}: ${JSON.stringify(res.json)}`); };
  const submit = async (P, title, type) => (await api(P, 'POST', '/api/v1/work/tickets', { requestId: `walk-${title.replace(/\W/g, '')}-${Date.now()}`, input: { title, type, department: 'SALES', category: 'MONDAY', date: '2030-06-30', description: 'WALKTHROUGH-PRIVATE-DESCRIPTION', criteria: 'Works' } })).json.created;
  // The next message to this person with this subject, once the server has sent it.
  const seen = new Set();
  const nextMail = async (to, subject, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { const m = mail.find(x => !seen.has(x) && x.to[0] === to && subject.test(x.subject)); if (m) { seen.add(m); return m; } await sleep(100); }
    throw new Error(`no email to ${to} matching ${subject}: got ${mail.map(m => `${m.to[0]} ${m.subject}`).join(' | ')}`);
  };
  const linkOf = m => /href="([^"]+)"/.exec(m.html)[1].replace(/&amp;/g, '&');
  const buttonOf = m => />([^<]+)<\/a>/.exec(m.html)[1];
  const opened = (P, id) => waitFor(P, `!document.querySelector('#overlay').hidden && __w.text().includes(${JSON.stringify(id)}) && !!document.querySelector('#ns-title')`);
  const nextStep = P => P.w(`document.querySelector('#ns-title').textContent`);
  const follow = async (P, m, id) => { await P.nav(linkOf(m)); await P.settle(); return opened(P, id); };
  const primary = async P => { await P.do(`__w.click('#ns-primary')`); };

  try {
    section = 'accounts';
    await signIn(ADMIN, 1, 'Alma Admin'); await signIn(DEV, 2, 'Dante Developer'); await signIn(REQ, 3, 'Rosa Requestor'); await signIn(OTHER, 4, 'Omar Other');
    await users.updateOne({ email: 'staff1@jarc.example' }, { $set: { role: 'Admin' } });
    await users.updateOne({ email: 'staff2@jarc.example' }, { $set: { role: 'Developer' } });
    await reload(ADMIN); await reload(DEV);
    const devId = String((await users.findOne({ email: 'staff2@jarc.example' }))._id);
    check('Admin, Developer, and Requestor are separate signed-in accounts', await ADMIN.w(`JARC_SESSION.role==='Admin'`) && await DEV.w(`JARC_SESSION.role==='Developer'`) && await REQ.w(`JARC_SESSION.role==='Requestor'`));

    section = 'settings';
    await REQ.do(`__w.click('#settings')`);
    await waitFor(REQ, `!!document.querySelector('#prefs-form')`);
    check('Settings offers action email (on) and reminder email (off)', await REQ.w(`document.querySelector('[name=emailActions]').checked && !document.querySelector('[name=emailReminders]').checked`));
    check('Settings says email is on and replies are not comments', await REQ.w(`__w.text().includes('Email delivery is on') && __w.text().includes('replies do not become comments')`));
    await REQ.shot('email-01-settings.png');
    await reload(REQ);

    section = 'assignment email';
    const project = await submit(REQ, 'Regional dashboard', 'Project');
    await act(ADMIN, project, 'assign', { dev: devId, priority: 'High' });
    const assigned = await nextMail('staff2@jarc.example', /Assigned to you/);
    check('it goes to the worker, from the app sender', assigned.from === 'JarcTech Ticket <tickets@jarc.example>' && assigned.subject.startsWith(project));
    check('it names who acted and the request', assigned.text.includes('Alma Admin assigned') && assigned.text.includes('Regional dashboard'));
    check('it holds no description', !JSON.stringify(assigned).includes('WALKTHROUGH-PRIVATE'));
    check('replies go to the Admin who acted', assigned.reply_to === 'staff1@jarc.example');
    check('the link uses the configured origin', linkOf(assigned) === `${origin}/?request=${project}`);
    check('the button says Open request', buttonOf(assigned) === 'Open request');
    const before = (await ticket(project)).version;
    check('the signed-in worker lands on the request', await follow(DEV, assigned, project));
    check('the page address is cleaned up', await DEV.w(`location.search===''`));
    check('the next action is scheduling the meeting', await nextStep(DEV) === 'Schedule the requirements meeting', await nextStep(DEV));
    check('opening the link changed nothing', (await ticket(project)).version === before);
    await DEV.shot('email-02-assignment-link.png');

    section = 'meeting email';
    await primary(DEV);
    await DEV.do(`__w.set('#meeting-form [name=meeting]','2030-03-05T14:30');__w.set('#meeting-form [name=location]','Room 2');__w.submit('#meeting-form')`);
    const proposed = await nextMail('staff3@jarc.example', /meeting proposed/i);
    check('the Requestor is told, with Manila time', /Mar 5, 2030.*2:30.*PM.*\(Asia\/Manila\)/.test(proposed.text), proposed.text);
    check('it says it is not a calendar invitation', proposed.text.includes('not a calendar invitation') && !proposed.attachments);
    check('the button says View meeting', buttonOf(proposed) === 'View meeting');

    section = 'signed out, and back to the exact request';
    await OUTSIDE.nav(linkOf(proposed));
    check('a signed-out person reaches the sign-in page', await OUTSIDE.w(`location.pathname==='/auth/signin' && !window.JARC_SESSION`));
    check('nothing about the request is shown before sign-in', await OUTSIDE.w(`!document.body.innerText.includes('Regional dashboard')`));
    check('the page explains what happens next', await OUTSIDE.w(`document.body.innerText.includes('the request from your email opens')`));
    await OUTSIDE.shot('email-03-sign-in.png');
    entra.signInNext(account(3, 'Rosa Requestor'));
    await OUTSIDE.loads(() => OUTSIDE.w(`document.querySelector('a.primary').click();true`));
    await OUTSIDE.settle();
    check('after Microsoft sign-in they land on that request', await opened(OUTSIDE, project));
    check('and the next action is confirming the meeting', await nextStep(OUTSIDE) === 'Confirm the requirements meeting');
    await OUTSIDE.shot('email-04-after-sign-in.png');
    await primary(OUTSIDE);
    check('confirming happens in the app, by a button', (await ticket(project)).meetingConfirmed === true);

    const confirmedMail = await nextMail('staff2@jarc.example', /meeting confirmed/i);
    check('the worker hears the meeting is confirmed', confirmedMail.text.includes('Rosa Requestor confirmed'));
    check('it leads to recording the agreement', await follow(DEV, confirmedMail, project) && await nextStep(DEV) === 'Record the agreement', await nextStep(DEV));

    section = 'agreement email';
    await primary(DEV);
    await DEV.do(`__w.set('#agreement-form [name=notes]','Met.');__w.set('#agreement-form [name=requirements]','A dashboard by region.');__w.set('#agreement-form [name=criteria]','Totals match.');__w.submit('#agreement-form')`);
    const agreement = await nextMail('staff3@jarc.example', /Agreement ready/);
    check('the Requestor is asked to confirm, without the requirements', !JSON.stringify(agreement).includes('A dashboard by region'));
    check('it leads to confirming the agreement', await follow(REQ, agreement, project) && await nextStep(REQ) === 'Confirm the agreement', await nextStep(REQ));
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#confirm-agreement')`);
    const workerSide = await nextMail('staff2@jarc.example', /Agreement ready/);
    check('then the worker, who has not confirmed yet', await follow(DEV, workerSide, project) && await DEV.w(`!!document.querySelector('#confirm-agreement')`));
    await DEV.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#confirm-agreement')`);
    check('the agreement locks as before', (await ticket(project)).agreements[0].version === 1);

    section = 'completed work, return, closure';
    const work = await submit(REQ, 'Fix the export', 'Ticket');
    await act(ADMIN, work, 'assign', { dev: devId, priority: 'Medium' });
    await nextMail('staff2@jarc.example', /Assigned to you/);
    await act(DEV, work, 'status', { status: 'In progress' });
    await act(DEV, work, 'add-evidence', { links: [{ url: 'https://example.com/proof' }] });
    await act(DEV, work, 'worker-complete', { summary: 'Delivered and tested' });
    const review = await nextMail('staff3@jarc.example', /ready for your review/);
    check('the button says Review completed work', buttonOf(review) === 'Review completed work');
    check('it holds no evidence or summary', !JSON.stringify(review).includes('example.com/proof') && !JSON.stringify(review).includes('Delivered and tested'));
    check('it leads to reviewing the evidence', await follow(REQ, review, work) && await nextStep(REQ) === 'Review the evidence and confirm completion', await nextStep(REQ));
    await REQ.shot('email-05-review-link.png');
    await act(REQ, work, 'reason', { status: 'In progress', reason: 'The totals are wrong' });
    const returned = await nextMail('staff2@jarc.example', /Returned for correction/);
    check('a return goes to the worker, without the reason', !JSON.stringify(returned).includes('totals are wrong'));
    check('it leads back to the work', await follow(DEV, returned, work));
    await act(DEV, work, 'worker-complete', { summary: 'Fixed' });
    const again = await nextMail('staff3@jarc.example', /ready for your review/);
    await follow(REQ, again, work);
    await REQ.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('#requestor-confirm')`);
    check('the Requestor confirms in the app', Boolean((await ticket(work)).completion.requestor));
    const closable = await nextMail('staff1@jarc.example', /Ready for closure/);
    check('it leads the Admin to closing it', await follow(ADMIN, closable, work) && await nextStep(ADMIN) === 'Close the request', await nextStep(ADMIN));
    await ADMIN.do(`for(const d of document.querySelectorAll('details'))d.open=true;__w.click('[data-action="Closed"]')`);
    check('the Admin closes it in the app', (await ticket(work)).status === 'Closed');
    const closedReq = await nextMail('staff3@jarc.example', /Request closed/), closedDev = await nextMail('staff2@jarc.example', /Request closed/);
    check('closure reaches the Requestor and the worker', closedReq.to.length === 1 && closedDev.to.length === 1);
    await sleep(800);
    check('and not the Admin who closed it', !mail.some(m => m.to[0] === 'staff1@jarc.example' && /Request closed/.test(m.subject)));

    section = 'access';
    await OTHER.nav(linkOf(review));
    await OTHER.settle();
    check('a forwarded link shows a clear message, not the request', await waitFor(OTHER, `!!document.querySelector('#request-link-problem')`) && await OTHER.w(`__w.text().includes('may have been deleted, or your access may have changed') && !document.body.innerText.includes('Fix the export')`));
    await OTHER.shot('email-06-no-access.png');
    const reassigned = await submit(REQ, 'Move the printer', 'Ticket');
    await act(ADMIN, reassigned, 'assign', { dev: devId, priority: 'Low' });
    const oldLink = await nextMail('staff2@jarc.example', /Assigned to you/);
    await act(ADMIN, reassigned, 'assign', { dev: String((await users.findOne({ email: 'staff1@jarc.example' }))._id), priority: 'Low' });
    await DEV.nav(linkOf(oldLink));
    await DEV.settle();
    check('a worker who was reassigned sees the message too', await waitFor(DEV, `!!document.querySelector('#request-link-problem')`));
    await reload(ADMIN);
    const archive = await api(ADMIN, 'POST', `/api/v1/work/tickets/${work}/archive`, { version: (await ticket(work)).version });
    check('an Admin can archive it', archive.status === 200);
    await REQ.nav(linkOf(review)); await REQ.settle();
    check('an archived request is not available to the Requestor', await waitFor(REQ, `!!document.querySelector('#request-link-problem')`));
    await ADMIN.nav(linkOf(closable)); await ADMIN.settle();
    check('an Admin still opens it from the link, marked archived', await waitFor(ADMIN, `!!document.querySelector('.archived-banner')`));
    const removed = await api(ADMIN, 'POST', `/api/v1/work/tickets/${work}/delete`, { version: (await ticket(work)).version, confirm: work });
    check('an Admin can delete it', removed.status === 200);
    await reload(ADMIN);
    await ADMIN.nav(linkOf(closable)); await ADMIN.settle();
    check('a deleted request gives a clear message, even to an Admin', await waitFor(ADMIN, `!!document.querySelector('#request-link-problem')`));
    await reload(ADMIN);

    section = 'Admin delivery status';
    provider = () => ({ status: 422, json: async () => ({ name: 'invalid_parameter' }) });
    const failing = await submit(REQ, 'Failing message', 'Ticket');
    await act(ADMIN, failing, 'assign', { dev: devId, priority: 'Low' });
    await nextMail('staff2@jarc.example', /Assigned to you/);
    await sleep(600);
    check('a provider failure does not affect the saved action', (await ticket(failing)).devId === devId);
    check('the in-app notification is still there', Boolean(await db.collection('notifications').findOne({ record: failing, inbox: `user:${devId}` })));
    check('a Requestor cannot read delivery status', (await api(OTHER, 'GET', '/api/v1/work/email')).status === 403);
    await ADMIN.do(`__w.click('#manage-users')`);
    await waitFor(ADMIN, `!!document.querySelector('#email-delivery')`);
    await ADMIN.w(`document.querySelector('#email-delivery').open=true;true`);
    await waitFor(ADMIN, `!!document.querySelector('[data-email-retry]')`);
    const panel = `document.querySelector('#email-delivery').textContent`;
    check('the Users screen shows queued, accepted, failed, and suppressed', await ADMIN.w(`/Queued \\d+ · Accepted \\d+ · Failed 1 · Suppressed \\d+/.test(${panel})`), await ADMIN.w(panel));
    check('it says acceptance is not proof of delivery', await ADMIN.w(`${panel}.includes('does not prove it reached the inbox')`));
    check('it shows names, not addresses', await ADMIN.w(`!${panel}.includes('@jarc.example') && ${panel}.includes('Dante Developer')`));
    check('it shows the provider error name', await ADMIN.w(`${panel}.includes('invalid_parameter')`));
    await ADMIN.shot('email-07-delivery-status.png');
    provider = () => ({ status: 200, json: async () => ({ id: 'stub-retry' }) });
    await ADMIN.w(`document.querySelector('[data-email-retry]').click();true`);
    const retried = await nextMail('staff2@jarc.example', /Assigned to you/);
    check('Retry sends the failed message', retried.subject.startsWith(failing));
    await waitFor(ADMIN, `!document.querySelector('[data-email-retry]')`);
    await sleep(800);
    check('and only once', mail.filter(m => m === retried || (m.subject === retried.subject && m.to[0] === retried.to[0])).length === 2 && (await outbox.findOne({ ticket: failing })).status === 'sent');
    await ADMIN.w(`document.querySelector('#email-test').click();true`);
    const test = await nextMail('staff1@jarc.example', /Test message/);
    check('a test message goes to the Admin who asked', test.to.length === 1 && !test.subject.includes('JRC-'));
    await ADMIN.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    check('the status panel fits a phone', await ADMIN.w(`__w.overflow()<=1`));
    await ADMIN.cdp.send('Emulation.clearDeviceMetricsOverride');

    section = 'the email itself';
    await OTHER.cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await OTHER.cdp.send('Page.setDocumentContent', { frameId: (await OTHER.cdp.send('Page.getFrameTree')).frameTree.frame.id, html: proposed.html });
    await sleep(300);
    check('the message renders with one button', await OTHER.w(`document.querySelectorAll('a').length===1 && document.querySelector('a').textContent==='View meeting'`));
    check('it has no scripts or images', await OTHER.w(`!document.querySelector('script,img')`));
    await OTHER.shot('email-08-message.png');
    await OTHER.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    check('the message fits a phone', await OTHER.w(`__w.overflow()<=1`));
    await OTHER.shot('email-09-message-phone.png');
    await OTHER.cdp.send('Emulation.clearDeviceMetricsOverride');

    section = 'page health';
    for (const [P, who] of [[ADMIN, 'Admin'], [DEV, 'Developer'], [REQ, 'Requestor'], [OUTSIDE, 'signed-out person']]) {
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
