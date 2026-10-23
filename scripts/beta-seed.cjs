// Adds the sample records to the shared beta simulation workspace. Explicit and repeatable; the server never seeds
// or resets on its own. Refuses if the workspace already has records unless --replace is given, which replaces only
// the beta workspace records (beta_tickets and beta_changes with workspace "beta"). Accounts and sessions are untouched.
//   npm run beta:seed -- --confirm-db <MONGODB_DB_NAME> [--replace]
const { fail, runDbCommand } = require('./db-command.cjs');
const { BETA_COLLECTIONS, missingSchema } = require('../server/schema.cjs');
const { seedWorkspace } = require('../server/beta/index.cjs');

const usage = 'Usage: npm run beta:seed -- --confirm-db <database-name> [--replace]';

runDbCommand(usage, async (db, args, name) => {
  const missing = await missingSchema(db, BETA_COLLECTIONS);
  if (missing.length) throw fail(`The beta workspace collections are not set up in ${name}. Run npm run db:setup -- --confirm-db ${name} first.`);
  const result = await seedWorkspace(db, { replace: args.replace === true });
  if (!result.seeded) throw fail(`Refusing: the beta workspace in ${name} already has ${result.existing} record(s). Use --replace to replace only the beta workspace records with the samples.`);
  console.log(`Seeded the beta workspace in ${name}: ${result.tickets} sample tickets and ${result.changes} sample change(s)${result.removed ? `, replacing ${result.removed} existing beta record(s)` : ''}.`);
  console.log('Accounts, sessions, events, and other collections were not changed.');
});
