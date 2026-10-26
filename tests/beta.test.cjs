// Shared beta simulation workspace API (BETA_SIMULATION=enabled), against a mock Entra provider and a temporary
// MongoDB on 127.0.0.1. Never uses real Entra, Atlas, or .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '33333333-4444-4555-8666-777777777777';
const CLIENT = 'cccccccc-dddd-4eee-8fff-000000000000';
const SECRET = 'beta-workspace-mock-secret';
const DB = 'jarctech_beta_workspace_test';
let mongod, mongo, db, entra, port, origin;
const apps = [];
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const configFor = (env = {}) => loadConfig({
  NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled',
  ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${port}`, SESSION_SECRET: 'beta-workspace-session-secret-0123456789ab', ...env
});
async function boot(env) { const app = await start(configFor(env), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } }); apps.push(app); return app; }

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  assert.match(mongod.getUri(), /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  await boot();
});
after(async () => { for (const app of apps) await app.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

const base = () => `http://127.0.0.1:${port}`;
async function call(p, { method = 'GET', cookie, body, headers = {} } = {}, retried = false) {
  let res;
  try { res = await fetch(base() + p, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (err) { if (retried) throw err; return call(p, { method, cookie, body, headers }, true); } // a pooled socket from a restarted server
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const post = (p, cookie, body) => call(p, { method: 'POST', cookie, body, headers: { Origin: origin } });
const member = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Member ${n}`, email: `member${n}@jarc.example`, preferred_username: `member${n}@jarc.example` });
async function signIn(n) {
  const login = await call('/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, member(n)));
  const res = await call(back.pathname + back.search, { cookie: flow });
  const session = res.setCookies.find(c => c.startsWith('jt_session='));
  assert.ok(session, 'signed in');
  return session.split(';')[0];
}
const ws = async cookie => (await call('/api/v1/beta/workspace', { cookie })).json;
const find = (w, id) => w.tickets.find(t => t.id === id) || w.changes.find(c => c.id === id);
let A, B, rid = 0;
const requestId = () => `test-request-${++rid}-${Date.now()}`;
async function act(cookie, kind, id, action, view, input = {}) {
  const current = find(await ws(cookie), id);
  return post(`/api/v1/beta/${kind}/${id}/actions`, cookie, { view, version: current.version, action, input });
}
const newRequest = (overrides = {}) => ({ title: 'Shared beta request', name: 'Spoofed Name', department: 'Sales', date: '2026-12-15', category: 'New feature', description: 'Need a shared report.', criteria: 'Report totals match.', ...overrides });

test('no seeding on startup: the workspace starts empty; the explicit seed adds the samples', async () => {
  A = await signIn(1); B = await signIn(2);
  assert.deepEqual(await ws(A), { tickets: [], changes: [], notices: [] });
  const result = await seedWorkspace(db);
  assert.equal(result.seeded, true); assert.equal(result.tickets, 6); assert.equal(result.changes, 1);
  assert.equal((await seedWorkspace(db)).seeded, false, 'refuses to seed a workspace that has records');
  const w = await ws(A);
  assert.equal(w.tickets.length, 6); assert.equal(w.changes.length, 1); assert.ok(w.notices.length > 0);
  assert.ok(w.tickets.every(t => t.requester.sample === true && t.version === 1));
  assert.ok(find(w, 'JRC-1042').tasks.every(t => t.scheduleSource === 'demo' && t.start));
});

test('authorization: sign-in, same origin, valid view, and the capability flag are all required', async () => {
  assert.equal((await call('/api/v1/beta/workspace')).status, 401);
  assert.equal((await call('/api/v1/beta/tickets', { method: 'POST', cookie: A, body: { view: 'Requestor', requestId: requestId(), input: newRequest() } })).status, 403, 'missing Origin');
  assert.equal((await call('/api/v1/beta/tickets', { method: 'POST', cookie: A, body: { view: 'Requestor', requestId: requestId(), input: newRequest() }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Owner', requestId: requestId(), input: newRequest() })).status, 400);
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: 'x', input: newRequest() })).status, 400, 'request id required');
  const page = await call('/', { cookie: A });
  assert.match(page.text, /"beta":true/); assert.match(page.text, /<script src="workspace-store\.js"><\/script>/);
  // A server without the capability does not expose the workspace at all.
  const otherPort = await freePort();
  const plain = await start(loadConfig({ NODE_ENV: 'test', PORT: String(otherPort), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${otherPort}`, SESSION_SECRET: 'beta-workspace-session-secret-0123456789ab' }), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  try {
    const res = await fetch(`http://127.0.0.1:${otherPort}/api/v1/beta/workspace`, { headers: { Cookie: A } });
    assert.equal(res.status, 404, 'BETA_SIMULATION off: no beta API');
    const html = await (await fetch(`http://127.0.0.1:${otherPort}/`, { headers: { Cookie: A } })).text();
    assert.match(html, /"beta":false/); assert.doesNotMatch(html, /beta-store\.js/);
  } finally { await plain.shutdown(); }
});

test('submission: validated, requester taken from the session, repeated submissions are not duplicated', async () => {
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: requestId(), input: newRequest({ department: 'Space' }) })).status, 400);
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: requestId(), input: newRequest({ title: '' }) })).status, 400);
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: requestId(), input: newRequest({ date: '2026-02-30' }) })).status, 400);
  assert.equal((await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: requestId(), input: newRequest({ description: 'x'.repeat(5001) }) })).status, 400);
  const id = requestId();
  const first = await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: id, input: newRequest() });
  assert.equal(first.status, 201); assert.equal(first.json.created, 'JRC-1043');
  const t = first.json.tickets[0];
  assert.equal(t.name, 'Member 1', 'requester name comes from the session, not the form');
  assert.deepEqual(t.requester, { id: t.requester.id, name: 'Member 1', sample: false });
  assert.equal(t.history[0].actor, 'Member 1'); assert.equal(t.history[0].view, 'Requestor'); assert.equal(t.status, 'Submitted');
  const again = await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: id, input: newRequest() });
  assert.equal(again.status, 200); assert.equal(again.json.duplicate, true); assert.equal(again.json.created, 'JRC-1043');
  assert.equal(await db.collection('beta_tickets').countDocuments({ title: 'Shared beta request' }), 1);
  assert.ok((await ws(B)).tickets.some(x => x.id === 'JRC-1043'), 'visible to another member');
});

