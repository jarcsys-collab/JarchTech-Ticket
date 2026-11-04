// The official configuration: no simulation or preview, accounts and roles, the agreed workflow gates, authorization on
// every route, and the hardening added for official use. Mock Entra and a temporary MongoDB only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { ConfigError, loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { createReminders } = require('../server/workspace/reminders.cjs');
const { createLimits } = require('../server/limits.cjs');
const { BETA_NAMES, backup, fingerprint, restore, verifyBackup } = require('../scripts/db-snapshot.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const CLIENT = '12121212-3434-4565-8787-909090909090';
const SECRET = 'official-mock-secret';
const DB = 'jarctech_official_test';
const W = '/api/v1/work';
const FUTURE = '2030-06-30';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
let mongod, mongo, db, entra, port, origin, app, betaBefore;
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const silent = { log() {}, error() {} };
const ENTRA_ENV = { AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, SESSION_SECRET: 'official-session-secret-0123456789abcdefghij' };
const envFor = (p, extra = {}) => ({ NODE_ENV: 'test', PORT: String(p), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, ...ENTRA_ENV, APP_BASE_URL: `http://localhost:${p}`, ...extra });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  await seedWorkspace(db);
  // A beta file, so the preserved data includes GridFS records.
  await db.collection('beta_attachments').insertOne({ workspace: 'beta', name: 'old.png', ext: 'png', size: 4, state: 'attached', uploadedBy: 'x', uploadedAt: new Date(), ticket: 'JRC-1001' });
  await db.collection('beta_files.files').insertOne({ length: 4, chunkSize: 261120, uploadDate: new Date(), filename: 'old.png', metadata: { workspace: 'beta', uploadedBy: 'x' } });
  betaBefore = await fingerprint(db, BETA_NAMES);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  app = await start(loadConfig(envFor(port)), { log: silent, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

async function call(p, { method = 'GET', cookie, body, headers = {}, raw, at = port } = {}) {
  const res = await fetch(`http://127.0.0.1:${at}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, text: buf.toString('utf8'), headers: res.headers, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const send = (method, p, cookie, body) => call(p, { method, cookie, body, headers: { Origin: origin } });
const post = (p, cookie, body) => send('POST', p, cookie, body);
const person = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: `person${n}@jarc.example`, preferred_username: `person${n}@jarc.example` });
async function signIn(n, at = port) {
  const login = await call('/auth/login', { at });
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(n)));
  const res = await call(back.pathname + back.search, { cookie: flow, at });
  const session = res.setCookies.find(c => c.startsWith('jt_session='));
  assert.ok(session, `person ${n} signed in`);
  return session.split(';')[0];
}
const account = async n => db.collection('users').findOne({ email: `person${n}@jarc.example` });
const idOf = async n => String((await account(n))._id);
const setRole = async (n, role) => db.collection('users').updateOne({ email: `person${n}@jarc.example` }, { $set: { role } });
let rid = 0;
const newRequest = async (cookie, overrides = {}) => {
  const res = await post(`${W}/tickets`, cookie, { requestId: `official-${++rid}-${Date.now()}`, input: { title: 'OFFICIAL request', type: 'Ticket', department: 'IT', date: FUTURE, category: 'Enhancement', description: 'Official test.', criteria: 'Works.', ...overrides } });
  assert.equal(res.status, 201, res.text);
  return res.json.created;
};
const ticketOf = async id => db.collection('tickets').findOne({ workspace: 'main', id });
const act = async (cookie, id, action, input = {}) => post(`${W}/tickets/${id}/actions`, cookie, { version: (await ticketOf(id)).version, action, input });
const ok = async (cookie, id, action, input) => { const r = await act(cookie, id, action, input); assert.equal(r.status, 200, `${action}: ${r.text}`); return r; };
const task = (n, owner) => ({ title: `Task ${n}`, requirement: 'Req', criteria: 'Crit', start: '2030-01-01', end: '2030-02-01', owner });
const assign = (admin, id, dev, priority = 'High') => ok(admin, id, 'assign', { dev, priority });
const changeOf = async id => db.collection('ticket_changes').findOne({ workspace: 'main', id });
const changeAct = async (cookie, id, action, input = {}) => post(`${W}/changes/${id}/actions`, cookie, { version: (await changeOf(id)).version, action, input });
const upload = (cookie, name = 'proof.png', bytes = PNG, at = port, o = origin) => call(`${W}/attachments`, { method: 'POST', cookie, raw: bytes, at, headers: { Origin: o, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) } });

// Drives a Project up to development: meeting, confirmed agreement, timeline.
async function projectInDevelopment(admin, dev, requestor, devId, devName) {
  const id = await newRequest(requestor, { type: 'Project' });
  await assign(admin, id, devId);
  await ok(dev, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  await ok(requestor, id, 'confirm-meeting');
  await ok(dev, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(dev, id, 'confirm-agreement');
  await ok(requestor, id, 'confirm-agreement');
  await ok(dev, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, devName)] });
  await ok(dev, id, 'status', { status: 'In progress' });
  return id;
}

// One set of accounts for most tests. Person 1 is the Admin (as the owner is), 2 a Developer, 3 and 4 Requestors.
let admin, dev, req, stranger, devId, adminId;
test('1-2. a new account starts as Requestor, and an Admin promotes it; other roles cannot', async () => {
  admin = await signIn(1); dev = await signIn(2); req = await signIn(3); stranger = await signIn(4);
  assert.deepEqual((await call('/api/v1/me', { cookie: dev })).json.user.role, 'Requestor');
  assert.equal((await account(2)).autoAdmitted, true);
  // Nobody can make themselves anything.
  assert.equal((await call('/api/v1/users', { cookie: dev })).status, 403);
  devId = await idOf(2);
  assert.equal((await send('PATCH', `/api/v1/users/${devId}`, dev, { role: 'Admin' })).status, 403);
  await setRole(1, 'Admin'); // as the owner's account is
  adminId = await idOf(1);
  const before = await db.collection('events').countDocuments({ type: 'user.updated' });
  const promoted = await send('PATCH', `/api/v1/users/${devId}`, admin, { role: 'Developer' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.json.user.role, 'Developer');
  // Immediately, on the same session.
  assert.equal((await call('/api/v1/me', { cookie: dev })).json.user.role, 'Developer');
  assert.equal(await db.collection('events').countDocuments({ type: 'user.updated' }), before + 1);
  const events = (await call('/api/v1/users/activity', { cookie: admin })).json.activity;
  assert.equal(events[0].type, 'user.updated');
  assert.equal(events[0].actor, 'Person 1');
  assert.equal(events[0].subject, 'Person 2');
  assert.deepEqual(events[0].changes, { role: 'Developer' });
  assert.equal(events[0].previous.role, 'Requestor');
  assert.equal((await call('/api/v1/users/activity', { cookie: req })).status, 403);
  // Developers cannot assign or manage users.
  const list = (await call('/api/v1/users', { cookie: admin })).json;
  assert.equal(list.users.length, 4);
  assert.deepEqual(Object.keys(list.usage).sort(), ['bytes', 'files', 'quotaBytes']);
  assert.equal((await call('/api/v1/users', { cookie: dev })).status, 403);
  // Self-changes and the last Admin are protected.
  assert.equal((await send('PATCH', `/api/v1/users/${adminId}`, admin, { role: 'Requestor' })).status, 403);
  // The invitation capability remains, for a role from the first sign-in.
  assert.equal((await post('/api/v1/users', admin, { email: 'later@jarc.example', role: 'Developer' })).status, 201);
});

test('every Admin can promote, and return accounts to Requestor; the last active Admin is protected', async () => {
  const second = await signIn(5);
  const id5 = await idOf(5);
  assert.equal((await send('PATCH', `/api/v1/users/${id5}`, admin, { role: 'Admin' })).status, 200);
  assert.equal((await send('PATCH', `/api/v1/users/${id5}`, second, { role: 'Admin' })).status, 403, 'not on themselves');
  // The second Admin can promote and demote too.
  const id6 = String((await signIn(6), await idOf(6)));
  assert.equal((await send('PATCH', `/api/v1/users/${id6}`, second, { role: 'Developer' })).status, 200);
  assert.equal((await send('PATCH', `/api/v1/users/${id6}`, second, { role: 'Requestor' })).status, 200);
  // Two Admins demoting each other at the same moment leave at least one.
  const results = await Promise.all([send('PATCH', `/api/v1/users/${id5}`, admin, { role: 'Requestor' }), send('PATCH', `/api/v1/users/${adminId}`, second, { role: 'Requestor' })]);
  assert.ok(await db.collection('users').countDocuments({ role: 'Admin', status: 'active' }) >= 1, JSON.stringify(results.map(r => r.status)));
  // Back to one Admin (person 1), for the tests below.
  await db.collection('users').updateOne({ email: 'person1@jarc.example' }, { $set: { role: 'Admin' } });
  await setRole(5, 'Requestor');
  const last = await send('PATCH', `/api/v1/users/${adminId}`, second, { role: 'Requestor' });
  assert.equal(last.status, 403, 'a Requestor cannot, whatever they are');
});

test('3. a Developer sees assigned work; unrelated Requestors cannot reach it through any route', async () => {
  const fileUp = await upload(req);
  assert.equal(fileUp.status, 201);
  const id = await newRequest(req, { title: 'ZEBRA secret request', attachments: [fileUp.json.attachment.id] });
  // Before assignment a Developer has no access.
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: dev })).status, 404);
  await assign(admin, id, devId);
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: dev })).status, 200);
  assert.ok((await call(`${W}/workspace`, { cookie: dev })).json.tickets.some(t => t.id === id));
  const download = `${W}/attachments/${fileUp.json.attachment.id}/download`;
  assert.equal((await call(download, { cookie: dev })).status, 200);
  const file = await call(download, { cookie: req });
  assert.match(file.headers.get('content-disposition'), /^attachment;/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  // The stranger, on every route.
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: stranger })).status, 404);
  assert.ok(!(await call(`${W}/workspace`, { cookie: stranger })).json.tickets.some(t => t.id === id));
  assert.equal((await call(`${W}/search?q=ZEBRA`, { cookie: stranger })).json.total, 0);
  assert.equal((await call(`${W}/search?q=ZEBRA`, { cookie: req })).json.total, 1);
  assert.equal((await call(download, { cookie: stranger })).status, 404);
  assert.equal((await act(stranger, id, 'comment', { comment: 'hello' })).status, 404);
  const changeTry = await post(`${W}/tickets/${id}/changes`, stranger, { requestId: `official-x-${Date.now()}`, ticketVersion: 1, input: { title: 'x', reason: 'x', criteria: 'x' } });
  assert.equal(changeTry.status, 404);
  assert.ok(!JSON.stringify((await call(`${W}/notifications`, { cookie: stranger })).json).includes(id));
  // Anonymous, and a sealed route for someone else's pending upload.
  assert.equal((await call(`${W}/tickets/${id}`)).status, 401);
  assert.equal((await call(download)).status, 401);
  const pending = await upload(stranger);
  assert.equal((await call(`${W}/attachments/${pending.json.attachment.id}/download`, { cookie: req })).status, 404);
  assert.equal((await send('DELETE', `${W}/attachments/${pending.json.attachment.id}`, req)).status, 404);
  // Attaching someone else's upload to your own request is refused.
  const taken = await post(`${W}/tickets`, req, { requestId: `official-steal-${Date.now()}`, input: { title: 'x', type: 'Ticket', department: 'IT', date: FUTURE, category: 'Enhancement', description: 'x', attachments: [pending.json.attachment.id] } });
  assert.equal(taken.status, 409);
  // The requester field cannot be chosen by the client.
  const forged = await post(`${W}/tickets`, stranger, { requestId: `official-forged-${Date.now()}`, requester: { id: devId }, input: { title: 'x', name: 'Someone Else', type: 'Ticket', department: 'IT', date: FUTURE, category: 'Enhancement', description: 'x' } });
  assert.equal(forged.status, 201);
  const made = await ticketOf(forged.json.created);
  assert.equal(made.requester.id, await idOf(4));
  assert.equal(made.name, 'Person 4');
  // A Requestor cannot act as staff on their own request.
  assert.equal((await act(req, id, 'assign', { dev: await idOf(3), priority: 'High' })).status, 403);
  assert.equal((await act(req, id, 'status', { status: 'Closed' })).status, 403);
  assert.equal((await act(dev, id, 'assign', { dev: devId, priority: 'Low' })).status, 403, 'a Developer cannot assign');
});

test('4a. a Ticket completes through the agreed gates', async () => {
  const id = await newRequest(req, { type: 'Ticket' });
  assert.equal((await act(dev, id, 'status', { status: 'In progress' })).status, 404, 'not assigned yet');
  await assign(admin, id, devId);
  await ok(dev, id, 'status', { status: 'In progress' });
  assert.equal((await act(dev, id, 'worker-complete', { summary: 'done' })).status, 400, 'evidence first');
  await ok(dev, id, 'add-evidence', { links: [{ url: 'https://example.com/report', label: 'Report' }] });
  assert.equal((await act(admin, id, 'status', { status: 'Closed' })).status, 409, 'no closure without confirmations');
  await ok(dev, id, 'worker-complete', { summary: 'done' });
  assert.equal((await act(dev, id, 'requestor-confirm')).status, 403, 'one account never confirms both sides');
  assert.equal((await act(admin, id, 'status', { status: 'Closed' })).status, 409, 'worker only is not enough');
  await ok(req, id, 'requestor-confirm');
  // A correction clears both confirmations.
  await ok(admin, id, 'reason', { status: 'In progress', reason: 'Totals are wrong.' });
  const returned = await ticketOf(id);
  assert.equal(returned.completion.worker, null);
  assert.equal(returned.completion.requestor, null);
  assert.equal(returned.status, 'In progress');
  await ok(dev, id, 'worker-complete', { summary: 'fixed' });
  await ok(req, id, 'requestor-confirm');
  await ok(admin, id, 'status', { status: 'Closed' });
  assert.equal((await ticketOf(id)).status, 'Closed');
  assert.equal((await act(req, id, 'status', { status: 'Under review' })).status, 409, 'closed work stays closed');
});

test('4b. a Project needs its meeting and locked agreement, uses versioned scope changes, and needs its handover', async () => {
  const id = await newRequest(req, { type: 'Project' });
  await assign(admin, id, devId);
  assert.equal((await act(dev, id, 'status', { status: 'In progress' })).status, 409, 'no development before the agreement');
  assert.equal((await act(dev, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, 'Person 2')] })).status, 409, 'no timeline before the agreement');
  assert.equal((await act(dev, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' })).status, 409, 'no agreement before the meeting');
  assert.equal((await act(dev, id, 'schedule-meeting', { meeting: '2030-99-99T10:00', location: 'Room' })).status, 400, 'an impossible date is refused');
  await ok(dev, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  assert.equal((await act(dev, id, 'confirm-meeting')).status, 403);
  await ok(req, id, 'confirm-meeting');
  await ok(dev, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(dev, id, 'confirm-agreement');
  assert.equal((await act(dev, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, 'Person 2')] })).status, 409, 'both sides must confirm');
  await ok(req, id, 'confirm-agreement');
  assert.equal((await ticketOf(id)).agreements.length, 1);
  assert.equal((await act(dev, id, 'edit-scope', {})).status, 409, 'the agreement is locked');
  await ok(dev, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, 'Person 2')] });
  await ok(dev, id, 'status', { status: 'In progress' });
  await ok(dev, id, 'toggle-task', { index: 0, done: true });
  await ok(dev, id, 'add-evidence', { links: [{ url: 'https://example.com/a' }] });
  await ok(dev, id, 'worker-complete', { summary: 'Delivered' });

  // A scope change: assessed, agreed, approved. New version; the confirmations no longer apply.
  const made = await post(`${W}/tickets/${id}/changes`, req, { requestId: `official-c-${Date.now()}`, ticketVersion: (await ticketOf(id)).version, input: { title: 'More', reason: 'Because', criteria: 'Works' } });
  assert.equal(made.status, 201, made.text);
  const cr = made.json.created;
  // An open change holds up closure.
  assert.equal((await changeAct(req, cr, 'status', { status: 'Assessment' })).status, 403);
  assert.equal((await changeAct(admin, cr, 'status', { status: 'Assessment' })).status, 200);
  assert.equal((await changeAct(dev, cr, 'assess', { impact: 'Some', effort: '1 day', date: '2030-07-15' })).status, 200);
  assert.equal((await changeAct(admin, cr, 'approve')).status, 409, 'the Requestor agrees first');
  assert.equal((await changeAct(req, cr, 'agree')).status, 200);
  assert.equal((await changeAct(dev, cr, 'approve')).status, 403);
  assert.equal((await changeAct(admin, cr, 'approve')).status, 200);
  let t = await ticketOf(id);
  assert.equal(t.agreements.length, 2);
  assert.equal(t.agreements[1].version, 2);
  assert.equal(t.agreements[0].requirements, 'R', 'the earlier version is unchanged');
  assert.equal(t.dueDate, '2030-07-15');
  assert.equal(t.status, 'In progress');
  assert.equal(t.completion.worker, null, 'an approved change clears confirmations');
  assert.equal(t.tasks.length, 2);
  // Deliver the change.
  assert.equal((await changeAct(dev, cr, 'status', { status: 'In progress' })).status, 200);
  assert.equal((await changeAct(dev, cr, 'submit-test', { results: 'Passed' })).status, 200);
  assert.equal((await changeAct(req, cr, 'status', { status: 'Accepted' })).status, 200);
  assert.equal((await changeAct(dev, cr, 'status', { status: 'Released' })).status, 200);
  await ok(dev, id, 'worker-complete', { summary: 'Delivered with the change' });
  await ok(req, id, 'requestor-confirm');
  assert.equal((await act(admin, id, 'status', { status: 'Closed' })).status, 409, 'a Project needs its handover first');
  assert.equal((await act(req, id, 'status', { status: 'Released' })).status, 403);
  await ok(dev, id, 'status', { status: 'Released' });
  await ok(admin, id, 'status', { status: 'Closed' });
  t = await ticketOf(id);
  assert.equal(t.status, 'Closed');
  // After closure, new scope has to be a new request.
  const late = await post(`${W}/tickets/${id}/changes`, req, { requestId: `official-late-${Date.now()}`, ticketVersion: t.version, input: { title: 'More', reason: 'x', criteria: 'x' } });
  assert.equal(late.status, 409);
});

test('an open scope change blocks closure, and approving one on released work clears the confirmations', async () => {
  const id = await projectInDevelopment(admin, dev, req, devId, 'Person 2');
  await ok(dev, id, 'toggle-task', { index: 0, done: true });
  await ok(dev, id, 'add-evidence', { links: [{ url: 'https://example.com/a' }] });
  await ok(dev, id, 'worker-complete', { summary: 'Delivered' });
  await ok(req, id, 'requestor-confirm');
  await ok(dev, id, 'status', { status: 'Released' });
  const cr = (await post(`${W}/tickets/${id}/changes`, req, { requestId: `official-c2-${Date.now()}`, ticketVersion: (await ticketOf(id)).version, input: { title: 'Late', reason: 'x', criteria: 'x' } })).json.created;
  const blocked = await act(admin, id, 'status', { status: 'Closed' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, new RegExp(cr));
  await changeAct(admin, cr, 'status', { status: 'Assessment' });
  await changeAct(dev, cr, 'assess', { impact: 'x', effort: '1 day', date: '2030-08-01' });
  await changeAct(req, cr, 'agree');
  assert.equal((await changeAct(admin, cr, 'approve')).status, 200);
  const t = await ticketOf(id);
  assert.equal(t.status, 'In progress', 'released work returns to the worker');
  assert.equal(t.completion.worker, null);
  assert.equal(t.completion.requestor, null);
  assert.equal(t.dueDate, '2030-08-01');
});

test('5. Admin self-assignment works with independent Requestor confirmation', async () => {
  const id = await newRequest(req);
  await assign(admin, id, adminId);
  assert.equal((await ticketOf(id)).devId, adminId);
  await ok(admin, id, 'status', { status: 'In progress' });
  await ok(admin, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(admin, id, 'worker-complete', { summary: 'Done by the Admin' });
  assert.equal((await act(admin, id, 'requestor-confirm')).status, 403, 'the Admin worker cannot confirm for the Requestor');
  assert.equal((await act(admin, id, 'status', { status: 'Closed' })).status, 409);
  await ok(req, id, 'requestor-confirm');
  await ok(admin, id, 'status', { status: 'Closed' });
});

test('self-requested and self-assigned work needs an independent Admin, on the request and on its scope changes', async () => {
  const otherAdmin = await signIn(7);
  await db.collection('users').updateOne({ email: 'person7@jarc.example' }, { $set: { role: 'Admin' } });
  const id = await newRequest(admin);
  await assign(admin, id, adminId);
  await ok(admin, id, 'status', { status: 'In progress' });
  await ok(admin, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(admin, id, 'worker-complete', { summary: 'Done' });
  const refused = await act(admin, id, 'requestor-confirm');
  assert.equal(refused.status, 403);
  await ok(otherAdmin, id, 'requestor-confirm');
  assert.equal((await ticketOf(id)).completion.requestor.id, await idOf(7));
  await ok(admin, id, 'status', { status: 'Closed' });

  // A Project where the Requestor is the worker: their own agreement to a scope change does not count.
  const p = await newRequest(admin, { type: 'Project' });
  await assign(admin, p, adminId);
  await ok(admin, p, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  assert.equal((await act(admin, p, 'confirm-meeting')).status, 403);
  await ok(otherAdmin, p, 'confirm-meeting');
  await ok(admin, p, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(admin, p, 'confirm-agreement');
  assert.equal((await act(admin, p, 'confirm-agreement')).status, 409);
  await ok(otherAdmin, p, 'confirm-agreement');
  await ok(admin, p, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, 'Person 1')] });
  const cr = (await post(`${W}/tickets/${p}/changes`, admin, { requestId: `official-self-${Date.now()}`, ticketVersion: (await ticketOf(p)).version, input: { title: 'Self', reason: 'x', criteria: 'x' } })).json.created;
  await changeAct(admin, cr, 'status', { status: 'Assessment' });
  assert.equal((await changeAct(admin, cr, 'assess', { impact: 'x', effort: '1 day', date: '2030-07-01' })).status, 200);
  assert.equal((await changeAct(admin, cr, 'agree')).status, 403, 'not their own agreement');
  assert.equal((await changeAct(otherAdmin, cr, 'agree')).status, 200);
  await db.collection('users').updateOne({ email: 'person7@jarc.example' }, { $set: { role: 'Requestor' } });
});

test('6. demotion and disabling remove access at once, and show on every route', async () => {
  const worker = await signIn(8);
  const workerId = await idOf(8);
  await db.collection('users').updateOne({ _id: new ObjectId(workerId) }, { $set: { role: 'Developer' } });
  const id = await newRequest(req, { title: 'QUOKKA note' });
  await assign(admin, id, workerId);
  await ok(req, id, 'comment', { comment: 'Sensitive detail about QUOKKA' });
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: worker })).status, 200);
  const before = (await call(`${W}/notifications`, { cookie: worker })).json.items;
  assert.ok(before.some(n => n.text.includes('QUOKKA')), 'the worker saw it while assigned');

  // Demoted: no longer the worker, in the same session.
  assert.equal((await send('PATCH', `/api/v1/users/${workerId}`, admin, { role: 'Requestor' })).status, 200);
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: worker })).status, 404);
  assert.equal((await act(worker, id, 'status', { status: 'In progress' })).status, 404);
  assert.equal((await call(`${W}/search?q=QUOKKA`, { cookie: worker })).json.total, 0);
  const after = (await call(`${W}/notifications`, { cookie: worker })).json.items;
  assert.ok(!JSON.stringify(after).includes('QUOKKA'), 'past notifications no longer show the text');
  assert.ok(after.some(n => n.unavailable));
  // The Admin is told it needs reassigning.
  const ws = (await call(`${W}/workspace`, { cookie: admin })).json;
  assert.ok(ws.cannotWork.includes(workerId));
  assert.equal((await call('/api/v1/users', { cookie: admin })).json.users.find(u => u.id === workerId).openAssigned, 1);
  assert.ok(!('cannotWork' in (await call(`${W}/workspace`, { cookie: dev })).json), 'only Admins receive account flags');

  // Disabled: the session ends and sign-in is refused.
  assert.equal((await send('PATCH', `/api/v1/users/${workerId}`, admin, { status: 'disabled' })).status, 200);
  assert.equal((await call('/api/v1/me', { cookie: worker })).status, 401);
  assert.equal((await call(`${W}/workspace`, { cookie: worker })).status, 401);
  assert.equal((await call('/', { cookie: worker })).status, 302);
  const login = await call('/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(8)));
  const denied = await call(back.pathname + back.search, { cookie: flow });
  assert.equal(denied.status, 403);
  assert.ok(!denied.setCookies.some(c => c.startsWith('jt_session=')));
  // A disabled account cannot be assigned, either.
  assert.equal((await act(admin, id, 'assign', { dev: workerId, priority: 'High' })).status, 400);
  await assign(admin, id, devId); // reassigned, the work continues
});

test('a disabled Requestor does not strand the work: an Admin other than the worker reviews', async () => {
  const leaver = await signIn(9);
  const id = await newRequest(leaver);
  await assign(admin, id, devId);
  await ok(dev, id, 'status', { status: 'In progress' });
  await ok(dev, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(dev, id, 'worker-complete', { summary: 'Done' });
  assert.equal((await act(admin, id, 'requestor-confirm')).status, 403, 'while the Requestor is active, they confirm');
  assert.equal((await send('PATCH', `/api/v1/users/${await idOf(9)}`, admin, { status: 'disabled' })).status, 200);
  await ok(admin, id, 'requestor-confirm');
  await ok(admin, id, 'status', { status: 'Closed' });
});

test('reassignment clears a stale draft confirmation; a held Project resumes where it was', async () => {
  const other = await signIn(10);
  const otherId = await idOf(10);
  await db.collection('users').updateOne({ _id: new ObjectId(otherId) }, { $set: { role: 'Developer' } });
  const id = await newRequest(req, { type: 'Project' });
  await assign(admin, id, devId);
  await ok(dev, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  await ok(req, id, 'confirm-meeting');
  await ok(dev, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(dev, id, 'confirm-agreement');
  await assign(admin, id, otherId);
  assert.equal((await ticketOf(id)).agreementDraft.worker, null, 'the new worker confirms for themselves');
  await ok(req, id, 'confirm-agreement');
  assert.ok(!(await ticketOf(id)).agreements, 'still not locked');
  await ok(other, id, 'confirm-agreement');
  await ok(other, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task(1, 'Person 10')] });
  await ok(other, id, 'status', { status: 'In progress' });

  // Hold and resume returns to In progress, so the Project cannot get stuck.
  await ok(admin, id, 'reason', { status: 'On hold', reason: 'Waiting for budget' });
  assert.equal((await act(other, id, 'toggle-task', { index: 0, done: true })).status, 409);
  await ok(admin, id, 'status', { status: 'Under review' });
  let t = await ticketOf(id);
  assert.equal(t.status, 'In progress');
  assert.equal(t.heldFrom, undefined);
  await ok(other, id, 'toggle-task', { index: 0, done: true });

  // Held after completion: confirmations are cleared and the work restarts.
  await ok(other, id, 'add-evidence', { links: [{ url: 'https://example.com/z' }] });
  await ok(other, id, 'worker-complete', { summary: 'Done' });
  await ok(admin, id, 'reason', { status: 'On hold', reason: 'Pause' });
  await ok(admin, id, 'status', { status: 'Under review' });
  t = await ticketOf(id);
  assert.equal(t.status, 'In progress');
  assert.equal(t.completion.worker, null);

  // A record from before this rule: On hold with a project and no remembered status reaches Planning when assigned.
  const old = await projectInDevelopment(admin, other, req, otherId, 'Person 10');
  await db.collection('tickets').updateOne({ id: old }, { $set: { status: 'On hold' }, $unset: { heldFrom: '' }, $inc: { version: 1 } });
  await ok(admin, old, 'status', { status: 'Under review' });
  await ok(admin, old, 'assign', { dev: otherId, priority: 'High' });
  assert.equal((await ticketOf(old)).status, 'Planning');
  await ok(other, old, 'status', { status: 'In progress' });
});

test('an Admin can change the priority of work another Admin assigned to themselves', async () => {
  const otherAdmin = await signIn(11);
  const otherId = await idOf(11);
  await db.collection('users').updateOne({ _id: new ObjectId(otherId) }, { $set: { role: 'Admin' } });
  const id = await newRequest(req);
  await assign(otherAdmin, id, otherId);
  await ok(admin, id, 'assign', { dev: otherId, priority: 'Critical' });
  const t = await ticketOf(id);
  assert.equal(t.priority, 'Critical');
  assert.equal(t.devId, otherId);
  // Assigning new work to another Admin (not themselves) stays refused.
  const next = await newRequest(req);
  assert.equal((await act(admin, next, 'assign', { dev: otherId, priority: 'High' })).status, 400);
  await db.collection('users').updateOne({ _id: new ObjectId(otherId) }, { $set: { role: 'Requestor' } });
});

test('7. simulation and preview are unavailable in the official configuration, on the server', async () => {
  for (const p of ['/api/v1/beta', '/api/v1/beta/workspace?view=Admin', '/api/v1/beta/search?view=Admin', '/api/v1/beta/notifications?view=Admin', '/api/v1/beta/tickets/JRC-1001?view=Admin']) {
    assert.equal((await call(p, { cookie: admin })).status, 404, p);
    assert.equal((await call(p)).status, 401, p);
  }
  for (const p of ['/api/v1/beta/reset', '/api/v1/beta/tickets', '/api/v1/beta/attachments', '/api/v1/beta/tickets/JRC-1001/actions']) {
    assert.equal((await post(p, admin, { confirm: 'RESET', view: 'Admin' })).status, 404, p);
  }
  assert.equal((await call('/inspection.js', { cookie: admin })).status, 404);
  assert.equal((await call('/sample-data.js', { cookie: admin })).status, 404);
  assert.equal((await call('/inspection.js')).status, 401);
  // The page carries no selector, sample data, or prototype labels.
  const page = await call('/', { cookie: req });
  assert.equal(page.status, 200);
  for (const text of ['demo-role', 'Demo role', 'sample-data.js', 'inspection.js', 'Local prototype', 'Saved locally', 'browser']) assert.ok(!page.text.includes(text), `page must not include ${text}`);
  assert.match(page.text, /My workspace/);
  const session = JSON.parse(/JARC_SESSION=Object\.freeze\((\{.*?\})\);/.exec(page.text)[1]);
  assert.equal(session.beta, false);
  assert.equal(session.inspection, false);
  // Sign-in page text.
  assert.ok(!/beta/i.test((await call('/auth/signin')).text));
  // Deployed configuration refuses to start with either enabled, even if a variable is left on.
  const deployed = { NODE_ENV: 'production', PORT: '8080', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'x', ...ENTRA_ENV, APP_BASE_URL: 'https://jarctech.example' };
  assert.doesNotThrow(() => loadConfig(deployed));
  for (const name of ['BETA_SIMULATION', 'INSPECTION_MODE']) {
    assert.throws(() => loadConfig({ ...deployed, [name]: 'enabled' }), err => err instanceof ConfigError && err.message.includes(name));
    assert.throws(() => loadConfig({ ...deployed, NODE_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: 'production', [name]: 'enabled' }), ConfigError);
    // Nor locally against a shared address.
    assert.throws(() => loadConfig({ ...deployed, NODE_ENV: 'development', [name]: 'enabled' }), ConfigError);
    assert.equal(loadConfig({ ...deployed, [name]: 'disabled' }).auth.beta, false);
  }
  assert.throws(() => loadConfig({ ...deployed, RATE_LIMITS: 'disabled' }), ConfigError);
  assert.equal(loadConfig(deployed).limits.rate, true);
  // Demo mode too.
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://h/', MONGODB_DB_NAME: 'x', AUTH_MODE: 'demo' }), ConfigError);
});

test('8. beta records stay separate and untouched by everything above', async () => {
  const reminders = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), now: () => new Date('2031-01-01T00:00:00Z'), instanceId: 'official-test' });
  await reminders.runOnce();
  assert.deepEqual(await fingerprint(db, BETA_NAMES), betaBefore);
  const real = (await call(`${W}/workspace`, { cookie: admin })).json.tickets.map(t => t.id);
  const beta = (await db.collection('beta_tickets').find({}, { projection: { id: 1 } }).toArray()).map(t => t.id);
  assert.ok(beta.length);
  assert.ok(!real.some(id => beta.includes(id)), 'no real ticket number means a beta record');
  assert.equal((await call(`${W}/tickets/${beta[0]}`, { cookie: admin })).status, 404);
  assert.deepEqual(Object.keys(app.auth.engines).filter(k => app.auth.engines[k]), ['work']);
});

test('reminders survive restarts: a later run catches up, with no duplicates', async () => {
  const id = await newRequest(req, { type: 'Ticket' });
  await assign(admin, id, devId);
  await db.collection('tickets').updateOne({ id }, { $set: { dueDate: '2030-12-30' } });
  const workspaces = Object.values(app.auth.engines).filter(Boolean);
  const first = createReminders({ db, workspaces, now: () => new Date('2031-01-05T00:00:00Z'), instanceId: 'first', settings: { timezone: 'Asia/Manila', dueSoonDays: 2, escalateOverdueDays: 2, acceptanceDays: 2, escalateAcceptanceDays: 5, pendingDays: 2, intervalMinutes: 5 } });
  await first.runOnce();
  const count = await db.collection('notifications').countDocuments({ ticket: id, reminder: true });
  assert.ok(count > 0);
  await first.stop(); // a new instance can take over at once
  const second = createReminders({ db, workspaces, now: () => new Date('2031-01-05T00:01:00Z'), instanceId: 'second', settings: { timezone: 'Asia/Manila', dueSoonDays: 2, escalateOverdueDays: 2, acceptanceDays: 2, escalateAcceptanceDays: 5, pendingDays: 2, intervalMinutes: 5 } });
  assert.equal((await second.runOnce()).ran, true);
  assert.equal(await db.collection('notifications').countDocuments({ ticket: id, reminder: true }), count);
  await second.stop();
  assert.equal((await ok(dev, id, 'status', { status: 'In progress' })).status, 200);
});

test('concurrent saves and duplicate submissions keep one result', async () => {
  const requestId = `official-dup-${Date.now()}`;
  const body = { requestId, input: { title: 'Duplicate', type: 'Ticket', department: 'IT', date: FUTURE, category: 'Enhancement', description: 'x' } };
  const all = await Promise.all(Array.from({ length: 6 }, () => post(`${W}/tickets`, req, body)));
  assert.ok(all.every(r => [200, 201].includes(r.status)), JSON.stringify(all.map(r => r.status)));
  assert.equal(new Set(all.map(r => r.json.created)).size, 1);
  assert.equal(await db.collection('tickets').countDocuments({ requestId }), 1);
  const id = all[0].json.created;
  // A retry of the same id by someone else is not answered with the record.
  assert.equal((await post(`${W}/tickets`, stranger, body)).status, 409);
  // Two people saving the same version: exactly one wins and the other gets the latest record back.
  const version = (await ticketOf(id)).version;
  const race = await Promise.all([post(`${W}/tickets/${id}/actions`, req, { version, action: 'comment', input: { comment: 'a' } }), post(`${W}/tickets/${id}/actions`, admin, { version, action: 'comment', input: { comment: 'b' } })]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  const loser = race.find(r => r.status === 409);
  assert.equal(loser.json.tickets[0].id, id);
  // A stale retry is refused rather than repeated.
  assert.equal((await post(`${W}/tickets/${id}/actions`, req, { version, action: 'comment', input: { comment: 'a' } })).status, 409);
});

test('input validation: unusual values are refused cleanly, never as a server error', async () => {
  const id = await newRequest(req);
  for (const status of ['constructor', '__proto__', 'toString', 'Bogus']) {
    assert.equal((await act(admin, id, 'reason', { status, reason: 'x' })).status, 400, status);
    assert.equal((await act(admin, id, 'status', { status })).status, 400, status);
  }
  const p = await projectInDevelopment(admin, dev, req, devId, 'Person 2');
  const cr = (await post(`${W}/tickets/${p}/changes`, req, { requestId: `official-v-${Date.now()}`, ticketVersion: (await ticketOf(p)).version, input: { title: 'x', reason: 'x', criteria: 'x' } })).json.created;
  for (const status of ['constructor', '__proto__']) {
    assert.equal((await changeAct(admin, cr, 'status', { status })).status, 400, status);
    assert.equal((await changeAct(admin, cr, 'decision', { status, reason: 'x' })).status, 400, status);
  }
  // Query and body objects cannot become database operators.
  assert.equal((await call(`${W}/search?status[$ne]=x`, { cookie: req })).status, 200);
  assert.equal((await call(`${W}/search?dev=${encodeURIComponent('{"$ne":""}')}`, { cookie: admin })).status, 400);
  assert.equal((await call(`${W}/search?q=${encodeURIComponent('.*(a+)+$')}`, { cookie: req })).status, 200);
  assert.equal((await post(`${W}/tickets`, req, { requestId: { $ne: '' }, input: {} })).status, 400);
  assert.equal((await post(`${W}/tickets/${id}/actions`, req, { version: { $gt: 0 }, action: 'comment', input: { comment: 'x' } })).status, 409);
  assert.equal((await act(req, id, 'comment', { comment: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post(`${W}/tickets`, req, { requestId: `official-long-${Date.now()}`, input: { title: 'x'.repeat(151), type: 'Ticket', department: 'IT', date: FUTURE, category: 'Enhancement', description: 'x' } })).status, 400);
  assert.equal((await post(`${W}/tickets`, req, { requestId: `official-date-${Date.now()}`, input: { title: 'x', type: 'Ticket', department: 'IT', date: '2030-02-31', category: 'Enhancement', description: 'x' } })).status, 400);
  // A task's text is capped, and a plan fits in a request: a full-size project plan in non-Latin text is not too large.
  const big = 'ก'.repeat(1900);
  const plan = await act(dev, p, 'save-task', { index: null, task: { ...task(2, 'Person 2'), requirement: big, criteria: big } });
  assert.equal(plan.status, 200, plan.text);
  assert.equal((await act(dev, p, 'save-task', { index: null, task: { ...task(3, 'Person 2'), requirement: 'x'.repeat(2001) } })).status, 400);
  // Unsafe links and stored markup: links are refused, text stays text for the page to escape.
  await ok(dev, p, 'toggle-task', { index: 0, done: true });
  assert.equal((await act(dev, p, 'add-evidence', { links: [{ url: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await act(dev, p, 'add-evidence', { links: [{ url: 'https://user:pw@example.com/' }] })).status, 400);
  // Requests over the limit get an answer, not a dropped connection.
  const tooBig = await call(`${W}/tickets`, { method: 'POST', cookie: req, headers: { Origin: origin, 'Content-Type': 'application/json' }, raw: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }) });
  assert.equal(tooBig.status, 413);
  // A record at its stored size limit says so.
  const full = await newRequest(req);
  await db.collection('tickets').updateOne({ id: full }, { $set: { history: Array.from({ length: 2000 }, () => ({ text: 'x', time: 't' })) } });
  const over = await act(req, full, 'comment', { comment: 'one more' });
  assert.equal(over.status, 409);
  assert.match(over.json.message, /size limit/);
});

test('CSRF protection, headers, and safe errors', async () => {
  const id = await newRequest(req);
  const version = (await ticketOf(id)).version;
  const body = { version, action: 'comment', input: { comment: 'forged' } };
  for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
    assert.equal((await call(`${W}/tickets/${id}/actions`, { method: 'POST', cookie: req, body, headers })).status, 403);
    assert.equal((await call('/api/v1/users', { method: 'POST', cookie: admin, body: { email: 'x@jarc.example', role: 'Admin' }, headers })).status, 403);
  }
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: req, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(`${W}/tickets/${id}/actions`, { method: 'POST', cookie: req, raw: JSON.stringify(body), headers: { Origin: origin, 'Content-Type': 'text/plain' } })).status, 415);
  const page = await call('/', { cookie: req });
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self' http:\/\/(localhost|127\.0\.0\.1)/, 'sign-out continues to the sign-in provider');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(page.text.includes(`<script nonce="${nonce}">window.JARC_SESSION`));
  const signin = await call('/auth/signin');
  assert.match(signin.headers.get('content-security-policy'), /default-src 'self'/);
  // A display name with markup cannot end the inline script.
  await db.collection('users').updateOne({ email: 'person3@jarc.example' }, { $set: { displayName: '</script><script>alert(1)</script>' } });
  const hostile = await call('/', { cookie: req });
  assert.ok(!hostile.text.includes('</script><script>alert(1)'));
  await db.collection('users').updateOne({ email: 'person3@jarc.example' }, { $set: { displayName: 'Person 3' } });
  // Health endpoints say nothing about the deployment.
  const ready = await call('/readyz');
  assert.deepEqual(ready.json, { status: 'ready', database: 'connected' });
  // Unknown routes and unknown record numbers.
  assert.equal((await call('/api/v1/nope', { cookie: req })).status, 404);
  assert.equal((await call(`${W}/tickets/JRC-999999`, { cookie: admin })).status, 404);
  assert.equal((await call('/..%2f..%2fserver.cjs', { cookie: admin })).status, 403);
  // Cookies.
  const login = await call('/auth/login');
  assert.match(login.setCookies[0], /HttpOnly/);
  assert.match(login.setCookies[0], /SameSite=Lax/);
});

test('attachments: type and content checks, safe names, cleanup, and the storage limit', async () => {
  assert.equal((await upload(req, 'page.html', Buffer.from('<script>alert(1)</script>'))).status, 415);
  assert.equal((await upload(req, 'fake.png', Buffer.from('<script>alert(1)</script>'))).status, 415);
  assert.equal((await upload(req, 'x.svg', Buffer.from('<svg/>'))).status, 415);
  assert.equal((await upload(req, 'empty.txt', Buffer.alloc(0))).status, 400);
  // An oversized upload is answered from its declared length, without reading the body.
  const oversize = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: `${W}/attachments`, method: 'POST', headers: { Cookie: req, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.txt', 'Content-Length': 11 * 1024 * 1024 } }, resolve);
    r.on('error', reject);
    r.flushHeaders();
  });
  assert.equal(oversize.statusCode, 413);
  oversize.destroy();
  const tricky = await upload(req, '..\\..\\evil\r\nSet-Cookie: x=1.png');
  assert.equal(tricky.status, 201);
  assert.ok(!/[\r\n\\/]/.test(tricky.json.attachment.name));
  const file = await call(`${W}/attachments/${tricky.json.attachment.id}/download`, { cookie: req });
  assert.equal(file.status, 200);
  assert.ok(!file.headers.get('set-cookie'));
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal((await send('DELETE', `${W}/attachments/${tricky.json.attachment.id}`, req)).status, 200);

  // An abandoned upload is removed by the scheduled cleanup, with its file.
  const left = await upload(req, 'left.png');
  const leftId = new ObjectId(left.json.attachment.id);
  await db.collection('attachments').updateOne({ _id: leftId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const reminders = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), instanceId: 'sweep-test' });
  await db.collection('scheduler_locks').deleteOne({ _id: 'reminders' });
  await reminders.runOnce();
  await reminders.stop();
  assert.equal(await db.collection('attachments').countDocuments({ _id: leftId }), 0);
  assert.equal(await db.collection('files.files').countDocuments({ _id: leftId }), 0);

  // The limit is configurable, and a full workspace refuses with a clear message.
  const p2 = await freePort();
  const small = await start(loadConfig(envFor(p2, { ATTACHMENT_QUOTA_MB: '1' })), { log: silent, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  try {
    const cookie = await signIn(3, p2);
    await db.collection('attachments').insertOne({ workspace: 'main', name: 'huge.pdf', ext: 'pdf', size: 1024 * 1024, state: 'attached', uploadedBy: await idOf(1), uploadedAt: new Date(), ticket: 'JRC-1' });
    const refused = await upload(cookie, 'more.png', PNG, p2, `http://localhost:${p2}`);
    assert.equal(refused.status, 507);
    assert.match(refused.json.message, /storage limit/);
    await db.collection('attachments').deleteOne({ name: 'huge.pdf' });
  } finally { await small.shutdown(); }
});

test('abuse limits answer 429 with a retry time, for each account separately', async () => {
  let clock = 1000;
  const limits = createLimits({ enabled: true, now: () => clock, rules: { write: { max: 2, windowMs: 1000 } } });
  assert.equal(limits.take('write', 'a'), null);
  assert.equal(limits.take('write', 'a'), null);
  assert.equal(limits.take('write', 'b'), null);
  const hit = limits.take('write', 'a');
  assert.ok(hit.retryAfter >= 1);
  assert.match(hit.message, /Wait/);
  clock += 1001;
  assert.equal(limits.take('write', 'a'), null);
  assert.equal(createLimits({ enabled: false, rules: {} }).take('write', 'a'), null);

  const p2 = await freePort();
  const limited = await start(loadConfig(envFor(p2, { RATE_LIMITS: 'enabled' })), { log: silent, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  try {
    const cookie = await signIn(3, p2);
    const o = `http://localhost:${p2}`;
    let last;
    for (let i = 0; i < 200 && (!last || last.status !== 429); i++) last = await call('/api/v1/me/preferences', { at: p2, method: 'PATCH', cookie, body: { emailReminders: false }, headers: { Origin: o } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.match(last.json.message, /Wait/);
    // Reading and other accounts are unaffected.
    assert.equal((await call('/api/v1/me', { at: p2, cookie })).status, 200);
    let signins;
    for (let i = 0; i < 80 && (!signins || signins.status !== 429); i++) signins = await call('/auth/login', { at: p2 });
    assert.equal(signins.status, 429);
    assert.match(signins.text, /Too many sign-in attempts/);
  } finally { await limited.shutdown(); }
});

test('backup and restore: complete, checked, and never overwriting by accident', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-backup-'));
  const target = mongo.db('jarctech_official_restore');
  try {
    const manifest = await backup(db, DB, dir);
    assert.ok(manifest.collections.users.count > 0);
    assert.ok(!manifest.collections.sessions, 'sign-in sessions are not backed up');
    assert.ok(manifest.collections['beta_tickets'].count > 0);
    await verifyBackup(dir);
    await assert.rejects(backup(db, DB, dir), /already holds a backup/);
    const result = await restore(target, dir);
    assert.equal(result.restored.users, manifest.collections.users.count);
    const names = Object.keys(manifest.collections);
    assert.deepEqual(await fingerprint(target, names), await fingerprint(db, names));
    assert.ok((await target.collection('users').indexes()).some(i => i.name === 'email_unique'), 'indexes come back');
    assert.ok((await target.listCollections({ name: 'users' }).next()).options.validator, 'validators come back');
    // A second restore refuses rather than overwriting; --replace replaces.
    await assert.rejects(restore(target, dir), /already has records/);
    await target.collection('users').deleteMany({});
    await target.collection('events').insertOne({ type: 'after-backup', at: new Date() });
    await restore(target, dir, { replace: true });
    assert.deepEqual(await fingerprint(target, names), await fingerprint(db, names));
    // Damage is detected before anything is written.
    const file = path.join(dir, manifest.collections.users.file);
    fs.appendFileSync(file, 'x');
    await assert.rejects(verifyBackup(dir), /damaged/);
    await assert.rejects(restore(mongo.db('jarctech_official_restore2'), dir), /damaged/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await target.dropDatabase(); }
});

function runCommand(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

test('the official-release command changes no record, is repeatable, and protects the beta data afterwards', async () => {
  assert.equal((await runCommand('db-official-release.cjs', [])).code, 2, 'names the database explicitly');
  assert.equal((await runCommand('db-official-release.cjs', ['--confirm-db', DB, '--verify'])).code, 1, 'nothing recorded yet');
  const users = await fingerprint(db, ['users', 'tickets', 'ticket_changes']);
  const first = await runCommand('db-official-release.cjs', ['--confirm-db', DB]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /No records were changed/);
  assert.equal(await db.collection('events').countDocuments({ type: 'release.official' }), 1);
  const again = await runCommand('db-official-release.cjs', ['--confirm-db', DB]);
  assert.equal(again.code, 0, again.out);
  assert.equal(await db.collection('events').countDocuments({ type: 'release.official' }), 1, 'recorded once');
  assert.equal((await runCommand('db-official-release.cjs', ['--confirm-db', DB, '--verify'])).code, 0);
  assert.deepEqual(await fingerprint(db, ['users', 'tickets', 'ticket_changes']), users);
  assert.deepEqual(await fingerprint(db, BETA_NAMES), betaBefore);
  // The seed command refuses on the official database, with or without --replace.
  for (const args of [['--confirm-db', DB], ['--confirm-db', DB, '--replace']]) {
    const seeded = await runCommand('beta-seed.cjs', args);
    assert.equal(seeded.code, 1, seeded.out);
    assert.match(seeded.out, /official database/);
  }
  assert.deepEqual(await fingerprint(db, BETA_NAMES), betaBefore);
  // A change to the beta data is reported.
  await db.collection('beta_changes').updateOne({ workspace: 'beta' }, { $set: { touched: true } });
  const changed = await runCommand('db-official-release.cjs', ['--confirm-db', DB, '--verify']);
  assert.equal(changed.code, 1);
  assert.match(changed.out, /beta_changes/);
  await db.collection('beta_changes').updateOne({ workspace: 'beta' }, { $unset: { touched: '' } });
});
