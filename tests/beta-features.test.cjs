// Beta attachments, in-app notifications, and search/filters (BETA_SIMULATION=enabled), against a mock Entra
// provider and a temporary MongoDB on 127.0.0.1. Never uses real Entra, Atlas, or .env.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');
const { createAttachments, disposition, inspector } = require('../server/workspace/attachments.cjs');
const Notify = require('../server/workspace/notifications.cjs');
const Rules = require('../public/attachment-rules.js');
const ListFilter = require('../public/list-filter.js');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '55555555-6666-4777-8888-999999999999';
const CLIENT = 'eeeeeeee-ffff-4000-8111-222222222222';
const SECRET = 'beta-features-mock-secret';
const DB = 'jarctech_beta_features_test';
let mongod, mongo, db, entra, port, origin;
const apps = [];
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const configFor = p => loadConfig({
  NODE_ENV: 'test', PORT: String(p), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', BETA_SIMULATION: 'enabled',
  ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${p}`, SESSION_SECRET: 'beta-features-session-secret-0123456789abcd'
});
const boot = async p => { const app = await start(configFor(p), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } }); apps.push(app); return app; };

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  assert.match(mongod.getUri(), /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  await seedWorkspace(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  await boot(port);
});
after(async () => { for (const app of apps) await app.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

const base = () => `http://127.0.0.1:${port}`;
async function call(p, { method = 'GET', cookie, body, raw, headers = {} } = {}) {
  const res = await fetch(base() + p, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, buf, headers: res.headers, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
const post = (p, cookie, body) => call(p, { method: 'POST', cookie, body, headers: { Origin: origin } });
const member = n => ({ sub: `sub-${n}`, oid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Tester ${n}`, email: `tester${n}@jarc.example`, preferred_username: `tester${n}@jarc.example` });
async function signIn(n) {
  const login = await call('/auth/login');
  const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
  const back = new URL(entra.authorize(login.location, member(n)));
  const res = await call(back.pathname + back.search, { cookie: flow });
  return res.setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
}
const upload = (cookie, name, bytes, headers = {}) => call('/api/v1/beta/attachments', { method: 'POST', cookie, raw: bytes, headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...headers } });
const ws = async cookie => (await call('/api/v1/beta/workspace', { cookie })).json;
const ticket = async (cookie, id) => (await ws(cookie)).tickets.find(t => t.id === id);
async function act(cookie, id, action, view, input = {}) {
  const t = await ticket(cookie, id);
  return post(`/api/v1/beta/tickets/${id}/actions`, cookie, { view, version: t.version, action, input });
}
let rid = 0;
const requestId = () => `features-${++rid}-${Date.now()}`;
const request = (overrides = {}) => ({ title: 'FEATURETEST request', department: 'Sales', date: '2026-12-15', category: 'New feature', description: 'Feature test description.', criteria: '', ...overrides });
const create = (cookie, input, extra = {}) => post('/api/v1/beta/tickets', cookie, { view: 'Requestor', requestId: requestId(), input: request(input), ...extra });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000dIHDR-test-image-bytes')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const ooxml = (part, extra = '') => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`....[Content_Types].xml....${part}document.xml....${extra}`)]);
const notes = (cookie, view, q = '') => call(`/api/v1/beta/notifications?view=${view}${q}`, { cookie });
const unread = async (cookie, view) => (await call(`/api/v1/beta/notifications/unread?view=${view}`, { cookie })).json.unread;
const search = (cookie, q) => call(`/api/v1/beta/search?${new URLSearchParams(q)}`, { cookie });
let A, B;

test('setup: two signed-in testers', async () => { A = await signIn(1); B = await signIn(2); assert.ok(A && B && A !== B); });

test('shared rules: safe names, extensions, size precheck, Content-Disposition', () => {
  assert.equal(Rules.safeName('..\\..\\evil<script>.png'), 'evil_script_.png');
  assert.equal(Rules.safeName('C:/Users/me/Screen Shot\u202e gnp.exe'), 'Screen Shot gnp.exe');
  assert.equal(Rules.safeName('  ...  '), '');
  assert.equal(Rules.safeName('a'.repeat(300) + '.xlsx').length, Rules.NAME_MAX);
  assert.ok(Rules.safeName('a'.repeat(300) + '.xlsx').endsWith('.xlsx'));
  assert.match(Rules.precheck('virus.exe', 10), /not allowed/);
  assert.match(Rules.precheck('big.png', Rules.MAX_FILE_BYTES + 1), /larger than 10 MB/);
  assert.equal(Rules.precheck('ok.PNG', 100), '');
  assert.equal(disposition('résumé "final".pdf'), `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
  const check = inspector(Rules.TYPES.png, 'x.png');
  check.push(PNG.subarray(0, 4)); check.push(PNG.subarray(4)); check.end(); // a signature split across chunks
  assert.throws(() => { const c = inspector(Rules.TYPES.png, 'x.png'); c.push(PNG); c.push(Buffer.alloc(Rules.MAX_FILE_BYTES - PNG.length)); c.push(Buffer.alloc(1)); }, e => e.status === 413);
});

test('attachments: upload, private while pending, safe download headers', async () => {
  const up = await upload(A, '../shots/Login error<1>.png', PNG);
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.deepEqual({ ...up.json.attachment, id: 'x' }, { id: 'x', name: 'Login error_1_.png', size: PNG.length, type: 'png', state: 'pending' });
  const id = up.json.attachment.id;
  const own = await call(`/api/v1/beta/attachments/${id}/download`, { cookie: A });
  assert.equal(own.status, 200); assert.ok(own.buf.equals(PNG));
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.match(own.headers.get('content-disposition'), /^attachment; filename="Login error_1_.png"/);
  assert.equal(own.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.match(own.headers.get('cache-control'), /no-store/);
  assert.equal((await call(`/api/v1/beta/attachments/${id}/download`, { cookie: B })).status, 404, 'another member cannot read a pending upload');
  assert.equal((await call(`/api/v1/beta/attachments/${id}/download`)).status, 401, 'sign-in required');
  assert.equal((await upload(null, 'a.png', PNG)).status, 401, 'upload requires sign-in');
  assert.equal((await upload(A, 'a.png', PNG, { Origin: 'https://evil.example' })).status, 403, 'cross-origin upload refused');
  assert.equal((await call(`/api/v1/beta/attachments/${'0'.repeat(24)}/download`, { cookie: A })).status, 404);
  const text = await upload(A, 'notes.txt', Buffer.from('Steps:\n1. Open the report\n2. Totals are wrong — ñ\n'));
  assert.equal(text.status, 201);
  const served = await call(`/api/v1/beta/attachments/${text.json.attachment.id}/download`, { cookie: A });
  assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
  for (const [name, bytes] of [['spec.pdf', PDF], ['form.docx', ooxml('word/')], ['data.xlsx', ooxml('xl/')], ['data.csv', Buffer.from('a,b\n1,2\n')]]) {
    assert.equal((await upload(A, name, bytes)).status, 201, name);
  }
});

test('attachments: invalid types, spoofed content, empty, oversized, and unsafe names are refused', async () => {
  const refused = async (name, bytes, status, pattern) => { const r = await upload(A, name, bytes); assert.equal(r.status, status, `${name}: ${JSON.stringify(r.json)}`); assert.match(r.json.message, pattern); };
  await refused('setup.exe', Buffer.from('MZ\x90\x00'), 415, /not allowed/);
  await refused('page.html', Buffer.from('<script>alert(1)</script>'), 415, /not allowed/);
  await refused('logo.svg', Buffer.from('<svg onload="alert(1)"/>'), 415, /not allowed/);
  await refused('fake.png', Buffer.from('<html><script>alert(1)</script></html>'), 415, /does not look like/);
  await refused('fake.pdf', PNG, 415, /does not look like/);
  await refused('binary.txt', Buffer.from([0x41, 0x00, 0x42]), 415, /does not look like/);
  await refused('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 415, /does not look like/);
  await refused('plain.docx', ooxml('xl/'), 415, /does not look like/);
  await refused('macro.docx', ooxml('word/', 'vbaProject.bin'), 415, /macros/);
  await refused('empty.png', Buffer.alloc(0), 400, /empty/);
  await refused('...', PNG, 400, /cannot be used/);
  // A declared size over the limit is refused before the body is read.
  const declared = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/beta/attachments', method: 'POST', headers: { Cookie: A, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'huge.png', 'Content-Length': Rules.MAX_FILE_BYTES + 1 } }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body), connection: res.headers.connection }));
    });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(declared.status, 413); assert.match(declared.body.message, /larger than 10 MB/); assert.equal(declared.connection, 'close');
  // A body that grows past the limit while streaming is refused and leaves no stored chunks.
  const chunksBefore = await db.collection('beta_files.chunks').countDocuments();
  const big = await upload(A, 'stream.png', Buffer.concat([PNG, Buffer.alloc(Rules.MAX_FILE_BYTES)]), { 'Transfer-Encoding': 'chunked' }).catch(err => ({ status: 'closed', err }));
  if (big.status !== 'closed') assert.equal(big.status, 413);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await db.collection('beta_files.chunks').countDocuments(), chunksBefore, 'aborted upload chunks are removed');
  assert.equal(await db.collection('beta_attachments').countDocuments({ name: 'stream.png' }), 0);
});

test('attachments: added to a new request and to comments; shared once attached; not reusable', async () => {
  const one = (await upload(A, 'screen-1.png', PNG)).json.attachment, two = (await upload(A, 'steps.pdf', PDF)).json.attachment;
  const made = await create(A, { title: 'FEATURETEST with files' }, {});
  assert.equal(made.status, 201);
  const withFiles = await create(A, { title: 'FEATURETEST attachments', attachments: [one.id, two.id] });
  assert.equal(withFiles.status, 201, JSON.stringify(withFiles.json));
  const t = withFiles.json.tickets[0];
  assert.deepEqual(t.history[0].attachments.map(x => x.name), ['screen-1.png', 'steps.pdf']);
  const shared = await call(`/api/v1/beta/attachments/${one.id}/download`, { cookie: B });
  assert.equal(shared.status, 200, 'any signed-in beta member can download an attached file'); assert.ok(shared.buf.equals(PNG));
  const reuse = await create(A, { title: 'FEATURETEST reuse', attachments: [one.id] });
  assert.equal(reuse.status, 409); assert.match(reuse.json.message, /no longer available/);
  const stolen = (await upload(B, 'b.png', PNG)).json.attachment;
  const steal = await create(A, { title: 'FEATURETEST steal', attachments: [stolen.id] });
  assert.equal(steal.status, 409, 'cannot attach another member\'s upload');
  assert.equal((await db.collection('beta_attachments').findOne({ _id: new ObjectId(stolen.id) })).state, 'pending');
  assert.equal((await create(A, { title: 'FEATURETEST bad ids', attachments: ['nope'] })).status, 400);
  assert.equal((await create(A, { title: 'FEATURETEST too many', attachments: Array.from({ length: 6 }, () => new ObjectId().toHexString()) })).status, 400);
  // Comment with files only; the files appear on the comment entry.
  const c1 = (await upload(B, 'reply.png', PNG)).json.attachment;
  const comment = await act(B, t.id, 'comment', 'Admin', { comment: '', attachments: [c1.id] });
  assert.equal(comment.status, 200, JSON.stringify(comment.json));
  const last = comment.json.tickets[0].history.at(-1);
  assert.equal(last.text, 'Admin: Shared 1 attachment.'); assert.equal(last.attachments[0].id, c1.id);
  // A comment that fails (stale version) keeps its upload pending for a retry.
  const c2 = (await upload(B, 'retry.png', PNG)).json.attachment;
  const stale = await post(`/api/v1/beta/tickets/${t.id}/actions`, B, { view: 'Admin', version: 1, action: 'comment', input: { comment: 'Stale', attachments: [c2.id] } });
  assert.equal(stale.status, 409);
  const invalid = await act(B, t.id, 'comment', 'Admin', { comment: 'x'.repeat(2001), attachments: [c2.id] });
  assert.equal(invalid.status, 400);
  assert.equal((await db.collection('beta_attachments').findOne({ _id: new ObjectId(c2.id) })).state, 'pending');
  assert.equal((await act(B, t.id, 'comment', 'Admin', { comment: 'Retry works', attachments: [c2.id] })).status, 200);
  // Remove: only pending uploads, only by the uploader.
  const gone = (await upload(A, 'remove-me.png', PNG)).json.attachment;
  assert.equal((await call(`/api/v1/beta/attachments/${gone.id}`, { method: 'DELETE', cookie: B, headers: { Origin: origin } })).status, 404);
  assert.equal((await call(`/api/v1/beta/attachments/${gone.id}`, { method: 'DELETE', cookie: A, headers: { Origin: origin } })).status, 200);
  assert.equal((await call(`/api/v1/beta/attachments/${gone.id}/download`, { cookie: A })).status, 404);
  assert.equal((await call(`/api/v1/beta/attachments/${one.id}`, { method: 'DELETE', cookie: A, headers: { Origin: origin } })).status, 404, 'attached files are not removed this way');
});

test('attachments: files persist across a server restart (as after a redeploy)', async () => {
  const t = (await ws(A)).tickets.find(x => x.title === 'FEATURETEST attachments');
  const file = t.history[0].attachments[0];
  const otherPort = await freePort();
  const app = await start(configFor(otherPort), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true } });
  try {
    const res = await fetch(`http://127.0.0.1:${otherPort}/api/v1/beta/attachments/${file.id}/download`, { headers: { Cookie: B } });
    assert.equal(res.status, 200); assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));
  } finally { await app.shutdown(); }
});

