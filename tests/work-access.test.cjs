// My workspace: real roles and ownership enforced on the server, simulation isolation, due-date reminders and
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
const request = (overrides = {}) => ({ title: 'WORKTEST request', department: 'Finance', date: '2026-12-31', category: 'Enhancement', description: 'Work access test.', criteria: '', ...overrides });
async function act(cookie, id, action, input = {}, extra = {}) {
  const t = (await ticketOf(cookie, id)).json?.tickets?.[0];
  return post(`${W}/tickets/${id}/actions`, cookie, { version: t ? t.version : 1, action, input, ...extra });
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const upload = cookie => fetch(`http://127.0.0.1:${port}${W}/attachments`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'proof.png' }, body: PNG }).then(r => r.json());
const today = () => DeadlineCore.today(new Date(), 'Asia/Manila');

let ADMIN, DEV1, DEV2, REQ1, REQ2, ids = {};

test('new members start as Requestors; nobody becomes Admin by signing in', async () => {
  ADMIN = await signIn(1); DEV1 = await signIn(2); DEV2 = await signIn(3); REQ1 = await signIn(4); REQ2 = await signIn(5);
  const roles = await db.collection('users').find({}).toArray();
  assert.equal(roles.length, 5);
  assert.ok(roles.every(u => u.role === 'Requestor' && u.status === 'active'), 'first sign-in, including the very first person, is a Requestor');
  assert.equal((await call('/api/v1/users', { cookie: ADMIN })).status, 403, 'no Admin until the owner runs the bootstrap');
});

test('admin:bootstrap --promote-existing makes the identified account the first Admin, once', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin-bootstrap.cjs'), ...args], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, JARCTECH_ENV_FILE: 'none', MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', code => resolve({ code, out }));
  });
  const plain = await run(['--email', 'person1@jarc.example', '--confirm-db', DB]);
  assert.equal(plain.code, 1); assert.match(plain.out, /--promote-existing/);
  assert.equal((await run(['--email', 'nobody@jarc.example', '--confirm-db', DB, '--promote-existing'])).code, 1);
  const promoted = await run(['--email', 'person1@jarc.example', '--confirm-db', DB, '--promote-existing']);
  assert.equal(promoted.code, 0, promoted.out); assert.match(promoted.out, /Promoted person1@jarc\.example from Requestor to Admin/);
  assert.equal((await call('/api/v1/users', { cookie: ADMIN })).status, 200, 'applies to the open session at once');
  const again = await run(['--email', 'person4@jarc.example', '--confirm-db', DB, '--promote-existing']);
  assert.equal(again.code, 1); assert.match(again.out, /already has an active Admin/);
  assert.ok(await db.collection('events').findOne({ type: 'admin.bootstrapped' }));
});

