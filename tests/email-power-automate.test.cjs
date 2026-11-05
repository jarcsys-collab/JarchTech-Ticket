// The Power Automate provider against a stand-in for Microsoft sign-in and the flow. Nothing leaves this machine.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { createEmail } = require('../server/workspace/email.cjs');

const SECRET = 'flow-secret-not-real', FLOW = 'https://prod-1.southeastasia.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1';
const TENANT = '77777777-8888-4999-aaaa-bbbbbbbbbbbb', CLIENT = '11111111-2222-4333-8444-555555555555';
const config = { enabled: true, provider: 'power-automate', flowUrl: FLOW, tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, allowedDomains: ['jarc.example'], appUrl: 'https://app.example', replyTo: null, testRecipients: [] };
let mongod, mongo, db, workerId, adminId, flowCalls, tokenCalls, answer, tokenAnswer, logged, email, clock;
const json = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: k => headers[k.toLowerCase()] ?? null } });
const stub = async (url, opts) => {
  if (url.includes('login.microsoftonline.com')) { tokenCalls.push({ url, body: new URLSearchParams(opts.body) }); return tokenAnswer(); }
  assert.equal(url, FLOW);
  const body = JSON.parse(opts.body);
  flowCalls.push({ headers: opts.headers, body, raw: opts.body });
  return answer(body);
};
const make = (over = {}) => createEmail({ config: { ...config, ...over }, db, fetch: stub, now: () => clock, log: { log: m => logged.push(String(m)), error: m => logged.push(String(m)) }, pace: 0 });
const row = () => db.collection('email_outbox').findOne({});
const queue = async () => {
  const after = { id: 'JRC-2100', version: 2, title: 'Printer', devId: String(workerId), requester: { id: String(adminId) }, status: 'Assigned' };
  await db.collection('tickets').replaceOne({ id: after.id }, { workspace: 'main', ...after, tasks: [] }, { upsert: true, bypassDocumentValidation: true }); // only the fields email reads
  return email.ticketSaved({ before: { ...after, devId: '' }, after, action: 'assign', input: {}, actor: { _id: adminId, email: 'admin@jarc.example', displayName: 'Ana Admin' } });
};
const due = () => db.collection('email_outbox').updateMany({ status: 'pending' }, { $set: { nextAttemptAt: new Date(0) } });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db('jarctech_power_automate_test');
  await ensureSchema(db);
  const at = new Date();
  workerId = (await db.collection('users').insertOne({ email: 'worker@jarc.example', displayName: 'Wes', role: 'Developer', status: 'active', createdAt: at, updatedAt: at })).insertedId;
  adminId = (await db.collection('users').insertOne({ email: 'admin@jarc.example', displayName: 'Ana Admin', role: 'Admin', status: 'active', createdAt: at, updatedAt: at })).insertedId;
});
after(async () => { await mongo?.close(); await mongod?.stop(); });
beforeEach(async () => {
  await db.collection('email_outbox').deleteMany({});
  await db.collection('users').updateOne({ _id: workerId }, { $set: { email: 'worker@jarc.example' } });
  flowCalls = []; tokenCalls = []; logged = []; clock = new Date();
  answer = () => json(200, { outcome: 'sent' });
  tokenAnswer = () => json(200, { access_token: 'token-value', expires_in: 3600 });
  email = make();
});

