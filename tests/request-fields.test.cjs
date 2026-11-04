// Departments and request categories: the exact lists, server validation, and compatibility with older records.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { start } = require('../server.cjs');
const { loadConfig } = require('../server/config.cjs');
const { ensureSchema } = require('../server/schema.cjs');
const WorkflowCore = require('../public/workflow-core.js');
const ListFilter = require('../public/list-filter.js');
const { startMockEntra } = require('./helpers/mock-entra.cjs');

const TENANT = '88888888-9999-4aaa-bbbb-cccccccccccc';
const CLIENT = '34343434-5656-4787-8989-010101010101';
const SECRET = 'fields-mock-secret';
const DB = 'jarctech_fields_test';
const W = '/api/v1/work';
const DEPARTMENTS = ['LEGAL', 'SALES', 'BUSINESS DEVELOPMENT', 'LEARNING', 'SUPPLY CHAIN', 'FINANCE', 'JARCET', 'SYS', 'HR & ADMIN', 'REGULATORY', 'COMMUNICATIONS', 'OOP'];
const CATEGORIES = ['NETWORK, HARDWARE, & SOFTWARE SUPPORT', 'MONDAY', 'POWERBI', 'EXCEL', 'BUSINESS CENTRAL', 'ECOM', 'SUPPORT FOR DISTRIBUTOR'];
let mongod, mongo, db, entra, port, origin, app, admin, dev, req, devId;
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  mongo = new MongoClient(mongod.getUri());
  db = mongo.db(DB);
  await ensureSchema(db);
  entra = await startMockEntra({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
  port = await freePort();
  origin = `http://localhost:${port}`;
  app = await start(loadConfig({ NODE_ENV: 'test', PORT: String(port), MONGODB_URI: mongod.getUri(), MONGODB_DB_NAME: DB, AUTH_MODE: 'entra', ACCESS_POLICY: 'tenant-members', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET, APP_BASE_URL: origin, SESSION_SECRET: 'fields-session-secret-0123456789abcdefghijkl' }), { log: { log() {}, error() {} }, oidc: { issuer: entra.issuer, allowInsecure: true }, scheduler: false });
  const signIn = async n => {
    const login = await call('/auth/login');
    const flow = login.setCookies.find(c => c.startsWith('jt_auth=')).split(';')[0];
    const back = new URL(entra.authorize(login.location, { sub: `sub-${n}`, oid: `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`, name: `Person ${n}`, email: `p${n}@jarc.example`, preferred_username: `p${n}@jarc.example` }));
    return (await call(back.pathname + back.search, { cookie: flow })).setCookies.find(c => c.startsWith('jt_session=')).split(';')[0];
  };
  admin = await signIn(1); dev = await signIn(2); req = await signIn(3);
  await db.collection('users').updateOne({ email: 'p1@jarc.example' }, { $set: { role: 'Admin' } });
  await db.collection('users').updateOne({ email: 'p2@jarc.example' }, { $set: { role: 'Developer' } });
  devId = String((await db.collection('users').findOne({ email: 'p2@jarc.example' }))._id);
});
after(async () => { await app?.shutdown(); await entra?.close(); await mongo?.close(); await mongod?.stop(); });

async function call(p, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, setCookies: res.headers.getSetCookie(), location: res.headers.get('location') };
}
let rid = 0;
const input = (o = {}) => ({ title: 'Fields request', type: 'Ticket', department: 'SALES', category: 'MONDAY', date: '2030-06-30', description: 'x', ...o });
const create = (o, requestId = `fields-${++rid}-${Date.now()}`) => call(`${W}/tickets`, { method: 'POST', cookie: req, body: { requestId, input: input(o) } });
const act = async (cookie, id, action, i = {}) => call(`${W}/tickets/${id}/actions`, { method: 'POST', cookie, body: { version: (await db.collection('tickets').findOne({ id })).version, action, input: i } });
const search = (cookie, q) => call(`${W}/search?${new URLSearchParams(q)}`, { cookie });
// A record exactly as an older version stored it.
async function older(id, department, category, extra = {}) {
  const requester = await db.collection('users').findOne({ email: 'p3@jarc.example' });
  const at = new Date();
  await db.collection('tickets').insertOne({ workspace: 'main', id, title: `Older ${id}`, type: 'Ticket', name: 'Person 3', department, date: '2030-01-01', category, description: 'Before the new lists.', status: 'Submitted', priority: 'Medium', dev: '', tasks: [], history: [], requestedDate: '2030-01-01', evidence: [], completion: { round: 1, worker: null, requestor: null, log: [] }, requester: { id: String(requester._id), name: 'Person 3', sample: false }, version: 1, statusSince: at, createdAt: at, updatedAt: at, ...extra });
}

