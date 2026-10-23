// npm run db:setup and npm run admin:bootstrap, run as real processes against a temporary MongoDB.
// They never read .env (JARCTECH_ENV_FILE=none) and never contact Atlas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const DB = 'jarctech_commands_test';
let mongod, mongo, uri;

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  uri = mongod.getUri();
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/$/, 'tests must only use the temporary local database');
  mongo = new MongoClient(uri);
});
after(async () => { await mongo?.close(); await mongod?.stop(); });

function run(script, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, JARCTECH_ENV_FILE: 'none', MONGODB_URI: uri, MONGODB_DB_NAME: DB, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', code => resolve({ code, out }));
  });
}
const collections = async () => (await mongo.db(DB).listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();

test('db:setup refuses to run unless --confirm-db names the target database', async () => {
  const missing = await run('db-setup.cjs', []);
  assert.equal(missing.code, 2); assert.match(missing.out, new RegExp(`--confirm-db ${DB}`));
  const wrong = await run('db-setup.cjs', ['--confirm-db', 'jarctech_ticket_prod']);
  assert.equal(wrong.code, 2);
  assert.deepEqual(await collections(), [], 'nothing created');
});

test('admin:bootstrap refuses before db:setup', async () => {
  const res = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB]);
  assert.equal(res.code, 1); assert.match(res.out, /Run npm run db:setup/);
});

test('db:setup creates the sign-in collections and indexes, idempotently, with no users', async () => {
  const first = await run('db-setup.cjs', ['--confirm-db', DB]);
  assert.equal(first.code, 0, first.out); assert.match(first.out, /collection created: users/); assert.match(first.out, /No users or records were created/);
  assert.deepEqual(await collections(), ['beta_changes', 'beta_tickets', 'events', 'sessions', 'users']);
  const names = (await mongo.db(DB).collection('users').indexes()).map(i => i.name).sort();
  assert.deepEqual(names, ['_id_', 'email_unique', 'entra_identity_unique']);
  const sessionIndexes = await mongo.db(DB).collection('sessions').indexes();
  assert.equal(sessionIndexes.find(i => i.name === 'expires_ttl').expireAfterSeconds, 0);
  const again = await run('db-setup.cjs', ['--confirm-db', DB]);
  assert.equal(again.code, 0); assert.doesNotMatch(again.out, /(collection|index) created/); assert.match(again.out, /validator updated: users/);
  assert.equal(await mongo.db(DB).collection('users').countDocuments(), 0);
  await assert.rejects(mongo.db(DB).collection('users').insertOne({ email: 'x@jarc.example', role: 'Owner', status: 'active', createdAt: new Date(), updatedAt: new Date() }), /Document failed validation/);
});

test('admin:bootstrap invites exactly one first Admin and refuses afterwards', async () => {
  const noEmail = await run('admin-bootstrap.cjs', ['--confirm-db', DB]);
  assert.equal(noEmail.code, 2); assert.match(noEmail.out, /--email is required/);
  const bad = await run('admin-bootstrap.cjs', ['--email', 'not-an-email', '--confirm-db', DB]);
  assert.equal(bad.code, 1);
  const ok = await run('admin-bootstrap.cjs', ['--email', 'Owner@JARC.example', '--confirm-db', DB]);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Invited owner@jarc\.example as the first Admin/);
  const users = await mongo.db(DB).collection('users').find().toArray();
  assert.equal(users.length, 1);
  assert.deepEqual({ email: users[0].email, role: users[0].role, status: users[0].status, entraObjectId: users[0].entraObjectId }, { email: 'owner@jarc.example', role: 'Admin', status: 'invited', entraObjectId: null });
  const again = await run('admin-bootstrap.cjs', ['--email', 'someone@jarc.example', '--confirm-db', DB]);
  assert.equal(again.code, 1); assert.match(again.out, /already has a pending Admin invitation/);
  assert.equal(await mongo.db(DB).collection('users').countDocuments(), 1);
});

test('database command errors never print the connection string', async () => {
  const secret = 'Cmd-Secret-Pw-123';
  const res = await run('db-setup.cjs', ['--confirm-db', DB], { MONGODB_URI: `mongodb://cmd_user:${secret}@127.0.0.1:1/?serverSelectionTimeoutMS=500` });
  assert.equal(res.code, 1);
  assert.ok(!res.out.includes(secret) && !res.out.includes('cmd_user'), res.out);
});

test('admin:bootstrap can replace a mistyped pending Admin invitation, but never an Admin who has signed in', async () => {
  const pending = await run('admin-bootstrap.cjs', ['--email', 'owner2@jarc.example', '--confirm-db', DB]);
  assert.equal(pending.code, 1); assert.match(pending.out, /pending Admin invitation for owner@jarc\.example/); assert.match(pending.out, /--replace-invitation/);
  const same = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB, '--replace-invitation']);
  assert.equal(same.code, 1); assert.match(same.out, /already has an account or invitation/); assert.match(same.out, /Nothing was changed/);
  assert.equal((await mongo.db(DB).collection('users').findOne({ email: 'owner@jarc.example' })).status, 'invited', 'unchanged after refusal');
  const replaced = await run('admin-bootstrap.cjs', ['--email', 'owner2@jarc.example', '--confirm-db', DB, '--replace-invitation']);
  assert.equal(replaced.code, 0, replaced.out); assert.match(replaced.out, /Disabled the pending Admin invitation for owner@jarc\.example/);
  const users = mongo.db(DB).collection('users');
  assert.equal((await users.findOne({ email: 'owner@jarc.example' })).status, 'disabled');
  assert.equal((await users.findOne({ email: 'owner2@jarc.example' })).status, 'invited');
  // Once an Admin has signed in (is active), bootstrap refuses even with --replace-invitation.
  await users.updateOne({ email: 'owner2@jarc.example' }, { $set: { status: 'active', entraObjectId: 'oid-owner2', tenantId: 't' } });
  const refused = await run('admin-bootstrap.cjs', ['--email', 'owner3@jarc.example', '--confirm-db', DB, '--replace-invitation']);
  assert.equal(refused.code, 1); assert.match(refused.out, /already has an active Admin/);
  assert.equal(await users.countDocuments({ email: 'owner3@jarc.example' }), 0);
});
