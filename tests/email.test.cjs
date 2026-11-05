// Email notifications with a stand-in for the provider: who receives what, preferences, safe templates, idempotency, retries,
// stale messages, direct links, sign-in return, and access. Mock Entra and a temporary MongoDB. No real email is ever sent.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { createEmail } = require('../server/workspace/email.cjs');
const { renderEmail } = require('../server/workspace/email-templates.cjs');
const { safeReturnPath } = require('../server/auth/return-path.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const SECRET = 'email-mock-secret';
const DB = 'jarctech_email_test';
const W = '/api/v1/work';
const FUTURE = '2030-06-30';
const SECRET_TEXT = 'SECRET-DESCRIPTION';
const logged = [];
const quiet = { log: m => logged.push(String(m)), error: m => logged.push(String(m)) };
const sent = [];
let respond = () => ({ status: 200, json: async () => ({ id: 'provider-id-1' }) });
let mongod, mongo, db, entra, port, origin, app, rid = 0;
let ADMIN, ADMIN2, DEV, REQ, OTHER, DEV2, adminId, admin2Id, devId, reqId, dev2Id;
const addr = n => `person${n}@jarc.example`;

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
async function callAt(at, p, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${at}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const call = (p, options) => callAt(port, p, options);
const post = (p, cookie, body = {}) => call(p, { method: 'POST', cookie, body, headers: { Origin: origin } });
const person = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: addr(n), preferred_username: addr(n) });
async function signIn(n, at = port) {
  const login = await callAt(at, '/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(n)));
  const res = await callAt(at, back.pathname + back.search, { cookie: flow });
  return res.setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
}
const idOf = async n => String((await db.collection('users').findOne({ email: addr(n) }))._id);
const setUser = (id, fields) => db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: fields });
const outbox = () => db.collection('email_outbox');
const stored = id => db.collection('tickets').findOne({ workspace: 'main', id });
const rows = id => outbox().find({ ticket: id }).sort({ _id: 1 }).toArray();
const drain = () => app.email.process();
const whoGot = () => sent.map(s => s.to[0]).sort();
const ready = () => outbox().updateMany({ status: 'pending' }, { $set: { nextAttemptAt: new Date(0) } });

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
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: origin, SESSION_SECRET: 'email-test-session-secret-0123456789abcdefghij',
    EMAIL_DELIVERY: 'resend', EMAIL_FROM: 'Someone Else <tickets@jarc.example>', RESEND_API_KEY: 're_test_not_real', EMAIL_REPLY_TO: 'support@jarc.example'
  }), { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false, emailFetch: async (url, opts) => { sent.push({ url, headers: opts.headers, ...JSON.parse(opts.body) }); return respond(url, opts); } });
  ADMIN = await signIn(1); ADMIN2 = await signIn(2); DEV = await signIn(3); REQ = await signIn(4); OTHER = await signIn(5); DEV2 = await signIn(6);
  [adminId, admin2Id, devId, reqId, dev2Id] = await Promise.all([1, 2, 3, 4, 6].map(idOf));
  await setUser(adminId, { role: 'Admin' }); await setUser(admin2Id, { role: 'Admin' }); await setUser(devId, { role: 'Developer' }); await setUser(dev2Id, { role: 'Developer' });
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });
beforeEach(async () => {
  sent.length = 0; logged.length = 0;
  respond = () => ({ status: 200, json: async () => ({ id: 'provider-id-1' }) });
  await outbox().deleteMany({});
});