test('the lists are exactly the agreed labels, in order', () => {
  assert.deepEqual(WorkflowCore.DEPARTMENTS, DEPARTMENTS);
  assert.deepEqual(WorkflowCore.CATEGORIES, CATEGORIES);
  assert.deepEqual(WorkflowCore.TYPES, ['Ticket', 'Project'], 'Ticket or Project stays a separate choice');
  assert.ok(!CATEGORIES.includes('Ticket') && !CATEGORIES.includes('Project'));
});

test('new requests accept every listed value and refuse anything else', async () => {
  for (const department of DEPARTMENTS) assert.equal((await create({ department })).status, 201, department);
  for (const category of CATEGORIES) assert.equal((await create({ category })).status, 201, category);
  const stored = await db.collection('tickets').findOne({ category: 'NETWORK, HARDWARE, & SOFTWARE SUPPORT' });
  assert.equal(stored.category, 'NETWORK, HARDWARE, & SOFTWARE SUPPORT', 'stored exactly');
  assert.equal(stored.type, 'Ticket', 'request type stays separate');
  const refusals = [
    [{ department: '' }, 'Select a department from the list.'], [{ department: undefined }, 'Select a department from the list.'], [{ department: 'Sales' }, 'Select a department from the list.'], [{ department: 'sales' }, 'Select a department from the list.'], [{ department: ['SALES'] }, 'Select a department from the list.'], [{ department: { $ne: '' } }, 'Select a department from the list.'],
    [{ category: '' }, 'Select a request category from the list.'], [{ category: undefined }, 'Select a request category from the list.'], [{ category: 'New feature' }, 'Select a request category from the list.'], [{ category: 'Project' }, 'Select a request category from the list.']
  ];
  for (const [o, message] of refusals) {
    const r = await create(o);
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.json.message, message);
  }
  // Type and category stay independent.
  for (const type of ['Ticket', 'Project']) assert.equal((await create({ type, category: 'ECOM' })).status, 201);
  assert.equal((await create({ type: 'ECOM' })).status, 400);
});

test('a repeat of a successful submission returns its record, even with values no longer offered', async () => {
  const id = `fields-repeat-${Date.now()}`;
  await db.collection('tickets').insertOne({ workspace: 'main', id: 'JRC-3000', title: 'Before', type: 'Ticket', name: 'Person 3', department: 'Finance', category: 'Enhancement', date: '2030-01-01', status: 'Submitted', priority: 'Medium', dev: '', tasks: [], history: [], requester: { id: String((await db.collection('users').findOne({ email: 'p3@jarc.example' }))._id), name: 'Person 3', sample: false }, version: 1, requestId: id, createdAt: new Date(), updatedAt: new Date() });
  const again = await create({ department: 'Finance', category: 'Enhancement' }, id);
  assert.equal(again.status, 200);
  assert.equal(again.json.created, 'JRC-3000');
  assert.equal(again.json.duplicate, true);
});