test('Admin assigns app roles through user management; changes apply to open sessions', async () => {
  for (const n of [2, 3]) {
    const res = await send('PATCH', `/api/v1/users/${await userId(n)}`, ADMIN, { role: 'Developer' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(1)}`, ADMIN, { role: 'Requestor' })).status, 403, 'cannot change self (and so never removes the last Admin)');
  assert.equal((await send('PATCH', `/api/v1/users/${await userId(4)}`, REQ1, { role: 'Admin' })).status, 403, 'only Admins manage roles');
  const people = await call(`${W}/people`, { cookie: ADMIN });
  assert.deepEqual(people.json.developers.map(d => d.name).sort(), ['Person 2', 'Person 3']);
  assert.deepEqual((await call(`${W}/people`, { cookie: REQ1 })).json.developers, [], 'Requestors get no account list');
});

test('ownership comes from the session; Requestors see only their own tickets, everywhere', async () => {
  const made = await post(`${W}/tickets`, REQ1, { view: 'Admin', requestId: requestId(), input: request({ title: 'WORKTEST owned by R1', name: 'Person 5', requester: { id: await userId(5) } }) });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const t = made.json.tickets[0];
  ids.r1 = t.id;
  assert.equal(t.requester.id, await userId(4)); assert.equal(t.name, 'Person 4', 'browser-supplied owner and name ignored');
  assert.equal(t.history[0].view, 'Requestor', 'browser-supplied view ignored');
  assert.equal(t.requestedDate, '2026-12-31');
  assert.match(t.id, /^JRC-2[0-9]{3}$/, 'numbered apart from the beta simulation');
  ids.r2 = (await post(`${W}/tickets`, REQ2, { requestId: requestId(), input: request({ title: 'WORKTEST owned by R2' }) })).json.created;
  // R2 cannot reach R1's ticket through any route.
  assert.ok(!(await ws(REQ2)).tickets.some(x => x.id === ids.r1), 'workspace');
  assert.equal((await ticketOf(REQ2, ids.r1)).status, 404, 'direct URL');
  assert.equal((await call(`${W}/search?q=${ids.r1}`, { cookie: REQ2 })).json.total, 0, 'search');
  assert.equal((await call(`${W}/search?q=WORKTEST`, { cookie: REQ2 })).json.total, 1);
  assert.equal((await post(`${W}/tickets/${ids.r1}/actions`, REQ2, { version: 1, action: 'comment', input: { comment: 'snooping' } })).status, 404, 'actions');
  assert.equal((await post(`${W}/tickets/${ids.r1}/changes`, REQ2, { requestId: requestId(), ticketVersion: 1, input: {} })).status, 404, 'linked changes');
  assert.ok(!(await ws(REQ2)).notices.some(n => n.text.includes(ids.r1)), 'activity feed');
  // Attachments follow ticket access.
  const file = (await upload(REQ1)).attachment;
  assert.equal((await act(REQ1, ids.r1, 'comment', { comment: 'Screenshot', attachments: [file.id] })).status, 200);
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: REQ1 })).status, 200);
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: REQ2 })).status, 404, 'download of another person\'s file');
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: ADMIN })).status, 200, 'Admins manage the workspace');
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: DEV1 })).status, 404, 'unassigned Developer');
  // Admin sees everything; notifications go to real inboxes only.
  assert.ok((await ws(ADMIN)).tickets.some(x => x.id === ids.r1) && (await ws(ADMIN)).tickets.some(x => x.id === ids.r2));
  assert.ok((await call(`${W}/notifications`, { cookie: ADMIN })).json.items.some(n => n.record === ids.r1 && n.title === 'New request submitted'));
  assert.ok(!(await call(`${W}/notifications`, { cookie: REQ2 })).json.items.some(n => n.record === ids.r1), 'notifications');
});

test('work is assigned only to active Developer accounts; Developers see only their assignments', async () => {
  const dev1 = await userId(2);
  for (const bad of ['Miguel Santos', await userId(4), new ObjectId().toHexString()]) {
    const res = await act(ADMIN, ids.r1, 'assign', { dev: bad, priority: 'High' });
    assert.equal(res.status, 400, `refused: ${bad}`); assert.match(res.json.message, /active Developer account/);
  }
  assert.equal((await act(REQ1, ids.r1, 'assign', { dev: dev1, priority: 'High' }, { view: 'Admin' })).status, 403, 'a Requestor cannot act as Admin by claiming the view');
  const assigned = await act(ADMIN, ids.r1, 'assign', { dev: dev1, priority: 'High' });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
  assert.equal(assigned.json.tickets[0].devId, dev1); assert.equal(assigned.json.tickets[0].dev, 'Person 2');
  assert.equal((await ticketOf(DEV1, ids.r1)).status, 200);
  assert.equal((await ticketOf(DEV2, ids.r1)).status, 404, 'another Developer');
  assert.equal((await act(DEV2, ids.r1, 'schedule-meeting', { meeting: '2026-11-30T10:00', location: 'Room 1' })).status, 404);
  assert.ok((await call(`${W}/notifications`, { cookie: DEV1 })).json.items.some(n => n.record === ids.r1 && n.title === 'Assigned to you'));
  assert.equal((await call(`${W}/search?dev=${dev1}`, { cookie: ADMIN })).json.total, 1, 'developer filter by account');
  assert.equal((await call(`${W}/search?dev=Unassigned&q=WORKTEST`, { cookie: ADMIN })).json.total, 1);
  // Full flow with each person in their own capacity.
  assert.equal((await act(DEV1, ids.r1, 'schedule-meeting', { meeting: '2026-11-30T10:00', location: 'Room 1' })).status, 200);
  assert.equal((await act(DEV1, ids.r1, 'confirm-meeting')).status, 403, 'only the owner confirms');
  assert.equal((await act(REQ1, ids.r1, 'confirm-meeting')).status, 200);
  const due = DeadlineCore.addDays(today(), 3);
  const project = await act(DEV1, ids.r1, 'create-project', { projectName: 'WORKTEST project', requirements: 'R', criteria: 'C', date: due, tasks: [{ title: 'Build', requirement: 'R', criteria: 'C', start: today(), end: due, owner: 'Person 2' }] });
  assert.equal(project.status, 200, JSON.stringify(project.json));
  const t = project.json.tickets[0];
  assert.equal(t.dueDate, due, 'agreed delivery date'); assert.equal(t.requestedDate, '2026-12-31', 'requested date kept');
  assert.equal((await act(DEV1, ids.r1, 'save-task', { index: null, task: { title: 'Sample owner', requirement: 'R', criteria: 'C', start: today(), end: due, owner: 'Miguel Santos' } })).status, 400, 'sample people are not task owners here');
});

test('role changes and disabled accounts take effect at once', async () => {
  const dev1 = await userId(2);
  assert.equal((await send('PATCH', `/api/v1/users/${dev1}`, ADMIN, { role: 'Requestor' })).status, 200);
  assert.equal((await ticketOf(DEV1, ids.r1)).status, 404, 'a demoted Developer loses the assignment');
  assert.equal((await act(DEV1, ids.r1, 'toggle-task', { index: 0, done: true })).status, 404);
  assert.equal((await send('PATCH', `/api/v1/users/${dev1}`, ADMIN, { role: 'Developer' })).status, 200);
  assert.equal((await ticketOf(DEV1, ids.r1)).status, 200);
  const dev2 = await userId(3);
  assert.equal((await send('PATCH', `/api/v1/users/${dev2}`, ADMIN, { status: 'disabled' })).status, 200);
  assert.equal((await call(`${W}/workspace`, { cookie: DEV2 })).status, 401, 'disabled: signed out everywhere');
  assert.equal((await act(ADMIN, ids.r2, 'assign', { dev: dev2, priority: 'Low' })).status, 400, 'cannot assign to a disabled account');
  assert.ok(!(await call(`${W}/people`, { cookie: ADMIN })).json.developers.some(d => d.id === dev2));
  assert.equal((await send('PATCH', `/api/v1/users/${dev2}`, ADMIN, { status: 'active' })).status, 200);
  DEV2 = await signIn(3);
});

test('the beta simulation never grants access to My workspace', async () => {
  // In the simulation anyone may act as Admin on shared test data...
  const beta = (await call('/api/v1/beta/workspace', { cookie: REQ2 })).json;
  const sample = beta.tickets.find(t => t.status === 'Submitted');
  assert.equal((await post(`/api/v1/beta/tickets/${sample.id}/actions`, REQ2, { view: 'Admin', version: sample.version, action: 'assign', input: { dev: 'Miguel Santos', priority: 'High' } })).status, 200);
  // ...but that changes nothing for real records.
  assert.equal((await ticketOf(REQ2, ids.r1)).status, 404);
  assert.equal((await act(REQ2, ids.r1, 'assign', { dev: await userId(2), priority: 'Low' }, { view: 'Admin' })).status, 404);
  assert.equal((await call('/api/v1/users', { cookie: REQ2 })).status, 403);
  assert.ok(!(await db.collection('notifications').findOne({ inbox: /^(developer:|requestor:|admin$|member:)/ })), 'no simulated inboxes in My workspace');
  assert.ok(!(await db.collection('beta_notifications').findOne({ record: ids.r1 })), 'no real records in the simulation');
  assert.equal(await db.collection('tickets').countDocuments({ title: sample.title }), 0, 'shared beta records are not converted');
});

test('reminders: due soon, overdue, escalation, acceptance, no duplicates, changed deadlines, completion', async () => {
  let clock = new Date();
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), settings: DeadlineCore.DEFAULTS, email: app.email, now: () => clock, log: { log() {}, error() {} } });
  const mine = async (cookie, filter = () => true) => (await call(`${W}/notifications?limit=50`, { cookie })).json.items.filter(n => n.reminder && n.record === ids.r1 && filter(n));
  // Due in 3 days: not yet. Due-soon window is 2 days.
  await runner.runOnce();
  assert.equal((await mine(DEV1)).length, 0);
  clock = new Date(Date.now() + 1 * DAY);
  await runner.runOnce();
  assert.deepEqual((await mine(DEV1)).map(n => n.title), ['Delivery due in 2 days']);
  await runner.runOnce(); await runner.runOnce();
  assert.equal((await mine(DEV1)).length, 1, 'no duplicate reminders');
  // Email (turned on by the developer) carries no ticket details.
  assert.equal((await send('PATCH', '/api/v1/me/preferences', DEV1, { emailReminders: true })).status, 200);
  assert.deepEqual((await call('/api/v1/me/preferences', { cookie: DEV1 })).json, { emailReminders: true, emailDelivery: 'enabled' });
  clock = new Date(Date.now() + 4 * DAY);
  await runner.runOnce();
  assert.ok((await mine(DEV1)).some(n => n.title.startsWith('Overdue')), 'overdue reminder to the assigned developer');
  assert.equal((await mine(ADMIN, n => n.title.startsWith('Escalated'))).length, 0, 'not escalated before the threshold');
  const mail = sent.find(m => JSON.parse(m.opts.body).subject.includes(ids.r1));
  assert.ok(mail, 'email sent for a reminder');
  const body = JSON.parse(mail.opts.body);
  assert.deepEqual(body.to, ['person2@jarc.example']);
  assert.match(mail.opts.headers.Authorization, /^Bearer /);
  assert.doesNotMatch(body.text + body.subject, /WORKTEST|Work access test|Person 4/, 'no summaries, descriptions, or names');
  assert.ok(!sent.some(m => JSON.parse(m.opts.body).to.includes('person4@jarc.example')), 'people who did not opt in get no email');
  clock = new Date(Date.now() + 6 * DAY);
  await runner.runOnce();
  assert.ok((await mine(ADMIN, n => n.title.startsWith('Escalated: delivery overdue'))).length === 1, 'escalated to Admins');
  // A changed deadline is a new deadline: new reminders, old ones are not repeated.
  const later = DeadlineCore.addDays(today(), 7);
  assert.equal((await act(DEV1, ids.r1, 'edit-scope', { projectName: 'WORKTEST project', requirements: 'R', criteria: 'C', date: later })).status, 200);
  assert.ok((await mine(REQ1, n => n.title === 'Agreed delivery date changed')).length === 0, 'reminder filter');
  assert.ok((await call(`${W}/notifications`, { cookie: REQ1 })).json.items.some(n => n.title === 'Agreed delivery date changed'));
  const before = (await mine(DEV1)).length;
  await runner.runOnce();
  assert.equal((await mine(DEV1)).length, before + 1, 'one reminder for the new date (due soon at +6 days)');
  // Acceptance pending: the requestor is reminded, then Admins; completion stops reminders.
  await act(DEV1, ids.r1, 'toggle-task', { index: 0, done: true });
  const deliveryBefore = (await mine(DEV1)).length;
  assert.equal((await act(DEV1, ids.r1, 'submit-acceptance', { summary: 'Tested.' })).status, 200);
  clock = new Date(Date.now() + 2 * DAY + 3600000);
  await runner.runOnce();
  assert.ok((await mine(REQ1, n => n.title.includes('awaiting your acceptance'))).length === 1);
  assert.equal((await mine(DEV1)).length, deliveryBefore, 'no delivery reminders while awaiting acceptance');
  assert.equal((await act(REQ1, ids.r1, 'status', { status: 'Ready for release' })).status, 200);
  assert.equal((await act(DEV1, ids.r1, 'status', { status: 'Released' })).status, 200);
  const count = await db.collection('notifications').countDocuments({ record: ids.r1, reminder: true });
  clock = new Date(Date.now() + 20 * DAY);
  await runner.runOnce();
  assert.equal(await db.collection('notifications').countDocuments({ record: ids.r1, reminder: true }), count, 'released work gets no reminders');
  // Cancelled requests get none either.
  const r2Before = await db.collection('notifications').countDocuments({ record: ids.r2, reminder: true });
  assert.equal((await act(REQ2, ids.r2, 'reason', { status: 'Cancelled', reason: 'No longer needed' })).status, 200);
  clock = new Date(Date.now() + 40 * DAY);
  await runner.runOnce();
  assert.equal(await db.collection('notifications').countDocuments({ record: ids.r2, reminder: true }), r2Before, 'cancelled requests get no further reminders');
  await runner.stop();
});

test('beta reminders reach simulated inboxes only and are never emailed', async () => {
  const outbox = await db.collection('email_outbox').countDocuments();
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), email: app.email, now: () => new Date(Date.now() + 400 * DAY), log: { log() {}, error() {} } });
  const result = await runner.runOnce();
  assert.ok(result.ran);
  const betaReminders = await db.collection('beta_notifications').find({ reminder: true }).toArray();
  assert.ok(betaReminders.length > 0);
  assert.ok(betaReminders.every(n => /^(admin|requestor:sample|developer:.+|member:[0-9a-f]{24})$/.test(n.inbox)));
  const keys = new Set(betaReminders.map(n => n.key));
  assert.ok(!(await db.collection('email_outbox').find({}).toArray()).some(m => keys.has(m.key.slice(0, m.key.lastIndexOf(':')))), 'no beta reminder was queued for email');
  assert.ok(await db.collection('email_outbox').countDocuments() >= outbox);
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
  // Instance a "crashes" (never stops). Once its lease expires, b takes over.
  clock = new Date(clock.getTime() + 11 * 60000);
  const ticket = (await post(`${W}/tickets`, REQ1, { requestId: requestId(), input: request({ title: 'WORKTEST waiting review' }) })).json.created;
  await db.collection('tickets').updateOne({ id: ticket }, { $set: { statusSince: new Date(Date.now() - 3 * DAY) } });
  const took = await b.runOnce();
  assert.equal(took.ran, true, 'takeover after lease expiry');
  assert.ok(await db.collection('notifications').findOne({ record: ticket, reminder: true, inbox: 'admins', title: 'Reminder: request awaiting review' }), 'missed reminders are caught up');
  // A clean stop hands the lease back immediately.
  await b.stop();
  assert.equal((await a.runOnce()).ran, true);
  await a.stop();
  // Two instances racing at the same moment still create each reminder once.
  await db.collection('scheduler_locks').deleteMany({});
  await db.collection('notifications').deleteMany({ record: ticket, reminder: true });
  await Promise.all([a.runOnce(), b.runOnce()]);
  assert.equal(await db.collection('notifications').countDocuments({ record: ticket, reminder: true }), 1);
});

test('email stays off unless configured, and failures are retried without affecting in-app notifications', async () => {
  const disabled = createEmail({ config: { enabled: false, provider: 'disabled' }, db });
  assert.equal(await disabled.enqueue([{ key: 'k', inbox: 'admins', title: 't', record: 'JRC-1' }]), 0);
  let status = 503;
  const flaky = createEmail({ config: { enabled: true, provider: 'resend', from: 'a@b.co', apiKey: 'x', appUrl: origin }, db, fetch: async () => ({ status }), log: { error() {} } });
  await send('PATCH', '/api/v1/me/preferences', ADMIN, { emailReminders: true });
  assert.equal(await flaky.enqueue([{ key: 'retry-test', inbox: 'admins', title: 'Reminder: request awaiting review', record: 'JRC-1' }]), 1);
  await flaky.process();
  const item = await db.collection('email_outbox').findOne({ key: /^retry-test:/ });
  assert.equal(item.status, 'pending'); assert.equal(item.attempts, 1); assert.equal(item.lastError, 'HTTP 503');
  await send('PATCH', '/api/v1/me/preferences', ADMIN, { emailReminders: false });
  await db.collection('email_outbox').updateOne({ _id: item._id }, { $set: { nextAttemptAt: new Date(0) } });
  status = 200;
  await flaky.process();
  assert.equal((await db.collection('email_outbox').findOne({ _id: item._id })).status, 'skipped', 'turning email off is respected before sending');
  assert.equal((await send('PATCH', '/api/v1/me/preferences', ADMIN, { emailReminders: 'yes' })).status, 400);
});
