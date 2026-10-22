// Creates the sign-in collections (users, sessions, events) with validators and indexes. Safe to re-run.
//   npm run db:setup -- --confirm-db <MONGODB_DB_NAME>
const { runDbCommand } = require('./db-command.cjs');
const { ensureSchema } = require('../server/schema.cjs');

runDbCommand('Usage: npm run db:setup -- --confirm-db <database-name>', async (db, args, name) => {
  console.log(`Preparing sign-in collections in database ${name}...`);
  const actions = await ensureSchema(db);
  for (const action of actions) console.log(`- ${action}`);
  console.log('Done. No users or records were created.');
});