test('views are checked on the server and never grant access outside the beta workspace', async () => {
  assert.equal((await act(A, 'tickets', 'JRC-1043', 'assign', 'Requestor', { dev: 'Miguel Santos', priority: 'High' })).status, 403);
  assert.equal((await act(A, 'tickets', 'JRC-1043', 'status', 'Admin', { status: 'Closed' })).status, 409, 'invalid transition');
  assert.equal((await act(A, 'tickets', 'JRC-1043', 'assign', 'Admin', { dev: 'Someone Real', priority: 'High' })).status, 400, 'sample developers only');
  assert.equal((await act(A, 'tickets', 'JRC-1041', 'create-project', 'Developer', {})).status, 403, 'JRC-1041 is assigned to another sample developer');
  assert.equal((await act(B, 'tickets', 'JRC-1043', 'reason', 'Requestor', { status: 'Cancelled', reason: 'Not mine' })).status, 403, 'only the requester (or sample requests) in Requestor view');
  // Real roles and real APIs are unaffected by simulated views.
  assert.equal((await call('/api/v1/users', { cookie: A })).status, 403);
  assert.equal((await call('/api/v1/me', { cookie: A })).json.user.role, 'Requestor');
  assert.equal(await db.collection('users').countDocuments({ role: { $ne: 'Requestor' } }), 0, 'no account was promoted');
});

