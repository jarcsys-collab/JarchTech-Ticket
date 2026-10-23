// Microsoft Entra sign-in, admission, sessions, and admin user management.
// Uses a local mock Entra provider and a temporary MongoDB on 127.0.0.1; never real Entra, Atlas, or .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { createStore } = require('../server/auth/store.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLIENT_SECRET = 'mock-client-secret-value';
const SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123456789';
const HOUR = 3600 * 1000;

let mongod, mongo, db, entra, app, base, origin, store;
let clock = null; // when set, the app's session clock (admission and expiry) uses this time
const quiet = { lines: [], log(...a) { this.lines.push(a.join(' ')); }, error(...a) { this.lines.push(a.join(' ')); } };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  assert.match(mongod.getUri(), /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db('jarctech_auth_test');
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: CLIENT_SECRET });
  const port = await freePort();
  origin = `http://localhost:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_auth_test',
    AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: CLIENT_SECRET, APP_BASE_URL: origin, SESSION_SECRET
  });
  app = await start(config, { log: quiet, oidc: { issuer: entra.issuer, allowInsecure: true }, now: () => clock ? new Date(clock) : new Date() });
  base = `http://127.0.0.1:${app.port}`;
  store = createStore(db);
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

// Minimal browser: sends cookies it was given, never follows redirects.
async function call(path, { method = 'GET', cookie, headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, location: res.headers.get('location'), setCookies: res.headers.getSetCookie(), text, json };
}
const cookieValue = (setCookies, name) => { const c = setCookies.find(s => s.startsWith(name + '=')); return c ? c.split(';')[0] : null; };

// Full sign-in: /auth/login -> (mock Microsoft) -> /auth/callback. Returns the callback response and the session cookie.
async function signIn(claims, options = {}, { cookie } = {}) {
  const login = await call('/auth/login');
  assert.equal(login.status, 302, login.text);
  const flow = cookieValue(login.setCookies, 'jt_auth');
  assert.ok(flow, 'sign-in flow cookie');
  const back = new URL(entra.authorize(login.location, claims, options));
  const res = await call(back.pathname + back.search, { cookie: [options.dropFlow ? null : flow, cookie].filter(Boolean).join('; ') });
  return { ...res, session: cookieValue(res.setCookies, 'jt_session') };
}
const person = (n, extra = {}) => ({ oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, sub: `sub-${n}`, name: `Person ${n}`, preferred_username: `person${n}@jarc.example`, email: `person${n}@jarc.example`, ...extra });
const users = () => db.collection('users');
const write = (path, cookie, body, method = 'POST') => call(path, { method, cookie, body, headers: { Origin: origin } });

test('before db:setup the server is not ready; after it, ready', async () => {
  const before = await call('/readyz');
  assert.equal(before.status, 503); assert.deepEqual(before.json, { status: 'not-ready', database: 'schema-missing' });
  // Sign-in must not start (or let MongoDB create collections implicitly) before db:setup.
  const login = await call('/auth/login');
  assert.equal(login.status, 503); assert.match(login.text, /Sign-in is not set up yet/); assert.equal(login.location, null);
  const callback = await call('/auth/callback?code=x&state=y');
  assert.equal(callback.status, 503);
  assert.deepEqual(await db.listCollections().toArray(), [], 'nothing created before db:setup');
  await ensureSchema(db);
  await new Promise(r => setTimeout(r, 1100)); // a not-ready readiness result is cached for 1 second
  const ready = await call('/readyz');
  assert.equal(ready.status, 200); assert.deepEqual(ready.json, { status: 'ready', database: 'connected' });
});

test('without a session the app is closed: sign-in page only, no app files or API', async () => {
  assert.equal((await call('/')).location, '/auth/signin');
  assert.equal((await call('/index.html')).location, '/auth/signin');
  assert.equal((await call('/app.js')).status, 401);
  assert.equal((await call('/auth-client.js')).status, 401);
  assert.equal((await call('/style.css')).status, 200);
  const page = await call('/auth/signin');
  assert.equal(page.status, 200); assert.match(page.text, /Sign in with Microsoft/); assert.doesNotMatch(page.text, /app\.js|localStorage/);
  assert.deepEqual((await call('/api/v1/me')).json, { error: 'sign-in-required' });
  assert.equal((await call('/healthz')).status, 200);
});