const newRequest = async (cookie, overrides = {}) => {
  const res = await post(`${W}/tickets`, cookie, { requestId: `email-${++rid}-${Date.now()}`, input: { title: 'EMAILTEST request', type: 'Ticket', department: 'FINANCE', date: FUTURE, category: 'EXCEL', description: SECRET_TEXT, criteria: 'Works', ...overrides } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.created;
};
const act = async (cookie, id, action, input = {}) => post(`${W}/tickets/${id}/actions`, cookie, { version: (await stored(id)).version, action, input });
async function ok(cookie, id, action, input = {}) {
  const res = await act(cookie, id, action, input);
  assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.json)}`);
}
const assign = (id, worker, cookie = ADMIN) => ok(cookie, id, 'assign', { dev: worker, priority: 'Medium' });
// A Ticket up to the worker's completion. The queue and the provider log start empty afterwards unless asked otherwise.
async function completed(requestor = REQ, worker = DEV, workerId = devId) {
  const id = await newRequest(requestor);
  await assign(id, workerId);
  await ok(worker, id, 'status', { status: 'In progress' });
  await ok(worker, id, 'add-evidence', { links: [{ url: 'https://example.com/run' }] });
  await ok(worker, id, 'worker-complete', { summary: 'Done' });
  return id;
}
const task = owner => ({ title: 'Build it', requirement: 'R', criteria: 'C', start: '2030-01-10', end: '2030-02-10', owner });

test('a Ticket: each step emails the right person once, with the right button and no one else', async () => {
  const id = await newRequest(REQ);
  await drain();
  assert.deepEqual(whoGot(), [], 'a new request is not on the list of emailed events');

  await assign(id, devId);
  await drain();
  assert.deepEqual(whoGot(), [addr(3)], 'assignment goes to the worker only');
  assert.match(sent[0].subject, new RegExp(`^${id}: Assigned to you`));
  assert.match(sent[0].html, />Open request</);
  sent.length = 0;

  await ok(ADMIN, id, 'assign', { dev: devId, priority: 'High' });
  await drain();
  assert.deepEqual(whoGot(), [], 'changing only the priority is not a new assignment');

  await ok(DEV, id, 'status', { status: 'In progress' });
  await ok(DEV, id, 'add-evidence', { links: [{ url: 'https://example.com/run' }] });
  await ok(DEV, id, 'worker-complete', { summary: 'Done' });
  await drain();
  assert.deepEqual(whoGot(), [addr(4)], 'completed work goes to the Requestor');
  assert.match(sent[0].html, />Review completed work</);
  assert.equal(sent[0].reply_to, addr(3), 'a reply reaches the person who acted');
  sent.length = 0;

  await ok(REQ, id, 'reason', { status: 'In progress', reason: 'Needs a fix' });
  await drain();
  assert.deepEqual(whoGot(), [addr(3)], 'a return for correction goes to the worker');
  assert.ok(!JSON.stringify(sent[0]).includes('Needs a fix'), 'the reason stays in the app');
  sent.length = 0;

  await ok(DEV, id, 'worker-complete', { summary: 'Done again' });
  await drain();
  sent.length = 0;
  await ok(REQ, id, 'requestor-confirm');
  await drain();
  assert.deepEqual(whoGot(), [addr(1), addr(2)], 'both active Admins can close');
  assert.equal(new Set(sent.map(s => JSON.stringify(s.to))).size, 2, 'one recipient per message, so nobody sees the list');
  assert.ok(sent.every(s => s.to.length === 1 && !s.cc && !s.bcc));
  sent.length = 0;

  await ok(ADMIN, id, 'status', { status: 'Closed' });
  await drain();
  assert.deepEqual(whoGot(), [addr(3), addr(4)], 'closure goes to the Requestor and the worker, not the Admin who closed it');
});

test('a Project: reassignment, meetings in Manila time, the agreement, and closure only after the handover', async () => {
  const id = await newRequest(REQ, { type: 'Project' });
  await assign(id, devId);
  await assign(id, dev2Id);
  await drain();
  assert.deepEqual(whoGot(), [addr(6)], 'the new worker is told; a message still queued for the previous worker is dropped');
  assert.match(sent[0].subject, /Reassigned to you/);
  assert.ok((await rows(id)).some(r => String(r.userId) === devId && r.status === 'skipped' && r.reason === 'no-longer-involved'));
  // Assigned, moved, and moved back while the first email waits: that worker gets one message.
  const backAgain = await newRequest(REQ);
  await assign(backAgain, devId); await assign(backAgain, dev2Id); await assign(backAgain, devId);
  sent.length = 0;
  await drain();
  assert.equal(sent.filter(s => s.subject.startsWith(backAgain) && s.to[0] === addr(3)).length, 1);
  sent.length = 0;
  sent.length = 0;

  await ok(DEV2, id, 'schedule-meeting', { meeting: '2030-03-04T14:30', location: 'Room <b>2</b>' });
  await ok(DEV2, id, 'edit-meeting', { meeting: '2030-03-05T09:00', location: 'Room 3' });
  await drain();
  assert.deepEqual(whoGot(), [addr(4)], 'only the latest meeting proposal is sent');
  assert.match(sent[0].subject, /meeting changed/i);
  assert.match(sent[0].text, /Mar 5, 2030.*9:00.*AM.*\(Asia\/Manila\)/);
  assert.match(sent[0].text, /not a calendar invitation/);
  assert.match(sent[0].html, />View meeting</);
  assert.ok((await rows(id)).some(r => r.reason === 'superseded'));
  assert.ok(!sent.some(s => s.attachments), 'no calendar file');
  sent.length = 0;

  await ok(REQ, id, 'confirm-meeting');
  await drain();
  assert.deepEqual(whoGot(), [addr(6)]);
  sent.length = 0;

  await ok(DEV2, id, 'record-agreement', { notes: 'N', requirements: 'R', criteria: 'C' });
  await drain();
  assert.deepEqual(whoGot(), [addr(4)], 'the Requestor is asked to confirm the agreement');
  sent.length = 0;
  await ok(REQ, id, 'confirm-agreement');
  await drain();
  assert.deepEqual(whoGot(), [addr(6)], 'then the worker, who has not confirmed yet');
  sent.length = 0;
  await ok(DEV2, id, 'confirm-agreement');
  await ok(DEV2, id, 'create-project', { projectName: 'Mailed', date: FUTURE, tasks: [task('Person 6')] });
  await ok(DEV2, id, 'status', { status: 'In progress' });
  await ok(DEV2, id, 'toggle-task', { index: 0, done: true });
  await ok(DEV2, id, 'add-evidence', { links: [{ url: 'https://example.com/y' }] });
  await drain();
  assert.deepEqual(whoGot(), [], 'locking the agreement, planning, tasks, and evidence are not emailed');

  await ok(DEV2, id, 'worker-complete', { summary: 'Done' });
  await drain();
  sent.length = 0;
  await ok(REQ, id, 'requestor-confirm');
  await drain();
  assert.deepEqual(whoGot(), [], 'a Project cannot be closed before its handover, so Admins are not told yet');
  await ok(DEV2, id, 'status', { status: 'Released' });
  await drain();
  assert.deepEqual(whoGot(), [addr(1), addr(2)], 'after the handover both Admins can close');
  assert.match(sent[0].text, /30 Jun 2030/, 'the agreed delivery date');
});

test('an Admin who is both Requestor and worker gets no email about their own steps, and other Admins hear only about closure', async () => {
  const id = await newRequest(ADMIN);
  await assign(id, adminId);
  await ok(ADMIN, id, 'status', { status: 'In progress' });
  await ok(ADMIN, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
  await ok(ADMIN, id, 'worker-complete', { summary: 'Done' });
  await drain();
  assert.deepEqual(whoGot(), [], 'no self-notifications, and nobody else is asked to review');
  await ok(ADMIN, id, 'requestor-confirm');
  await drain();
  assert.deepEqual(whoGot(), [addr(2)], 'the other active Admin is eligible to close');
  sent.length = 0;
  await ok(ADMIN, id, 'status', { status: 'Closed' });
  await drain();
  assert.deepEqual(whoGot(), []);
});

test('a self-assigned Admin worker gets one email when they can close, not two', async () => {
  const id = await completed(REQ, ADMIN, adminId);
  await drain();
  sent.length = 0;
  await ok(REQ, id, 'requestor-confirm');
  await drain();
  assert.deepEqual(whoGot(), [addr(1), addr(2)]);
});

test('with a Developer\'s own request, or a disabled Requestor, an Admin other than the worker is asked to review', async () => {
  const own = await completed(DEV, DEV, devId);
  await drain();
  const reviews = sent.filter(s => /ready for your review/.test(s.subject));
  assert.deepEqual(reviews.map(s => s.to[0]).sort(), [addr(1), addr(2)], 'the Developer cannot confirm for both sides');
  assert.match(reviews[0].text, /You are receiving this as an Admin/);
  sent.length = 0;

  await setUser(reqId, { status: 'disabled' });
  try {
    const id = await newRequest(OTHER);
    await db.collection('tickets').updateOne({ id }, { $set: { 'requester.id': reqId } });
    await assign(id, adminId);
    await ok(ADMIN, id, 'status', { status: 'In progress' });
    await ok(ADMIN, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] });
    await ok(ADMIN, id, 'worker-complete', { summary: 'Done' });
    await drain();
    assert.deepEqual(sent.filter(s => /ready for your review/.test(s.subject)).map(s => s.to[0]), [addr(2)], 'the other Admin reviews; the worker never does');
    assert.ok(!whoGot().includes(addr(4)), 'a disabled account receives nothing');
  } finally { await setUser(reqId, { status: 'active' }); }
  assert.ok(own);
});

test('preferences: action email can be turned off, reminder email stays opt-in, and both are rechecked before sending', async () => {
  assert.equal((await call('/api/v1/me/preferences', { cookie: DEV })).json.emailActions, true, 'action email is on by default');
  assert.equal((await call('/api/v1/me/preferences', { cookie: DEV })).json.emailReminders, false, 'reminder email is off by default');
  assert.equal((await call('/api/v1/me/preferences', { method: 'PATCH', cookie: DEV, body: { emailActions: 'no' }, headers: { Origin: origin } })).status, 400);
  assert.equal((await call('/api/v1/me/preferences', { method: 'PATCH', cookie: DEV, body: {}, headers: { Origin: origin } })).status, 400);
  assert.equal((await call('/api/v1/me/preferences', { method: 'PATCH', cookie: DEV, body: { emailActions: false }, headers: { Origin: origin } })).status, 200);
  try {
    const id = await newRequest(REQ);
    await assign(id, devId);
    await drain();
    assert.deepEqual(whoGot(), []);
    const [row] = await rows(id);
    assert.equal(row.status, 'skipped'); assert.equal(row.reason, 'preference-off');
    assert.ok(await db.collection('notifications').findOne({ record: id, inbox: `user:${devId}` }), 'the in-app notification is unaffected');
  } finally { await setUser(devId, { emailActions: true }); }

  const id = await newRequest(REQ);
  await assign(id, devId);
  await setUser(devId, { emailActions: false }); // turned off after it was queued
  await drain();
  assert.deepEqual(whoGot(), []);
  assert.equal((await rows(id))[0].reason, 'preference-off');
  await setUser(devId, { emailActions: true });

  await setUser(devId, { status: 'disabled' });
  const later = await newRequest(REQ);
  await db.collection('tickets').updateOne({ id: later }, { $set: { devId, dev: 'Person 3', status: 'Assigned' } });
  await setUser(devId, { status: 'active' });
  await assign(later, dev2Id);
  await assign(later, devId);
  await setUser(devId, { status: 'disabled' });
  await drain();
  await setUser(devId, { status: 'active' });
  assert.ok(!whoGot().includes(addr(3)), 'a disabled account receives nothing');
});

test('templates: fixed sender, escaped content, plain text, no sensitive detail, and a local link', async () => {
  const id = await newRequest(REQ, { title: 'Fix <img src=x onerror=alert(1)> & "more"' });
  await setUser(adminId, { displayName: 'Ada <script>alert(2)</script>' });
  await assign(id, devId);
  await setUser(adminId, { displayName: 'Person 1' });
  await drain();
  const m = sent[0];
  assert.equal(m.from, 'JarcTech Ticket <tickets@jarc.example>', 'always named JarcTech Ticket, whatever the setting says');
  assert.ok(!m.html.includes('<img') && !m.html.includes('<script'));
  assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(m.text.includes('<img src=x'), 'plain text carries the same words');
  assert.ok(!JSON.stringify(m).includes(SECRET_TEXT), 'no description');
  assert.match(m.text, /do not become comments/);
  assert.match(m.subject, new RegExp(`^${id}: `));
  assert.ok(!/onerror/.test(m.subject), 'the title stays out of the subject');
  assert.equal(m.html.match(/<a /g).length, 1, 'one button');
  const link = new RegExp(`${origin}(/\\?request=${id})`).exec(m.html);
  assert.ok(link, 'links to the request on the configured origin');
  assert.equal(safeReturnPath(link[1]), link[1], 'the link is accepted by the return path rule');
  assert.ok(!/token|password|secret/i.test(m.text), 'nothing secret-looking');

  const nasty = renderEmail({ event: 'meeting-proposed', record: 'JRC-1', ticketTitle: 'x\r\nBcc: a@b.co', actorName: 'y\r\nz', meeting: '2030-03-04T14:30', location: '"><a href=javascript:alert(1)>', timezone: 'Asia/Manila', link: 'https://app.example/?request=JRC-1' });
  assert.ok(!/\r|^Bcc:/m.test(nasty.text), 'no line breaks from people');
  assert.ok(!nasty.html.includes('<a href=javascript'));
  assert.ok(nasty.text.length <= 2000);
  const long = renderEmail({ event: 'assigned', record: 'JRC-123456789', ticketTitle: 'x'.repeat(5000), actorName: 'y'.repeat(5000), timezone: 'Asia/Manila', link: 'https://app.example/?request=JRC-1' });
  assert.ok(long.text.length <= 2000 && long.text.includes('https://app.example'), 'fits the outbox and keeps its link');
  assert.equal(renderEmail({ event: 'meeting-proposed', record: 'JRC-1', meeting: 'not a date', timezone: 'Asia/Manila', link: 'https://x' }).text.includes('Meeting:'), false);
});

test('idempotency: repeated saves and concurrent runs send one message, and a retry reuses its provider key', async () => {
  const id = await newRequest(REQ);
  await assign(id, devId);
  const after = await stored(id);
  await app.email.ticketSaved({ before: { ...after, devId: '' }, after, action: 'assign', input: {}, actor: { _id: new ObjectId(adminId), email: addr(1) } });
  assert.equal((await rows(id)).length, 1, 'the same version of the same event is queued once');

  const other = createEmail({ config: { enabled: true, provider: 'resend', from: 'a@b.co', apiKey: 'x', appUrl: origin }, db, fetch: async (u, o) => { sent.push({ headers: o.headers, ...JSON.parse(o.body) }); return { status: 200 }; }, log: quiet, pace: 0 });
  await Promise.all([drain(), other.process(), drain()]);
  assert.equal(sent.length, 1, 'two runs and an overlapping call send it once');

  sent.length = 0;
  const id2 = await newRequest(REQ);
  await assign(id2, devId);
  respond = () => { throw new Error('connection reset'); };
  await drain();
  let [row] = await rows(id2);
  assert.equal(row.status, 'pending'); assert.equal(row.lastError, 'network');
  assert.ok(row.nextAttemptAt > new Date(), 'backs off');
  await drain();
  assert.equal(sent.length, 1, 'not due again yet');
  await ready();
  respond = () => ({ status: 200 });
  await drain();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers['Idempotency-Key'], sent[1].headers['Idempotency-Key'], 'the provider can recognise the retry if the first attempt arrived');
  assert.equal(sent[0].html, sent[1].html, 'an identical body, as idempotency requires');
  assert.equal(sent[0].headers['User-Agent'], 'JarcTech-Ticket');
  assert.equal(new Set((await rows(id2)).map(r => r.status)).has('sent'), true);

  // A process that stopped mid-send: the claim runs out, and the same key goes again.
  sent.length = 0;
  const id3 = await newRequest(REQ);
  await assign(id3, devId);
  const stuck = (await rows(id3))[0];
  await outbox().updateOne({ _id: stuck._id }, { $set: { nextAttemptAt: new Date(Date.now() + 60000) } }); // claimed by a run that died
  await drain();
  assert.equal(sent.length, 0, 'a message claimed by another run is left alone');
  await ready();
  await drain();
  assert.equal(sent.length, 1);
});

test('retries: temporary failures back off, permanent ones stop, quota and key problems stop the batch', async () => {
  const id = await newRequest(REQ);
  await assign(id, devId);
  respond = () => ({ status: 503 });
  for (let i = 0; i < 5; i++) { await ready(); await drain(); }
  let [row] = await rows(id);
  assert.equal(row.status, 'failed', 'gives up after five attempts');
  assert.equal(row.attempts, 5); assert.equal(row.lastError, 'HTTP 503');
  assert.ok(logged.some(l => l.includes(id) && l.includes('HTTP 503')));
  assert.ok(!logged.some(l => l.includes('@') || l.includes('re_test') || l.includes('EMAILTEST')), 'logs hold no address, key, or content');

  sent.length = 0;
  const a = await newRequest(REQ), b = await newRequest(REQ);
  await assign(a, devId); await assign(b, devId);
  respond = () => ({ status: 422, json: async () => ({ name: 'invalid_parameter', message: `bad address ${addr(3)}` }) });
  await drain();
  assert.equal((await rows(a))[0].status, 'failed', 'a permanent refusal is not retried');
  assert.equal((await rows(a))[0].lastError, 'HTTP 422 invalid_parameter', 'only the provider\'s error name is kept, not its message');
  assert.equal(sent.length, 2, 'one bad message does not block the next');

  await outbox().deleteMany({});
  sent.length = 0;
  const c = await newRequest(REQ), d = await newRequest(REQ);
  await assign(c, devId); await assign(d, devId);
  respond = () => ({ status: 429, json: async () => ({ name: 'daily_quota_exceeded' }) });
  await drain();
  assert.equal(sent.length, 1, 'stops at the quota');
  const held = (await rows(c))[0];
  assert.equal(held.status, 'pending'); assert.equal(held.attempts, 0, 'the quota does not use up attempts');
  assert.ok(held.nextAttemptAt > new Date(Date.now() + 60000) && held.nextAttemptAt.getUTCHours() === 0, 'waits for the reset at midnight UTC');

  await outbox().deleteMany({});
  sent.length = 0;
  const e = await newRequest(REQ), f = await newRequest(REQ);
  await assign(e, devId); await assign(f, devId);
  respond = () => ({ status: 403, json: async () => ({ name: 'validation_error' }) });
  await drain();
  assert.equal(sent.length, 1, 'an unverified domain or a bad key would fail for every message, so the run stops');
  assert.equal((await rows(e))[0].status, 'failed');
  assert.equal((await rows(f))[0].status, 'pending', 'the rest wait');
});

test('stale messages are suppressed: closure, archive, deletion, lost access, a changed meeting, and withdrawn work', async () => {
  const reasons = async id => (await rows(id)).map(r => r.reason);
  // The work was withdrawn before the review email went.
  const withdrawn = await completed();
  await ok(DEV, withdrawn, 'withdraw-completion');
  await drain();
  assert.ok((await reasons(withdrawn)).includes('no-longer-needed'));
  assert.ok(!whoGot().includes(addr(4)));

  // Closed before the "ready to close" email went: the other Admin needs no reminder of it.
  const closed = await completed();
  await drain();
  await ok(REQ, closed, 'requestor-confirm');
  await ok(ADMIN, closed, 'status', { status: 'Closed' });
  sent.length = 0;
  await drain();
  const rowsClosed = await rows(closed);
  assert.ok(rowsClosed.some(r => r.event === 'ready-to-close' && r.reason === 'no-longer-needed'));

  // Archived with messages still queued.
  const archived = await completed();
  await drain();
  await ok(REQ, archived, 'requestor-confirm');
  await ok(ADMIN, archived, 'status', { status: 'Closed' });
  assert.ok((await rows(archived)).some(r => r.status === 'pending'));
  assert.equal((await post(`${W}/tickets/${archived}/archive`, ADMIN, { version: (await stored(archived)).version })).status, 200);
  assert.ok(!(await rows(archived)).some(r => r.status === 'pending'));
  assert.ok((await reasons(archived)).includes('archived'));

  // Deleted: the queue entry goes with it.
  const deleted = await completed();
  await drain();
  await ok(REQ, deleted, 'requestor-confirm');
  await ok(ADMIN, deleted, 'status', { status: 'Closed' });
  assert.equal((await post(`${W}/tickets/${deleted}/delete`, ADMIN, { version: (await stored(deleted)).version, confirm: deleted })).status, 200);
  assert.equal((await rows(deleted)).length, 0);
  sent.length = 0;
  await drain();
  assert.ok(!sent.some(s => s.subject.includes(deleted)));

  // A Developer who became a Requestor no longer has access to work assigned to them.
  const lost = await newRequest(REQ);
  await assign(lost, devId);
  await setUser(devId, { role: 'Requestor' });
  await drain();
  await setUser(devId, { role: 'Developer' });
  assert.ok((await reasons(lost)).includes('no-access'));

  // The meeting was confirmed before the proposal went.
  const met = await newRequest(REQ, { type: 'Project' });
  await assign(met, devId);
  await drain();
  await ok(DEV, met, 'schedule-meeting', { meeting: '2030-03-04T14:30', location: 'Room' });
  await ok(REQ, met, 'confirm-meeting');
  sent.length = 0;
  await drain();
  assert.ok((await rows(met)).some(r => r.event === 'meeting-proposed' && r.reason === 'no-longer-needed'));
  assert.deepEqual(whoGot(), [addr(3)], 'only the meeting confirmation goes');

  // Old queued messages expire rather than arrive days late.
  const old = await newRequest(REQ);
  await assign(old, devId);
  await outbox().updateMany({ ticket: old }, { $set: { createdAt: new Date(Date.now() - 3 * 86400000) } });
  await drain();
  assert.equal((await rows(old))[0].reason, 'expired');
});

test('reminders: opted-in people only, a live check before sending, and the request link', async () => {
  const id = await newRequest(REQ);
  await db.collection('tickets').updateOne({ id }, { $set: { statusSince: new Date(Date.now() - 3 * 86400000) } });
  await setUser(adminId, { emailReminders: true });
  try {
    const engine = app.auth.engines.work;
    const stale = await stored(id);
    const DeadlineCore = require('../public/deadline-core.js');
    const docs = await engine.notify.remind(DeadlineCore.reminders(stale, [], { now: new Date() }).map(r => ({ ...r, ticket: stale })), new Date());
    assert.ok(docs.length);
    assert.equal(await app.email.enqueue(docs), 1, 'only the Admin who opted in');
    await drain();
    assert.deepEqual(whoGot(), [addr(1)]);
    assert.match(sent[0].subject, new RegExp(`^${id}: Reminder`));
    assert.match(sent[0].text, /Automatic reminder/);
    assert.equal(sent[0].reply_to, 'support@jarc.example', 'automatic messages reply to the configured address');
    assert.ok(sent[0].html.includes(`/?request=${id}`));

    // Already reviewed by the time it would go.
    await outbox().deleteMany({});
    sent.length = 0;
    await db.collection('notifications').deleteMany({ record: id, reminder: true });
    const fresh = await engine.notify.remind(DeadlineCore.reminders(await stored(id), [], { now: new Date() }).map(r => ({ ...r, ticket: stale })), new Date());
    await app.email.enqueue(fresh);
    await assign(id, devId);
    await drain();
    assert.ok(!sent.some(s => /Reminder/.test(s.subject)));
    assert.ok((await rows(id)).some(r => r.event === 'reminder' && r.reason === 'no-longer-needed'));
  } finally { await setUser(adminId, { emailReminders: false }); }
});

test('the app action never depends on email: a failing provider or queue changes nothing for the person acting', async () => {
  const id = await newRequest(REQ);
  respond = () => { throw new Error('down'); };
  await assign(id, devId);
  await drain();
  assert.equal((await stored(id)).devId, devId);
  assert.ok(await db.collection('notifications').findOne({ record: id, inbox: `user:${devId}` }));

  const collection = db.collection('email_outbox');
  const broken = createEmail({ config: { enabled: true, provider: 'resend', from: 'a@b.co', apiKey: 'x', appUrl: origin }, db: { collection: name => (name === 'email_outbox' ? { ...collection, insertOne: async () => { throw new Error('queue down'); } } : db.collection(name)) }, log: quiet });
  const t = await stored(id);
  assert.equal(await broken.ticketSaved({ before: { ...t, devId: '' }, after: t, action: 'assign', input: {}, actor: { _id: new ObjectId(adminId) } }), 0, 'reports nothing queued and does not throw');
  assert.ok(logged.some(l => l.includes('not queued') && l.includes(id)));
});

test('direct links: a signed-out person returns to the exact request; anything else is ignored; state and nonce still apply', async () => {
  const id = await newRequest(REQ);
  const path = `/?request=${id}`;
  const home = await call(path);
  assert.equal(home.status, 302);
  assert.equal(home.location, `/auth/signin?returnTo=${encodeURIComponent(path)}`);
  const page = await call(home.location);
  assert.ok(page.text.includes(`/auth/login?returnTo=${encodeURIComponent(path)}`), 'the Microsoft button carries the request');

  const login = await call(`/auth/login?returnTo=${encodeURIComponent(path)}`);
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  assert.ok(!flow.includes(id), 'sealed in the cookie, not readable');
  assert.ok(!login.location.includes(id), 'and never sent to Microsoft');
  const authorize = new URL(login.location);
  assert.ok(authorize.searchParams.get('state') && authorize.searchParams.get('nonce') && authorize.searchParams.get('code_challenge'));

  const wrong = new URL(entra.authorize(login.location, person(4), { state: 'tampered' }));
  const refused = await call(wrong.pathname + wrong.search, { cookie: flow });
  assert.equal(refused.status, 401, 'a changed state is refused');
  assert.ok(refused.text.includes(`returnTo=${encodeURIComponent(path)}`), 'and Try again keeps the request');

  const again = await call(`/auth/login?returnTo=${encodeURIComponent(path)}`);
  const back = new URL(entra.authorize(again.location, person(4)));
  const done = await call(back.pathname + back.search, { cookie: again.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0] });
  assert.equal(done.status, 302);
  assert.equal(done.location, path, 'lands on the exact request');

  const signedIn = done.setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
  assert.equal((await call(`/auth/signin?returnTo=${encodeURIComponent(path)}`, { cookie: signedIn })).location, path);
  assert.equal((await call(path, { cookie: signedIn })).status, 200, 'already signed in: opens directly');

  for (const evil of ['https://evil.example/', '//evil.example', '/\\evil.example', '/%2F%2Fevil.example', `/?request=${id}&next=https://evil.example`, `/?request=${id}#x`, '/auth/logout', `/?request=${id}\n`, '/?request=JRC-1&change=x', 'javascript:alert(1)']) {
    assert.equal(safeReturnPath(evil), null, evil);
    const attempt = await call(`/auth/login?returnTo=${encodeURIComponent(evil)}`);
    const out = new URL(entra.authorize(attempt.location, person(4)));
    const res = await call(out.pathname + out.search, { cookie: attempt.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0] });
    assert.equal(res.location, '/', `ignored: ${evil}`);
    assert.equal((await call(`/auth/signin?returnTo=${encodeURIComponent(evil)}`, { cookie: signedIn })).location, '/');
    assert.ok(!(await call(`/auth/signin?returnTo=${encodeURIComponent(evil)}`)).text.includes('evil'));
  }
  assert.equal((await call('/?request=JRC-1%22%3E%3Cscript%3E')).location, '/auth/signin', 'an odd link just signs in');
  // Too slow at Microsoft: the attempt has expired, and Try again still leads to the request.
  const slow = await call(`/auth/login?returnTo=${encodeURIComponent(path)}`);
  const slowCookie = slow.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const slowBack = new URL(entra.authorize(slow.location, person(4)));
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60000;
  try {
    const expired = await call(slowBack.pathname + slowBack.search, { cookie: slowCookie });
    assert.equal(expired.status, 400);
    assert.ok(expired.text.includes(`returnTo=${encodeURIComponent(path)}`));
  } finally { Date.now = realNow; }
  // A tampered sealed cookie is refused outright, so its return address cannot be chosen.
  const tamper = await call(`/auth/login?returnTo=${encodeURIComponent(path)}`);
  const cookie = tamper.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const out = new URL(entra.authorize(tamper.location, person(4)));
  assert.equal((await call(out.pathname + out.search, { cookie: `${cookie.slice(0, -4)}AAAA` })).status, 400);
  assert.equal(safeReturnPath(`/?request=${id}&change=CR-501`), `/?request=${id}&change=CR-501`);
});

