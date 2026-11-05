// Power Automate delivery: the flow collects from the app, sends, and reports. Exercised over HTTP against the real routes, with
// a temporary MongoDB. No flow, Outlook, or Microsoft service is involved, and no email exists to send.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { createLimits, RULES } = require('../server/limits.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '77777777-8888-4999-aaaa-bbbbbbbbbbbb', CLIENT = '11111111-2222-4333-8444-555555555555', ENTRA = 'pa-mock-secret';
const SECRET = 'collect-secret-for-tests-0123456789-abcdef', OLD = 'previous-secret-for-tests-0123456789-abcd';
const W = '/api/v1/work', FLOW = '/api/v1/email-flow';
let mongod, mongo, db, entra, port, origin, app, rid = 0;
let ADMIN, DEV, REQ, adminId, devId, reqId;
const logged = [];
const quiet = { log: m => logged.push(String(m)), error: m => logged.push(String(m)) };
const addr = n => `person${n}@jarc.example`;
const person = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-e000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: addr(n), preferred_username: addr(n) });
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
async function callAt(at, p, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${at}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookies: res.headers.getSetCookie(), location: res.headers.get('location'), headers: res.headers };
}
const call = (p, o) => callAt(port, p, o);
const post = (p, cookie, body = {}) => call(p, { method: 'POST', cookie, body, headers: { Origin: origin } });
const flow = (route, body, secret = SECRET) => call(`${FLOW}/${route}`, { method: 'POST', body, headers: { Authorization: `Bearer ${secret}` } });
const collect = async () => { const r = await flow('collect'); assert.equal(r.status, 200, r.text); return r.json; };
const report = (m, outcome, code) => flow('report', { id: m.id, claim: m.claim, eventId: m.eventId, outcome, code });
async function signIn(n) {
  const login = await call('/auth/login');
  const cookie = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, person(n)));
  return (await call(back.pathname + back.search, { cookie })).setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
}
const outbox = () => db.collection('email_outbox');
const stored = id => db.collection('tickets').findOne({ workspace: 'main', id });
const row = m => outbox().findOne({ _id: new ObjectId(m.id) });
const newRequest = async (overrides = {}) => { const r = await post(`${W}/tickets`, REQ, { requestId: `pa-${++rid}-${Date.now()}`, input: { title: 'PATEST request', type: 'Ticket', department: 'FINANCE', date: '2030-06-30', category: 'EXCEL', description: 'SECRET-DESCRIPTION', criteria: 'Works', ...overrides } }); assert.equal(r.status, 201, r.text); return r.json.created; };
const act = async (cookie, id, action, input = {}) => { const r = await post(`${W}/tickets/${id}/actions`, cookie, { version: (await stored(id)).version, action, input }); assert.equal(r.status, 200, r.text); };
const assign = (id, who = devId) => act(ADMIN, id, 'assign', { dev: who, priority: 'Low' });
const backdate = (filter, ms) => outbox().updateMany(filter, { $set: { createdAt: new Date(Date.now() - ms) } });
const queued = async () => { const id = await newRequest(); await assign(id); return id; };
// Everything that was collected is due again, as if its claim had run out.
const expireClaims = async () => {
  await outbox().updateMany({ status: 'pending' }, { $set: { nextAttemptAt: new Date(0) } });
  await db.collection('scheduler_locks').updateOne({ _id: 'email-collect' }, { $set: { leaseUntil: new Date(0) }, $unset: { pausedUntil: '' } });
};

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db('jarctech_power_automate_test');
  await ensureSchema(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: ENTRA });
  port = await freePort();
  origin = `http://localhost:${port}`;
  app = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: db.databaseName, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: ENTRA, APP_BASE_URL: origin, SESSION_SECRET: 'power-automate-session-secret-0123456789abcdefg',
    EMAIL_DELIVERY: 'power-automate', EMAIL_COLLECT_SECRET: SECRET, EMAIL_COLLECT_SECRET_PREVIOUS: OLD, EMAIL_ALLOWED_DOMAINS: 'jarc.example'
  }), { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false, emailFetch: async () => { throw new Error('the app must never call out to send'); } });
  ADMIN = await signIn(1); DEV = await signIn(2); REQ = await signIn(3);
  const idOf = async n => String((await db.collection('users').findOne({ email: addr(n) }))._id);
  [adminId, devId, reqId] = await Promise.all([1, 2, 3].map(idOf));
  await db.collection('users').updateOne({ _id: new ObjectId(adminId) }, { $set: { role: 'Admin' } });
  await db.collection('users').updateOne({ _id: new ObjectId(devId) }, { $set: { role: 'Developer' } });
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });
beforeEach(async () => {
  logged.length = 0;
  await outbox().deleteMany({});
  await db.collection('scheduler_locks').deleteMany({ _id: 'email-collect' });
  await db.collection('users').updateOne({ _id: new ObjectId(devId) }, { $set: { email: addr(2), emailActions: true } });
});