test('a valid Microsoft sign-in without an invitation is denied and creates nothing', async () => {
  const count = await users().countDocuments();
  const res = await signIn(person(1));
  assert.equal(res.status, 403); assert.match(res.text, /Access not granted/); assert.match(res.text, /not been given access/);
  assert.equal(res.session, null, 'no session cookie');
  assert.equal(await users().countDocuments(), count, 'sign-in never creates a user');
  assert.ok(await db.collection('events').findOne({ type: 'signin.denied', reason: 'not-invited', entraObjectId: person(1).oid }));
});

test('an invited person signs in once: the invitation binds to their Entra object ID with the invited role', async () => {
  await store.inviteUser({ email: 'person2@jarc.example', role: 'Requestor' }, null);
  const res = await signIn(person(2));
  assert.equal(res.status, 302); assert.equal(res.location, '/');
  const set = res.setCookies.find(c => c.startsWith('jt_session='));
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Path=\//); assert.match(set, /Max-Age=86400/); assert.doesNotMatch(set, /Secure/, 'http://localhost has no Secure flag');
  const user = await users().findOne({ email: 'person2@jarc.example' });
  assert.equal(user.status, 'active'); assert.equal(user.entraObjectId, person(2).oid); assert.equal(user.tenantId, TENANT); assert.equal(user.role, 'Requestor');
  const stored = await db.collection('sessions').findOne({ userId: user._id });
  assert.ok(stored && stored._id !== res.session.split('=')[1], 'only a hash of the session token is stored');
  const me = await call('/api/v1/me', { cookie: res.session });
  assert.equal(me.json.user.role, 'Requestor'); assert.equal(me.json.user.email, 'person2@jarc.example');
  const index = await call('/', { cookie: res.session });
  assert.equal(index.status, 200);
  assert.match(index.text, /window\.JARC_SESSION=Object\.freeze\(\{"displayName":"Person 2","email":"person2@jarc.example","role":"Requestor","accessPolicy":"invite-only","inspection":false\}\)/);
  assert.match(index.text, /<script src="auth-client\.js"><\/script><\/body>/);
  assert.doesNotMatch(index.text, /inspection\.js/, 'inspection mode is off unless enabled');
  // A different Microsoft account with the same email can never take over the already-bound invitation.
  const other = await signIn(person(3, { email: 'person2@jarc.example', preferred_username: 'person2@jarc.example' }));
  assert.equal(other.status, 403); assert.equal(other.session, null);
  assert.equal((await signIn(person(2))).status, 302, 'the bound account can sign in again');
});

test('disabled, guest, and other-tenant accounts are denied even when invited', async () => {
  await store.inviteUser({ email: 'person4@jarc.example', role: 'Developer' }, null);
  assert.equal((await signIn(person(4))).status, 302);
  await users().updateOne({ email: 'person4@jarc.example' }, { $set: { status: 'disabled' } });
  const disabled = await signIn(person(4));
  assert.equal(disabled.status, 403); assert.match(disabled.text, /turned off/); assert.equal(disabled.session, null);

  await store.inviteUser({ email: 'guest5@partner.example', role: 'Requestor' }, null);
  const guest = await signIn(person(5, { email: 'guest5@partner.example', preferred_username: 'guest5@partner.example', idp: 'https://sts.windows.net/99999999-9999-4999-8999-999999999999/' }));
  assert.equal(guest.status, 403); assert.match(guest.text, /Guest accounts/);
  assert.equal((await users().findOne({ email: 'guest5@partner.example' })).status, 'invited', 'guest never activates the invitation');

  await store.inviteUser({ email: 'person6@jarc.example', role: 'Requestor' }, null);
  const tenant = await signIn(person(6, { tid: '99999999-9999-4999-8999-999999999999' }));
  assert.equal(tenant.status, 403); assert.match(tenant.text, /different organization/);
});