test('email links navigate only: forwarding grants nothing, GET changes nothing, and access is checked when opened', async () => {
  const id = await newRequest(REQ);
  await assign(id, devId);
  const before = await stored(id);
  assert.equal((await call(`/?request=${id}`, { cookie: DEV })).status, 200);
  assert.equal((await call(`/?request=${id}&action=requestor-confirm`, { cookie: DEV })).status, 200);
  assert.equal((await stored(id)).version, before.version, 'opening a link changes nothing');
  assert.equal((await call(`/?request=${id}`, { cookie: OTHER })).status, 200, 'the page loads for anyone signed in');
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: OTHER })).status, 404, 'but the request does not, for someone who was forwarded the email');
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: DEV2 })).status, 404);
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: DEV })).status, 200);
  await assign(id, dev2Id);
  assert.equal((await call(`${W}/tickets/${id}`, { cookie: DEV })).status, 404, 'a reassigned worker loses it at once');
  assert.equal((await call(`${W}/tickets/JRC-9999999`, { cookie: ADMIN })).status, 404, 'a deleted or unknown request says the same');
});

test('delivery status and retry: Admins only, no addresses or content, and a retry cannot send twice', async () => {
  const id = await newRequest(REQ);
  await assign(id, devId);
  respond = () => ({ status: 422, json: async () => ({ name: 'invalid_parameter' }) });
  await drain();
  sent.length = 0;
  for (const cookie of [DEV, REQ]) {
    assert.equal((await call(`${W}/email`, { cookie })).status, 403);
    assert.equal((await post(`${W}/email/test`, cookie)).status, 403);
  }
  assert.equal((await call(`${W}/email`)).status, 401);
  const status = await call(`${W}/email`, { cookie: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(status.json.delivery, 'enabled');
  assert.equal(status.json.counts.failed, 1);
  const [item] = status.json.items;
  assert.equal(item.record, id); assert.equal(item.recipient, 'Person 3'); assert.equal(item.status, 'failed'); assert.equal(item.canRetry, true);
  assert.ok(!status.text.includes('@jarc.example') && !status.text.includes('<html') && !status.text.includes('EMAILTEST'), 'status holds no address or message content');

  assert.equal((await post(`${W}/email/${item.id}/retry`, DEV)).status, 403);
  assert.equal((await call(`${W}/email/${item.id}/retry`, { method: 'POST', cookie: ADMIN, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403, 'another site cannot trigger it');
  assert.equal((await call(`${W}/email/${item.id}/retry`, { cookie: ADMIN })).status, 405, 'a GET does nothing');
  respond = () => ({ status: 200, json: async () => ({ id: 'accepted-1' }) });
  const results = await Promise.all([post(`${W}/email/${item.id}/retry`, ADMIN), post(`${W}/email/${item.id}/retry`, ADMIN)]);
  assert.deepEqual(results.map(r => r.status).sort(), [202, 409], 'a double click queues it once');
  assert.ok(await db.collection('events').findOne({ type: 'email.retried', message: item.id }));
  await drain();
  await drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].headers['Idempotency-Key'], /#1$/, 'the provider refused the first, so the retry is a new attempt');
  const row = (await rows(id))[0];
  assert.equal(row.status, 'sent'); assert.equal(row.providerId, 'accepted-1');
  assert.equal((await post(`${W}/email/${item.id}/retry`, ADMIN)).status, 409, 'a sent message cannot be retried');
  assert.equal((await post(`${W}/email/${'0'.repeat(24)}/retry`, ADMIN)).status, 409);

  // An attempt with an unknown outcome means the message may have arrived, so it keeps its key whatever happens afterwards.
  sent.length = 0;
  const unknown = await newRequest(REQ);
  await assign(unknown, devId);
  respond = () => { throw new Error('timed out after the provider accepted it'); };
  await drain();
  respond = () => ({ status: 422 });
  await ready();
  await drain();
  const uncertain = (await rows(unknown))[0];
  assert.equal(uncertain.status, 'failed'); assert.equal(uncertain.refused, true);
  respond = () => ({ status: 200 });
  assert.equal((await post(`${W}/email/${uncertain._id}/retry`, ADMIN)).status, 202);
  await drain();
  assert.equal(new Set(sent.map(s => s.headers['Idempotency-Key'])).size, 1, 'the provider can still recognise it');

  // A failed message is rechecked too: if the step is done, the retry suppresses it instead of sending.
  sent.length = 0;
  const stale = await newRequest(REQ);
  await assign(stale, devId);
  respond = () => ({ status: 422 });
  await drain();
  sent.length = 0;
  respond = () => ({ status: 200 });
  await assign(stale, dev2Id);
  const failed = (await rows(stale)).find(r => r.status === 'failed');
  assert.equal((await post(`${W}/email/${failed._id}/retry`, ADMIN)).status, 202);
  await drain();
  assert.equal((await outbox().findOne({ _id: failed._id })).reason, 'no-longer-involved');
  assert.ok(!whoGot().includes(addr(3)));

  // A test message goes only to the Admin who asks, touches no request, and cannot be repeated within the minute.
  await outbox().deleteMany({});
  sent.length = 0;
  assert.equal((await post(`${W}/email/test`, ADMIN, { to: 'someone@evil.example' })).status, 202);
  const repeat = await post(`${W}/email/test`, ADMIN);
  await drain();
  assert.deepEqual(whoGot(), [addr(1)], 'the browser cannot choose the recipient');
  assert.match(sent[0].subject, /Test message/);
  if (repeat.status !== 202) assert.equal(repeat.json.error, 'test-too-soon');
});

test('the beta simulation and its sample people are never emailed', async () => {
  const headers = { Origin: origin };
  const workspace = await call('/api/v1/beta/workspace?view=Admin', { cookie: ADMIN });
  const target = workspace.json.tickets.find(t => ['Submitted', 'Under review'].includes(t.status));
  assert.ok(target);
  const res = await call(`/api/v1/beta/tickets/${target.id}/actions`, { method: 'POST', cookie: ADMIN, headers, body: { view: 'Admin', version: target.version, action: 'assign', input: { dev: 'Miguel Santos', priority: 'High' } } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await drain();
  assert.equal(await outbox().countDocuments({}), 0);
  assert.equal(sent.length, 0);

  const sample = await stored(await newRequest(REQ));
  assert.equal(await app.email.ticketSaved({ before: { ...sample, devId: '' }, after: { ...sample, devId, requester: { ...sample.requester, sample: true } }, action: 'assign', input: {}, actor: { _id: new ObjectId(adminId) } }), 0);
});

test('delivery off: nothing is queued and nothing appears later; test-only mode reaches listed accounts only', async () => {
  const offPort = await freePort();
  const off = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(offPort), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${offPort}`, SESSION_SECRET: 'email-test-session-secret-0123456789abcdefghij'
  }), { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false, emailFetch: async () => { throw new Error('must not be called'); } });
  try {
    const cookie = await signIn(1, offPort);
    const offOrigin = `http://localhost:${offPort}`;
    const created = await callAt(offPort, `${W}/tickets`, { method: 'POST', cookie, headers: { Origin: offOrigin }, body: { requestId: `email-off-${Date.now()}`, input: { title: 'EMAILTEST off', type: 'Ticket', department: 'FINANCE', date: FUTURE, category: 'EXCEL', description: 'x', criteria: 'y' } } });
    const id = created.json.created;
    const res = await callAt(offPort, `${W}/tickets/${id}/actions`, { method: 'POST', cookie, headers: { Origin: offOrigin }, body: { version: 1, action: 'assign', input: { dev: devId, priority: 'Low' } } });
    assert.equal(res.status, 200);
    assert.equal(await outbox().countDocuments({ ticket: id }), 0, 'no backlog exists to send later');
    assert.ok(await db.collection('notifications').findOne({ record: id, inbox: `user:${devId}` }), 'in-app notifications continue');
    const prefs = await callAt(offPort, '/api/v1/me/preferences', { cookie });
    assert.equal(prefs.json.emailDelivery, 'disabled');
    const status = await callAt(offPort, `${W}/email`, { cookie });
    assert.equal(status.json.delivery, 'disabled');
    assert.equal((await callAt(offPort, `${W}/email/test`, { method: 'POST', cookie, body: {}, headers: { Origin: offOrigin } })).status, 409);
    assert.match((await callAt(offPort, '/', { cookie })).text, /"emailDelivery":"disabled"/);
    await off.email.process();
  } finally { await off.shutdown(); }

  const fetched = [];
  const limited = createEmail({ config: { enabled: true, provider: 'resend', from: 'a@b.co', apiKey: 'x', appUrl: origin, testRecipients: [addr(3)] }, db, fetch: async (u, o) => { fetched.push(JSON.parse(o.body).to[0]); return { status: 200 }; }, log: quiet, pace: 0 });
  assert.equal(limited.mode, 'test-only');
  const id = await newRequest(REQ);
  await assign(id, devId);
  await limited.process();
  assert.deepEqual(fetched, [addr(3)], 'a listed account receives it');
  const t = await stored(id);
  await limited.ticketSaved({ before: { ...t, status: 'In progress', completion: { worker: { id: devId } } }, after: { ...t, version: t.version + 1, completion: { worker: { id: devId } }, status: 'Awaiting acceptance' }, action: 'worker-complete', input: {}, actor: { _id: new ObjectId(devId), email: addr(3) } });
  const held = await outbox().findOne({ ticket: id, event: 'completion-review' });
  assert.equal(held.status, 'skipped'); assert.equal(held.reason, 'not-test-recipient');
  await limited.process();
  assert.deepEqual(fetched, [addr(3)], 'nobody else does');
});

test('settings validate the sender, reply address, and test list', () => {
  const base = { NODE_ENV: 'test', AUTH_MODE: 'demo', EMAIL_DELIVERY: 'resend', RESEND_API_KEY: 're_x', APP_BASE_URL: 'http://localhost:4175' };
  const load = extra => loadConfig({ ...base, ...extra }).email;
  assert.equal(load({ EMAIL_FROM: 'tickets@jarc.example' }).from, 'JarcTech Ticket <tickets@jarc.example>');
  assert.equal(load({ EMAIL_FROM: 'Anything <tickets@jarc.example>' }).from, 'JarcTech Ticket <tickets@jarc.example>');
  assert.deepEqual(load({ EMAIL_FROM: 'a@b.co', EMAIL_TEST_RECIPIENTS: ' A@b.co, c@d.co ' }).testRecipients, ['a@b.co', 'c@d.co']);
  assert.throws(() => load({ EMAIL_FROM: 'a@b.co', EMAIL_TEST_RECIPIENTS: 'not-an-address' }), /EMAIL_TEST_RECIPIENTS/);
  assert.throws(() => load({ EMAIL_FROM: 'a@b.co', EMAIL_REPLY_TO: 'nope' }), /EMAIL_REPLY_TO/);
  assert.throws(() => load({}), /EMAIL_FROM/);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).email.enabled, false, 'off unless asked');
});
