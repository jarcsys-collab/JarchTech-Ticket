// Backend foundation tests against an isolated, temporary MongoDB (mongodb-memory-server on 127.0.0.1).
// They never read .env and never contact a shared or production database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const entry = require('../server.cjs');
const { createServer } = entry;
const { loadConfig } = require('../server/config.cjs');

const SERVER = path.join(__dirname, '..', 'server.cjs');
let mongod, testUri;
// Every started app is shut down at the end even if a test fails part-way, so a failure can never hang the run.
const started = [];
const start = async (...args) => { const app = await entry.start(...args); started.push(app); return app; };
const dbName = () => 'jarctech_test_' + Math.random().toString(36).slice(2, 10);
const quietLog = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }; };

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, agent: false }, res => {
      let body = ''; res.on('data', b => body += b);
      res.on('end', () => {
        try {
          const json = /json/.test(res.headers['content-type'] || '') && body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, body, json, headers: res.headers });
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject); req.end();
  });
}
function freePort() {
  return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  testUri = mongod.getUri();
  assert.match(testUri, /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
});
after(async () => { await Promise.all(started.map(app => app.shutdown())); await mongod?.stop(); });

test('with a reachable database: healthy, ready, and still serving the prototype', async () => {
  const { lines, ...log } = quietLog();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: dbName() }), { log });
  try {
    const health = await request(app.port, '/healthz');
    assert.equal(health.status, 200); assert.deepEqual(health.json, { status: 'ok' });
    assert.equal(health.headers['cache-control'], 'no-store');
    const ready = await request(app.port, '/readyz');
    assert.equal(ready.status, 200); assert.deepEqual(ready.json, { status: 'ready', database: 'connected' });
    assert.equal((await request(app.port, '/readyz', 'HEAD')).body, '');
    const index = await request(app.port, '/');
    assert.equal(index.status, 200); assert.match(index.body, /JarcTech Ticket/);
    assert.equal((await request(app.port, '/healthz', 'POST')).status, 405);
    assert.ok(lines.some(l => l.includes(`http://localhost:${app.port}`)), 'startup line the walkthrough waits for');
  } finally { await app.shutdown(); }
});

test('start-up and readiness checks create no database, collections, indexes, or documents', async () => {
  const { MongoClient } = require('mongodb');
  const name = dbName();
  const inspector = new MongoClient(testUri);
  const { log, error } = quietLog();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: name }), { log: { log, error } });
  try {
    await new Promise(r => setTimeout(r, 200)); // let the start-up connection check finish
    for (let i = 0; i < 3; i++) assert.equal((await request(app.port, '/readyz')).status, 200);
    // MongoDB creates a database only on its first write, so an untouched database does not exist at all.
    const { databases } = await inspector.db('admin').admin().listDatabases();
    assert.ok(!databases.some(d => d.name === name), 'database must not be created by start-up or readiness checks');
    assert.deepEqual(await inspector.db(name).listCollections().toArray(), []);
  } finally { await app.shutdown(); await inspector.close(); }
});

test('without database settings: prototype mode, healthy but not ready', async () => {
  const { lines, ...log } = quietLog();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: '0' }), { log });
  try {
    assert.equal((await request(app.port, '/healthz')).status, 200);
    const ready = await request(app.port, '/readyz');
    assert.equal(ready.status, 503); assert.deepEqual(ready.json, { status: 'not-ready', database: 'not-configured' });
    assert.ok(lines.some(l => l.includes('browser-only prototype')));
  } finally { await app.shutdown(); }
});

test('unreachable database: not ready, and neither the response nor the logs reveal credentials', async () => {
  const secret = 'Sup3r-Secret-Pw';
  const closedPort = await freePort();
  const { lines, ...log } = quietLog();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: `mongodb://jt_reader:${secret}@127.0.0.1:${closedPort}/?serverSelectionTimeoutMS=500`, MONGODB_DB_NAME: dbName() }), { log });
  try {
    const ready = await request(app.port, '/readyz');
    assert.equal(ready.status, 503); assert.deepEqual(ready.json, { status: 'not-ready', database: 'unreachable' });
    await new Promise(r => setTimeout(r, 300));
    const all = lines.join('\n') + ready.body;
    assert.match(all, /database unreachable/);
    assert.ok(!all.includes(secret) && !all.includes('jt_reader'), all);
  } finally { await app.shutdown(); }
});