test('forged, expired, mis-addressed, replayed, or cross-browser sign-in responses are rejected', async () => {
  await store.inviteUser({ email: 'person7@jarc.example', role: 'Requestor' }, null);
  for (const [label, options] of [['bad signature', { badSignature: true }], ['expired', { expired: true }], ['wrong audience', { audience: '00000000-0000-4000-8000-000000000000' }], ['wrong issuer', { issuer: 'https://login.microsoftonline.com/other/v2.0' }], ['wrong nonce', { nonce: 'not-the-nonce' }], ['wrong state', { state: 'not-the-state' }]]) {
    const res = await signIn(person(7), options);
    assert.equal(res.status, 401, label); assert.match(res.text, /could not be verified/, label); assert.equal(res.session, null, label);
  }
  const noFlow = await signIn(person(7), { dropFlow: true });
  assert.equal(noFlow.status, 400); assert.match(noFlow.text, /expired or was started in another browser/);
  assert.equal((await users().findOne({ email: 'person7@jarc.example' })).status, 'invited', 'nothing was activated');
  const login = await call('/auth/login');
  const back = new URL(entra.authorize(login.location, person(7)));
  const flow = cookieValue(login.setCookies, 'jt_auth');
  assert.equal((await call(back.pathname + back.search, { cookie: flow })).status, 302);
  assert.equal((await call(back.pathname + back.search, { cookie: flow })).status, 401, 'an authorization code works once');
  const err = await call('/auth/callback?error=access_denied&error_description=x', { cookie: flow });
  assert.equal(err.status, 400); assert.match(err.text, /did not complete \(access_denied\)/);
  assert.ok(entra.tokenRequests.every(r => r.code_verifier && r.redirect_uri === `${origin}/auth/callback`), 'PKCE verifier and exact redirect URI sent');
});

test('every sign-in issues a new session and ends the previous one in that browser', async () => {
  const first = await signIn(person(2));
  const second = await signIn(person(2), {}, { cookie: first.session });
  assert.notEqual(first.session, second.session);
  assert.equal((await call('/api/v1/me', { cookie: first.session })).status, 401);
  assert.equal((await call('/api/v1/me', { cookie: second.session })).status, 200);
});

test('roles come only from the server: browser-supplied roles are ignored', async () => {
  const { session } = await signIn(person(2));
  const page = await call('/?role=Admin', { cookie: `${session}; role=Admin; jarc_role=Admin`, headers: { 'X-Role': 'Admin' } });
  assert.match(page.text, /"role":"Requestor"/); assert.doesNotMatch(page.text, /"role":"Admin"/);
  assert.equal((await call('/api/v1/me?role=Admin', { cookie: session, headers: { 'X-Role': 'Admin' } })).json.user.role, 'Requestor');
  assert.equal((await write('/api/v1/users', session, { email: 'x@jarc.example', role: 'Admin' })).status, 403);
  assert.equal((await write(`/api/v1/users/${String((await users().findOne({ email: 'person2@jarc.example' }))._id)}`, session, { role: 'Admin' }, 'PATCH')).status, 403);
  assert.equal((await users().findOne({ email: 'person2@jarc.example' })).role, 'Requestor');
});

