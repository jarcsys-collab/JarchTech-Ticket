// npm run db:setup and npm run developer:bootstrap, run as real processes against a temporary MongoDB.
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

test('developer:bootstrap refuses before db:setup', async () => {
  const res = await run('developer-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB]);
  assert.equal(res.code, 1); assert.match(res.out, /Run npm run db:setup/);
});

test('db:setup creates the sign-in collections and indexes, idempotently, with no users', async () => {
  const first = await run('db-setup.cjs', ['--confirm-db', DB]);
  assert.equal(first.code, 0, first.out); assert.match(first.out, /collection created: users/); assert.match(first.out, /No users or records were created/);
  assert.deepEqual(await collections(), ['attachments', 'beta_attachments', 'beta_changes', 'beta_files.chunks', 'beta_files.files', 'beta_notifications', 'beta_tickets', 'email_outbox', 'events', 'files.chunks', 'files.files', 'notifications', 'scheduler_locks', 'sessions', 'ticket_changes', 'tickets', 'users']);
  const names = (await mongo.db(DB).collection('users').indexes()).map(i => i.name).sort();
  assert.deepEqual(names, ['_id_', 'email_unique', 'entra_identity_unique']);
  const sessionIndexes = await mongo.db(DB).collection('sessions').indexes();
  assert.equal(sessionIndexes.find(i => i.name === 'expires_ttl').expireAfterSeconds, 0);
  const again = await run('db-setup.cjs', ['--confirm-db', DB]);
  assert.equal(again.code, 0); assert.doesNotMatch(again.out, /(collection|index) created/); assert.match(again.out, /validator unchanged: users/); assert.doesNotMatch(again.out, /validator updated/);
  assert.equal(await mongo.db(DB).collection('users').countDocuments(), 0);
  await assert.rejects(mongo.db(DB).collection('users').insertOne({ email: 'x@jarc.example', role: 'Owner', status: 'active', createdAt: new Date(), updatedAt: new Date() }), /Document failed validation/);
});

// A signed-in member as created by tenant-members admission: active, Requestor, linked to a Microsoft object ID.
const member = (email, oid, extra = {}) => ({ email, role: 'Requestor', status: 'active', displayName: email, tenantId: 't', entraObjectId: oid, invitedBy: null, createdAt: new Date(), updatedAt: new Date(), activatedAt: new Date(), lastSignInAt: new Date(), ...extra });

test('developer:bootstrap promotes only an identified, signed-in account, bound to its Microsoft identity, once', async () => {
  const users = mongo.db(DB).collection('users');
  const noEmail = await run('developer-bootstrap.cjs', ['--confirm-db', DB]);
  assert.equal(noEmail.code, 2); assert.match(noEmail.out, /--email is required/);
  const missing = await run('developer-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB]);
  assert.equal(missing.code, 1); assert.match(missing.out, /no account.*sign in to JarcTech Ticket once/s);
  await users.insertMany([member('owner@jarc.example', 'oid-owner'), member('other@jarc.example', null, { status: 'invited', entraObjectId: null }), member('off@jarc.example', 'oid-off', { status: 'disabled' })]);
  for (const email of ['other@jarc.example', 'off@jarc.example']) {
    const res = await run('developer-bootstrap.cjs', ['--email', email, '--confirm-db', DB]);
    assert.equal(res.code, 1, email); assert.match(res.out, /Only an active account that has signed in can be promoted/);
  }
  const wrongIdentity = await run('developer-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB, '--object-id', 'oid-someone-else']);
  assert.equal(wrongIdentity.code, 1); assert.match(wrongIdentity.out, /different Microsoft account/);
  const ok = await run('developer-bootstrap.cjs', ['--email', 'Owner@JARC.example', '--confirm-db', DB, '--object-id', 'oid-owner']);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Promoted owner@jarc\.example \(Microsoft object ID oid-owner\) from Requestor to Developer/);
  assert.equal((await users.findOne({ email: 'owner@jarc.example' })).role, 'Developer');
  assert.equal(await users.countDocuments({ role: 'Developer' }), 1, 'no other account changed');
  const event = await mongo.db(DB).collection('events').findOne({ type: 'developer.bootstrapped' });
  assert.equal(event.entraObjectId, 'oid-owner');
  const again = await run('developer-bootstrap.cjs', ['--email', 'other@jarc.example', '--confirm-db', DB, '--invite']);
  assert.equal(again.code, 1); assert.match(again.out, /already has an active Developer/);
});

test('database command errors never print the connection string', async () => {
  const secret = 'Cmd-Secret-Pw-123';
  const res = await run('db-setup.cjs', ['--confirm-db', DB], { MONGODB_URI: `mongodb://cmd_user:${secret}@127.0.0.1:1/?serverSelectionTimeoutMS=500` });
  assert.equal(res.code, 1);
  assert.ok(!res.out.includes(secret) && !res.out.includes('cmd_user'), res.out);
});

test('developer:bootstrap --invite (invite-only sign-in) creates one Developer invitation, bound at first sign-in', async () => {
  const fresh = 'jarctech_commands_invite_test';
  const env = { MONGODB_DB_NAME: fresh };
  assert.equal((await run('db-setup.cjs', ['--confirm-db', fresh], env)).code, 0);
  const ok = await run('developer-bootstrap.cjs', ['--email', 'lead@jarc.example', '--confirm-db', fresh, '--invite'], env);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Invited lead@jarc\.example as the first Developer/);
  const user = await mongo.db(fresh).collection('users').findOne({ email: 'lead@jarc.example' });
  assert.deepEqual({ role: user.role, status: user.status, entraObjectId: user.entraObjectId }, { role: 'Developer', status: 'invited', entraObjectId: null });
  const second = await run('developer-bootstrap.cjs', ['--email', 'lead2@jarc.example', '--confirm-db', fresh, '--invite'], env);
  assert.equal(second.code, 1); assert.match(second.out, /pending Developer invitation/);
  assert.equal(await mongo.db(fresh).collection('users').countDocuments(), 1);
});