test('full lifecycle across all three views, including a returned correction, with actor and view recorded', async () => {
  const id = 'JRC-1043';
  const step = async (cookie, action, view, input, expect = 200) => { const r = await act(cookie, 'tickets', id, action, view, input); assert.equal(r.status, expect, `${action} as ${view}: ${r.text}`); return r.json?.tickets?.[0]; };
  await step(A, 'status', 'Admin', { status: 'Under review' });
  await step(A, 'reason', 'Admin', { status: 'Waiting for information', reason: 'Which columns?' });
  await step(A, 'comment', 'Requestor', { comment: 'Date, amount, region.' });
  await step(A, 'status', 'Requestor', { status: 'Under review' });
  let t = await step(B, 'assign', 'Admin', { dev: 'Miguel Santos', priority: 'High' });
  assert.equal(t.status, 'Assigned'); assert.equal(t.priority, 'High');
  t = await step(B, 'schedule-meeting', 'Developer', { meeting: '2026-11-03T10:00', location: 'JARC room' });
  assert.equal(t.status, 'Meeting scheduled');
  await step(A, 'confirm-meeting', 'Requestor', {});
  const task = (title, start, end) => ({ title, requirement: `Req ${title}`, criteria: `Crit ${title}`, start, end, owner: 'Miguel Santos' });
  await step(B, 'create-project', 'Developer', { projectName: 'Shared project', requirements: 'Build it.', criteria: 'Works.', date: '2026-12-15', tasks: [task('Build', '2026-11-10', '2026-11-05')] }, 400);
  await step(B, 'create-project', 'Developer', { projectName: 'Shared project', requirements: 'Build it.', criteria: 'Works.', date: '2026-12-15', tasks: [task('Build', '2026-11-10', '2026-12-20')] }, 400);
  t = await step(B, 'create-project', 'Developer', { projectName: 'Shared project', requirements: 'Build it.', criteria: 'Works.', date: '2026-12-15', tasks: [task('Build', '2026-11-10', '2026-11-20'), task('Test', '2026-11-21', '2026-12-01')] });
  assert.equal(t.project, 'PRJ-1043'); assert.equal(t.status, 'Planning'); assert.equal(t.tasks.length, 2);
  await step(B, 'create-project', 'Developer', { projectName: 'Again', requirements: 'x', criteria: 'x', date: '2026-12-15', tasks: [task('X', '2026-11-10', '2026-11-11')] }, 409);
  t = await step(B, 'save-task', 'Developer', { index: 1, task: { ...task('Test', '2026-11-21', '2026-12-02'), done: false } });
  assert.equal(t.tasks[1].end, '2026-12-02');
  await step(B, 'edit-scope', 'Developer', { projectName: 'Shared project', requirements: 'Build it.', criteria: 'Works.', date: '2026-11-30' }, 400);
  await step(B, 'toggle-task', 'Developer', { index: 0, done: true });
  await step(B, 'status', 'Developer', { status: 'In progress' });
  await step(B, 'submit-acceptance', 'Developer', { summary: 'Tested.' }, 400);
  await step(B, 'toggle-task', 'Developer', { index: 1, done: true });
  t = await step(B, 'submit-acceptance', 'Developer', { summary: 'Tested.' });
  assert.equal(t.status, 'Awaiting acceptance');
  t = await step(A, 'reason', 'Requestor', { status: 'In progress', reason: 'Totals are wrong.' });
  assert.equal(t.status, 'In progress'); assert.equal(t.tasks[1].done, false, 'correction reopens the last task');
  await step(B, 'toggle-task', 'Developer', { index: 1, done: true });
  await step(B, 'submit-acceptance', 'Developer', { summary: 'Fixed.' });
  await step(A, 'status', 'Requestor', { status: 'Ready for release' });
  await step(B, 'status', 'Developer', { status: 'Released' });
  t = await step(A, 'status', 'Admin', { status: 'Closed' });
  assert.equal(t.status, 'Closed');
  assert.ok(t.history.some(h => h.actor === 'Member 2' && h.view === 'Developer' && h.text.startsWith('Project created')));
  assert.ok(t.history.some(h => h.actor === 'Member 1' && h.view === 'Admin' && h.text === 'Admin: status changed to Closed.'));
  assert.ok(t.version > 15, 'every saved step created a new version');
});

test('conflicting updates are refused instead of silently overwritten', async () => {
  const before = find(await ws(A), 'JRC-1041');
  const first = await post('/api/v1/beta/tickets/JRC-1041/actions', A, { view: 'Requestor', version: before.version, action: 'comment', input: { comment: 'First writer' } });
  assert.equal(first.status, 200);
  const stale = await post('/api/v1/beta/tickets/JRC-1041/actions', B, { view: 'Requestor', version: before.version, action: 'comment', input: { comment: 'Stale writer' } });
  assert.equal(stale.status, 409); assert.equal(stale.json.error, 'conflict'); assert.equal(stale.json.tickets[0].version, before.version + 1, 'the latest record is returned');
  const after = find(await ws(A), 'JRC-1041');
  assert.ok(after.history.some(h => h.text.endsWith('First writer'))); assert.ok(!after.history.some(h => h.text.endsWith('Stale writer')));
});