test('admin user management: invite, change roles, disable, and no self-changes', async () => {
  await store.inviteUser({ email: 'admin8@jarc.example', role: 'Admin' }, null);
  const admin = (await signIn(person(8, { email: 'admin8@jarc.example', preferred_username: 'admin8@jarc.example' }))).session;
  assert.ok(admin, 'invited Admin signed in');
  const requestor = (await signIn(person(2))).session;
  assert.equal((await call('/api/v1/users')).status, 401);
  assert.equal((await call('/api/v1/users', { cookie: requestor })).status, 403);
  assert.equal((await call('/api/v1/users', { cookie: (await signIn(person(9, { email: 'nobody@jarc.example' }))).session })).status, 401, 'denied sign-in has no session');

  assert.equal((await call('/api/v1/users', { method: 'POST', cookie: admin, body: { email: 'a@jarc.example', role: 'Requestor' } })).status, 403, 'missing Origin');
  assert.equal((await call('/api/v1/users', { method: 'POST', cookie: admin, body: { email: 'a@jarc.example', role: 'Requestor' }, headers: { Origin: 'https://evil.example' } })).status, 403, 'other origin');
  assert.equal((await call('/api/v1/users', { method: 'POST', cookie: admin, headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: undefined })).status, 415);

  const invited = await write('/api/v1/users', admin, { email: 'New.Person@JARC.example', role: 'Developer', displayName: 'New Person' });
  assert.equal(invited.status, 201); assert.equal(invited.json.user.email, 'new.person@jarc.example'); assert.equal(invited.json.user.status, 'invited');
  assert.equal((await write('/api/v1/users', admin, { email: 'new.person@jarc.example', role: 'Requestor' })).status, 409);
  assert.equal((await write('/api/v1/users', admin, { email: 'not-an-email', role: 'Requestor' })).status, 400);
  assert.equal((await write('/api/v1/users', admin, { email: 'b@jarc.example', role: 'Owner' })).status, 400);

  const list = (await call('/api/v1/users', { cookie: admin })).json.users;
  const id = email => list.find(u => u.email === email).id;
  const adminId = id('admin8@jarc.example');
  assert.equal((await write(`/api/v1/users/${adminId}`, admin, { role: 'Requestor' }, 'PATCH')).json.error, 'cannot-change-self');
  assert.equal((await write(`/api/v1/users/${id('new.person@jarc.example')}`, admin, { status: 'active' }, 'PATCH')).json.error, 'invitation-not-accepted');

  // Role change applies on the person's next request.
  assert.equal((await write(`/api/v1/users/${id('person2@jarc.example')}`, admin, { role: 'Developer' }, 'PATCH')).status, 200);
  assert.equal((await call('/api/v1/me', { cookie: requestor })).json.user.role, 'Developer');
  await write(`/api/v1/users/${id('person2@jarc.example')}`, admin, { role: 'Requestor' }, 'PATCH');
  // Disabling ends the person's sessions immediately.
  assert.equal((await write(`/api/v1/users/${id('person2@jarc.example')}`, admin, { status: 'disabled' }, 'PATCH')).status, 200);
  assert.equal((await call('/api/v1/me', { cookie: requestor })).status, 401);
  await write(`/api/v1/users/${id('person2@jarc.example')}`, admin, { status: 'active' }, 'PATCH');

  // With two Admins, one may demote or disable the other; the demoted person loses Admin access at once.
  await store.inviteUser({ email: 'admin10@jarc.example', role: 'Admin' }, null);
  const admin2 = (await signIn(person(10, { email: 'admin10@jarc.example', preferred_username: 'admin10@jarc.example' }))).session;
  assert.ok(admin2, 'second invited Admin signed in');
  const admin2Id = String((await users().findOne({ email: 'admin10@jarc.example' }))._id);
  assert.equal((await write(`/api/v1/users/${admin2Id}`, admin, { role: 'Developer' }, 'PATCH')).status, 200);
  assert.equal((await call('/api/v1/users', { cookie: admin2 })).status, 403, 'demoted Admin loses admin access on the next request');
  assert.equal((await write(`/api/v1/users/${adminId}`, admin2, { status: 'disabled' }, 'PATCH')).status, 403, 'a non-Admin cannot remove the remaining Admin');
  assert.ok(await db.collection('events').findOne({ type: 'user.updated', 'changes.role': 'Developer' }), 'role changes are audited');
});

test('the last active Admin can never be demoted or disabled (store-level guard)', async () => {
  // Through the API an Admin can only change other people, so an active Admin always remains. This guard covers
  // anything that reaches the store anyway, for example two Admins demoting each other at the same moment.
  const onlyAdmin = await users().findOne({ email: 'admin8@jarc.example' });
  assert.equal(await users().countDocuments({ role: 'Admin', status: 'active' }), 1);
  const actor = await users().findOne({ email: 'admin10@jarc.example' }); // a former Admin acting on a stale view
  await assert.rejects(store.updateUser(String(onlyAdmin._id), { role: 'Requestor' }, actor), { code: 'last-admin', status: 409 });
  await assert.rejects(store.updateUser(String(onlyAdmin._id), { status: 'disabled' }, actor), { code: 'last-admin', status: 409 });
  assert.equal((await users().findOne({ _id: onlyAdmin._id })).role, 'Admin');
});

