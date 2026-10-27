// My workspace: the role model (Requestor, Developer, Admin), request types, locked agreements, evidence, and dual
// confirmation enforced on the server, simulation isolation, due-date reminders and
// escalation (controlled time), scheduler leases, and optional email. Mock Entra and a temporary MongoDB only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { createReminders } = require('../server/workspace/reminders.cjs');
const { createEmail } = require('../server/workspace/email.cjs');
const DeadlineCore = require('../public/deadline-core.js');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CLIENT = 'ffffffff-0000-4111-8222-333333333333';
const SECRET = 'work-access-mock-secret';
const DB = 'jarctech_work_access_test';
const DAY = 86400000;
let mongod, mongo, db, entra, port, origin, app;
const sent = []; // email provider calls
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  assert.match(mongod.getUri(), /^mongodb:\/\/127\.0\.0\.1:\d+\/$/);
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: origin, SESSION_SECRET: 'work-access-session-secret-0123456789abcdefg',
    EMAIL_DELIVERY: 'resend', EMAIL_FROM: 'JarcTech Ticket <tickets@jarc.example>', RESEND_API_KEY: 're_test_not_real'
  }), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false, emailFetch: async (url, opts) => { sent.push({ url, opts }); return { status: 200 }; } });
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

async function call(p, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, buf, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const send = (method, p, cookie, body) => call(p, { method, cookie, body, headers: { Origin: origin } });
const post = (p, cookie, body) => send('POST', p, cookie, body);
const person = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: `person${n}@jarc.example`, preferred_username: `person${n}@jarc.example` });
async function signIn(n) {
  const login = await call('/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(n)));
  const res = await call(back.pathname + back.search, { cookie: flow });
  const session = res.setCookies.find(c => c.startsWith('jt_session='));
  assert.ok(session, `person ${n} signed in`);
  return session.split(';')[0];
}
const userId = async n => String((await db.collection('users').findOne({ email: `person${n}@jarc.example` }))._id);
const W = '/api/v1/work';
const ws = async cookie => (await call(`${W}/workspace`, { cookie })).json;
const ticketOf = async (cookie, id) => (await call(`${W}/tickets/${id}`, { cookie }));
let rid = 0;
const requestId = () => `work-${++rid}-${Date.now()}`;
const request = (overrides = {}) => ({ title: 'WORKTEST request', type: 'Project', department: 'Finance', date: '2026-12-31', category: 'Enhancement', description: 'Work access test.', criteria: '', ...overrides });
async function act(cookie, id, action, input = {}, extra = {}) {
  const t = (await ticketOf(cookie, id)).json?.tickets?.[0];
  return post(`${W}/tickets/${id}/actions`, cookie, { version: t ? t.version : 1, action, input, ...extra });
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const upload = cookie => fetch(`http://127.0.0.1:${port}${W}/attachments`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'proof.png' }, body: PNG }).then(r => r.json());
const today = () => DeadlineCore.today(new Date(), 'Asia/Manila');


// Accounts: LEAD (first Admin, via admin:bootstrap), ADM (second Admin), DEV2 (Developer), REQ1 and REQ2 (Requestors).
let LEAD, ADM, DEV2, REQ1, REQ2, ids = {};
const usersApi = cookie => call('/api/v1/users', { cookie });
const task = (title, owner, end, start = today()) => ({ title, requirement: 'R', criteria: 'C', start, end, owner });
async function agree(worker, requestor, id) {
  assert.equal((await act(worker, id, 'schedule-meeting', { meeting: '2026-11-30T10:00', location: 'Room 1' })).status, 200);
  assert.equal((await act(requestor, id, 'confirm-meeting')).status, 200);
  assert.equal((await act(worker, id, 'record-agreement', { notes: 'Met.', requirements: 'R', criteria: 'C' })).status, 200);
  assert.equal((await act(worker, id, 'confirm-agreement')).status, 200);
  const locked = await act(requestor, id, 'confirm-agreement');
  assert.equal(locked.status, 200, JSON.stringify(locked.json)); assert.equal(locked.json.tickets[0].agreements.length, 1);
}

test('new members start as Requestors; nobody gains a staff role by signing in', async () => {
  LEAD = await signIn(1); ADM = await signIn(2); DEV2 = await signIn(3); REQ1 = await signIn(4); REQ2 = await signIn(5);
  const all = await db.collection('users').find({}).toArray();
  assert.equal(all.length, 5);
  assert.ok(all.every(u => u.role === 'Requestor' && u.status === 'active'), 'including the very first person');
  assert.equal((await usersApi(LEAD)).status, 403, 'no user management until the owner runs the first-Admin setup');
});

