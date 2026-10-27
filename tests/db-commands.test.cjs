// npm run db:setup, admin:bootstrap, and db:migrate-request-types, run as real processes against a temporary MongoDB.
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
  const res = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--object-id', 'oid-owner', '--confirm-db', DB]);
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

test('admin:bootstrap moves only the identified, signed-in account to Admin, bound to its Microsoft identity, once', async () => {
  const users = mongo.db(DB).collection('users');
  const noEmail = await run('admin-bootstrap.cjs', ['--confirm-db', DB]);
  assert.equal(noEmail.code, 2); assert.match(noEmail.out, /--email is required/);
  const noIdentity = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB]);
  assert.equal(noIdentity.code, 2); assert.match(noIdentity.out, /--object-id is required/);
  const missing = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--object-id', 'oid-owner', '--confirm-db', DB]);
  assert.equal(missing.code, 1); assert.match(missing.out, /no account.*sign in to JarcTech Ticket once/s);
  // The owner, as under the earlier role model: the only Developer.
  await users.insertMany([member('owner@jarc.example', 'oid-owner', { role: 'Developer' }), member('other@jarc.example', null, { status: 'invited', entraObjectId: null }), member('off@jarc.example', 'oid-off', { status: 'disabled' }), member('dev@jarc.example', 'oid-dev', { role: 'Developer' })]);
  for (const email of ['other@jarc.example', 'off@jarc.example']) {
    const res = await run('admin-bootstrap.cjs', ['--email', email, '--object-id', 'oid-off', '--confirm-db', DB]);
    assert.equal(res.code, 1, email); assert.match(res.out, /Only an active account that has signed in can be promoted/);
  }
  const wrongIdentity = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB, '--object-id', 'oid-someone-else']);
  assert.equal(wrongIdentity.code, 1); assert.match(wrongIdentity.out, /different Microsoft account/);
  const wrongRole = await run('admin-bootstrap.cjs', ['--email', 'owner@jarc.example', '--confirm-db', DB, '--object-id', 'oid-owner', '--from', 'Requestor']);
  assert.equal(wrongRole.code, 1); assert.match(wrongRole.out, /is Developer, not Requestor/);
  const before = await users.findOne({ email: 'owner@jarc.example' });
  const ok = await run('admin-bootstrap.cjs', ['--email', 'Owner@JARC.example', '--confirm-db', DB, '--object-id', 'oid-owner', '--from', 'Developer']);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Promoted owner@jarc\.example \(Microsoft object ID oid-owner\) from Developer to Admin/);
  const after = await users.findOne({ email: 'owner@jarc.example' });
  assert.deepEqual({ ...after, role: before.role, updatedAt: before.updatedAt }, before, 'only the role (and updatedAt) changed: same id, identity, and everything else');
  assert.equal(after.role, 'Admin');
  assert.deepEqual((await users.find({ email: { $ne: 'owner@jarc.example' } }).toArray()).map(u => `${u.email}:${u.role}`).sort(), ['dev@jarc.example:Developer', 'off@jarc.example:Requestor', 'other@jarc.example:Requestor'], 'no other account changed');
  const event = await mongo.db(DB).collection('events').findOne({ type: 'admin.bootstrapped' });
  assert.deepEqual([event.entraObjectId, event.previousRole, String(event.subjectId)], ['oid-owner', 'Developer', String(before._id)]);
  const again = await run('admin-bootstrap.cjs', ['--email', 'dev@jarc.example', '--object-id', 'oid-dev', '--confirm-db', DB]);
  assert.equal(again.code, 1); assert.match(again.out, /already has an active Admin/);
});

