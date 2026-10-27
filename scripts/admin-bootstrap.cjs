// One-time setup of the first Admin (the role that manages users and roles), run deliberately by the owner. Nobody
// becomes an Admin by signing in, and nothing here compares against a built-in email.
//   npm run admin:bootstrap -- --email <work-email> --object-id <entra-object-id> --confirm-db <MONGODB_DB_NAME> [--from <current-role>]
// promotes one existing account that is active and has signed in with Microsoft. The privilege is bound to that
// account's permanent Microsoft Entra identity (tenant + object ID): the email only finds the account, --object-id
// must match the identity stored for it, and the update applies only if the account still has that identity, role,
// and status. --from additionally requires the account's current role (for example Developer, when moving the owner
// from the earlier role model). The account keeps its id, identity, sessions, records, and ownership; only the role
// changes, and the change is recorded in the audit log (admin.bootstrapped, with the previous role).
//   npm run admin:bootstrap -- --email <work-email> --confirm-db <MONGODB_DB_NAME> --invite
// is for invite-only sign-in, where nobody can sign in before being invited: it creates an Admin invitation that is
// bound to the person's Microsoft object ID at their first sign-in. Both forms refuse once an active Admin exists.
const { fail, runDbCommand } = require('./db-command.cjs');
const { missingSchema, ROLES } = require('../server/schema.cjs');
const { createStore } = require('../server/auth/store.cjs');

const usage = 'Usage: npm run admin:bootstrap -- --email <work-email> --object-id <entra-object-id> --confirm-db <database-name> [--from <current-role>]\n   or: npm run admin:bootstrap -- --email <work-email> --confirm-db <database-name> --invite';

runDbCommand(usage, async (db, args, name) => {
  if (typeof args.email !== 'string') throw fail(`--email is required.\n${usage}`, 2);
  if (!args.invite && typeof args['object-id'] !== 'string') throw fail(`--object-id is required: the account's Microsoft Entra object ID, which binds the role to that identity.\n${usage}`, 2);
  if (args.from !== undefined && !ROLES.includes(args.from)) throw fail(`--from must be one of ${ROLES.join(', ')}.\n${usage}`, 2);
  const missing = await missingSchema(db);
  if (missing.length) throw fail(`The sign-in collections are not set up in ${name}. Run npm run db:setup -- --confirm-db ${name} first.`);
  const users = db.collection('users');
  if (await users.countDocuments({ role: 'Admin', status: 'active' })) {
    throw fail(`Refusing: database ${name} already has an active Admin. Further roles are managed on the Users screen by an Admin. Nothing was changed.`);
  }
  const email = args.email.trim().toLowerCase();
  const store = createStore(db);
  const account = await users.findOne({ email });

  if (args.invite) {
    if (account) throw fail(`Refusing: ${email} already has an account (${account.role}, ${account.status}). Run without --invite to promote it. Nothing was changed.`);
    if (await users.countDocuments({ role: 'Admin', status: 'invited' })) throw fail(`Refusing: ${name} already has a pending Admin invitation. Nothing was changed.`);
    const user = await store.inviteUser({ email, role: 'Admin' }, null);
    await store.record('admin.bootstrapped', { subjectId: null, email: user.email, invited: true });
    console.log(`Invited ${user.email} as the first Admin in ${name}. The role is bound to their Microsoft account at their first sign-in with that email.`);
    return;
  }

  if (!account) throw fail(`Refusing: ${email} has no account in ${name}. Ask them to sign in to JarcTech Ticket once (they start as a Requestor), then run this again. Nothing was changed.`);
  if (account.status !== 'active' || !account.entraObjectId || !account.tenantId) throw fail(`Refusing: ${email} is ${account.status}${account.entraObjectId ? '' : ' and has not signed in with Microsoft'}. Only an active account that has signed in can be promoted. Nothing was changed.`);
  if (args['object-id'].trim().toLowerCase() !== String(account.entraObjectId).toLowerCase()) {
    throw fail(`Refusing: ${email} is linked to a different Microsoft account than --object-id. Nothing was changed.`);
  }
  if (await users.countDocuments({ tenantId: account.tenantId, entraObjectId: account.entraObjectId }) !== 1) throw fail('Refusing: that Microsoft identity is not linked to exactly one account. Nothing was changed.');
  if (args.from !== undefined && account.role !== args.from) throw fail(`Refusing: ${email} is ${account.role}, not ${args.from}. Nothing was changed.`);
  if (account.role === 'Admin') throw fail(`Refusing: ${email} is already an Admin but is not active. Nothing was changed.`);
  // Bound to the verified identity: applies only if the account still has the same Microsoft identity, role, and state.
  const { modifiedCount } = await users.updateOne(
    { _id: account._id, status: 'active', role: account.role, tenantId: account.tenantId, entraObjectId: account.entraObjectId },
    { $set: { role: 'Admin', updatedAt: new Date() } }
  );
  if (!modifiedCount) throw fail('Refusing: the account changed while promoting it. Nothing was changed.');
  await store.record('admin.bootstrapped', { subjectId: account._id, email, tenantId: account.tenantId, entraObjectId: account.entraObjectId, previousRole: account.role });
  console.log(`Promoted ${email} (Microsoft object ID ${account.entraObjectId}) from ${account.role} to Admin in ${name}.`);
  console.log('Its account id, sign-in identity, sessions, records, and ownership are unchanged. The new role applies to open sessions at once: they can now manage users and roles on the Users screen.');
});