test('admin:bootstrap makes the identified, signed-in account the first Admin, bound to its Microsoft identity', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin-bootstrap.cjs'), ...args], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, JARCTECH_ENV_FILE: 'none', MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', code => resolve({ code, out }));
  });
  const wrong = await run(['--email', 'person1@jarc.example', '--confirm-db', DB, '--object-id', person(4).oid]);
  assert.equal(wrong.code, 1); assert.match(wrong.out, /different Microsoft account/);
  const ok = await run(['--email', 'person1@jarc.example', '--confirm-db', DB, '--object-id', person(1).oid]);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /from Requestor to Admin/);
  assert.equal((await usersApi(LEAD)).status, 200, 'applies to the open session at once');
  const again = await run(['--email', 'person4@jarc.example', '--confirm-db', DB, '--object-id', person(4).oid]);
  assert.equal(again.code, 1); assert.match(again.out, /already has an active Admin/);
});

test('only Admins manage users and roles; Developers and Requestors are refused on every endpoint', async () => {
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(2)}`, LEAD, { role: 'Admin' })).status, 200);
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(3)}`, LEAD, { role: 'Developer' })).status, 200);
  for (const [who, cookie] of [['Developer', DEV2], ['Requestor', REQ1]]) {
    assert.equal((await usersApi(cookie)).status, 403, `${who}: list`);
    assert.equal((await usersApi(cookie)).json.error, 'admin-only');
    assert.equal((await post('/api/v1/users', cookie, { email: 'new@jarc.example', role: 'Requestor' })).status, 403, `${who}: invite`);
    assert.equal((await send('PATCH', `/api/v1/users/${await userId(5)}`, cookie, { role: 'Admin' })).status, 403, `${who}: change role`);
    assert.equal((await send('PATCH', `/api/v1/users/${await userId(5)}`, cookie, { status: 'disabled' })).status, 403, `${who}: disable`);
  }
  assert.equal((await usersApi(ADM)).status, 200, 'any Admin manages users');
  assert.equal((await post('/api/v1/users', ADM, { email: 'invited@jarc.example', role: 'Developer' })).status, 201);
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(2)}`, ADM, { role: 'Requestor' })).json.error, 'cannot-change-self');
  const people = (await call(`${W}/people`, { cookie: ADM })).json.developers;
  assert.deepEqual(people.map(d => `${d.name}:${d.role}${d.self ? ':self' : ''}`), ['Person 3:Developer', 'Person 2:Admin:self'], 'an Admin assigns to active Developers or themselves');
  assert.deepEqual((await call(`${W}/people`, { cookie: DEV2 })).json.developers.map(d => d.name), ['Person 3'], 'Developers see Developers (task owners) only');
  assert.deepEqual((await call(`${W}/people`, { cookie: REQ1 })).json.developers, [], 'Requestors get no account list');
});

test('ownership comes from the session; Requestors see only their own requests, Developers only assigned work, everywhere', async () => {
  const made = await post(`${W}/tickets`, REQ1, { view: 'Admin', requestId: requestId(), input: request({ title: 'WORKTEST owned by R1', name: 'Person 5', requester: { id: await userId(5) } }) });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const t = made.json.tickets[0];
  ids.r1 = t.id;
  assert.equal(t.requester.id, await userId(4)); assert.equal(t.name, 'Person 4', 'browser-supplied owner and name ignored');
  assert.equal(t.history[0].view, 'Requestor', 'browser-supplied view ignored');
  assert.equal(t.type, 'Project');
  assert.match(t.id, /^JRC-2[0-9]{3}$/, 'numbered apart from the beta simulation');
  ids.r2 = (await post(`${W}/tickets`, REQ2, { requestId: requestId(), input: request({ title: 'WORKTEST owned by R2', type: 'Ticket' }) })).json.created;
  assert.ok(!(await ws(REQ2)).tickets.some(x => x.id === ids.r1), 'workspace');
  assert.equal((await ticketOf(REQ2, ids.r1)).status, 404, 'direct URL');
  assert.equal((await call(`${W}/search?q=${ids.r1}`, { cookie: REQ2 })).json.total, 0, 'search');
  assert.equal((await call(`${W}/search?q=WORKTEST`, { cookie: REQ2 })).json.total, 1);
  assert.equal((await post(`${W}/tickets/${ids.r1}/actions`, REQ2, { version: 1, action: 'comment', input: { comment: 'snooping' } })).status, 404, 'actions');
  assert.equal((await post(`${W}/tickets/${ids.r1}/actions`, REQ2, { version: 1, action: 'assign', view: 'Admin', input: { dev: await userId(5), priority: 'High' } })).status, 404, 'claiming a staff view changes nothing');
  assert.equal((await post(`${W}/tickets/${ids.r1}/changes`, REQ2, { requestId: requestId(), ticketVersion: 1, input: {} })).status, 404, 'linked changes');
  assert.ok(!(await ws(REQ2)).notices.some(n => n.text.includes(ids.r1)), 'activity feed');
  const file = (await upload(REQ1)).attachment;
  assert.equal((await act(REQ1, ids.r1, 'comment', { comment: 'Screenshot', attachments: [file.id] })).status, 200);
  for (const [who, cookie, status] of [['owner', REQ1, 200], ['other Requestor', REQ2, 404], ['Admin', ADM, 200], ['unassigned Developer', DEV2, 404]]) {
    assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie })).status, status, `download: ${who}`);
  }
  for (const cookie of [ADM, LEAD]) assert.ok((await ws(cookie)).tickets.some(x => x.id === ids.r1) && (await ws(cookie)).tickets.some(x => x.id === ids.r2), 'Admins see every request');
  assert.ok(!(await ws(DEV2)).tickets.some(x => x.id === ids.r1 || x.id === ids.r2), 'a Developer sees no unassigned work');
  assert.equal((await ticketOf(DEV2, ids.r1)).status, 404); assert.equal((await call(`${W}/search?q=WORKTEST`, { cookie: DEV2 })).json.total, 0);
  assert.ok((await call(`${W}/notifications`, { cookie: ADM })).json.items.some(n => n.record === ids.r1 && n.title === 'New request submitted'), 'shared Admin inbox');
  assert.ok(!(await call(`${W}/notifications`, { cookie: DEV2 })).json.items.some(n => n.record === ids.r1), 'Developers do not read the Admin inbox');
  assert.ok(!(await call(`${W}/notifications`, { cookie: REQ2 })).json.items.some(n => n.record === ids.r1), 'notifications');
  // A Developer's own request is theirs to see, like any Requestor's.
  ids.d1 = (await post(`${W}/tickets`, DEV2, { requestId: requestId(), input: request({ title: 'WORKTEST owned by DEV2', type: 'Ticket' }) })).json.created;
  assert.ok((await ws(DEV2)).tickets.some(x => x.id === ids.d1)); assert.equal((await ticketOf(REQ1, ids.d1)).status, 404);
});

test('an Admin assigns to an active Developer or themselves, and a self-assigned Admin does the Project delivery work', async () => {
  const adm = await userId(2);
  for (const bad of ['Miguel Santos', await userId(4), await userId(1), new ObjectId().toHexString()]) {
    const res = await act(ADM, ids.r1, 'assign', { dev: bad, priority: 'High' });
    assert.equal(res.status, 400, `refused: ${bad}`); assert.match(res.json.message, /active Developer, or assign it to yourself/);
  }
  assert.equal((await act(REQ1, ids.r1, 'assign', { dev: adm, priority: 'High' }, { view: 'Admin' })).status, 403, 'a Requestor cannot act as staff by claiming the view');
  const assigned = await act(ADM, ids.r1, 'assign', { dev: adm, priority: 'High' });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
  assert.equal(assigned.json.tickets[0].devId, adm); assert.equal(assigned.json.tickets[0].dev, 'Person 2'); assert.match(assigned.json.tickets[0].history.at(-1).text, /assigned it to themselves/);
  assert.equal((await call(`${W}/search?dev=${adm}`, { cookie: LEAD })).json.total, 1, 'assignee filter');
  assert.equal((await call(`${W}/search?dev=Unassigned&q=WORKTEST`, { cookie: LEAD })).json.total, 2);
  // Only the assigned worker does delivery work; another Admin manages but does not deliver.
  assert.equal((await act(LEAD, ids.r1, 'schedule-meeting', { meeting: '2026-11-30T10:00', location: 'Room 1' })).status, 403, 'not the worker');
  const due = DeadlineCore.addDays(today(), 3);
  assert.equal((await act(ADM, ids.r1, 'create-project', { projectName: 'WORKTEST project', date: due, tasks: [task('Build', 'Person 2', due)] })).status, 409, 'no project before the agreement');
  assert.equal((await act(ADM, ids.r1, 'schedule-meeting', { meeting: '2026-11-30T10:00', location: 'Room 1' })).status, 200);
  assert.equal((await act(ADM, ids.r1, 'confirm-meeting')).status, 403, 'only the owner confirms');
  assert.equal((await act(REQ1, ids.r1, 'confirm-meeting')).status, 200);
  assert.equal((await act(ADM, ids.r1, 'record-agreement', { notes: 'Met.', requirements: 'Reports', criteria: 'Totals match' })).status, 200);
  assert.equal((await act(REQ1, ids.r1, 'confirm-agreement')).status, 200);
  assert.equal((await act(LEAD, ids.r1, 'confirm-agreement')).status, 403, 'another Admin cannot confirm for either side');
  const locked = await act(ADM, ids.r1, 'confirm-agreement');
  assert.equal(locked.json.tickets[0].agreements[0].worker.id, adm); assert.equal(locked.json.tickets[0].agreements[0].requestor.id, await userId(4));
  const project = await act(ADM, ids.r1, 'create-project', { projectName: 'WORKTEST project', date: due, tasks: [task('Build', 'Person 2', due)] });
  assert.equal(project.status, 200, JSON.stringify(project.json));
  assert.equal(project.json.tickets[0].dueDate, due); assert.equal(project.json.tickets[0].requestedDate, '2026-12-31');
  assert.equal((await act(ADM, ids.r1, 'save-task', { index: null, task: task('Sample owner', 'Miguel Santos', due) })).status, 400, 'sample people are not task owners here');
  assert.equal((await act(ADM, ids.r1, 'save-task', { index: null, task: task('Review', 'Person 3', due) })).status, 200, 'an active Developer may own a task');
  assert.equal((await act(DEV2, ids.r1, 'toggle-task', { index: 0, done: true })).status, 404, 'a task owner who is not the assignee does not get the request');
  assert.equal((await act(ADM, ids.r1, 'status', { status: 'In progress' })).status, 200);
});

test('a Developer delivers a Ticket with evidence; the Requestor confirms independently; only an Admin closes', async () => {
  const dev2 = await userId(3);
  assert.equal((await act(DEV2, ids.r2, 'assign', { dev: dev2, priority: 'Medium' })).status, 404, 'not visible before assignment');
  assert.equal((await act(ADM, ids.r2, 'assign', { dev: dev2, priority: 'Medium' })).status, 200);
  assert.ok((await call(`${W}/notifications`, { cookie: DEV2 })).json.items.some(n => n.record === ids.r2 && n.title === 'Assigned to you'));
  assert.equal((await act(DEV2, ids.r2, 'assign', { dev: dev2, priority: 'High' })).status, 403, 'Developers have no assignment authority');
  assert.equal((await act(DEV2, ids.r2, 'status', { status: 'In progress' })).status, 200, 'a Ticket starts without a meeting');
  const other = (await upload(REQ2)).attachment;
  assert.equal((await act(DEV2, ids.r2, 'add-evidence', { attachments: [other.id] })).status, 409, 'only your own uploads can be evidence');
  assert.equal((await act(DEV2, ids.r2, 'worker-complete', { summary: 'Done.' })).status, 400, 'evidence is required');
  const proof = (await upload(DEV2)).attachment;
  const withEvidence = await act(DEV2, ids.r2, 'add-evidence', { attachments: [proof.id], links: [{ url: 'https://intranet.example/run/7', label: 'Run 7' }] });
  assert.equal(withEvidence.status, 200, JSON.stringify(withEvidence.json));
  assert.deepEqual(withEvidence.json.tickets[0].evidence.map(x => x.kind), ['link', 'file']);
  for (const [who, cookie, status] of [['Requestor', REQ2, 200], ['Admin', ADM, 200], ['worker', DEV2, 200], ['other Requestor', REQ1, 404]]) {
    assert.equal((await call(`${W}/attachments/${proof.id}/download`, { cookie })).status, status, `evidence download: ${who}`);
  }
  const done = await act(DEV2, ids.r2, 'worker-complete', { summary: 'Fixed and tested.' });
  assert.equal(done.json.tickets[0].completion.worker.id, dev2);
  assert.equal((await act(DEV2, ids.r2, 'requestor-confirm')).status, 403, 'the worker cannot confirm for the Requestor');
  assert.equal((await act(ADM, ids.r2, 'requestor-confirm')).status, 403, 'nor can an Admin when the Requestor is someone else');
  assert.equal((await act(ADM, ids.r2, 'status', { status: 'Closed' })).status, 409, 'one confirmation never closes');
  assert.equal((await act(REQ2, ids.r2, 'requestor-confirm')).status, 200);
  assert.ok((await call(`${W}/notifications`, { cookie: LEAD })).json.items.some(n => n.record === ids.r2 && n.title === 'Both confirmations recorded: ready for closure'));
  assert.equal((await act(DEV2, ids.r2, 'status', { status: 'Closed' })).status, 403, 'only an Admin closes');
  assert.equal((await act(REQ2, ids.r2, 'status', { status: 'Closed' })).status, 403);
  assert.equal((await act(ADM, ids.r2, 'status', { status: 'Closed' })).status, 200);
  assert.equal((await ticketOf(REQ2, ids.r2)).json.tickets[0].status, 'Closed');
  assert.equal((await call(`${W}/search?stage=closed&type=Ticket`, { cookie: LEAD })).json.items.map(t => t.id).join(), ids.r2, 'overview drill-through');
});

test('when the Requestor is also the worker, a different Admin confirms for the Requestor side', async () => {
  assert.equal((await act(ADM, ids.d1, 'assign', { dev: await userId(3), priority: 'Low' })).status, 200);
  assert.equal((await act(DEV2, ids.d1, 'status', { status: 'In progress' })).status, 200);
  assert.equal((await act(DEV2, ids.d1, 'add-evidence', { links: [{ url: 'https://example.com/d1' }] })).status, 200);
  assert.equal((await act(DEV2, ids.d1, 'worker-complete', { summary: 'Own request done.' })).status, 200);
  const self = await act(DEV2, ids.d1, 'requestor-confirm');
  assert.equal(self.status, 403); assert.match(self.json.message, /a different Admin must confirm it independently/);
  const review = await act(LEAD, ids.d1, 'requestor-confirm');
  assert.equal(review.status, 200, JSON.stringify(review.json));
  const t = review.json.tickets[0];
  assert.equal(t.completion.requestor.id, await userId(1)); assert.notEqual(t.completion.requestor.id, t.completion.worker.id);
  assert.equal((await act(LEAD, ids.d1, 'status', { status: 'Closed' })).status, 200);
});

test('role changes and disabled accounts take effect at once; at least one active Admin remains', async () => {
  const adm = await userId(2);
  assert.equal((await send('PATCH', `/api/v1/users/${adm}`, LEAD, { role: 'Requestor' })).status, 200);
  assert.equal((await ticketOf(ADM, ids.r1)).status, 404, 'a former Admin loses access at once, even to work assigned to them');
  assert.equal((await act(ADM, ids.r1, 'toggle-task', { index: 0, done: true })).status, 404);
  assert.equal((await usersApi(ADM)).status, 403, 'and user management');
  assert.equal((await send('PATCH', `/api/v1/users/${adm}`, LEAD, { role: 'Admin' })).status, 200);
  assert.equal((await ticketOf(ADM, ids.r1)).status, 200);
  const dev2 = await userId(3);
  assert.equal((await send('PATCH', `/api/v1/users/${dev2}`, LEAD, { status: 'disabled' })).status, 200);
  assert.equal((await call(`${W}/workspace`, { cookie: DEV2 })).status, 401, 'disabled: signed out everywhere');
  assert.equal((await act(ADM, ids.r1, 'assign', { dev: dev2, priority: 'High' })).status, 400, 'cannot assign to a disabled account');
  assert.equal((await send('PATCH', `/api/v1/users/${dev2}`, LEAD, { status: 'active' })).status, 200);
  DEV2 = await signIn(3);
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(1)}`, LEAD, { status: 'disabled' })).json.error, 'cannot-change-self');
  assert.equal((await send('PATCH', `/api/v1/users/${adm}`, LEAD, { role: 'Developer' })).status, 200, 'another Admin may be changed while one remains');
  assert.equal((await send('PATCH', `/api/v1/users/${adm}`, LEAD, { role: 'Admin' })).status, 200);
});