test('shutdown stops accepting connections, reports not ready while stopping, and closes the database', async () => {
  const { lines, ...log } = quietLog();
  const app = await start(loadConfig({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: dbName() }), { log });
  assert.equal((await request(app.port, '/readyz')).status, 200);
  const first = app.shutdown('SIGTERM');
  assert.equal(app.shutdown('SIGTERM'), first, 'repeated shutdown requests share one shutdown');
  await first;
  assert.equal(app.server.listening, false);
  await assert.rejects(request(app.port, '/healthz'), /ECONNREFUSED/);
  assert.deepEqual(await app.database.ping(), { ok: false, reason: 'closed' });
  assert.ok(lines.includes('Shutdown complete.'));
});

test('readiness reports stopping during shutdown', async () => {
  const server = createServer({ database: { configured: true, ping: async () => ({ ok: true }) }, isShuttingDown: () => true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const ready = await request(server.address().port, '/readyz');
    assert.equal(ready.status, 503); assert.deepEqual(ready.json, { status: 'not-ready', database: 'stopping' });
  } finally { await new Promise(r => server.close(r)); }
});

function runServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, JARCTECH_ENV_FILE: 'none', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => out };
}

test('process refuses to start in production without database settings', async () => {
  const run = runServer({ NODE_ENV: 'production', PORT: '0' });
  const { code } = await run.exited;
  assert.equal(code, 1);
  assert.match(run.output(), /MONGODB_URI and MONGODB_DB_NAME are required when deployed/);
  assert.ok(!run.output().includes('http://localhost:'), 'must not start listening');
});

test('process start-up errors never print the connection string', async () => {
  const secret = 'Pa55-in-a-bad-uri';
  const run = runServer({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: `mongodb+srv://jt_user:${secret}@host:27017/`, MONGODB_DB_NAME: dbName() });
  const { code } = await run.exited; // srv URIs may not include a port, so the driver rejects it
  assert.equal(code, 1);
  assert.match(run.output(), /MONGODB_URI could not be used/);
  assert.ok(!run.output().includes(secret) && !run.output().includes('jt_user'), run.output());
});

// Signals cannot be delivered gracefully to a child process on Windows (Node terminates it instead),
// so the SIGTERM path is verified on Linux and macOS, including GitHub Actions.
test('SIGTERM shuts the process down cleanly', { skip: process.platform === 'win32' && 'signals are not deliverable to child processes on Windows' }, async () => {
  const run = runServer({ NODE_ENV: 'test', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: dbName() });
  let port;
  for (let i = 0; i < 100 && !port; i++) { port = Number(/http:\/\/localhost:(\d+)/.exec(run.output())?.[1]); if (!port) await new Promise(r => setTimeout(r, 50)); }
  assert.ok(port, run.output());
  assert.equal((await request(port, '/readyz')).status, 200);
  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.equal(code, 0, run.output());
  assert.match(run.output(), /SIGTERM received\. Stopping\.\.\.[\s\S]*Shutdown complete\./);
});

test('process refuses to start in production without valid sign-in settings, and never falls back to demo mode', async () => {
  const noAuth = runServer({ NODE_ENV: 'production', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: dbName() });
  assert.equal((await noAuth.exited).code, 1);
  assert.match(noAuth.output(), /AUTH_MODE=entra is required when deployed/);
  const partial = runServer({ NODE_ENV: 'production', PORT: '0', MONGODB_URI: testUri, MONGODB_DB_NAME: dbName(), AUTH_MODE: 'entra', ENTRA_TENANT_ID: '11111111-2222-4333-8444-555555555555' });
  assert.equal((await partial.exited).code, 1);
  assert.match(partial.output(), /ENTRA_CLIENT_ID is required/); assert.match(partial.output(), /SESSION_SECRET is required/);
  for (const run of [noAuth, partial]) assert.ok(!/http:\/\/localhost:|Sign-in: none/.test(run.output()), 'must not start listening or start in demo mode: ' + run.output());
});