test('attachments: abandoned uploads and orphaned file data are swept', async () => {
  let clock = new Date();
  const files = createAttachments({ db, workspace: 'beta', log: { log() {}, error() {} }, now: () => clock });
  const pending = (await upload(A, 'abandoned.png', PNG)).json.attachment;
  const orphanId = new ObjectId(ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3 * 86400).toHexString().slice(0, 8) + new ObjectId().toHexString().slice(8));
  await db.collection('beta_files.chunks').insertOne({ files_id: orphanId, n: 0, data: Buffer.from('x') });
  assert.equal((await files.sweep()).removed, 1, 'only the old orphaned chunk goes now');
  clock = new Date(Date.now() + 25 * 3600 * 1000);
  await files.sweep();
  assert.equal(await db.collection('beta_attachments').countDocuments({ _id: new ObjectId(pending.id) }), 0);
  assert.equal(await db.collection('beta_files.files').countDocuments({ _id: new ObjectId(pending.id) }), 0);
  assert.equal(await db.collection('beta_files.chunks').countDocuments({ files_id: { $in: [orphanId, new ObjectId(pending.id)] } }), 0);
  const t = (await ws(A)).tickets.find(x => x.title === 'FEATURETEST attachments');
  assert.equal((await call(`/api/v1/beta/attachments/${t.history[0].attachments[0].id}/download`, { cookie: A })).status, 200, 'attached files are kept');
});

