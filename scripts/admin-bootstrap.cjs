// One-time creation of the first Admin, run deliberately by the owner. Nobody becomes Admin by signing in.
//   npm run admin:bootstrap -- --email <work-email> --confirm-db <MONGODB_DB_NAME>
// creates an Admin invitation; the person becomes active on their first Microsoft sign-in with that work email.
//   npm run admin:bootstrap -- --email <work-email> --confirm-db <MONGODB_DB_NAME> --promote-existing
// promotes an existing account instead (for example someone admitted as a Requestor under the tenant-members policy),
// only if it is active and has signed in. Either form refuses once an active Admin exists.
// Refuses if an Admin already exists. If the only Admins are invitations nobody has accepted yet (for example a
// mistyped email), --replace-invitation disables those pending invitations and creates the new one. It never
// touches an Admin who has signed in.
const { fail, runDbCommand } = require('./db-command.cjs');
const { missingSchema } = require('../server/schema.cjs');
const { createStore } = require('../server/auth/store.cjs');

const usage = 'Usage: npm run admin:bootstrap -- --email <work-email> --confirm-db <database-name> [--replace-invitation | --promote-existing]';

runDbCommand(usage, async (db, args, name) => {
  if (typeof args.email !== 'string') throw fail(`--email is required.\n${usage}`, 2);
  const missing = await missingSchema(db);
  if (missing.length) throw fail(`The sign-in collections are not set up in ${name}. Run npm run db:setup -- --confirm-db ${name} first.`);
  const users = db.collection('users');
  if (await users.countDocuments({ role: 'Admin', status: 'active' })) {
    throw fail(`Refusing: database ${name} already has an active Admin. Further Admins are invited from the Users screen by an existing Admin.`);
  }
  const email = args.email.trim().toLowerCase();
  const existing = await users.findOne({ email });
  const store = createStore(db);
  if (existing && args['promote-existing']) {
    if (existing.status !== 'active' || !existing.entraObjectId) throw fail(`Refusing: ${email} is ${existing.status}${existing.entraObjectId ? '' : ' and has not signed in'}. Only an active account that has signed in can be promoted. Nothing was changed.`);
    const { modifiedCount } = await users.updateOne({ _id: existing._id, status: 'active' }, { $set: { role: 'Admin', updatedAt: new Date() } });
    if (!modifiedCount) throw fail('Refusing: the account changed while promoting it. Nothing was changed.');
    await store.record('admin.bootstrapped', { subjectId: existing._id, email, promotedFrom: existing.role });
    console.log(`Promoted ${email} from ${existing.role} to Admin in database ${name}. The change applies to their open sessions at once.`);
    return;
  }
  if (existing) throw fail(`Refusing: ${email} already has an account or invitation (${existing.role}, ${existing.status}) in ${name}. Nothing was changed.${existing.status === 'active' && existing.entraObjectId ? ' To make this existing account the first Admin, run again with --promote-existing.' : ''}`);
  if (args['promote-existing']) throw fail(`Refusing: ${email} has no account in ${name} to promote. Run without --promote-existing to invite them as Admin. Nothing was changed.`);
  const pending = await users.find({ role: 'Admin', status: 'invited' }, { projection: { email: 1 } }).toArray();
  if (pending.length) {
    if (!args['replace-invitation']) {
      throw fail(`Refusing: database ${name} already has a pending Admin invitation for ${pending.map(u => u.email).join(', ')} that nobody has accepted yet. To replace it (for example after a typo), run again with --replace-invitation.`);
    }
    await users.updateMany({ _id: { $in: pending.map(u => u._id) }, status: 'invited', entraObjectId: null }, { $set: { status: 'disabled', updatedAt: new Date() } });
    for (const u of pending) await store.record('admin.invitation-replaced', { subjectId: u._id, email: u.email });
    console.log(`Disabled the pending Admin invitation for ${pending.map(u => u.email).join(', ')}.`);
  }
  const user = await store.inviteUser({ email: args.email, role: 'Admin' }, null);
  await store.record('admin.bootstrapped', { subjectId: null, email: user.email });
  console.log(`Invited ${user.email} as the first Admin in database ${name}.`);
  console.log('They become active the first time they sign in with that Microsoft work account. No other users were created.');
});