test('only the dedicated secret reaches the routes, and it reaches nothing else', async () => {
  for (const [name, headers] of [['none', {}], ['wrong', { Authorization: 'Bearer wrong' }], ['session secret', { Authorization: 'Bearer power-automate-session-secret-0123456789abcdefg' }], ['not bearer', { Authorization: SECRET }]]) {
    for (const route of ['check', 'collect', 'report']) assert.equal((await call(`${FLOW}/${route}`, { method: 'POST', headers })).status, 401, `${name} ${route}`);
  }
  assert.equal((await call(`${FLOW}/collect`, { method: 'POST', cookie: ADMIN, headers: { Origin: origin } })).status, 401, 'a signed-in Admin is not the flow');
  assert.equal((await flow('check')).status, 200);
  assert.equal((await flow('check', undefined, OLD)).status, 200, 'the previous secret works during a rotation');
  assert.equal((await call(`${FLOW}/collect`, { headers: { Authorization: `Bearer ${SECRET}` } })).status, 405, 'a GET changes nothing');
  assert.equal((await flow('unknown')).status, 404);
  const bearer = { Authorization: `Bearer ${SECRET}` };
  for (const p of [`${W}/workspace`, '/api/v1/users', `${W}/email`, '/api/v1/me']) assert.equal((await call(p, { headers: bearer })).status, 401, p);
  assert.ok(logged.some(l => l.includes('wrong or missing secret')));
  assert.ok(!logged.some(l => l.includes(SECRET) || l.includes('Bearer')));
});

test('the flow collects a bounded batch: one recipient each, with an event ID, and no way to add to it', async () => {
  const id = await queued();
  const { messages } = await collect();
  assert.equal(messages.length, 1);
  const [m] = messages;
  assert.deepEqual(Object.keys(m).sort(), ['claim', 'eventId', 'html', 'id', 'replyTo', 'subject', 'to']);
  assert.equal(m.to, addr(2));
  assert.equal(m.replyTo, addr(1), 'the person who acted');
  assert.match(m.subject, new RegExp(`^${id}: Assigned to you`));
  assert.match(m.html, /Person 1 assigned/);
  assert.match(m.html, new RegExp(`/\\?request=${id}`), 'the button opens the request');
  assert.match(m.html, /do not become comments/);
  assert.ok(!m.html.includes('SECRET-DESCRIPTION'));
  assert.match(m.eventId, /^[0-9a-f]{64}$/);

  await outbox().deleteMany({});
  await db.collection('scheduler_locks').deleteMany({ _id: 'email-collect' });
  for (let i = 0; i < 13; i++) await queued();
  assert.equal((await collect()).messages.length, 10, 'at most 10 at a time');
});

test('overlapping runs: a batch still out blocks another collection, and the lease ends with the last report', async () => {
  await queued(); await queued();
  const first = (await collect()).messages;
  assert.equal(first.length, 2);
  await queued();
  const during = await collect();
  assert.deepEqual(during.messages, []); assert.equal(during.busy, true);
  const both = await Promise.all([flow('collect'), flow('collect')]);
  assert.ok(both.every(r => r.json.messages.length === 0));
  await report(first[0], 'sent');
  assert.equal((await collect()).messages.length, 0, 'one report still out');
  await report(first[1], 'sent');
  assert.equal((await collect()).messages.length, 1, 'all reported: free again, and the new one comes');
});

test('concurrent first collections hand out a message once', async () => {
  await queued();
  const results = await Promise.all([flow('collect'), flow('collect'), flow('collect')]);
  assert.equal(results.flatMap(r => r.json.messages).length, 1);
});