test('sessions end after 8 hours idle and 24 hours in total', async () => {
  const t0 = Date.now();
  clock = t0;
  const idle = (await signIn(person(2))).session;
  clock = t0 + 8 * HOUR - 60 * 1000;
  assert.equal((await call('/api/v1/me', { cookie: idle })).status, 200, 'still valid just before 8 idle hours');
  clock = t0 + 16 * HOUR;
  assert.equal((await call('/api/v1/me', { cookie: idle })).status, 401, 'expired after 8 idle hours');

  clock = t0;
  const active = (await signIn(person(2))).session;
  for (const h of [7, 14, 21]) { clock = t0 + h * HOUR; assert.equal((await call('/api/v1/me', { cookie: active })).status, 200, `active at ${h}h`); }
  clock = t0 + 24 * HOUR + 1000;
  assert.equal((await call('/api/v1/me', { cookie: active })).status, 401, 'expired at 24 hours even while active');
  clock = null;
});

test('sign-out requires the app origin, ends the session, and returns through Microsoft sign-out', async () => {
  const { session } = await signIn(person(2));
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: session })).status, 403, 'no Origin');
  assert.equal((await call('/api/v1/me', { cookie: session })).status, 200);
  const out = await call('/auth/logout', { method: 'POST', cookie: session, headers: { Origin: origin } });
  assert.equal(out.status, 303);
  assert.ok(out.location.startsWith(entra.issuer.replace('/v2.0', '/oauth2/v2.0/logout')), out.location);
  assert.equal(new URL(out.location).searchParams.get('post_logout_redirect_uri'), `${origin}/auth/signed-out`);
  assert.match(out.setCookies.find(c => c.startsWith('jt_session=')), /Max-Age=0/);
  assert.equal((await call('/api/v1/me', { cookie: session })).status, 401);
  assert.match((await call('/auth/signed-out')).text, /You have signed out/);
});

test('when Microsoft sign-in is unreachable the app shows an error and never falls back to demo mode', async () => {
  const port = await freePort();
  const deadIssuer = `http://127.0.0.1:${await freePort()}/${TENANT}/v2.0`;
  const config = loadConfig({
    NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_auth_test',
    AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: CLIENT_SECRET, APP_BASE_URL: `http://localhost:${port}`, SESSION_SECRET
  });
  const log = { lines: [], log(...a) { this.lines.push(a.join(' ')); }, error(...a) { this.lines.push(a.join(' ')); } };
  const offline = await start(config, { log, oidc: { issuer: deadIssuer, allowInsecure: true } });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 503); assert.match(await res.text(), /temporarily unavailable/);
    const home = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(home.headers.get('location'), '/auth/signin');
    assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status, 401);
    assert.ok(!log.lines.join('\n').includes(CLIENT_SECRET) && !log.lines.join('\n').includes(SESSION_SECRET), 'secrets never logged');
  } finally { await offline.shutdown(); }
});

test('an Admin can revoke and restore an invitation; restoring never activates an account that has not signed in', async () => {
  const admin = (await signIn(person(8, { email: 'admin8@jarc.example', preferred_username: 'admin8@jarc.example' }))).session;
  assert.ok(admin);
  const invited = (await write('/api/v1/users', admin, { email: 'person11@jarc.example', role: 'Requestor' })).json.user;
  assert.equal(invited.linked, false);
  const revoked = await write(`/api/v1/users/${invited.id}`, admin, { status: 'disabled' }, 'PATCH');
  assert.equal(revoked.json.user.status, 'disabled');
  const denied = await signIn(person(11));
  assert.equal(denied.status, 403); assert.match(denied.text, /turned off/);
  const restored = await write(`/api/v1/users/${invited.id}`, admin, { status: 'active' }, 'PATCH');
  assert.equal(restored.status, 200); assert.equal(restored.json.user.status, 'invited', 'restored as an invitation, not an active account');
  assert.equal((await users().findOne({ email: 'person11@jarc.example' })).entraObjectId, null);
  const ok = await signIn(person(11));
  assert.equal(ok.status, 302, 'the restored invitation works on first sign-in');
  assert.equal((await users().findOne({ email: 'person11@jarc.example' })).status, 'active');
});
