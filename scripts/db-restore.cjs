// Restores a backup made by db:backup into the configured database, and checks the result against the backup.
//   npm run db:restore -- --confirm-db <MONGODB_DB_NAME> --from <folder>             into an empty database
//   npm run db:restore -- --confirm-db <MONGODB_DB_NAME> --from <folder> --replace   replaces the backup's collections
// Without --replace it refuses if any target collection has records. --replace deletes those collections' current
// records first, so take a new backup before using it on a database in use. Validators and indexes are kept or recreated.
const path = require('node:path');
const { fail, runDbCommand } = require('./db-command.cjs');
const { restore } = require('./db-snapshot.cjs');

const usage = 'Usage: npm run db:restore -- --confirm-db <database-name> --from <folder> [--replace]';

runDbCommand(usage, async (db, args, name) => {
  if (typeof args.from !== 'string') throw fail(`--from is required.\n${usage}`, 2);
  console.log(`Restoring into ${name}...`);
  const result = await restore(db, path.resolve(args.from), { replace: args.replace === true, log: console.log });
  console.log(`Restored from the backup of ${result.database} taken ${result.createdAt}, and verified against it. Everyone signs in again if sessions were cleared.`);
});