test('sends one recipient with a stable event ID, signed in as the app, and reports Outlook success as sent', async () => {
  assert.equal(await queue(), 1);
  await email.process();
  assert.equal(flowCalls.length, 1);
  const { headers, body } = flowCalls[0];
  assert.equal(headers.Authorization, 'Bearer token-value');
  assert.equal(tokenCalls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(tokenCalls[0].body.get('grant_type'), 'client_credentials');
  assert.equal(tokenCalls[0].body.get('scope'), 'https://service.flow.microsoft.com//.default');
  assert.equal(tokenCalls[0].body.get('client_id'), CLIENT);
  assert.equal(body.to, 'worker@jarc.example');
  assert.equal(body.replyTo, 'admin@jarc.example', 'names the person who acted as Reply-To');
  assert.match(body.eventId, /^[0-9a-f]{64}$/);
  assert.match(body.subject, /^JRC-2100: Assigned to you/);
  assert.match(body.html, /Ana Admin assigned/);
  assert.ok(!('from' in body), 'the sender is fixed in the flow; the app cannot choose it');
  const r = await row();
  assert.equal(r.status, 'sent'); assert.equal(r.providerId, 'sent');
  assert.equal((await email.status()).sentLabel, 'Sent by Outlook');
});

test('the request matches the documented trigger schema', async () => {
  await queue(); await email.process();
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../deploy/power-automate/trigger-schema.json'), 'utf8'));
  for (const key of schema.required) assert.ok(key in flowCalls[0].body, key);
  for (const key of Object.keys(flowCalls[0].body)) assert.ok(key in schema.properties, key);
  const check = await make().check();
  assert.equal(check.ok, false, 'a stand-in that says sent does not pass as a connection check');
  answer = () => json(200, { outcome: 'check' });
  flowCalls = [];
  assert.deepEqual(await make().check(), { ok: true });
  assert.equal(flowCalls[0].body.check, true);
  assert.equal(flowCalls[0].body.to, '', 'a check carries no recipient');
  for (const key of schema.required) assert.ok(key in flowCalls[0].body, key);
});

test('"flow accepted" is not "sent": a 202 stays queued and is never counted', async () => {
  answer = () => json(202, {});
  await queue(); await email.process();
  const r = await row();
  assert.equal(r.status, 'pending'); assert.equal(r.lastError, 'flow accepted, no result'); assert.equal(r.uncertain, true);
  assert.equal((await email.status()).counts.sent, 0);
});

test('retries reuse the event ID, and the flow\'s ledger answer ends them without another send', async () => {
  await queue();
  answer = () => { throw new Error('socket hang up'); };
  await email.process();
  assert.equal((await row()).lastError, 'network');
  await due();
  answer = () => json(200, { outcome: 'already-sent' });
  await email.process();
  assert.equal(flowCalls[0].body.eventId, flowCalls[1].body.eventId);
  assert.equal((await row()).status, 'sent');
});

test('in doubt: retries, then asks an Admin, who must accept a possible duplicate', async () => {
  await queue();
  answer = () => json(409, { outcome: 'in-doubt' });
  for (let i = 0; i < 5; i++) { await due(); await email.process(); }
  let r = await row();
  assert.equal(r.status, 'failed'); assert.equal(r.inDoubt, true); assert.equal(r.lastError, 'in doubt');
  const id = String(r._id);
  assert.equal((await email.status()).items[0].inDoubt, true);
  await assert.rejects(email.retry(id), e => e.code === 'in-doubt', 'a plain retry is refused');
  assert.equal((await row()).status, 'failed');
  answer = () => json(200, { outcome: 'sent' });
  await email.retry(id, { force: true });
  flowCalls = [];
  await email.process();
  r = await row();
  assert.equal(r.status, 'sent'); assert.equal(r.generation, 1);
  const earlier = (await createEmailKey());
  assert.notEqual(flowCalls[0].body.eventId, earlier, 'a new attempt on purpose has a new event ID');
});
const createEmailKey = async () => require('node:crypto').createHash('sha256').update((await row()).key).digest('hex');

test('Outlook failures: an expired connection stops the run; throttling waits; others retry', async () => {
  await queue();
  await db.collection('email_outbox').insertOne({ ...(await row()), _id: new ObjectId(), key: 'JRC-2100:9:email:assigned:second' });
  answer = () => json(502, { outcome: 'outlook-failed', code: '401' });
  await email.process();
  assert.equal(flowCalls.length, 1, 'the next message would fail the same way');
  const statuses = (await db.collection('email_outbox').find({}).toArray()).map(r => r.status).sort();
  assert.deepEqual(statuses, ['failed', 'pending']);
  assert.equal((await db.collection('email_outbox').findOne({ status: 'failed' })).lastError, 'Outlook 401');
  assert.ok(logged.some(l => l.includes('Outlook 401')));

  await db.collection('email_outbox').deleteMany({});
  await queue();
  answer = () => json(502, { outcome: 'outlook-failed', code: '429' }, { 'retry-after': '120' });
  await email.process();
  let r = await row();
  assert.equal(r.status, 'pending');
  assert.equal(r.nextAttemptAt.getTime(), clock.getTime() + 120000, 'Retry-After is respected');

  await db.collection('email_outbox').deleteMany({});
  await queue();
  answer = () => json(502, { outcome: 'outlook-failed', code: '500' });
  await email.process();
  r = await row();
  assert.equal(r.status, 'pending'); assert.equal(r.lastError, 'Outlook 500');
  assert.ok(r.nextAttemptAt > clock);
});

test('the flow\'s other answers: refused, unavailable ledger, throttled, and unauthorized', async () => {
  const cases = [
    [() => json(422, { outcome: 'rejected', code: 'recipient' }), 'failed', 'rejected recipient'],
    [() => json(503, { outcome: 'ledger-unavailable' }), 'pending', 'HTTP 503'],
    [() => json(429, {}, { 'retry-after': '30' }), 'pending', 'HTTP 429'],
    [() => json(401, {}), 'failed', 'HTTP 401'],
    [() => json(403, {}), 'failed', 'HTTP 403'],
    [() => json(404, {}), 'failed', 'HTTP 404']
  ];
  for (const [respond, status, error] of cases) {
    await db.collection('email_outbox').deleteMany({});
    answer = respond;
    await queue(); await email.process();
    const r = await row();
    assert.equal(r.status, status, error); assert.equal(r.lastError, error);
  }
});

test('a sign-in failure reaches no flow, is retried, and the token is reused until it nears expiry', async () => {
  tokenAnswer = () => json(401, { error: 'invalid_client', error_description: `bad secret ${SECRET}` });
  await queue(); await email.process();
  assert.equal(flowCalls.length, 0);
  const r = await row();
  assert.equal(r.status, 'pending'); assert.equal(r.lastError, 'token invalid_client');
  assert.deepEqual((await email.check()).step, 'sign-in');

  tokenAnswer = () => json(200, { access_token: 'token-value', expires_in: 3600 });
  tokenCalls = [];
  await due(); await email.process();
  await db.collection('email_outbox').deleteMany({});
  await queue(); await email.process();
  assert.equal(tokenCalls.length, 1, 'cached');
  clock = new Date(clock.getTime() + 3600000);
  await db.collection('email_outbox').deleteMany({});
  await queue(); await email.process();
  assert.equal(tokenCalls.length, 2, 'renewed');
});

test('logs and status hold no secret, token, flow address, recipient, or content', async () => {
  answer = () => json(422, { outcome: 'rejected', code: 'recipient', message: 'worker@jarc.example' });
  await queue(); await email.process();
  tokenAnswer = () => json(400, { error: 'x y z', error_description: SECRET });
  const text = logged.join(' ') + JSON.stringify(await email.status());
  for (const secret of [SECRET, 'token-value', 'logic.azure.com', 'worker@jarc.example', 'Printer']) assert.ok(!text.includes(secret), secret);
  const stored = JSON.stringify(await row());
  for (const secret of [SECRET, 'token-value', 'logic.azure.com']) assert.ok(!stored.includes(secret), secret);
});

test('recipients and Reply-To stay inside the company', async () => {
  await db.collection('users').updateOne({ _id: workerId }, { $set: { email: 'worker@elsewhere.example' } });
  await queue();
  const r = await row();
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'outside-company');
  await email.process();
  assert.equal(flowCalls.length, 0);
  await db.collection('email_outbox').deleteMany({});
  await db.collection('users').updateOne({ _id: workerId }, { $set: { email: 'worker@jarc.example' } });
  const t = await db.collection('tickets').findOne({ id: 'JRC-2100' });
  await email.ticketSaved({ before: { ...t, devId: '' }, after: t, action: 'assign', input: {}, actor: { _id: adminId, email: 'admin@elsewhere.example' } });
  await email.process();
  assert.equal(flowCalls[0].body.replyTo, '', 'no Reply-To rather than an outside one');
});