test('notifications: recipients, own actions, per-member read state, duplicates, links', async () => {
  const before = { admin: await unread(B, 'Admin') };
  const made = await create(A, { title: 'FEATURETEST notify' });
  const id = made.json.created;
  assert.equal(await unread(B, 'Admin'), before.admin + 1, 'admin inbox notified for another tester');
  const adminA = (await notes(A, 'Admin')).json;
  const mine = adminA.items.find(n => n.record === id);
  assert.equal(mine.read, true, 'no unread alert for the submitter\'s own action');
  const list = (await notes(B, 'Admin')).json;
  assert.equal(list.inbox, 'Admin inbox (simulated)');
  const item = list.items.find(n => n.record === id);
  assert.deepEqual({ title: item.title, kind: item.kind, target: item.target, read: item.read, actor: item.actor, actorView: item.actorView }, { title: 'New request submitted', kind: 'ticket', target: 'ticket', read: false, actor: 'Tester 1', actorView: 'Requestor' });
  // Admin (B) assigns: developer and the submitter's own inbox are notified; the admin inbox is not.
  const adminCount = await db.collection('beta_notifications').countDocuments({ inbox: 'admin' });
  assert.equal((await act(B, id, 'assign', 'Admin', { dev: 'Miguel Santos', priority: 'High' })).status, 200);
  assert.equal(await db.collection('beta_notifications').countDocuments({ inbox: 'admin' }), adminCount, 'acting view inbox not notified');
  const reqA = (await notes(A, 'Requestor')).json;
  assert.ok(reqA.items.some(n => n.record === id && n.title === 'Developer assigned' && !n.read));
  assert.ok(!(await notes(B, 'Requestor')).json.items.some(n => n.record === id), 'another member cannot see this member\'s own request inbox');
  assert.ok((await notes(B, 'Developer')).json.items.some(n => n.record === id && n.title === 'Assigned to you'));
  // Information request, meeting proposal, acceptance request, returned correction.
  assert.equal((await act(B, id, 'reason', 'Admin', { status: 'On hold', reason: 'Waiting on budget' })).status, 200);
  assert.ok((await notes(A, 'Requestor')).json.items.some(n => n.record === id && n.title === 'Put on hold'));
  assert.equal((await act(B, id, 'reason', 'Admin', { status: 'Waiting for information', reason: 'Which region?' })).status, 200);
  assert.ok((await notes(A, 'Requestor')).json.items.some(n => n.title === 'Information requested' && /Which region/.test(n.text)));
  assert.equal((await act(A, id, 'status', 'Requestor', { status: 'Under review' })).status, 200);
  assert.ok((await notes(B, 'Admin')).json.items.some(n => n.record === id && n.title === 'Information provided'));
  assert.equal((await act(B, id, 'assign', 'Admin', { dev: 'Miguel Santos', priority: 'High' })).status, 200);
  assert.equal((await act(B, id, 'schedule-meeting', 'Developer', { meeting: '2026-11-20T10:00', location: 'Room 2' })).status, 200);
  assert.ok((await notes(A, 'Requestor')).json.items.some(n => n.title === 'Meeting proposed: please confirm'));
  assert.equal((await act(A, id, 'confirm-meeting', 'Requestor')).status, 200);
  assert.ok((await notes(B, 'Developer')).json.items.some(n => n.record === id && n.title === 'Meeting confirmed'));
  const project = await act(B, id, 'create-project', 'Developer', { projectName: 'FEATURETEST project', requirements: 'R', criteria: 'C', date: '2026-12-15', tasks: [{ title: 'Build', requirement: 'R', criteria: 'C', start: '2026-11-21', end: '2026-11-25', owner: 'Miguel Santos' }] });
  assert.equal(project.status, 200, JSON.stringify(project.json));
  assert.equal((await notes(A, 'Requestor')).json.items.find(n => n.title === 'Project created').target, 'project', 'links to the project');
  assert.equal((await act(B, id, 'toggle-task', 'Developer', { index: 0, done: true })).status, 200);
  assert.equal((await act(B, id, 'submit-acceptance', 'Developer', { summary: 'Tested.' })).status, 200);
  assert.ok((await notes(A, 'Requestor')).json.items.some(n => n.record === id && n.title === 'Acceptance requested'));
  assert.equal((await act(A, id, 'reason', 'Requestor', { status: 'In progress', reason: 'Totals still wrong' })).status, 200);
  assert.ok((await notes(B, 'Developer')).json.items.some(n => n.record === id && n.title === 'Returned for correction'));
  // Comments reach the other parties, never the commenter's view.
  assert.equal((await act(A, id, 'comment', 'Requestor', { comment: 'FEATURETEST ping' })).status, 200);
  const pings = await db.collection('beta_notifications').find({ text: /FEATURETEST ping/ }).toArray();
  assert.deepEqual(pings.map(n => n.inbox).sort(), ['admin', 'developer:Miguel Santos']);
  // Read state is per member.
  const aBefore = await unread(A, 'Requestor'), bAdmin = await unread(B, 'Admin');
  const target = (await notes(A, 'Requestor')).json.items.find(n => !n.read);
  assert.equal((await post('/api/v1/beta/notifications/read', A, { view: 'Requestor', ids: [target.id] })).json.unread, aBefore - 1);
  assert.equal((await post('/api/v1/beta/notifications/read', A, { view: 'Admin', all: true })).json.unread, 0);
  assert.equal(await unread(B, 'Admin'), bAdmin, 'another member\'s read state is unchanged');
  assert.ok(await unread(B, 'Admin') > 0);
  // Marking ids from another inbox has no effect.
  const devItem = (await notes(B, 'Developer')).json.items.find(n => !n.read);
  await post('/api/v1/beta/notifications/read', B, { view: 'Admin', ids: [devItem.id] });
  assert.equal((await notes(B, 'Developer')).json.items.find(n => n.id === devItem.id).read, false);
  // Duplicate submission: one ticket, one notification.
  const dupId = requestId();
  const first = await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: dupId, input: request({ title: 'FEATURETEST dup' }) });
  const second = await post('/api/v1/beta/tickets', A, { view: 'Requestor', requestId: dupId, input: request({ title: 'FEATURETEST dup' }) });
  assert.equal(second.json.duplicate, true);
  assert.equal(await db.collection('beta_notifications').countDocuments({ record: first.json.created }), 1);
  // Paging and validation.
  const page1 = (await notes(B, 'Developer', '&limit=2')).json;
  assert.equal(page1.items.length, 2); assert.ok(page1.next);
  const page2 = (await notes(B, 'Developer', `&limit=2&before=${encodeURIComponent(page1.next)}`)).json;
  assert.ok(page2.items.every(n => !page1.items.some(m => m.id === n.id)));
  assert.equal((await notes(B, 'Owner')).status, 400);
  assert.equal((await notes(B, 'Admin', '&limit=500')).status, 400);
  assert.equal((await post('/api/v1/beta/notifications/read', B, { view: 'Admin', ids: ['bad'] })).status, 400);
  assert.equal((await call('/api/v1/beta/notifications?view=Admin')).status, 401);
});