test('older records keep their values, stay readable and filterable, and take unrelated updates', async () => {
  await older('JRC-3101', 'Human Resources', 'Bug / issue');
  await older('JRC-3102', 'Customer Service', 'Access request', { type: 'Project' });
  await older('JRC-3103', 'IT', undefined); // from before categories
  const seen = await call(`${W}/tickets/JRC-3101`, { cookie: req });
  assert.equal(seen.json.tickets[0].department, 'Human Resources');
  assert.equal(seen.json.tickets[0].category, 'Bug / issue');
  // Filters, on the server, for people who can see the record, alongside current values.
  assert.deepEqual((await search(req, { department: 'Human Resources' })).json.items.map(t => t.id), ['JRC-3101']);
  assert.deepEqual((await search(req, { category: 'Bug / issue' })).json.items.map(t => t.id), ['JRC-3101']);
  assert.deepEqual((await search(admin, { department: 'Customer Service', category: 'Access request' })).json.items.map(t => t.id), ['JRC-3102']);
  assert.equal((await search(req, { department: 'IT' })).json.total, 1);
  assert.equal((await search(dev, { department: 'Human Resources' })).json.total, 0, 'filters never widen access');
  assert.ok((await search(req, { department: 'SALES' })).json.items.every(t => t.department === 'SALES'));
  assert.ok((await search(req, { category: 'ECOM' })).json.items.every(t => t.category === 'ECOM'));
  // Unknown values and operators are refused.
  assert.equal((await search(req, { department: 'Space' })).status, 400);
  assert.equal((await search(req, { category: 'Space' })).status, 400);
  assert.equal((await search(req, { category: '{"$ne":""}' })).status, 400);

  // A full run of unrelated updates on older records, without touching their values.
  const id = 'JRC-3101';
  assert.equal((await act(req, id, 'comment', { comment: 'Still needed.' })).status, 200);
  assert.equal((await act(admin, id, 'assign', { dev: devId, priority: 'High' })).status, 200);
  assert.equal((await act(dev, id, 'status', { status: 'In progress' })).status, 200);
  assert.equal((await act(dev, id, 'add-evidence', { links: [{ url: 'https://example.com/x' }] })).status, 200);
  assert.equal((await act(dev, id, 'worker-complete', { summary: 'Done' })).status, 200);
  assert.equal((await act(req, id, 'requestor-confirm')).status, 200);
  assert.equal((await act(admin, id, 'status', { status: 'Closed' })).status, 200);
  const closed = await db.collection('tickets').findOne({ id });
  assert.equal(closed.status, 'Closed');
  assert.equal(closed.department, 'Human Resources');
  assert.equal(closed.category, 'Bug / issue');
  // Without a category at all, and changing the request type.
  assert.equal((await act(req, 'JRC-3103', 'comment', { comment: 'Old one.' })).status, 200);
  assert.equal((await act(admin, 'JRC-3102', 'set-type', { type: 'Ticket' })).status, 200);
  const changed = await db.collection('tickets').findOne({ id: 'JRC-3102' });
  assert.equal(changed.department, 'Customer Service');
  assert.equal(changed.category, 'Access request');
  // Nothing reclassified anything.
  assert.equal(await db.collection('tickets').countDocuments({ department: 'Human Resources' }), 1);
});

test('filter choices include current and earlier values, in their own order, for local and server filtering', () => {
  assert.deepEqual(ListFilter.CHOICES.department.slice(0, 12), DEPARTMENTS);
  assert.deepEqual(ListFilter.CHOICES.category.slice(0, 7), CATEGORIES);
  for (const v of ['Sales', 'Human Resources', 'IT']) assert.ok(ListFilter.CHOICES.department.includes(v));
  for (const v of ['New feature', 'Bug / issue']) assert.ok(ListFilter.CHOICES.category.includes(v));
  assert.equal(ListFilter.empty().category, '');
  const f = { ...ListFilter.empty(), category: 'Bug / issue' };
  assert.ok(ListFilter.matches({ id: 'a', category: 'Bug / issue' }, f));
  assert.ok(!ListFilter.matches({ id: 'b', category: 'MONDAY' }, f));
  assert.ok(!ListFilter.matches({ id: 'c' }, f));
  assert.throws(() => ListFilter.normalize({ category: 'Space' }), ListFilter.FilterError);
  assert.equal(ListFilter.normalize({ category: 'HR & ADMIN'.replace('HR & ADMIN', 'ECOM') }).filters.category, 'ECOM');
  assert.equal(ListFilter.normalize({ department: 'HR & ADMIN' }).filters.department, 'HR & ADMIN');
});
