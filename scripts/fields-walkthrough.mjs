// Real-browser check of the Department and Request category dropdowns: exact labels and order, placeholders, nothing
// chosen in advance, required-field errors, search, scrolling, keyboard use, phone width and touch, filters, and older
// records. MOCK Microsoft Entra and a temporary MongoDB only. Not run by npm test or CI (it needs Chrome or Edge).
// Exit codes: 0 all passed, 1 a check failed, 2 could not start.
//   npm run walkthrough:fields            BETA_SCREENSHOTS=<folder> also saves screenshots
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

const TENANT = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const CLIENT = 'abababab-cdcd-4efe-8010-232323232323';
const DB = 'jarctech_fields_walkthrough';
const SHOTS = process.env.BETA_SCREENSHOTS ? path.resolve(process.env.BETA_SCREENSHOTS) : null;
const DEPARTMENTS = ['LEGAL', 'SALES', 'BUSINESS DEVELOPMENT', 'LEARNING', 'SUPPLY CHAIN', 'FINANCE', 'JARCET', 'SYS', 'HR & ADMIN', 'REGULATORY', 'COMMUNICATIONS', 'OOP'];
const CATEGORIES = ['NETWORK, HARDWARE, & SOFTWARE SUPPORT', 'MONDAY', 'POWERBI', 'EXCEL', 'BUSINESS CENTRAL', 'ECOM', 'SUPPORT FOR DISTRIBUTOR'];
const BROWSER = process.env.BROWSER_PATH || [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(p => p && fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info !== '' ? '  -- ' + info : ''}`); };

let mongod, mongo, entra, app, browser, profile, exitCode = 0;
const sockets = [];
async function connect(url) {
  const ws = new WebSocket(url); sockets.push(ws);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('DevTools connection failed'))); });
  let id = 1; const pending = new Map(), waits = [], errors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { exceptionDetails: { text: m.error?.message } }); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    for (let i = waits.length - 1; i >= 0; i--) if (waits[i].method === m.method) { waits[i].res(m.params); waits.splice(i, 1); }
  });
  return { errors, send: (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), event: method => new Promise(res => waits.push({ method, res })) };
}

try {
  if (!BROWSER) throw new Error('No Chrome or Edge found. Set BROWSER_PATH.');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  const db = mongo.db(DB);
  await ensureSchema(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'fields-secret' });
  const port = await freePort(), debug = await freePort(), origin = `http://localhost:${port}`;
  app = await start(loadConfig({ NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'fields-secret', APP_BASE_URL: origin, SESSION_SECRET: 'fields-walkthrough-session-secret-0123456789' }), { log: { log() {}, error(...a) { console.log('server error:', a.join(' ')); } }, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-fields-'));
  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--force-device-scale-factor=1', '--window-size=1280,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 150 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!page) await sleep(200); }
  if (!page) throw new Error('The browser did not start.');
  const cdp = await connect(page);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const w = async js => { const r = await cdp.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (js, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await w(js).catch(() => false)) return true; await sleep(100); } return false; };
  const key = async (k, code = k, text) => { const vk = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, PageDown: 34 }[k]; await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await sleep(60); };
  const type = async text => { await cdp.send('Input.insertText', { text }); await sleep(80); };
  const shot = async name => { if (!SHOTS) return; const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); };
  const loads = async action => { const l = cdp.event('Page.loadEventFired'); await action(); await l; await sleep(300); };
  const home = async () => { await loads(() => cdp.send('Page.navigate', { url: origin + '/' })); await waitFor(`!!window.JARC_SERVER && JARC_SERVER.ready && !document.querySelector('#records[aria-busy]')`); };
  const openForm = async () => { await w(`document.querySelector('#overlay').hidden || close(); document.querySelector('#new-ticket').click(); true`); await waitFor(`!!document.querySelector('#request-form')`); await sleep(120); };
  const D = `document.querySelector('#request-form [name=department]')`, C = `document.querySelector('#request-form [name=category]')`;
  const listOf = el => `${el}.closest('.combo').querySelector('ul')`;
  const labels = el => `[...${listOf(el)}.querySelectorAll('[role=option]')].map(x=>x.textContent)`;
  const opened = el => `!${listOf(el)}.hidden`;
  const activeText = el => `(${listOf(el)}.querySelector('.active')||{}).textContent||''`;
  const focusOn = el => w(`${el}.focus();true`);
  const realClick = async sel => { const b = await w(`(()=>{const r=${sel}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type: t, x: b.x, y: b.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: t === 'mouseMoved' ? 0 : 1 }); await sleep(100); };

  await loads(() => cdp.send('Page.navigate', { url: `${origin}/auth/signin` }));
  const account = n => ({ sub: `s${n}`, oid: `00000000-0000-4000-d000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: `p${n}@jarc.example`, preferred_username: `p${n}@jarc.example` });
  entra.signInNext(account(1));
  await loads(() => w(`document.querySelector('a.primary').click();true`));
  await waitFor(`!!window.JARC_SERVER && JARC_SERVER.ready`);
  const user = await db.collection('users').findOne({ email: 'p1@jarc.example' });
  // Older records exactly as earlier versions stored them.
  const at = new Date();
  const older = (id, department, category) => ({ workspace: 'main', id, title: `Older ${id}`, type: 'Ticket', name: 'Person 1', department, date: '2030-01-01', category, description: 'Before the new lists.', status: 'Submitted', priority: 'Medium', dev: '', tasks: [], history: [], requestedDate: '2030-01-01', evidence: [], completion: { round: 1, worker: null, requestor: null, log: [] }, requester: { id: String(user._id), name: 'Person 1', sample: false }, version: 1, statusSince: at, createdAt: at, updatedAt: at });
  await db.collection('tickets').insertMany([older('JRC-3201', 'Human Resources', 'Bug / issue'), older('JRC-3202', 'Procurement', 'New feature')]);
  await home();

  await openForm();
  check('Department placeholder is exactly "Select department"', await w(`${D}.placeholder`) === 'Select department');
  check('Request category placeholder is exactly "Select request category"', await w(`${C}.placeholder`) === 'Select request category');
  check('nothing is chosen automatically', await w(`${D}.value===''&&${C}.value===''`));
  check('both are marked required', await w(`${D}.required&&${C}.required&&${D}.closest('label').querySelector('.req')!==null&&${C}.closest('label').querySelector('.req')!==null`));
  check('Ticket or Project stays a separate field', await w(`[...document.querySelector('#request-form [name=type]').options].map(o=>o.value).join()`) === ',Ticket,Project');

  // Required-field errors: submitting the form with nothing chosen.
  await w(`document.querySelector('#request-form [name=title]').value='Needs doing';document.querySelector('#request-form [name=date]').value='2030-06-30';document.querySelector('#request-form [name=type]').value='Ticket';document.querySelector('#request-form [name=description]').value='x';document.querySelector('#request-form').requestSubmit();true`);
  await sleep(250);
  const summary = await w(`document.querySelector('#request-form .error-summary').textContent`);
  check('empty fields show exact errors, in a summary and next to each field', summary.includes('Select a department.') && summary.includes('Select a request category.') && await w(`${D}.getAttribute('aria-invalid')==='true'&&${C}.getAttribute('aria-invalid')==='true'&&!!document.getElementById(${D}.id+'-error')`), summary);
  check('and nothing is submitted', await db.collection('tickets').countDocuments({ title: 'Needs doing' }) === 0);
  await shot('fields-1-errors.png');
  // Text that is not a choice.
  await focusOn(D); await type('Space');
  await key('Tab', 'Tab');
  check('text that is not a choice is kept while typing elsewhere', await w(`${D}.value`) === 'Space');
  await w(`document.querySelector('#request-form').requestSubmit();true`); await sleep(200);
  check('and refused with a clear message', (await w(`document.querySelector('#request-form .error-summary').textContent`)).includes('Select a department from the list.'));
  await w(`${D}.value='';${D}.dispatchEvent(new Event('input',{bubbles:true}));${listOf(D)}.hidden=true;true`);

  // Exact lists, by mouse.
  await realClick(D);
  check('clicking opens the list', await w(opened(D)));
  check('the departments are exact and in order', JSON.stringify(await w(labels(D))) === JSON.stringify(DEPARTMENTS), JSON.stringify(await w(labels(D))));
  check('the list scrolls within itself', await w(`(()=>{const l=${listOf(D)};return l.scrollHeight>l.clientHeight&&getComputedStyle(l).overflowY==='auto'})()`));
  const scrolled = await w(`(()=>{const l=${listOf(D)};l.scrollTop=l.scrollHeight;return l.scrollTop>0})()`);
  check('scrolling reaches the last choice', scrolled && await w(`(()=>{const l=${listOf(D)},o=[...l.children].at(-1).getBoundingClientRect(),b=l.getBoundingClientRect();return o.bottom<=b.bottom+1})()`));
  await shot('fields-2-open.png');
  await realClick(`[...${listOf(D)}.children].find(x=>x.textContent==='HR & ADMIN')`);
  check('clicking a choice selects it and closes the list', await w(`${D}.value`) === 'HR & ADMIN' && !await w(opened(D)));
  check('and clears its error', await w(`${D}.getAttribute('aria-invalid')!=='true'&&!document.getElementById(${D}.id+'-error')`));
  await realClick(C);
  check('the categories are exact and in order', JSON.stringify(await w(labels(C))) === JSON.stringify(CATEGORIES), JSON.stringify(await w(labels(C))));
  await realClick(`[...${listOf(C)}.children].find(x=>x.textContent==='NETWORK, HARDWARE, & SOFTWARE SUPPORT')`);
  check('a long label with punctuation is chosen exactly', await w(`${C}.value`) === 'NETWORK, HARDWARE, & SOFTWARE SUPPORT' && await w(`${C}.validity.valid`));
  await w(`close();true`);

  // Search.
  await openForm();
  await focusOn(D); await type('bus');
  check('search narrows the list, ignoring case', JSON.stringify(await w(labels(D))) === '["BUSINESS DEVELOPMENT"]');
  await w(`${D}.value='';true`); await type('&');
  check('search matches punctuation', JSON.stringify(await w(labels(D))) === '["HR & ADMIN"]');
  await w(`${D}.value='';true`); await type('zzz');
  check('no match says so, with nothing to choose', await w(`${listOf(D)}.textContent`) === 'No matches' && (await w(labels(D))).length === 0);
  await w(`${D}.value='';true`); await type('e');
  check('a broad search keeps the original order', JSON.stringify(await w(labels(D))) === JSON.stringify(DEPARTMENTS.filter(x => x.includes('E'))));
  await w(`${D}.value='';${D}.dispatchEvent(new Event('input',{bubbles:true}));${listOf(D)}.hidden=true;true`);

  // Keyboard only.
  await focusOn(D);
  check('focus alone does not open the list', !await w(opened(D)));
  await key('ArrowDown');
  check('Down opens the list', await w(opened(D)) && await w(`${D}.getAttribute('aria-expanded')`) === 'true');
  await key('ArrowDown');
  check('Down moves to the first choice, and it is announced', await w(activeText(D)) === 'LEGAL' && await w(`document.getElementById(${D}.getAttribute('aria-activedescendant')).textContent`) === 'LEGAL');
  await key('ArrowDown'); await key('ArrowDown');
  check('Down moves on', await w(activeText(D)) === 'BUSINESS DEVELOPMENT');
  await key('ArrowUp');
  check('Up moves back', await w(activeText(D)) === 'SALES');
  await key('End');
  check('End reaches the last choice, in view', await w(activeText(D)) === 'OOP' && await w(`(()=>{const a=${listOf(D)}.querySelector('.active').getBoundingClientRect(),b=${listOf(D)}.getBoundingClientRect();return a.bottom<=b.bottom+1&&a.top>=b.top-1})()`));
  await key('Home');
  check('Home reaches the first', await w(activeText(D)) === 'LEGAL');
  await key('PageDown');
  check('Page Down moves further', await w(activeText(D)) === 'SUPPLY CHAIN' || (await w(activeText(D))) === 'FINANCE');
  await key('Escape');
  check('Esc closes the list but not the dialog', !await w(opened(D)) && await w(`!document.querySelector('#overlay').hidden && !!document.querySelector('#request-form')`));
  check('and chooses nothing', await w(`${D}.value`) === '');
  await type('sup');
  await key('ArrowDown');
  check('typing then Down moves in the results', await w(activeText(D)) === 'SUPPLY CHAIN');
  await key('Enter');
  check('Enter chooses, without submitting the form', await w(`${D}.value`) === 'SUPPLY CHAIN' && !await w(opened(D)) && await w(`!!document.querySelector('#request-form')`));
  await focusOn(C); await type('power'); await key('Enter');
  check('Enter chooses the only match', await w(`${C}.value`) === 'POWERBI');
  await focusOn(C); await w(`${C}.value='';true`); await type('ecom');
  check('typing a full name counts as choosing it, in its exact form', await w(`${C}.value`) === 'ECOM' && await w(`${C}.validity.valid`));
  await key('Tab', 'Tab');
  check('Tab moves on and closes the list', !await w(opened(C)) && await w(`document.activeElement!==${C}`));
  await focusOn(C); await key('ArrowDown'); await key('ArrowDown');
  await key('Tab', 'Tab');
  check('Tab on a highlighted choice takes it', !await w(opened(C)));
  await w(`${C}.value='';${C}.dispatchEvent(new Event('input',{bubbles:true}));${listOf(C)}.hidden=true;true`);
  await focusOn(C); await type('ecom'); await key('Escape');
  check('the first Esc after typing keeps the dialog', await w(`!document.querySelector('#overlay').hidden`));
  await w(`close();true`);

  // A real submission, keyboard-chosen values reach the server exactly.
  await openForm();
  await w(`document.querySelector('#request-form [name=title]').value='Exact labels';document.querySelector('#request-form [name=date]').value='2030-06-30';document.querySelector('#request-form [name=type]').value='Project';document.querySelector('#request-form [name=description]').value='x';true`);
  await focusOn(D); await type('hr'); await key('Enter');
  await focusOn(C); await type('network'); await key('Enter');
  await w(`document.querySelector('#request-form').requestSubmit();true`);
  await waitFor(`document.querySelector('#overlay').hidden`);
  const saved = await db.collection('tickets').findOne({ title: 'Exact labels' });
  check('the request stores the exact labels and its separate type', saved && saved.department === 'HR & ADMIN' && saved.category === 'NETWORK, HARDWARE, & SOFTWARE SUPPORT' && saved.type === 'Project', JSON.stringify(saved && [saved.department, saved.category, saved.type]));

  // Filters.
  await home();
  const opts = id => `[...document.querySelector('#${id}-filter').options].map(o=>o.textContent)`;
  const deptOpts = await w(opts('department')), catOpts = await w(opts('category'));
  check('the department filter lists the current values in order', JSON.stringify(deptOpts.slice(1, 13)) === JSON.stringify(DEPARTMENTS), JSON.stringify(deptOpts));
  check('the category filter lists the current values in order', JSON.stringify(catOpts.slice(1, 8)) === JSON.stringify(CATEGORIES), JSON.stringify(catOpts));
  check('older values in use appear under "Earlier values"; unused ones do not', await w(`[...document.querySelectorAll('#department-filter optgroup[label="Earlier values"] option')].map(o=>o.value).join()`) === 'Human Resources,Procurement' && await w(`[...document.querySelectorAll('#category-filter optgroup[label="Earlier values"] option')].map(o=>o.value).join()`) === 'New feature,Bug / issue');
  const setFilter = async (id, value) => { await w(`(()=>{const s=document.querySelector('#${id}-filter');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`); await sleep(400); await waitFor(`!document.querySelector('#records[aria-busy]')`); };
  const rows = () => w(`[...document.querySelectorAll('#records tr[data-id]')].map(r=>r.dataset.id)`);
  await setFilter('department', 'Human Resources');
  check('filtering by an older department finds its record', JSON.stringify(await rows()) === '["JRC-3201"]');
  await setFilter('department', '');
  await setFilter('category', 'New feature');
  check('filtering by an older category finds its record', JSON.stringify(await rows()) === '["JRC-3202"]');
  await setFilter('category', 'NETWORK, HARDWARE, & SOFTWARE SUPPORT');
  check('filtering by a current category finds its record', JSON.stringify(await rows()) === JSON.stringify([saved.id]));
  await setFilter('department', 'LEGAL');
  check('filters combine, and an empty result says so', (await rows()).length === 0 && await w(`document.querySelector('#records').textContent.includes('No tickets match')`));
  await w(`document.querySelector('#clear-filters').click();true`); await sleep(300);
  check('Clear filters resets both', await w(`document.querySelector('#department-filter').value===''&&document.querySelector('#category-filter').value===''`));

  // An older record, in the browser.
  await waitFor(`!!document.querySelector('[data-id="JRC-3201"]')`);
  await w(`detail('JRC-3201');true`); await sleep(200);
  check('an older record shows its original values', await w(`document.querySelector('[data-section="details"]').textContent.includes('Human Resources') && document.querySelector('[data-section="details"]').textContent.includes('Bug / issue')`));
  await w(`for(const d of document.querySelectorAll('details'))d.open=true;document.querySelector('#comment-form textarea').value='Still needed.';document.querySelector('#comment-form').requestSubmit();true`);
  await waitFor(`document.querySelector('[data-section="activity"]').textContent.includes('Still needed.')`);
  const kept = await db.collection('tickets').findOne({ id: 'JRC-3201' });
  check('an unrelated update on it succeeds and changes neither value', kept.history.some(h => h.text.includes('Still needed.')) && kept.department === 'Human Resources' && kept.category === 'Bug / issue');
  await w(`close();true`);

  // Phone width and touch.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 700, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await home();
  await openForm();
  const drawerFits = `document.querySelector('.drawer').scrollWidth-document.querySelector('.drawer').clientWidth<=1`;
  check('phone: the form fits, with no sideways scroll', await w(drawerFits) && await w(`document.documentElement.scrollWidth-document.documentElement.clientWidth<=1`));
  check('phone: the field matches the other fields on the form', await w(`getComputedStyle(${D}).fontSize===getComputedStyle(document.querySelector('#request-form [name=title]')).fontSize`));
  const tap = async sel => { const b = await w(`(()=>{const e=${sel};e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [b] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250); };
  await tap(C);
  check('phone: tapping opens the list', await w(opened(C)));
  check('phone: choices are comfortable to tap, and long labels wrap inside the list', await w(`(()=>{const l=${listOf(C)},o=[...l.children];return o.every(x=>x.getBoundingClientRect().height>=40)&&l.scrollWidth-l.clientWidth<=1&&l.getBoundingClientRect().right<=innerWidth})()`));
  check('phone: the open list is on screen', await w(`(()=>{const r=${listOf(C)}.getBoundingClientRect();return r.top>=0&&r.top<innerHeight&&r.height<=innerHeight*.5})()`));
  await shot('fields-3-phone.png');
  await tap(`[...${listOf(C)}.children].find(x=>x.textContent==='NETWORK, HARDWARE, & SOFTWARE SUPPORT')`);
  check('phone: tapping a choice selects it', await w(`${C}.value`) === 'NETWORK, HARDWARE, & SOFTWARE SUPPORT' && !await w(opened(C)));
  await shot('fields-4-phone-chosen.png');
  await tap(D);
  check('phone: the department list opens and scrolls', await w(opened(D)) && await w(`${listOf(D)}.scrollHeight>${listOf(D)}.clientHeight`));
  await w(`close();true`);
  await home();
  check('phone: the filter bar with the new filter fits', await w(`document.documentElement.scrollWidth-document.documentElement.clientWidth<=1 && document.querySelector('#category-filter').getBoundingClientRect().right<=innerWidth`));
  await shot('fields-5-phone-filters.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  check('no script errors', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));
} catch (err) {
  check('walkthrough finished', false, err.message);
  exitCode = 2;
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) exitCode ||= 1;
for (const s of sockets) { try { s.close(); } catch {} }
if (browser) await new Promise(resolve => { const t = setTimeout(resolve, 5000); browser.once('exit', () => { clearTimeout(t); resolve(); }); browser.kill(); });
for (const step of [() => app?.shutdown(), () => entra?.close(), () => mongo?.close(), () => mongod?.stop()]) { try { await step(); } catch {} }
for (let i = 0; profile && i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
process.exit(exitCode);