test('linked scope change: assessment, agreement, approval, delivery, and rejection', async () => {
  const rq = requestId();
  const w = await ws(A);
  const made = await post('/api/v1/beta/tickets/JRC-1042/changes', A, { view: 'Requestor', requestId: rq, ticketVersion: find(w, 'JRC-1042').version, input: { title: 'Add region filter', reason: 'Managers need it.', criteria: 'Filter works.' } });
  assert.equal(made.status, 201); const id = made.json.created; assert.equal(id, 'CR-202');
  const dup = await post('/api/v1/beta/tickets/JRC-1042/changes', A, { view: 'Requestor', requestId: rq, ticketVersion: 1, input: { title: 'Add region filter', reason: 'x', criteria: 'x' } });
  assert.equal(dup.json.duplicate, true); assert.equal(await db.collection('beta_changes').countDocuments({ title: 'Add region filter' }), 1);
  const step = async (cookie, action, view, input, expect = 200) => { const r = await act(cookie, 'changes', id, action, view, input); assert.equal(r.status, expect, `${action} as ${view}: ${r.text}`); return r.json; };
  await step(A, 'agree', 'Requestor', {}, 409);
  await step(A, 'status', 'Admin', { status: 'Assessment' });
  await step(B, 'assess', 'Developer', { impact: 'Adds a filter.', effort: '2 days', date: '2026-11-15' });
  await step(B, 'agree', 'Requestor', {}, 200); // JRC-1042 is a shared sample request, so any member may act as its requester
  let r = await step(A, 'approve', 'Admin', {});
  assert.equal(r.changes[0].status, 'Approved'); assert.ok(r.tickets[0].tasks.some(t => t.title === `${id}: Add region filter` && !t.done));
  await step(B, 'status', 'Developer', { status: 'In progress' });
  await step(B, 'submit-test', 'Developer', { results: 'Filter tested.' });
  await step(A, 'status', 'Requestor', { status: 'Accepted' });
  r = await step(B, 'status', 'Developer', { status: 'Released' });
  assert.ok(r.tickets[0].tasks.find(t => t.title.startsWith(id + ':')).done, 'release completes the change task');
  r = await step(A, 'status', 'Admin', { status: 'Closed' });
  assert.equal(r.changes[0].status, 'Closed'); assert.equal(r.changes[0].approvedBy, 'Admin');
  await act(A, 'changes', 'CR-201', 'status', 'Admin', { status: 'Assessment' });
  const rej = await act(A, 'changes', 'CR-201', 'decision', 'Admin', { status: 'Rejected', reason: 'Out of scope.' });
  assert.equal(rej.status, 200); assert.equal(rej.json.changes[0].status, 'Rejected');
});

test('records persist across a server restart and are shared between members', async () => {
  const [app] = apps.splice(0, 1);
  await app.shutdown();
  await boot();
  const w = await ws(B);
  assert.equal(find(w, 'JRC-1043').status, 'Closed'); assert.equal(find(w, 'CR-202').status, 'Closed');
});

test('reset needs confirmation and restores only the shared beta workspace', async () => {
  await db.collection('normal_records').insertOne({ note: 'not part of the beta workspace' });
  const counts = async () => ({ users: await db.collection('users').countDocuments(), sessions: await db.collection('sessions').countDocuments(), normal: await db.collection('normal_records').countDocuments() });
  const beforeCounts = await counts();
  assert.equal((await post('/api/v1/beta/reset', A, { confirm: 'reset' })).status, 400);
  assert.ok(find(await ws(A), 'JRC-1043'), 'unchanged after a refused reset');
  const res = await post('/api/v1/beta/reset', A, { confirm: 'RESET' });
  assert.equal(res.status, 200); assert.equal(res.json.tickets.length, 6); assert.ok(!find(res.json, 'JRC-1043'));
  assert.deepEqual(await counts(), beforeCounts, 'accounts, sessions, and other collections untouched');
  assert.equal((await call('/api/v1/me', { cookie: B })).status, 200, 'sessions still valid');
  assert.ok(await db.collection('events').findOne({ type: 'beta.reset' }), 'reset is audited');
});

test('readiness requires the beta collections only when the capability is enabled', async () => {
  assert.equal((await call('/readyz')).json.status, 'ready');
  const fresh = mongo.db('jarctech_beta_unset_test');
  await ensureSchema(fresh);
  await fresh.collection('beta_changes').drop();
  const otherPort = await freePort();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: String(otherPort), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: 'jarctech_beta_unset_test', AUTH_MODE: 'entra', BETA_SIMULATION: 'enabled', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${otherPort}`, SESSION_SECRET: 'beta-workspace-session-secret-0123456789ab' }), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  try { assert.deepEqual(await (await fetch(`http://127.0.0.1:${otherPort}/readyz`)).json(), { status: 'not-ready', database: 'schema-missing' }); }
  finally { await app.shutdown(); }
});

test('beta:seed command: confirmation, refusal on existing records, and --replace scope', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'beta-seed.cjs'), ...args], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, JARCTECH_ENV_FILE: 'none', MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', code => resolve({ code, out }));
  });
  assert.equal((await run([])).code, 2);
  const refused = await run(['--confirm-db', DB]);
  assert.equal(refused.code, 1); assert.match(refused.out, /already has \d+ record/);
  const users = await db.collection('users').countDocuments();
  const replaced = await run(['--confirm-db', DB, '--replace']);
  assert.equal(replaced.code, 0, replaced.out); assert.match(replaced.out, /6 sample tickets and 1 sample change/);
  assert.equal(await db.collection('users').countDocuments(), users);
});
