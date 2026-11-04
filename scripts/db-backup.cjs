// Recoverable logical backup of the configured database, into a new folder outside the repository. Reads only.
//   npm run db:backup -- --confirm-db <MONGODB_DB_NAME> --out <new-folder>
// The folder holds real account data: keep it private and out of Git. Sign-in sessions are not included.
//   npm run db:backup -- --verify <folder>      checks a backup's files against its manifest (no database needed)
const path = require('node:path');
const { backup, verifyBackup } = require('./db-snapshot.cjs');

const usage = 'Usage: npm run db:backup -- --confirm-db <database-name> --out <new-folder>\n   or: npm run db:backup -- --verify <folder>';
const verifyAt = process.argv.indexOf('--verify');

if (verifyAt >= 0) {
  verifyBackup(process.argv[verifyAt + 1] || '').then(m => {
    console.log(`Backup verified: ${m.database}, taken ${m.createdAt}.`);
    for (const [name, e] of Object.entries(m.collections)) console.log(`- ${name}: ${e.count} document(s)`);
  }).catch(err => { console.error(err.message); process.exitCode = 1; });
} else {
  const { fail, runDbCommand } = require('./db-command.cjs');
  runDbCommand(usage, async (db, args, name) => {
    if (typeof args.out !== 'string') throw fail(`--out is required.\n${usage}`, 2);
    const dir = path.resolve(args.out);
    if (dir.startsWith(path.resolve(__dirname, '..') + path.sep)) throw fail('Refusing: choose a folder outside this repository, so account data cannot reach Git.', 2);
    const manifest = await backup(db, name, dir);
    await verifyBackup(dir);
    console.log(`Backup of ${name} written and verified: ${dir}`);
    for (const [c, e] of Object.entries(manifest.collections)) console.log(`- ${c}: ${e.count} document(s), ${e.bytes} bytes compressed`);
    console.log('Keep this folder private. It holds real account data. Sign-in sessions are not included.');
  });
}