test('reports: sent, repeated, a lost report, and an unknown message', async () => {
  await queued();
  const [m] = (await collect()).messages;
  assert.equal((await report(m, 'sent')).status, 200);
  let r = await row(m);
  assert.equal(r.status, 'sent'); assert.equal(r.providerId, 'sent'); assert.ok(r.sentAt);
  const firstSent = r.sentAt;
  assert.equal((await report(m, 'sent')).status, 200, 'safe to repeat');
  assert.equal((await row(m)).sentAt.getTime(), firstSent.getTime());

  for (const bad of [{}, { id: 'x', eventId: m.eventId, outcome: 'sent' }, { id: m.id, eventId: 'x', outcome: 'sent' }, { id: m.id, eventId: m.eventId, outcome: 'whatever' }, { id: m.id, eventId: m.eventId, outcome: 'outlook-failed', code: '<b>' }]) assert.equal((await flow('report', bad)).status, 400);
  assert.equal((await flow('report', { id: '0'.repeat(24), eventId: m.eventId, outcome: 'sent' })).json.gone, true);
  assert.equal((await flow('report', { id: m.id, eventId: '0'.repeat(64), outcome: 'in-doubt', claim: m.claim })).json.ignored, true);

  // The flow sent it, but the report never arrived: collected again with the same event ID, and the ledger says so.
  await queued();
  const [second] = (await collect()).messages;
  await expireClaims();
  const [again] = (await collect()).messages;
  assert.equal(again.eventId, second.eventId, 'the same event ID, so the flow finds its ledger entry');
  assert.notEqual(again.claim, second.claim);
  await report(again, 'already-sent');
  assert.equal((await row(again)).status, 'sent');
  assert.equal((await row(again)).providerId, 'already-sent');
});

test('a slow old run cannot overrule a newer claim, but its "sent" still counts', async () => {
  await queued();
  const [old] = (await collect()).messages;
  await expireClaims();
  const [current] = (await collect()).messages;
  assert.equal((await report(old, 'outlook-failed', '500')).json.ignored, true);
  assert.equal((await row(current)).status, 'pending');
  await report(old, 'sent');
  assert.equal((await row(current)).status, 'sent');
});

test('in doubt: never resent by itself, never silently dropped, and only an Admin\'s choice sends it again', async () => {
  const id = await queued();
  const [m] = (await collect()).messages;
  await report(m, 'in-doubt');
  let r = await row(m);
  assert.equal(r.status, 'failed'); assert.equal(r.inDoubt, true); assert.equal(r.lastError, 'in doubt');
  await expireClaims();
  assert.deepEqual((await collect()).messages, [], 'not collected again');
  assert.ok(logged.some(l => l.includes('may or may not have gone out') && l.includes(id)));
  const alert = await db.collection('notifications').findOne({ record: id, inbox: 'admins', type: 'email' });
  assert.match(alert.title, /in doubt/);
  assert.ok(!JSON.stringify(alert).includes(addr(2)), 'no recipient in the alert');
  const shown = (await call(`${W}/notifications?view=Admin`, { cookie: ADMIN })).json.items.find(n => n.type === 'email');
  assert.ok(shown, 'Admins see it in the bell');

  const status = await call(`${W}/email`, { cookie: ADMIN });
  const item = status.json.items.find(i => i.id === m.id);
  assert.equal(item.inDoubt, true); assert.equal(item.canRetry, true);
  assert.equal((await post(`${W}/email/${m.id}/retry`, ADMIN)).json.error, 'in-doubt', 'a plain retry is refused');
  assert.equal((await post(`${W}/email/${m.id}/retry`, DEV, { force: true })).status, 403);
  assert.equal((await post(`${W}/email/${m.id}/retry`, ADMIN, { force: true })).status, 202);
  const [next] = (await collect()).messages;
  assert.equal(next.id, m.id);
  assert.notEqual(next.eventId, m.eventId, 'a new event ID, because this is a deliberate new attempt');
  await report(next, 'sent');
  assert.equal((await row(next)).status, 'sent');
});

test('a claim that was never reported is retried, then treated as in doubt after 48 hours, not as expired', async () => {
  const id = await queued();
  const [m] = (await collect()).messages;
  await backdate({ ticket: id }, 49 * 3600000);
  await app.email.process();
  const r = await row(m);
  assert.equal(r.status, 'failed'); assert.equal(r.inDoubt, true);
  assert.ok(await db.collection('notifications').findOne({ record: id, type: 'email', inbox: 'admins' }));

  await outbox().deleteMany({});
  const never = await queued();
  await app.email.process();
  await backdate({ ticket: never }, 49 * 3600000);
  await app.email.process();
  const unsent = await outbox().findOne({ ticket: never });
  assert.equal(unsent.status, 'skipped'); assert.equal(unsent.reason, 'expired', 'never handed to the flow, so it certainly did not go');
});

