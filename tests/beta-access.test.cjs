// ACCESS_POLICY=tenant-members (beta): every member of the configured tenant may sign in and starts as Requestor.
// Uses a local mock Entra provider and a temporary MongoDB on 127.0.0.1; never real Entra, Atlas, or .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { createStore, CONSUMER_TENANT } = require('../server/auth/store.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '22222222-3333-4444-8555-666666666666';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const CLIENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const SECRET = 'beta-mock-client-secret';
const GLOBAL_ADMIN_ROLE_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10'; // Entra "Global Administrator" (wids claim)

let mongod, mongo, db, entra, app, base, origin, store;
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  assert.match(mongod.getUri(), /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db('jarctech_beta_test');
  await ensureSchema(db);
  store = createStore(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  const port = await freePort();
  origin = `http://localhost:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_beta_test', AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members',
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: origin, SESSION_SECRET: 'beta-session-secret-0123456789abcdefghijkl'
  });
  app = await start(config, { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

async function call(path, { method = 'GET', cookie, headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, location: res.headers.get('location'), setCookies: res.headers.getSetCookie(), text, json };
}
const cookieValue = (setCookies, name) => { const c = setCookies.find(s => s.startsWith(name + '=')); return c ? c.split(';')[0] : null; };
async function signIn(claims) {
  const login = await call('/auth/login');
  const flow = cookieValue(login.setCookies, 'jt_auth');
  const back = new URL(entra.authorize(login.location, claims));
  const res = await call(back.pathname + back.search, { cookie: flow });
  return { ...res, session: cookieValue(res.setCookies, 'jt_session') };
}
const member = (n, extra = {}) => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Member ${n}`, preferred_username: `member${n}@jarcgroup.example`, email: `member${n}@jarcgroup.example`, ...extra });
const users = () => db.collection('users');
const adminActor = async () => {
  if (!await users().findOne({ email: 'beta-admin@jarcgroup.example' })) {
    await users().insertOne({ email: 'beta-admin@jarcgroup.example', role: 'Admin', status: 'active', displayName: 'Beta Admin', tenantId: TENANT, entraObjectId: 'admin-oid', createdAt: new Date(), updatedAt: new Date() });
  }
  return users().findOne({ email: 'beta-admin@jarcgroup.example' });
};

test('the sign-in page explains beta access', async () => {
  const page = await call('/auth/signin');
  assert.match(page.text, /all company member accounts can sign in; new users start as Requestors/);
});

test('a member of the configured tenant is admitted without an invitation, as Requestor, once', async () => {
  const res = await signIn(member(1));
  assert.equal(res.status, 302); assert.equal(res.location, '/'); assert.ok(res.session);
  const user = await users().findOne({ entraObjectId: member(1).oid });
  assert.deepEqual({ role: user.role, status: user.status, tenantId: user.tenantId, email: user.email, autoAdmitted: user.autoAdmitted }, { role: 'Requestor', status: 'active', tenantId: TENANT, email: 'member1@jarcgroup.example', autoAdmitted: true });
  assert.ok(await db.collection('events').findOne({ type: 'user.auto-admitted', subjectId: user._id, role: 'Requestor' }));
  assert.equal((await call('/api/v1/me', { cookie: res.session })).json.user.role, 'Requestor');
  assert.match((await call('/', { cookie: res.session })).text, /"role":"Requestor","accessPolicy":"tenant-members"/);
  assert.equal((await signIn(member(1))).status, 302, 'signs in again');
  assert.equal(await users().countDocuments({ entraObjectId: member(1).oid }), 1, 'no duplicate account');
});

test('sign-in claims can never grant Admin or Developer automatically', async () => {
  const escalation = member(2, {
    roles: ['Admin', 'Developer'], role: 'Admin', groups: ['jarctech-admins'], wids: [GLOBAL_ADMIN_ROLE_TEMPLATE],
    email: 'admin@jarcgroup.example', preferred_username: 'admin@jarcgroup.example', name: 'Admin'
  });
  const res = await signIn(escalation);
  assert.equal(res.status, 302);
  const user = await users().findOne({ entraObjectId: escalation.oid });
  assert.equal(user.role, 'Requestor', 'role claims, group claims, and directory roles are ignored');
  const me = await call('/api/v1/me?role=Admin', { cookie: `${res.session}; role=Admin`, headers: { 'X-Role': 'Admin' } });
  assert.equal(me.json.user.role, 'Requestor');
  assert.equal((await call('/api/v1/users', { cookie: res.session })).status, 403);
  const selfPromote = await call(`/api/v1/users/${user._id}`, { method: 'PATCH', cookie: res.session, body: { role: 'Admin' }, headers: { Origin: origin } });
  assert.equal(selfPromote.status, 403);
  const invite = await call('/api/v1/users', { method: 'POST', cookie: res.session, body: { email: 'x@jarcgroup.example', role: 'Admin' }, headers: { Origin: origin } });
  assert.equal(invite.status, 403);
  assert.equal((await users().findOne({ _id: user._id })).role, 'Requestor');
  assert.equal(await users().countDocuments({ role: { $in: ['Admin', 'Developer'] }, autoAdmitted: true }), 0, 'no automatically created Admin or Developer');
});