test('db:migrate-request-types classifies existing records explicitly, repeatably, and reversibly', async () => {
  const fresh = 'jarctech_commands_migrate_test';
  const env = { MONGODB_DB_NAME: fresh };
  assert.equal((await run('db-setup.cjs', ['--confirm-db', fresh], env)).code, 0);
  const tickets = mongo.db(fresh).collection('tickets');
  const doc = (id, extra) => ({ workspace: 'main', id, title: id, status: 'In progress', priority: 'Low', tasks: [], history: [{ text: 'Submitted' }], requester: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'R' }, version: 3, createdAt: new Date(), updatedAt: new Date(), ...extra });
  await tickets.insertMany([doc('JRC-2001', { project: 'PRJ-2001' }), doc('JRC-2002', {}), doc('JRC-2003', { type: 'Ticket', project: 'PRJ-2003' })]);
  const dry = await run('migrate-request-types.cjs', ['--confirm-db', fresh, '--dry-run'], env);
  assert.equal(dry.code, 0, dry.out); assert.match(dry.out, /1 Project, 1 Ticket \(not written\)/);
  assert.equal(await tickets.countDocuments({ type: { $exists: true } }), 1, 'a dry run writes nothing');
  const ok = await run('migrate-request-types.cjs', ['--confirm-db', fresh], env);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /My workspace \(tickets\): 1 Project, 1 Ticket/);
  const [p, t, kept] = await tickets.find({}, { sort: { id: 1 } }).toArray();
  assert.deepEqual([p.type, t.type, kept.type], ['Project', 'Ticket', 'Ticket'], 'linked projects become Projects; an existing type is kept');
  assert.deepEqual([p.version, p.history.length, p.history[0].text, p.id, p.project], [4, 2, 'Submitted', 'JRC-2001', 'PRJ-2001'], 'history and identifiers preserved, one note added');
  assert.match(p.history[1].text, /Request type set to Project/);
  const again = await run('migrate-request-types.cjs', ['--confirm-db', fresh], env);
  assert.match(again.out, /Nothing needed changing/); assert.equal((await tickets.findOne({ id: 'JRC-2001' })).version, 4, 'repeatable');
  await tickets.updateOne({ id: 'JRC-2002' }, { $set: { type: 'Project' }, $unset: { typeSource: '' } }); // an Admin changed it since
  const revert = await run('migrate-request-types.cjs', ['--confirm-db', fresh, '--revert'], env);
  assert.equal(revert.code, 0, revert.out); assert.match(revert.out, /1 reverted/);
  assert.deepEqual((await tickets.find({}, { sort: { id: 1 } }).toArray()).map(x => x.type), [undefined, 'Project', 'Ticket'], "only the migration's own classifications are removed");
  assert.equal(await mongo.db(fresh).collection('events').countDocuments({ type: 'migration.request-types' }), 2, 'audited');
});

test('database command errors never print the connection string', async () => {
  const secret = 'Cmd-Secret-Pw-123';
  const res = await run('db-setup.cjs', ['--confirm-db', DB], { MONGODB_URI: `mongodb://cmd_user:${secret}@127.0.0.1:1/?serverSelectionTimeoutMS=500` });
  assert.equal(res.code, 1);
  assert.ok(!res.out.includes(secret) && !res.out.includes('cmd_user'), res.out);
});

test('admin:bootstrap --invite (invite-only sign-in) creates one Admin invitation, bound at first sign-in', async () => {
  const fresh = 'jarctech_commands_invite_test';
  const env = { MONGODB_DB_NAME: fresh };
  assert.equal((await run('db-setup.cjs', ['--confirm-db', fresh], env)).code, 0);
  const ok = await run('admin-bootstrap.cjs', ['--email', 'lead@jarc.example', '--confirm-db', fresh, '--invite'], env);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /Invited lead@jarc\.example as the first Admin/);
  const user = await mongo.db(fresh).collection('users').findOne({ email: 'lead@jarc.example' });
  assert.deepEqual({ role: user.role, status: user.status, entraObjectId: user.entraObjectId }, { role: 'Admin', status: 'invited', entraObjectId: null });
  const second = await run('admin-bootstrap.cjs', ['--email', 'lead2@jarc.example', '--confirm-db', fresh, '--invite'], env);
  assert.equal(second.code, 1); assert.match(second.out, /pending Admin invitation/);
  assert.equal(await mongo.db(fresh).collection('users').countDocuments(), 1);
});
