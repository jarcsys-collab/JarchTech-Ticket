// An Admin completing their own request, and Admin-only archiving, restoring, and permanent deletion of finished
// requests, enforced on the server. Mock Entra and a temporary MongoDB only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { createReminders } = require('../server/workspace/reminders.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const SECRET = 'admin-records-mock-secret';
const DB = 'jarctech_admin_records_test';
const W = '/api/v1/work';
const FUTURE = '2030-06-01';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const quiet = { log() {}, error() {} };
let mongod, mongo, db, entra, port, origin, app;
let ADMIN, ADMIN2, DEV, REQ, OTHER; // cookies
let adminId, admin2Id, devId, reqId;
let rid = 0;

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
async function call(p, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, buf, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const post = (p, cookie, body = {}) => call(p, { method: 'POST', cookie, body, headers: { Origin: origin } });
const person = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: `person${n}@jarc.example`, preferred_username: `person${n}@jarc.example` });
async function signIn(n) {
  const login = await call('/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(n)));
  const res = await call(back.pathname + back.search, { cookie: flow });
  return res.setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
}
const users = () => db.collection('users');
const idOf = async n => String((await users().findOne({ email: `person${n}@jarc.example` }))._id);
const setUser = (id, fields) => users().updateOne({ _id: new ObjectId(id) }, { $set: fields });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: origin, SESSION_SECRET: 'admin-records-session-secret-0123456789abcdefg'
  }), { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  ADMIN = await signIn(1); ADMIN2 = await signIn(2); DEV = await signIn(3); REQ = await signIn(4); OTHER = await signIn(5);
  [adminId, admin2Id, devId, reqId] = await Promise.all([1, 2, 3, 4].map(idOf));
  await setUser(adminId, { role: 'Admin' }); await setUser(admin2Id, { role: 'Admin' }); await setUser(devId, { role: 'Developer' });
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

const stored = id => db.collection('tickets').findOne({ workspace: 'main', id });
const details = (cookie, id) => call(`${W}/tickets/${id}`, { cookie });
const newRequest = async (cookie, overrides = {}) => {
  const res = await post(`${W}/tickets`, cookie, { requestId: `records-${++rid}-${Date.now()}`, input: { title: 'RECORDTEST request', type: 'Ticket', department: 'FINANCE', date: FUTURE, category: 'EXCEL', description: 'SECRET-DESCRIPTION', criteria: 'Works', ...overrides } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.created;
};
async function act(cookie, id, action, input = {}) {
  return post(`${W}/tickets/${id}/actions`, cookie, { version: (await stored(id)).version, action, input });
}
async function ok(cookie, id, action, input = {}) {
  const res = await act(cookie, id, action, input);
  assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.json)}`);
  return res.json.tickets[0];
}
const changeOf = id => db.collection('ticket_changes').findOne({ workspace: 'main', id });
async function changeAct(cookie, id, action, input = {}) {
  return post(`${W}/changes/${id}/actions`, cookie, { version: (await changeOf(id)).version, action, input });
}
const assign = (id, worker, cookie = ADMIN) => ok(cookie, id, 'assign', { dev: worker, priority: 'Medium' });
const uploadAs = async cookie => (await (await fetch(`http://127.0.0.1:${port}${W}/attachments`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'proof.png' }, body: PNG })).json()).attachment;
const task = owner => ({ title: 'Build it', requirement: 'R', criteria: 'C', start: '2030-01-10', end: '2030-02-10', owner });

// A finished Ticket: worker DEV, Requestor REQ, an evidence file, closed by ADMIN.
async function closedTicket(overrides) {
  const id = await newRequest(REQ, overrides);
  await assign(id, devId);
  await ok(DEV, id, 'status', { status: 'In progress' });
  const file = await uploadAs(DEV);
  await ok(DEV, id, 'add-evidence', { attachments: [file.id], links: [{ url: 'https://example.com/run' }] });
  await ok(DEV, id, 'worker-complete', { summary: 'Done' });
  await ok(REQ, id, 'requestor-confirm');
  await ok(ADMIN, id, 'status', { status: 'Closed' });
  return { id, file };
}

// ---- An Admin completing their own request ----

test('a self-requested, self-assigned Ticket: separate explicit steps by one Admin, each recorded in its capacity', async () => {
  const id = await newRequest(ADMIN);
  await assign(id, adminId);
  await ok(ADMIN, id, 'status', { status: 'In progress' });
  assert.equal((await act(ADMIN, id, 'worker-complete', { summary: 'Done' })).status, 400, 'evidence is still required');
  await ok(ADMIN, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  assert.equal((await act(ADMIN, id, 'worker-complete', { summary: '  ' })).status, 400, 'the delivery summary is still required');
  assert.equal((await act(ADMIN, id, 'requestor-confirm')).status, 409, 'nothing to confirm before the worker has marked it done');

  const done = await ok(ADMIN, id, 'worker-complete', { summary: 'Delivered and tested' });
  assert.equal(done.completion.worker.id, adminId);
  assert.equal(done.completion.requestor, null, 'one action never counts as both');
  assert.equal(done.status, 'Awaiting acceptance');
  assert.equal((await act(ADMIN, id, 'status', { status: 'Closed' })).status, 409, 'not closable on the worker confirmation alone');

  const confirmed = await ok(ADMIN, id, 'requestor-confirm');
  assert.equal(confirmed.completion.requestor.id, adminId);
  assert.equal(confirmed.status, 'Ready for release', 'confirming does not close it either');
  assert.equal((await act(ADMIN, id, 'requestor-confirm')).status, 409, 'cannot confirm twice');

  const closed = await ok(ADMIN, id, 'status', { status: 'Closed' });
  assert.equal(closed.status, 'Closed');
  const h = closed.history;
  const of = text => h.find(x => x.text.includes(text));
  for (const [text, capacity] of [['Worker marked the work done', 'Worker'], ['reviewed the evidence and confirmed', 'Requestor'], ['status changed to Closed', 'Admin']]) {
    assert.equal(of(text).actorId, adminId, `${text}: same person`);
    assert.equal(of(text).actor, 'Person 1');
    assert.equal(of(text).capacity, capacity, `${text}: capacity`);
  }
  assert.equal(closed.completion.worker.capacity, 'Worker');
  assert.equal(closed.completion.requestor.capacity, 'Requestor');
  assert.match(of('Worker marked').text, /Confirming as the Requestor is a separate step/);
});

test('a self-requested, self-assigned Project keeps the meeting, agreement, timeline, scope change, and handover gates', async () => {
  const id = await newRequest(ADMIN, { type: 'Project' });
  await assign(id, adminId);
  assert.equal((await act(ADMIN, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' })).status, 409, 'the meeting comes first');
  await ok(ADMIN, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  assert.equal((await act(ADMIN, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' })).status, 409, 'and must be confirmed');
  await ok(ADMIN, id, 'confirm-meeting');
  assert.equal((await stored(id)).meetingConfirmedBy.capacity, 'Requestor');
  await ok(ADMIN, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  const first = await ok(ADMIN, id, 'confirm-agreement');
  assert.equal(first.agreementDraft.worker.capacity, 'Worker');
  assert.equal(first.agreementDraft.requestor, null, 'the first confirmation is the worker side only');
  assert.ok(!first.agreements, 'not locked yet');
  const locked = await ok(ADMIN, id, 'confirm-agreement');
  assert.equal(locked.agreements[0].requestor.capacity, 'Requestor');
  assert.equal(locked.agreements[0].worker.id, locked.agreements[0].requestor.id);
  await ok(ADMIN, id, 'create-project', { projectName: 'Mine', date: FUTURE, tasks: [task('Person 1')] });
  await ok(ADMIN, id, 'status', { status: 'In progress' });
  assert.equal((await act(ADMIN, id, 'worker-complete', { summary: 'Done' })).status, 400, 'tasks must be finished');
  await ok(ADMIN, id, 'toggle-task', { index: 0, done: true });
  await ok(ADMIN, id, 'add-evidence', { links: [{ url: 'https://example.com/y' }] });
  await ok(ADMIN, id, 'worker-complete', { summary: 'Done' });
  await ok(ADMIN, id, 'requestor-confirm');
  const handover = await act(ADMIN, id, 'status', { status: 'Closed' });
  assert.equal(handover.status, 409); assert.match(handover.json.message, /release or handover/);

  // An open scope change still holds up closure. The Admin takes its Requestor side too.
  const cr = (await post(`${W}/tickets/${id}/changes`, ADMIN, { requestId: `records-${++rid}-${Date.now()}`, ticketVersion: (await stored(id)).version, input: { title: 'More', reason: 'x', criteria: 'x' } })).json.created;
  await ok(ADMIN, id, 'status', { status: 'Released' });
  const blocked = await act(ADMIN, id, 'status', { status: 'Closed' });
  assert.equal(blocked.status, 409); assert.match(blocked.json.message, /still open/);
  assert.equal((await changeAct(ADMIN, cr, 'status', { status: 'Assessment' })).status, 200);
  assert.equal((await changeAct(ADMIN, cr, 'assess', { impact: 'x', effort: '1 day', date: '2030-07-01' })).status, 200);
  const agreed = await changeAct(ADMIN, cr, 'agree');
  assert.equal(agreed.status, 200, JSON.stringify(agreed.json));
  assert.equal((await changeOf(cr)).requestorAgreedBy.capacity, 'Requestor');
  assert.equal((await changeAct(ADMIN, cr, 'decision', { status: 'Rejected', reason: 'Not now' })).status, 200);
  const closed = await ok(ADMIN, id, 'status', { status: 'Closed' });
  assert.equal(closed.status, 'Closed');
});

test('an existing request already in progress qualifies, with nothing filled in on anyone\'s behalf', async () => {
  // Waiting since before this rule: the worker confirmation is recorded, and the Requestor side was refused back then.
  const id = await newRequest(ADMIN);
  await assign(id, adminId);
  await ok(ADMIN, id, 'status', { status: 'In progress' });
  await ok(ADMIN, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN, id, 'worker-complete', { summary: 'Old' });
  const before = await stored(id);
  assert.equal((await details(ADMIN, id)).json.tickets[0].completion.requestor, null, 'reading fills nothing in');
  assert.equal((await stored(id)).version, before.version);
  assert.equal((await ok(ADMIN, id, 'requestor-confirm')).completion.requestor.id, adminId);
  // A return for correction still clears both, and keeps the reason.
  const back = await ok(ADMIN, id, 'reason', { status: 'In progress', reason: 'A mistake' });
  assert.equal(back.completion.worker, null); assert.equal(back.completion.requestor, null);
  assert.equal(back.completion.log.at(-1).worker.id, adminId);
});

test('the exception covers only that one Admin: every other case keeps its rule', async () => {
  // Another Admin takes neither side of it, though any Admin can still close it once both have confirmed.
  const mine = await newRequest(ADMIN);
  await assign(mine, adminId);
  await ok(ADMIN, mine, 'status', { status: 'In progress' });
  await ok(ADMIN, mine, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN, mine, 'worker-complete', { summary: 'Done' });
  assert.equal((await act(ADMIN2, mine, 'requestor-confirm')).status, 403, 'another Admin has nothing to confirm while the Requestor can');
  for (const [who, cookie, status] of [['unrelated Requestor', OTHER, 404], ['unrelated Requestor (close)', OTHER, 404], ['unassigned Developer', DEV, 404]]) {
    assert.equal((await act(cookie, mine, 'requestor-confirm')).status, status, who);
    assert.equal((await act(cookie, mine, 'status', { status: 'Closed' })).status, status, who);
  }

  // A Developer who is both still needs an Admin, and cannot close it.
  const own = await newRequest(DEV);
  await assign(own, devId);
  await ok(DEV, own, 'status', { status: 'In progress' });
  await ok(DEV, own, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(DEV, own, 'worker-complete', { summary: 'Done' });
  const refused = await act(DEV, own, 'requestor-confirm');
  assert.equal(refused.status, 403); assert.match(refused.json.message, /a different Admin must confirm/);
  assert.equal((await act(DEV, own, 'status', { status: 'Closed' })).status, 403);
  assert.equal((await ok(ADMIN, own, 'requestor-confirm')).completion.requestor.capacity, 'Independent reviewer');
  assert.equal((await act(DEV, own, 'status', { status: 'Closed' })).status, 403, 'only an Admin closes');

  // An Admin working on someone else's request cannot confirm for that Requestor.
  const theirs = await newRequest(REQ);
  await assign(theirs, adminId);
  await ok(ADMIN, theirs, 'status', { status: 'In progress' });
  await ok(ADMIN, theirs, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN, theirs, 'worker-complete', { summary: 'Done' });
  assert.equal((await act(ADMIN, theirs, 'requestor-confirm')).status, 403);
  assert.equal((await act(ADMIN, theirs, 'status', { status: 'Closed' })).status, 409);
  assert.equal((await act(REQ, theirs, 'status', { status: 'Closed' })).status, 403, 'a Requestor cannot close');
  await ok(REQ, theirs, 'requestor-confirm');
  await ok(ADMIN, theirs, 'status', { status: 'Closed' });

  // An Admin's own request worked by a Developer: they confirm only as the Requestor.
  const delegated = await newRequest(ADMIN);
  await assign(delegated, devId);
  await ok(DEV, delegated, 'status', { status: 'In progress' });
  assert.equal((await act(ADMIN, delegated, 'worker-complete', { summary: 'x' })).status, 403, 'not the worker');
  await ok(DEV, delegated, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(DEV, delegated, 'worker-complete', { summary: 'Done' });
  await ok(ADMIN, delegated, 'requestor-confirm');
});

test('the exception follows the account: a former Admin, or a disabled one, is reviewed by another Admin again', async () => {
  const id = await newRequest(ADMIN2);
  await assign(id, admin2Id, ADMIN2);
  await ok(ADMIN2, id, 'status', { status: 'In progress' });
  await ok(ADMIN2, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN2, id, 'worker-complete', { summary: 'Done' });
  await setUser(admin2Id, { role: 'Developer' });
  const demoted = await act(ADMIN2, id, 'requestor-confirm');
  assert.equal(demoted.status, 403); assert.match(demoted.json.message, /a different Admin must confirm/);
  assert.equal((await ok(ADMIN, id, 'requestor-confirm')).completion.requestor.id, adminId);
  await setUser(admin2Id, { role: 'Admin' });

  const other = await newRequest(ADMIN2);
  await assign(other, admin2Id, ADMIN2);
  await ok(ADMIN2, other, 'status', { status: 'In progress' });
  await ok(ADMIN2, other, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN2, other, 'worker-complete', { summary: 'Done' });
  await setUser(admin2Id, { status: 'disabled' });
  assert.equal((await ok(ADMIN, other, 'requestor-confirm')).completion.requestor.capacity, 'Independent reviewer');
  await setUser(admin2Id, { status: 'active' });
});

// ---- Archive and restore ----

const archive = async (cookie, id) => post(`${W}/tickets/${id}/archive`, cookie, { version: (await stored(id)).version });
const restore = async (cookie, id) => post(`${W}/tickets/${id}/restore`, cookie, { version: (await stored(id)).version });
const remove = async (cookie, id, confirm = id) => post(`${W}/tickets/${id}/delete`, cookie, { version: (await stored(id)).version, confirm });
const preview = (cookie, id) => call(`${W}/tickets/${id}/deletion-preview`, { cookie });
const search = (cookie, q) => call(`${W}/search?${q}`, { cookie });

test('only a real Admin archives, restores, or deletes; others are refused on the server, with no change', async () => {
  const { id } = await closedTicket();
  const version = (await stored(id)).version;
  for (const [who, cookie, status] of [['the Requestor', REQ, 403], ['the Developer who did the work', DEV, 403], ['an unrelated Requestor', OTHER, 404]]) {
    assert.equal((await archive(cookie, id)).status, status, `archive: ${who}`);
    assert.equal((await remove(cookie, id)).status, status, `delete: ${who}`);
    assert.equal((await preview(cookie, id)).status, status, `preview: ${who}`);
  }
  // Claiming an Admin view changes nothing: access comes from the account.
  assert.equal((await post(`${W}/tickets/${id}/archive`, REQ, { version, view: 'Admin' })).status, 403);
  assert.equal((await post(`${W}/tickets/${id}/delete`, REQ, { version, view: 'Admin', confirm: id })).status, 403);
  for (const cookie of [REQ, DEV, OTHER]) {
    assert.equal((await search(cookie, 'archived=1')).status, 403, 'the Archived view');
    assert.equal((await call(`${W}/deletions`, { cookie })).status, 403, 'the deletion log');
  }
  assert.equal((await call(`${W}/tickets/${id}/archive`, { method: 'POST', cookie: ADMIN, body: { version } })).status, 403, 'a change without the app\'s origin');
  assert.equal((await call(`${W}/tickets/${id}/archive`, { method: 'POST', body: { version }, headers: { Origin: origin } })).status, 401, 'not signed in');
  assert.equal((await stored(id)).version, version, 'nothing changed');
  assert.ok(!(await stored(id)).archived);

  const beta = await post('/api/v1/beta/tickets/JRC-1043/archive', ADMIN, { view: 'Admin', version: 1 });
  assert.equal(beta.status, 404, 'the beta simulation has no such route, whichever view is claimed');
  assert.equal((await post('/api/v1/beta/tickets/JRC-1043/delete', ADMIN, { view: 'Admin', version: 1, confirm: 'JRC-1043' })).status, 404);
  assert.equal((await db.collection('beta_tickets').countDocuments({ archived: { $exists: true } })), 0);
});

test('only finished requests can be archived or deleted; an open scope change must be settled first', async () => {
  const open = await newRequest(REQ);
  for (const res of [await archive(ADMIN, open), await remove(ADMIN, open)]) { assert.equal(res.status, 409); assert.match(res.json.message, /Only closed, rejected, or cancelled/); }
  const plan = (await preview(ADMIN, open)).json;
  assert.equal(plan.canDelete, false); assert.match(plan.blockers[0], /Only closed/);

  // Rejected with a scope change still open.
  const id = await newRequest(REQ, { type: 'Project' });
  await assign(id, adminId);
  await ok(ADMIN, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  await ok(REQ, id, 'confirm-meeting');
  await ok(ADMIN, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(ADMIN, id, 'confirm-agreement');
  await ok(REQ, id, 'confirm-agreement');
  await ok(ADMIN, id, 'create-project', { projectName: 'P', date: FUTURE, tasks: [task('Person 1')] });
  const cr = (await post(`${W}/tickets/${id}/changes`, REQ, { requestId: `records-${++rid}-${Date.now()}`, ticketVersion: (await stored(id)).version, input: { title: 'More', reason: 'x', criteria: 'x' } })).json.created;
  await ok(ADMIN, id, 'reason', { status: 'On hold', reason: 'Paused' });
  await ok(ADMIN, id, 'reason', { status: 'Rejected', reason: 'Dropped' });
  for (const res of [await archive(ADMIN, id), await remove(ADMIN, id)]) { assert.equal(res.status, 409); assert.match(res.json.message, new RegExp(`Scope change ${cr} is still open`)); }
  assert.equal((await changeAct(ADMIN, cr, 'decision', { status: 'Rejected', reason: 'Dropped' })).status, 200);
  assert.equal((await archive(ADMIN, id)).status, 200);
});

test('archived: out of every active view and hidden from non-Admins; read-only; Restore brings it back exactly as it was', async () => {
  const { id, file } = await closedTicket({ title: 'ARCHIVEME request' });
  const before = await stored(id);
  const stale = await post(`${W}/tickets/${id}/archive`, ADMIN, { version: before.version - 1 });
  assert.equal(stale.status, 409, 'a stale screen is refused');

  const res = await archive(ADMIN, id);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const shown = res.json.tickets[0];
  assert.equal(shown.archived.by.id, adminId);
  assert.equal(shown.status, 'Closed', 'its status is unchanged');
  assert.equal((await archive(ADMIN, id)).status, 409, 'already archived');

  for (const [who, cookie] of [['Admin', ADMIN], ['Requestor', REQ], ['Developer', DEV]]) {
    const ws = (await call(`${W}/workspace`, { cookie })).json;
    assert.ok(!ws.tickets.some(t => t.id === id), `${who}: dashboard and queues`);
    assert.ok(!ws.notices.some(n => n.text.includes(id)), `${who}: activity feed`);
    assert.equal((await search(cookie, 'q=ARCHIVEME')).json.total, 0, `${who}: active search`);
  }
  assert.equal((await search(ADMIN, 'archived=1&q=ARCHIVEME')).json.items[0].id, id, 'the Archived view');
  assert.equal((await details(ADMIN, id)).status, 200, 'an Admin can open it');
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: ADMIN })).status, 200, 'and its files');
  for (const cookie of [REQ, DEV]) {
    assert.equal((await details(cookie, id)).status, 404, 'hidden until restored');
    assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie })).status, 404);
    const note = (await call(`${W}/notifications?limit=50`, { cookie })).json.items.find(n => n.ticket === id);
    if (note) assert.ok(note.unavailable, 'old notifications keep only a generic line');
  }
  const comment = await act(ADMIN, id, 'comment', { comment: 'Still here?' });
  assert.equal(comment.status, 409); assert.match(comment.json.message, /archived/);

  assert.equal((await post(`${W}/tickets/${id}/restore`, ADMIN, { version: 1 })).status, 409, 'a stale restore is refused');
  for (const [cookie, status] of [[REQ, 404], [DEV, 404], [OTHER, 404]]) assert.equal((await restore(cookie, id)).status, status);
  const back = await restore(ADMIN, id);
  assert.equal(back.status, 200);
  const after = await stored(id);
  assert.ok(!after.archived);
  assert.deepEqual([after.status, after.dev, after.completion, after.evidence, after.statusSince], [before.status, before.dev, before.completion, before.evidence, before.statusSince], 'nothing else changed');
  assert.deepEqual(after.history.slice(0, before.history.length), before.history, 'the earlier history is kept');
  assert.deepEqual(after.history.slice(before.history.length).map(h => [h.text.split(':')[0], h.actorId, h.capacity]), [['Archived', adminId, 'Admin'], ['Restored from the archive.', adminId, 'Admin']]);
  assert.equal((await details(REQ, id)).status, 200, 'the Requestor has it again');
  assert.equal((await call(`${W}/attachments/${file.id}/download`, { cookie: REQ })).status, 200);
  assert.equal((await restore(ADMIN, id)).status, 409, 'not archived any more');
  const events = await db.collection('events').find({ type: { $in: ['request.archived', 'request.restored'] }, ticket: id }).toArray();
  assert.deepEqual(events.map(e => e.type), ['request.archived', 'request.restored']);
  assert.equal(String(events[0].actorId), adminId);
});

test('archived records stop generating reminders, and queued reminder email is skipped', async () => {
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), now: () => new Date('2035-01-01T00:00:00Z'), log: quiet, instanceId: 'records-reminders' });
  // The app only archives finished requests. Force an open record into that state to prove the scheduler's own filter.
  const active = await newRequest(REQ), forced = await newRequest(REQ);
  await db.collection('tickets').updateOne({ workspace: 'main', id: forced }, { $set: { archived: { at: new Date(), time: 'now', by: { id: adminId, name: 'Person 1' } } } });
  await runner.runOnce();
  const count = id => db.collection('notifications').countDocuments({ workspace: 'main', ticket: id, reminder: true });
  assert.ok(await count(active) > 0, 'an active request still gets its reminder');
  assert.equal(await count(forced), 0, 'an archived one does not');
  await db.collection('tickets').updateOne({ workspace: 'main', id: forced }, { $unset: { archived: '' } });

  const { id } = await closedTicket();
  await db.collection('email_outbox').insertOne({ key: `${id}:reminder:review:x:admins:1`, userId: new ObjectId(adminId), to: 'person1@jarc.example', subject: 's', text: 't', status: 'pending', attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
  await db.collection('email_outbox').insertOne({ key: `${id}0:reminder:review:x:admins:1`, userId: new ObjectId(adminId), to: 'person1@jarc.example', subject: 's', text: 't', status: 'pending', attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
  assert.equal((await archive(ADMIN, id)).status, 200);
  assert.equal((await db.collection('email_outbox').findOne({ key: `${id}:reminder:review:x:admins:1` })).status, 'skipped');
  assert.equal((await db.collection('email_outbox').findOne({ key: `${id}0:reminder:review:x:admins:1` })).status, 'pending', 'another record\'s email is left alone');
  await db.collection('email_outbox').deleteOne({ key: `${id}0:reminder:review:x:admins:1` });
  await runner.stop();
});

// ---- Permanent deletion ----

// A closed Project with a task, a settled scope change, a comment file, and evidence files.
async function closedProject() {
  const id = await newRequest(REQ, { type: 'Project', title: 'SECRET-TITLE project' });
  await assign(id, devId);
  await ok(DEV, id, 'schedule-meeting', { meeting: '2030-01-05T10:00', location: 'Room' });
  await ok(REQ, id, 'confirm-meeting');
  await ok(DEV, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await ok(DEV, id, 'confirm-agreement');
  await ok(REQ, id, 'confirm-agreement');
  await ok(DEV, id, 'create-project', { projectName: 'SECRET-PROJECT', date: FUTURE, tasks: [task('Person 3')] });
  const cr = (await post(`${W}/tickets/${id}/changes`, REQ, { requestId: `records-${++rid}-${Date.now()}`, ticketVersion: (await stored(id)).version, input: { title: 'SECRET-CHANGE', reason: 'x', criteria: 'x' } })).json.created;
  assert.equal((await changeAct(ADMIN, cr, 'decision', { status: 'Rejected', reason: 'No' })).status, 200);
  await ok(DEV, id, 'status', { status: 'In progress' });
  await ok(DEV, id, 'toggle-task', { index: 0, done: true });
  const commentFile = await uploadAs(REQ), evidenceFile = await uploadAs(DEV);
  await ok(REQ, id, 'comment', { comment: 'See this', attachments: [commentFile.id] });
  await ok(DEV, id, 'add-evidence', { attachments: [evidenceFile.id] });
  await ok(DEV, id, 'worker-complete', { summary: 'Done' });
  await ok(REQ, id, 'requestor-confirm');
  await ok(DEV, id, 'status', { status: 'Released' });
  await ok(ADMIN, id, 'status', { status: 'Closed' });
  return { id, cr, commentFile, evidenceFile };
}
const fileIsGone = async id => {
  const _id = new ObjectId(id);
  return !(await db.collection('attachments').findOne({ _id })) && !(await db.collection('files.files').findOne({ _id })) && !(await db.collection('files.chunks').findOne({ files_id: _id }));
};
const fileIsHere = async id => {
  const _id = new ObjectId(id);
  return Boolean((await db.collection('attachments').findOne({ _id })) && (await db.collection('files.files').findOne({ _id })) && (await db.collection('files.chunks').findOne({ files_id: _id })));
};

test('deleting needs the exact ID and a current screen, shows what it affects, removes all of it, and leaves a minimal audit entry', async () => {
  const { id, cr, commentFile, evidenceFile } = await closedProject();
  const keepOther = await closedTicket(); // a retained record that must not be touched
  const otherBefore = await stored(keepOther.id);
  await db.collection('email_outbox').insertOne({ key: `${cr}:reminder:change-review:x:admins:1`, userId: new ObjectId(adminId), to: 'person1@jarc.example', subject: 's', text: 't', status: 'sent', attempts: 1, nextAttemptAt: new Date(), createdAt: new Date() });

  const plan = (await preview(ADMIN, id)).json;
  assert.equal(plan.title, 'SECRET-TITLE project');
  assert.deepEqual(plan.project, { id: `PRJ-${id.split('-')[1]}`, name: 'SECRET-PROJECT' });
  assert.deepEqual(plan.tasks.filter(x => x === 'Build it'), ['Build it']);
  assert.deepEqual(plan.changes.map(c => c.id), [cr]);
  assert.equal(plan.attachments.remove.length, 2);
  assert.deepEqual(plan.attachments.keep, []);
  assert.ok(plan.notifications > 0);
  assert.equal(plan.canDelete, true);
  assert.ok((await stored(id)), 'the preview changes nothing');

  for (const wrong of ['', 'jrc', id.toLowerCase(), `${id} `, keepOther.id]) {
    const res = await remove(ADMIN, id, wrong);
    assert.equal(res.status, 400, `typed "${wrong}"`); assert.match(res.json.message, /Type the request ID exactly/);
  }
  assert.equal((await post(`${W}/tickets/${id}/delete`, ADMIN, { version: 1, confirm: id })).status, 409, 'a stale screen is refused');
  assert.ok(await stored(id), 'still there');

  const res = await remove(ADMIN, id);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.deleted, id);
  assert.equal(await stored(id), null);
  assert.equal(await changeOf(cr), null, 'no orphaned scope change');
  assert.equal(await db.collection('notifications').countDocuments({ workspace: 'main', ticket: id }), 0, 'no orphaned notifications');
  assert.equal(await db.collection('email_outbox').countDocuments({ key: { $regex: `^(${id}|${cr}):` } }), 0, 'no orphaned email');
  assert.ok(await fileIsGone(commentFile.id)); assert.ok(await fileIsGone(evidenceFile.id));
  assert.equal((await details(ADMIN, id)).status, 404);
  assert.equal((await call(`${W}/attachments/${commentFile.id}/download`, { cookie: ADMIN })).status, 404);
  assert.equal((await search(ADMIN, `q=${id}`)).json.total, 0);

  // The audit entry: who, which, when. None of the content.
  const events = await db.collection('events').find({ type: 'request.deleted', ticket: id }).toArray();
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(String(e.actorId), adminId); assert.equal(e.actorName, 'Person 1'); assert.ok(e.at instanceof Date);
  assert.deepEqual([e.requestType, e.requestStatus, e.project, e.changes], ['Project', 'Closed', `PRJ-${id.split('-')[1]}`, [cr]]);
  assert.deepEqual(e.counts, { tasks: 1, changes: 1, filesRemoved: 2, filesKept: 0 });
  assert.doesNotMatch(JSON.stringify(e), /SECRET|proof\.png|See this/);
  const log = (await call(`${W}/deletions`, { cookie: ADMIN })).json.items;
  assert.equal(log[0].ticket, id); assert.equal(log[0].by, 'Person 1');
  assert.doesNotMatch(JSON.stringify(log), /SECRET/);

  assert.deepEqual(await stored(keepOther.id), otherBefore, 'another request is untouched');
  assert.ok(await fileIsHere(keepOther.file.id));

  // An ID is never reused, even for the newest record.
  const newest = await closedTicket();
  assert.equal((await remove(ADMIN, newest.id)).status, 200);
  const next = await newRequest(REQ);
  assert.ok(Number(next.split('-')[1]) > Number(newest.id.split('-')[1]), `${next} comes after ${newest.id}`);
});

test('a file a retained record also uses is kept and stays available', async () => {
  const a = await closedTicket(), b = await closedTicket();
  // b also refers to a's file (the app does not create this today; a deletion must still never break it).
  await db.collection('tickets').updateOne({ workspace: 'main', id: b.id }, { $push: { history: { text: 'Shared', time: 't', at: new Date(), attachments: [{ id: a.file.id, name: 'proof.png', size: PNG.length, type: 'png' }] } } });
  const plan = (await preview(ADMIN, a.id)).json;
  assert.deepEqual(plan.attachments.remove, []);
  assert.deepEqual(plan.attachments.keep, [{ name: 'proof.png', retainedBy: b.id }]);
  assert.equal((await remove(ADMIN, a.id)).status, 200);
  assert.ok(await fileIsHere(a.file.id), 'the file stays');
  assert.equal((await db.collection('attachments').findOne({ _id: new ObjectId(a.file.id) })).ticket, b.id, 'and now belongs to the record that uses it');
  assert.equal((await call(`${W}/attachments/${a.file.id}/download`, { cookie: REQ })).status, 200, 'its Requestor can still download it');

  // A file that belongs to another record, referred to from this one, stays too.
  const c = await closedTicket(), d = await closedTicket();
  await db.collection('tickets').updateOne({ workspace: 'main', id: c.id }, { $push: { evidence: { kind: 'file', file: { id: d.file.id, name: 'proof.png', size: PNG.length, type: 'png' } } } });
  assert.equal((await remove(ADMIN, c.id)).status, 200);
  assert.ok(await fileIsHere(d.file.id));
  assert.ok(await fileIsGone(c.file.id), 'its own file goes');

  // Someone's unsubmitted upload is never touched.
  const pending = await uploadAs(REQ);
  const e = await closedTicket();
  await db.collection('tickets').updateOne({ workspace: 'main', id: e.id }, { $push: { history: { text: 'Odd', time: 't', at: new Date(), attachments: [{ id: pending.id, name: 'proof.png', size: PNG.length, type: 'png' }] } } });
  assert.equal((await remove(ADMIN, e.id)).status, 200);
  assert.ok(await fileIsHere(pending.id));
});

test('an interrupted deletion hides the record, keeps its audit entry, and finishes on the next scheduler run', async () => {
  const engine = app.auth.engines.work;
  const runner = createReminders({ db, workspaces: Object.values(app.auth.engines).filter(Boolean), now: () => new Date('2036-01-01T00:00:00Z'), log: quiet, instanceId: 'records-recover' }); // after the earlier runner's lease
  for (const fault of ['beforeDeleteLinked', 'beforeDeleteRequest']) {
    const { id, file } = await closedTicket();
    engine.faults[fault] = () => { throw new Error('simulated stop'); };
    const stopped = await remove(ADMIN, id);
    engine.faults[fault] = null;
    assert.equal(stopped.status, 500, fault);
    assert.ok((await stored(id)).deleting, 'marked');
    assert.equal((await details(ADMIN, id)).status, 404, 'hidden from everyone');
    assert.ok(!(await call(`${W}/workspace`, { cookie: ADMIN })).json.tickets.some(t => t.id === id));
    assert.equal((await search(ADMIN, `q=${id}`)).json.total, 0);
    assert.equal((await search(ADMIN, `archived=1&q=${id}`)).json.total, 0);
    assert.equal(await db.collection('events').countDocuments({ type: 'request.deleted', ticket: id }), 1, 'the audit entry is written first');
    await runner.runOnce();
    assert.equal(await stored(id), null, 'finished');
    assert.ok(await fileIsGone(file.id));
    assert.equal(await db.collection('events').countDocuments({ type: 'request.deleted', ticket: id }), 1, 'exactly one audit entry');
  }
  await runner.stop();
});

test('older records: archived, restored, and deleted safely, with no invented steps', async () => {
  // As stored before request types and dual confirmation: no type, completion, or evidence.
  const at = new Date('2024-03-01T00:00:00Z');
  const legacy = id => ({ workspace: 'main', id, title: 'Old closed request', status: 'Closed', priority: 'Low', dev: 'Former worker', tasks: [], history: [{ text: 'Closed long ago', time: 'Mar 1' }], requester: { id: reqId, name: 'Person 4' }, name: 'Person 4', department: 'Sales', category: 'Enhancement', description: 'old', version: 3, createdAt: at, updatedAt: at });
  await db.collection('tickets').insertMany([legacy('JRC-2900'), legacy('JRC-2901')]);
  assert.equal((await archive(ADMIN, 'JRC-2900')).status, 200);
  assert.equal((await restore(ADMIN, 'JRC-2900')).status, 200);
  const kept = await stored('JRC-2900');
  assert.ok(!('completion' in kept) && !('evidence' in kept) && !('type' in kept), 'no type, confirmation, or evidence was invented');
  assert.deepEqual([kept.status, kept.department, kept.category], ['Closed', 'Sales', 'Enhancement'], 'earlier values stay as they are');
  const plan = (await preview(ADMIN, 'JRC-2901')).json;
  assert.deepEqual([plan.type, plan.canDelete, plan.tasks, plan.changes], ['Ticket', true, [], []]);
  assert.equal((await remove(ADMIN, 'JRC-2901')).status, 200);
  assert.equal(await stored('JRC-2901'), null);

  // Every record no Admin acted on is simply active: nothing needs migrating, and nothing is hidden.
  assert.ok((await call(`${W}/workspace`, { cookie: ADMIN })).json.tickets.some(t => t.id === 'JRC-2900'));
});