test('settings: the flow address, the app registration, and the allowed domains are required and checked', () => {
  const base = { NODE_ENV: 'test', AUTH_MODE: 'demo', APP_BASE_URL: 'http://localhost:4175', EMAIL_DELIVERY: 'power-automate', ENTRA_TENANT_ID: TENANT, EMAIL_FLOW_URL: FLOW, EMAIL_FLOW_CLIENT_ID: CLIENT, EMAIL_FLOW_CLIENT_SECRET: SECRET, EMAIL_ALLOWED_DOMAINS: 'jarc.example, Other.example' };
  const load = extra => loadConfig({ ...base, ...extra }).email;
  const ok = load({});
  assert.equal(ok.provider, 'power-automate'); assert.deepEqual(ok.allowedDomains, ['jarc.example', 'other.example']);
  assert.ok(load({ EMAIL_FLOW_URL: 'https://abc.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/1' }).enabled);
  const refuses = (extra, pattern) => assert.throws(() => load(extra), pattern);
  refuses({ EMAIL_FLOW_URL: '' }, /EMAIL_FLOW_URL is required/);
  refuses({ EMAIL_FLOW_URL: 'http://prod-1.logic.azure.com/x' }, /must be the https address/);
  refuses({ EMAIL_FLOW_URL: 'https://evil.example/logic.azure.com' }, /must be the https address/);
  refuses({ EMAIL_FLOW_URL: 'https://logic.azure.com.evil.example/x' }, /must be the https address/);
  refuses({ EMAIL_FLOW_CLIENT_ID: 'nope' }, /EMAIL_FLOW_CLIENT_ID/);
  refuses({ EMAIL_FLOW_CLIENT_SECRET: '' }, /EMAIL_FLOW_CLIENT_SECRET is required/);
  refuses({ EMAIL_FLOW_CLIENT_SECRET: 'same', ENTRA_CLIENT_SECRET: 'same' }, /must not be the sign-in secret/);
  refuses({ EMAIL_ALLOWED_DOMAINS: '' }, /EMAIL_ALLOWED_DOMAINS/);
  refuses({ EMAIL_ALLOWED_DOMAINS: 'not a domain' }, /EMAIL_ALLOWED_DOMAINS/);
  const off = loadConfig({ NODE_ENV: 'test' }).email;
  assert.equal(off.enabled, false, 'still off unless asked');
  assert.throws(() => load({ EMAIL_DELIVERY: 'outlook' }), /must be disabled, resend, or power-automate/);
});