test('notifications: change workflow and recipient rules', () => {
  const actor = { _id: new ObjectId(), displayName: 'T' };
  const t = { id: 'JRC-1', dev: 'Elyza Cruz', requester: { sample: true } };
  const docs = Notify.build({ events: Notify.ticketEvents({ dev: 'Paolo Reyes' }, t, 'assign'), record: 'JRC-1', kind: 'ticket', target: 'ticket', version: 3, ticket: t, before: { dev: 'Paolo Reyes' }, text: 'x', actor, view: 'Admin', at: new Date(), workspace: 'beta' });
  assert.deepEqual(docs.map(d => d.inbox), ['developer:Elyza Cruz', 'requestor:sample', 'developer:Paolo Reyes']);
  assert.ok(docs.every(d => d.readBy[0] === String(actor._id) && d.key.startsWith('JRC-1:3:')));
  assert.deepEqual(Notify.changeEvents({ status: 'Awaiting approval' }, 'assess')[0].to, ['requestor']);
  assert.deepEqual(Notify.changeEvents({}, 'decision', { status: 'In progress' })[0].title, 'Change returned for correction');
  assert.deepEqual(Notify.ticketEvents({}, {}, 'save-task'), []);
});

test('search: combined filters, pagination, visibility, and validation over all shared records', async () => {
  const mk = async (cookie, title, extra) => (await create(cookie, { title, ...extra })).json.created;
  const ids = {
    a1: await mk(A, 'FINDME alpha invoice', { department: 'Finance', description: 'Quarterly invoice export' }),
    a2: await mk(A, 'FINDME beta report', { department: 'Finance', description: 'Payroll (special) chars [x]' }),
    b1: await mk(B, 'FINDME gamma access', { department: 'IT', description: 'VPN access for invoice team' })
  };
  assert.equal((await act(B, ids.a1, 'assign', 'Admin', { dev: 'Elyza Cruz', priority: 'Critical' })).status, 200);
  const s = async q => { const r = await search(B, { view: 'Admin', ...q }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
  assert.equal((await s({ q: 'findme' })).total, 3);
  assert.deepEqual((await s({ q: 'invoice' })).items.map(t => t.id).sort(), [ids.a1, ids.b1].sort(), 'summary or description');
  assert.deepEqual((await s({ q: ids.a2 })).items.map(t => t.id), [ids.a2], 'by ticket ID');
  assert.deepEqual((await s({ q: '(special) chars [x]' })).items.map(t => t.id), [ids.a2], 'regex characters are literal');
  assert.deepEqual((await s({ q: 'findme', department: 'Finance', dev: 'Elyza Cruz', priority: 'Critical', status: 'Assigned' })).items.map(t => t.id), [ids.a1], 'combined');
  assert.deepEqual((await s({ q: 'findme', dev: 'Unassigned' })).items.map(t => t.id).sort(), [ids.a2, ids.b1].sort());
  const p1 = await s({ q: 'findme', pageSize: 2 }), p2 = await s({ q: 'findme', pageSize: 2, page: 2 });
  assert.equal(p1.total, 3); assert.equal(p1.items.length, 2); assert.equal(p2.items.length, 1);
  assert.equal(new Set([...p1.items, ...p2.items].map(t => t.id)).size, 3);
  assert.equal((await s({ q: 'no such thing zzz' })).total, 0);
  // Requestor view: own requests plus the shared samples; never another member's requests.
  const asB = await search(B, { view: 'Requestor', q: 'FINDME' });
  assert.deepEqual(asB.json.items.map(t => t.id), [ids.b1]);
  const devView = (await search(B, { view: 'Developer' })).json;
  assert.ok(devView.items.every(t => t.dev === 'Miguel Santos'));
  // Projects scope searches project IDs and names.
  const projects = (await search(B, { view: 'Admin', scope: 'projects', q: 'PRJ-' })).json;
  assert.ok(projects.total >= 1 && projects.items.every(t => t.project));
  // Server search agrees with the shared browser filter on the same records.
  const all = (await ws(B)).tickets;
  for (const f of [{ q: 'invoice' }, { status: 'In progress' }, { department: 'Finance', dev: 'Unassigned' }, { priority: 'High' }]) {
    const local = ListFilter.page(all, ListFilter.normalize({ ...f, pageSize: 50 }));
    const remote = await s({ ...f, pageSize: 50 });
    assert.deepEqual(remote.items.map(t => t.id), local.items.map(t => t.id), JSON.stringify(f));
  }
  for (const bad of [{ status: 'Nope' }, { dev: 'Real Person' }, { pageSize: 500 }, { page: 0 }, { q: 'x'.repeat(101) }, { scope: 'changes' }]) {
    const r = await search(B, { view: 'Admin', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.ok(r.json.message || r.json.error);
  }
  assert.equal((await search(B, { view: 'Owner' })).status, 400);
  assert.equal((await search(null, { view: 'Admin' })).status, 401);
  const one = await call(`/api/v1/beta/tickets/${ids.a1}`, { cookie: B });
  assert.equal(one.status, 200); assert.equal(one.json.tickets[0].id, ids.a1);
  assert.equal((await call('/api/v1/beta/tickets/JRC-999999', { cookie: B })).status, 404);
});

test('reset clears only beta records, beta files, and beta notifications', async () => {
  const usersBefore = await db.collection('users').countDocuments();
  const unrelated = mongo.db('some_other_app');
  await unrelated.collection('fs.files').insertOne({ keep: true });
  const res = await post('/api/v1/beta/reset', A, { confirm: 'RESET' });
  assert.equal(res.status, 200);
  assert.equal(await db.collection('beta_attachments').countDocuments(), 0);
  assert.equal(await db.collection('beta_files.files').countDocuments(), 0);
  assert.equal(await db.collection('beta_files.chunks').countDocuments(), 0);
  assert.equal(await db.collection('beta_notifications').countDocuments(), 0);
  assert.equal(await db.collection('users').countDocuments(), usersBefore);
  assert.equal(await unrelated.collection('fs.files').countDocuments(), 1);
  const event = await db.collection('events').findOne({ type: 'beta.reset' }, { sort: { at: -1 } });
  assert.ok(event.removedFiles > 0 && event.removedNotifications > 0);
});
