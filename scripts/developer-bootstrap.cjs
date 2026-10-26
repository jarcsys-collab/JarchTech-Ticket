// One-time setup of the first Developer (the highest app role, and the only one that manages users), run deliberately
// by the owner. Nobody becomes a Developer by signing in, and nothing here compares against a built-in email.
//   npm run developer:bootstrap -- --email <work-email> --confirm-db <MONGODB_DB_NAME> [--object-id <entra-object-id>]
// promotes an existing account that is active and has signed in with Microsoft. The privilege is bound to that
// account, which is identified by its permanent Microsoft Entra object ID (tenant + oid), not by the email: the
// email only finds the account, and the promotion applies only if the account still has the same object ID.
// --object-id additionally requires the account to have exactly that object ID.
//   npm run developer:bootstrap -- --email <work-email> --confirm-db <MONGODB_DB_NAME> --invite
// is for invite-only sign-in, where nobody can sign in before being invited: it creates a Developer invitation that is
// bound to the person's Microsoft object ID at their first sign-in. Both forms refuse once an active Developer exists.
const { fail, runDbCommand } = require('./db-command.cjs');
const { missingSchema } = require('../server/schema.cjs');
const { createStore } = require('../server/auth/store.cjs');

const usage = 'Usage: npm run developer:bootstrap -- --email <work-email> --confirm-db <database-name> [--object-id <entra-object-id> | --invite]';

runDbCommand(usage, async (db, args, name) => {
  if (typeof args.email !== 'string') throw fail(`--email is required.\n${usage}`, 2);
  const missing = await missingSchema(db);
  if (missing.length) throw fail(`The sign-in collections are not set up in ${name}. Run npm run db:setup -- --confirm-db ${name} first.`);
  const users = db.collection('users');
  if (await users.countDocuments({ role: 'Developer', status: 'active' })) {
    throw fail(`Refusing: database ${name} already has an active Developer. Further roles are managed on the Users screen by a Developer. Nothing was changed.`);
  }
  const email = args.email.trim().toLowerCase();
  const store = createStore(db);
  const account = await users.findOne({ email });

  if (args.invite) {
    if (account) throw fail(`Refusing: ${email} already has an account (${account.role}, ${account.status}). Run without --invite to promote it. Nothing was changed.`);
    if (await users.countDocuments({ role: 'Developer', status: 'invited' })) throw fail(`Refusing: ${name} already has a pending Developer invitation. Nothing was changed.`);
    const user = await store.inviteUser({ email, role: 'Developer' }, null);
    await store.record('developer.bootstrapped', { subjectId: null, email: user.email, invited: true });
    console.log(`Invited ${user.email} as the first Developer in ${name}. The role is bound to their Microsoft account at their first sign-in with that email.`);
    return;
  }

  if (!account) throw fail(`Refusing: ${email} has no account in ${name}. Ask them to sign in to JarcTech Ticket once (they start as a Requestor), then run this again. Nothing was changed.`);
  if (account.status !== 'active' || !account.entraObjectId) throw fail(`Refusing: ${email} is ${account.status}${account.entraObjectId ? '' : ' and has not signed in with Microsoft'}. Only an active account that has signed in can be promoted. Nothing was changed.`);
  if (typeof args['object-id'] === 'string' && args['object-id'].trim().toLowerCase() !== String(account.entraObjectId).toLowerCase()) {
    throw fail(`Refusing: ${email} is linked to a different Microsoft account than --object-id. Nothing was changed.`);
  }
  // Bound to the verified identity: applies only if the account still has the same Microsoft object ID and state.
  const { modifiedCount } = await users.updateOne(
    { _id: account._id, status: 'active', role: account.role, tenantId: account.tenantId, entraObjectId: account.entraObjectId },
    { $set: { role: 'Developer', updatedAt: new Date() } }
  );
  if (!modifiedCount) throw fail('Refusing: the account changed while promoting it. Nothing was changed.');
  await store.record('developer.bootstrapped', { subjectId: account._id, email, entraObjectId: account.entraObjectId, previousRole: account.role });
  console.log(`Promoted ${email} (Microsoft object ID ${account.entraObjectId}) from ${account.role} to Developer in ${name}.`);
  console.log('This applies to their open sessions at once. They can now manage users and roles on the Users screen.');
});