test('the beta simulation demonstrates the roles but never changes real roles or reaches real records', async () => {
  const beta = (await call('/api/v1/beta/workspace?view=Admin', { cookie: REQ2 })).json;
  const sample = beta.tickets.find(t => t.status === 'Submitted');
  assert.equal((await post(`/api/v1/beta/tickets/${sample.id}/actions`, REQ2, { view: 'Developer', version: sample.version, action: 'assign', input: { dev: 'Miguel Santos', priority: 'High' } })).status, 404, 'the simulated Developer view sees only its assigned work');
  assert.equal((await post(`/api/v1/beta/tickets/${sample.id}/actions`, REQ2, { view: 'Admin', version: sample.version, action: 'assign', input: { dev: 'Miguel Santos', priority: 'High' } })).status, 200, 'the simulated Admin view assigns');
  assert.equal((await ticketOf(REQ2, ids.r1)).status, 404);
  assert.equal((await act(REQ2, ids.r1, 'assign', { dev: await userId(2), priority: 'Low' }, { view: 'Admin' })).status, 404);
  assert.equal((await call('/api/v1/users', { cookie: REQ2, headers: { 'X-View': 'Admin' } })).status, 403, 'no user management from a simulated view');
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(5)}`, REQ2, { role: 'Admin', view: 'Admin' })).status, 403);
  assert.equal((await db.collection('users').findOne({ email: 'person5@jarc.example' })).role, 'Requestor', 'real role unchanged');
  assert.ok(!(await db.collection('notifications').findOne({ inbox: /^(developer:|requestor:|admin$|member:)/ })), 'no simulated inboxes in My workspace');
  assert.ok(!(await db.collection('beta_notifications').findOne({ record: ids.r1 })), 'no real records in the simulation');
  assert.equal(await db.collection('tickets').countDocuments({ title: sample.title }), 0, 'shared beta records are not converted');
});

test('reminders: due soon to the assignee, escalation to Admins, confirmation, no duplicates, changed deadlines, completion', async () => {
  let clock = new Date();
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), settings: DeadlineCore.DEFAULTS, email: app.email, now: () => clock, log: { log() {}, error() {} } });
  const mine = async (cookie, filter = () => true) => (await call(`${W}/notifications?limit=50`, { cookie })).json.items.filter(n => n.reminder && n.record === ids.r1 && filter(n));
  await runner.runOnce();
  assert.equal((await mine(ADM)).length, 0, 'three days out: nothing yet');
  clock = new Date(Date.now() + 1 * DAY);
  await runner.runOnce();
  assert.deepEqual((await mine(ADM)).map(n => n.title), ['Delivery due in 2 days'], 'to the actual assignee (a self-assigned Admin)');
  assert.equal((await mine(LEAD, n => n.title.startsWith('Delivery due'))).length, 0, 'not to other Admins');
  await runner.runOnce(); await runner.runOnce();
  assert.equal((await mine(ADM)).length, 1, 'no duplicate reminders');
  assert.equal((await send('PATCH', '/api/v1/me/preferences', ADM, { emailReminders: true })).status, 200);
  clock = new Date(Date.now() + 4 * DAY);
  await runner.runOnce();
  assert.ok((await mine(ADM)).some(n => n.title.startsWith('Overdue')));
  const mail = sent.find(m => JSON.parse(m.opts.body).subject.includes(ids.r1));
  assert.ok(mail, 'email for an opted-in assignee');
  const body = JSON.parse(mail.opts.body);
  assert.deepEqual(body.to, ['person2@jarc.example']);
  assert.doesNotMatch(body.text + body.subject, /WORKTEST|Work access test|Person 4/, 'no summaries, descriptions, or names');
  clock = new Date(Date.now() + 6 * DAY);
  await runner.runOnce();
  assert.equal((await mine(LEAD, n => n.title.startsWith('Escalated: delivery overdue'))).length, 1, 'escalated to the shared Admin inbox');
  assert.equal((await mine(DEV2, n => n.title.startsWith('Escalated'))).length, 0, 'not to Developers');
  assert.equal((await mine(REQ1, n => n.title.startsWith('Escalated'))).length, 0);
  // The delivery target moves only through an approved scope change, which adds agreement v2.
  const later = DeadlineCore.addDays(today(), 7);
  assert.equal((await act(ADM, ids.r1, 'edit-scope', { date: later })).status, 409, 'no direct edits after agreement');
  const t = (await ticketOf(REQ1, ids.r1)).json.tickets[0];
  const cr = await post(`${W}/tickets/${ids.r1}/changes`, REQ1, { requestId: requestId(), ticketVersion: t.version, input: { title: 'Add export', reason: 'Needed.', criteria: 'Export works.' } });
  assert.equal(cr.status, 201, JSON.stringify(cr.json));
  const change = async (cookie, action, input = {}) => { const c = (await call(`${W}/tickets/${ids.r1}`, { cookie: LEAD })).json.changes.find(x => x.id === cr.json.created); return post(`${W}/changes/${c.id}/actions`, cookie, { version: c.version, action, input }); };
  assert.equal((await change(LEAD, 'status', { status: 'Assessment' })).status, 200);
  assert.equal((await change(LEAD, 'assess', { impact: 'Small', effort: '1 day', date: later })).status, 403, 'the worker assesses');
  assert.equal((await change(ADM, 'assess', { impact: 'Small', effort: '1 day', date: later })).status, 200);
  assert.equal((await change(REQ1, 'agree')).status, 200);
  assert.equal((await change(DEV2, 'approve')).status, 404);
  const approved = await change(LEAD, 'approve');
  assert.equal(approved.status, 200);
  const v2 = approved.json.tickets[0];
  assert.deepEqual([v2.agreements.length, v2.agreements[0].requirements, v2.dueDate], [2, 'Reports', later], 'the original agreement is kept; v2 adds the change');
  assert.ok((await call(`${W}/notifications`, { cookie: REQ1 })).json.items.some(n => n.title === 'Scope change approved: new agreement version'));
  const before = (await mine(ADM)).length;
  await runner.runOnce();
  assert.equal((await mine(ADM)).length, before + 1, 'one reminder for the new date');
  const current = (await ticketOf(ADM, ids.r1)).json.tickets[0];
  for (const i of current.tasks.keys()) await act(ADM, ids.r1, 'toggle-task', { index: i, done: true });
  assert.equal((await act(ADM, ids.r1, 'add-evidence', { links: [{ url: 'https://example.com/report' }] })).status, 200);
  assert.equal((await act(ADM, ids.r1, 'worker-complete', { summary: 'Tested.' })).status, 200);
  const deliveryBefore = (await mine(ADM)).length;
  clock = new Date(Date.now() + 2 * DAY + 3600000);
  await runner.runOnce();
  assert.equal((await mine(REQ1, n => n.title.includes('awaiting your confirmation'))).length, 1);
  assert.equal((await mine(ADM)).length, deliveryBefore, 'no delivery reminders while awaiting confirmation');
  assert.equal((await act(REQ1, ids.r1, 'requestor-confirm')).status, 200);
  assert.equal((await act(LEAD, ids.r1, 'status', { status: 'Closed' })).status, 409, 'a Project needs its release or handover');
  assert.equal((await act(ADM, ids.r1, 'status', { status: 'Released' })).status, 200, 'the self-assigned Admin confirms release');
  clock = new Date(Date.now() + 5 * DAY);
  await runner.runOnce();
  assert.equal((await mine(LEAD, n => n.title.includes('ready for Admin closure'))).length, 1, 'closure reminder to the Admins');
  assert.equal((await act(LEAD, ids.r1, 'status', { status: 'Closed' })).status, 200, 'another Admin closes it');
  const count = await db.collection('notifications').countDocuments({ record: ids.r1, reminder: true });
  clock = new Date(Date.now() + 20 * DAY);
  await runner.runOnce();
  assert.equal(await db.collection('notifications').countDocuments({ record: ids.r1, reminder: true }), count, 'closed work gets no reminders');
  ids.r3 = (await post(`${W}/tickets`, REQ2, { requestId: requestId(), input: request({ title: 'WORKTEST to cancel' }) })).json.created;
  assert.equal((await act(REQ2, ids.r3, 'reason', { status: 'Cancelled', reason: 'No longer needed' })).status, 200);
  await runner.runOnce();
  assert.equal(await db.collection('notifications').countDocuments({ record: ids.r3, reminder: true }), 0, 'cancelled requests get none');
  await runner.stop();
});

test('beta reminders reach simulated inboxes only and are never emailed', async () => {
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), email: app.email, now: () => new Date(Date.now() + 400 * DAY), log: { log() {}, error() {} } });
  assert.ok((await runner.runOnce()).ran);
  const betaReminders = await db.collection('beta_notifications').find({ reminder: true }).toArray();
  assert.ok(betaReminders.length > 0);
  assert.ok(betaReminders.every(n => /^(admin|requestor:sample|developer:.+|member:[0-9a-f]{24})$/.test(n.inbox)));
  const keys = new Set(betaReminders.map(n => n.key));
  assert.ok(!(await db.collection('email_outbox').find({}).toArray()).some(m => keys.has(m.key.slice(0, m.key.lastIndexOf(':')))), 'no beta reminder was queued for email');
  await runner.stop();
});

test('scheduler: one instance at a time, takeover after a crash, and catch-up after restarts', async () => {
  await db.collection('scheduler_locks').deleteMany({});
  let clock = new Date(Date.now() + 500 * DAY);
  const opts = { db, workspaces: Object.values(app.auth.engines).filter(Boolean), now: () => clock, log: { log() {}, error() {} } };
  const a = createReminders({ ...opts, instanceId: 'instance-a' }), b = createReminders({ ...opts, instanceId: 'instance-b' });
  assert.equal((await a.runOnce()).ran, true);
  assert.equal((await b.runOnce()).ran, false, 'second instance waits while the lease is held');
  assert.equal((await a.runOnce()).ran, true, 'the holder renews');
  clock = new Date(clock.getTime() + 11 * 60000);
  const ticket = (await post(`${W}/tickets`, REQ1, { requestId: requestId(), input: request({ title: 'WORKTEST waiting review' }) })).json.created;
  await db.collection('tickets').updateOne({ id: ticket }, { $set: { statusSince: new Date(Date.now() - 3 * DAY) } });
  assert.equal((await b.runOnce()).ran, true, 'takeover after lease expiry');
  assert.ok(await db.collection('notifications').findOne({ record: ticket, reminder: true, inbox: 'admins', title: 'Reminder: request awaiting review' }), 'missed reminders are caught up, to the Admin inbox');
  await b.stop();
  assert.equal((await a.runOnce()).ran, true);
  await a.stop();
  await db.collection('scheduler_locks').deleteMany({});
  await db.collection('notifications').deleteMany({ record: ticket, reminder: true });
  await Promise.all([a.runOnce(), b.runOnce()]);
  assert.equal(await db.collection('notifications').countDocuments({ record: ticket, reminder: true }), 1);
});

test('email stays off unless configured, reaches opted-in Admins for escalations, and retries without affecting in-app notifications', async () => {
  const disabled = createEmail({ config: { enabled: false, provider: 'disabled' }, db });
  assert.equal(await disabled.enqueue([{ key: 'k', inbox: 'admins', title: 't', record: 'JRC-1' }]), 0);
  let status = 503;
  const flaky = createEmail({ config: { enabled: true, provider: 'resend', from: 'a@b.co', apiKey: 'x', appUrl: origin }, db, fetch: async () => ({ status }), log: { error() {} } });
  await send('PATCH', '/api/v1/me/preferences', ADM, { emailReminders: false });
  await send('PATCH', '/api/v1/me/preferences', LEAD, { emailReminders: true });
  await send('PATCH', '/api/v1/me/preferences', DEV2, { emailReminders: true });
  assert.equal(await flaky.enqueue([{ key: 'retry-test', inbox: 'admins', title: 'Reminder: request awaiting review', record: 'JRC-1' }]), 1, 'only the opted-in Admin of the Admin inbox, never a Developer');
  await flaky.process();
  const item = await db.collection('email_outbox').findOne({ key: /^retry-test:/ });
  assert.equal(item.to, 'person1@jarc.example');
  assert.equal(item.status, 'pending'); assert.equal(item.attempts, 1); assert.equal(item.lastError, 'HTTP 503');
  await send('PATCH', '/api/v1/me/preferences', LEAD, { emailReminders: false });
  await db.collection('email_outbox').updateOne({ _id: item._id }, { $set: { nextAttemptAt: new Date(0) } });
  status = 200;
  await flaky.process();
  assert.equal((await db.collection('email_outbox').findOne({ _id: item._id })).status, 'skipped', 'turning email off is respected before sending');
  assert.equal((await send('PATCH', '/api/v1/me/preferences', LEAD, { emailReminders: 'yes' })).status, 400);
});