test('Outlook failures: retries with backoff, stops at the limit, and pauses on a connection problem or throttling', async () => {
  const id = await queued();
  const [m] = (await collect()).messages;
  await report(m, 'outlook-failed', '500');
  let r = await row(m);
  assert.equal(r.status, 'pending'); assert.equal(r.lastError, 'Outlook 500'); assert.equal(r.attempts, 1);
  assert.ok(r.nextAttemptAt > new Date(), 'backs off');
  assert.deepEqual((await collect()).messages, [], 'not due yet');
  for (let i = 0; i < 4; i++) { await expireClaims(); const [x] = (await collect()).messages; await report(x, 'outlook-failed', '500'); }
  r = await row(m);
  assert.equal(r.status, 'failed'); assert.equal(r.attempts, 5);
  assert.ok(await db.collection('notifications').findOne({ record: id, inbox: 'admins', type: 'email' }));
  assert.equal((await post(`${W}/email/${m.id}/retry`, ADMIN)).status, 202, 'an Admin can retry without accepting a duplicate: Outlook definitely failed');

  await outbox().deleteMany({});
  await expireClaims();
  await queued();
  const [c] = (await collect()).messages;
  await report(c, 'outlook-failed', '401');
  assert.equal((await row(c)).status, 'pending', 'fixing the connection is enough; it retries');
  await outbox().updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
  const paused = await collect();
  assert.equal(paused.paused, true); assert.deepEqual(paused.messages, []);
  const lock = await db.collection('scheduler_locks').findOne({ _id: 'email-collect' });
  assert.ok(lock.pausedUntil > new Date(Date.now() + 14 * 60000), 'about 15 minutes');
  await db.collection('scheduler_locks').updateOne({ _id: 'email-collect' }, { $set: { pausedUntil: new Date(0) } });
  assert.equal((await collect()).messages.length, 1, 'collects again after the pause');

  await outbox().deleteMany({});
  await expireClaims();
  await queued();
  const [l] = (await collect()).messages;
  await report(l, 'ledger-unavailable');
  assert.equal((await row(l)).lastError, 'ledger unavailable'); assert.equal((await row(l)).status, 'pending');

  await outbox().deleteMany({});
  await expireClaims();
  await queued();
  const [x] = (await collect()).messages;
  await report(x, 'rejected', 'recipient');
  assert.equal((await row(x)).status, 'failed'); assert.equal((await row(x)).lastError, 'rejected recipient');
});

test('stale checks and preferences apply when collected', async () => {
  const moved = await newRequest();
  await assign(moved);
  await assign(moved, adminId);
  assert.deepEqual((await collect()).messages.filter(m => m.subject.startsWith(moved)), []);
  assert.equal((await outbox().findOne({ ticket: moved })).reason, 'no-longer-involved');

  await expireClaims();
  const off = await queued();
  await db.collection('users').updateOne({ _id: new ObjectId(devId) }, { $set: { emailActions: false } });
  assert.deepEqual((await collect()).messages, []);
  assert.equal((await outbox().findOne({ ticket: off })).reason, 'preference-off');

  await db.collection('users').updateOne({ _id: new ObjectId(devId) }, { $set: { emailActions: true, email: 'worker@elsewhere.example' } });
  await newRequest().then(assign);
  const held = await outbox().findOne({}, { sort: { _id: -1 } });
  assert.equal(held.status, 'skipped'); assert.equal(held.reason, 'outside-company');
});

test('a stopped flow is noticed: Admins are told, once a day, and the status shows when it last collected', async () => {
  const before = (await call(`${W}/email`, { cookie: ADMIN })).json;
  assert.equal(before.provider, 'power-automate'); assert.equal(before.sentLabel, 'Sent by Outlook');
  const id = await queued();
  await app.email.process();
  assert.ok(!await db.collection('notifications').findOne({ record: id, type: 'email' }), 'nothing yet: it has only just been queued');
  await backdate({ ticket: id }, 31 * 60000);
  await app.email.process(); await app.email.process();
  assert.equal(await db.collection('notifications').countDocuments({ record: id, type: 'email', inbox: 'admins' }), 1);
  assert.ok(logged.some(l => l.includes('waiting over 30 minutes')));
  assert.equal((await collect()).messages.length, 1);
  assert.ok((await call(`${W}/email`, { cookie: ADMIN })).json.lastCollectedAt);
});