test('guests, personal Microsoft accounts, and other tenants are refused and nothing is created', async () => {
  const before = await users().countDocuments();
  const cases = [
    ['B2B guest', member(3, { idp: `https://sts.windows.net/${OTHER_TENANT}/` }), /Guest accounts/],
    ['guest flagged by acct claim', member(4, { acct: 1 }), /Guest accounts/],
    ['personal account invited as guest', member(5, { idp: 'live.com', email: 'someone@outlook.example', preferred_username: 'someone@outlook.example' }), /Personal Microsoft accounts/],
    ['personal account tenant', member(6, { tid: CONSUMER_TENANT }), /Personal Microsoft accounts/],
    ['other tenant', member(7, { tid: OTHER_TENANT }), /different organization/]
  ];
  for (const [label, claims, message] of cases) {
    const res = await signIn(claims);
    assert.equal(res.status, 403, label); assert.match(res.text, message, label); assert.equal(res.session, null, label);
  }
  assert.equal(await users().countDocuments(), before, 'no accounts created for refused sign-ins');
});

test('disabled users stay locked out: auto-admitted, linked, or revoked by email', async () => {
  const admin = await adminActor();
  const first = await signIn(member(8));
  const user = await users().findOne({ entraObjectId: member(8).oid });
  await store.updateUser(String(user._id), { status: 'disabled' }, admin);
  assert.equal((await call('/api/v1/me', { cookie: first.session })).status, 401, 'existing session ended');
  const again = await signIn(member(8));
  assert.equal(again.status, 403); assert.match(again.text, /turned off/);
  assert.equal(await users().countDocuments({ email: 'member8@jarcgroup.example' }), 1, 'no replacement account created');

  // A revoked invitation for an email blocks that person too; beta access does not bypass it.
  const invited = await store.inviteUser({ email: 'member9@jarcgroup.example', role: 'Developer' }, admin);
  await store.updateUser(invited.id, { status: 'disabled' }, admin);
  const revoked = await signIn(member(9));
  assert.equal(revoked.status, 403); assert.match(revoked.text, /turned off/);
  assert.equal(await users().countDocuments({ email: 'member9@jarcgroup.example' }), 1);
  assert.equal((await users().findOne({ email: 'member9@jarcgroup.example' })).entraObjectId, null);
});

test('existing roles are preserved: invitations keep their role, and Admin changes stick across sign-ins', async () => {
  const admin = await adminActor();
  await store.inviteUser({ email: 'member10@jarcgroup.example', role: 'Developer' }, admin);
  assert.equal((await signIn(member(10))).status, 302);
  assert.equal((await users().findOne({ email: 'member10@jarcgroup.example' })).role, 'Developer', 'invited role honoured, not downgraded');

  await signIn(member(11));
  const auto = await users().findOne({ entraObjectId: member(11).oid });
  await store.updateUser(String(auto._id), { role: 'Developer' }, admin);
  const res = await signIn(member(11));
  assert.equal((await call('/api/v1/me', { cookie: res.session })).json.user.role, 'Developer', 'not reset to Requestor on sign-in');

  const existingAdmin = await signIn({ sub: 'sub-admin', oid: 'admin-oid', name: 'Beta Admin', email: 'beta-admin@jarcgroup.example', preferred_username: 'beta-admin@jarcgroup.example' });
  assert.equal((await call('/api/v1/me', { cookie: existingAdmin.session })).json.user.role, 'Admin');
});

test('an email already linked to a different Microsoft account is refused, not duplicated or taken over', async () => {
  await signIn(member(12));
  const takeover = await signIn(member(13, { email: 'member12@jarcgroup.example', preferred_username: 'member12@jarcgroup.example' }));
  assert.equal(takeover.status, 403); assert.match(takeover.text, /different Microsoft account/);
  const accounts = await users().find({ email: 'member12@jarcgroup.example' }).toArray();
  assert.equal(accounts.length, 1); assert.equal(accounts[0].entraObjectId, member(12).oid);
});

test('a member without a work email or UPN is refused', async () => {
  const res = await signIn(member(14, { email: undefined, preferred_username: undefined }));
  assert.equal(res.status, 403); assert.match(res.text, /stable account identifier and work email/);
  assert.equal(await users().countDocuments({ entraObjectId: member(14).oid }), 0);
});

test('simultaneous first sign-ins of the same member create one account', async () => {
  const results = await Promise.all([signIn(member(15)), signIn(member(15))]);
  assert.ok(results.every(r => r.status === 302), results.map(r => r.status).join(','));
  assert.equal(await users().countDocuments({ entraObjectId: member(15).oid }), 1);
});