test('saving never depends on the flow, and nothing is sent by the app', async () => {
  const id = await queued();
  assert.equal((await stored(id)).devId, devId);
  assert.ok(await db.collection('notifications').findOne({ record: id, inbox: `user:${devId}` }));
  const r = await outbox().findOne({ ticket: id });
  assert.equal(r.status, 'pending'); assert.equal(r.to, '', 'the address is read from the account when collected');
  assert.deepEqual(await app.email.process(), { sent: 0 });
  assert.equal((await outbox().findOne({ ticket: id })).attempts, 0);
});

test('logs, status, and alerts hold no secret, recipient, or message content', async () => {
  await queued();
  const [m] = (await collect()).messages;
  await report(m, 'in-doubt');
  await call(`${FLOW}/collect`, { method: 'POST', headers: { Authorization: 'Bearer guess-of-a-secret' } });
  const text = logged.join(' ') + (await call(`${W}/email`, { cookie: ADMIN })).text + JSON.stringify(await db.collection('notifications').find({ type: 'email' }).toArray());
  for (const s of [SECRET, OLD, 'guess-of-a-secret', addr(2), 'PATEST', '<html']) assert.ok(!text.includes(s), s);
});

test('rate limits cover the flow\'s routes, wrong secrets included', () => {
  let t = 0;
  const limits = createLimits({ now: () => t });
  assert.equal(RULES.emailflow.max, 60);
  for (let i = 0; i < 60; i++) assert.equal(limits.take('emailflow', 'a'), null);
  assert.ok(limits.take('emailflow', 'a').retryAfter > 0);
  assert.equal(limits.take('emailflow', 'b'), null, 'per address');
  t = 60001;
  assert.equal(limits.take('emailflow', 'a'), null);
});

test('with delivery off the routes do not exist', async () => {
  const offPort = await freePort();
  const off = await start(loadConfig({
    NODE_ENV: 'test', PORT: String(offPort), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: db.databaseName, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: ENTRA, APP_BASE_URL: `http://localhost:${offPort}`, SESSION_SECRET: 'power-automate-session-secret-0123456789abcdefg'
  }), { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  try {
    for (const route of ['check', 'collect', 'report']) assert.equal((await callAt(offPort, `${FLOW}/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } })).status, 404);
    assert.equal(off.email.collects, false);
  } finally { await off.shutdown(); }
});

test('settings: the secret and the allowed domains are required and checked', () => {
  const base = { NODE_ENV: 'test', AUTH_MODE: 'demo', APP_BASE_URL: 'http://localhost:4175', EMAIL_DELIVERY: 'power-automate', EMAIL_COLLECT_SECRET: SECRET, EMAIL_ALLOWED_DOMAINS: 'jarc.example, Other.example' };
  const load = extra => loadConfig({ ...base, ...extra }).email;
  const ok = load({});
  assert.equal(ok.provider, 'power-automate'); assert.deepEqual(ok.allowedDomains, ['jarc.example', 'other.example']); assert.deepEqual(ok.collectSecrets, [SECRET]);
  assert.deepEqual(load({ EMAIL_COLLECT_SECRET_PREVIOUS: OLD }).collectSecrets, [SECRET, OLD]);
  const refuses = (extra, pattern) => assert.throws(() => load(extra), pattern);
  refuses({ EMAIL_COLLECT_SECRET: '' }, /EMAIL_COLLECT_SECRET is required/);
  refuses({ EMAIL_COLLECT_SECRET: 'short' }, /at least/);
  refuses({ EMAIL_COLLECT_SECRET: '<placeholder-value-that-is-long-enough-to-pass>' }, /placeholder/);
  refuses({ SESSION_SECRET: SECRET }, /its own secret/);
  refuses({ ENTRA_CLIENT_SECRET: SECRET }, /its own secret/);
  refuses({ EMAIL_COLLECT_SECRET_PREVIOUS: 'short' }, /EMAIL_COLLECT_SECRET_PREVIOUS must be at least/);
  refuses({ EMAIL_ALLOWED_DOMAINS: '' }, /EMAIL_ALLOWED_DOMAINS/);
  refuses({ EMAIL_ALLOWED_DOMAINS: 'not a domain' }, /EMAIL_ALLOWED_DOMAINS/);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).email.enabled, false, 'still off unless asked');
});
