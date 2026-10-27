// Versioned, repeatable, reversible migration: gives every existing request an explicit request type.
//   npm run db:migrate-request-types -- --confirm-db <MONGODB_DB_NAME> [--dry-run]
//   npm run db:migrate-request-types -- --confirm-db <MONGODB_DB_NAME> --revert [--dry-run]
// Records with a linked project become Projects; all others become Tickets. Applies to My workspace (tickets) and the
// shared beta simulation (beta_tickets), when those collections exist. Nothing else changes: ids, history, owners,
// assignments, dates, and attachments are preserved. Each classified record gets typeSource (this migration's id), a
// new version (so an open page refreshes before saving over it), and an activity note saying what was set and why.
// Running it again only classifies records that still have no type. --revert removes only the types this migration
// set and that nobody has changed since (an Admin's later type change clears typeSource), with an activity note.
// Every run that changes records is written to the audit log (migration.request-types).
const { runDbCommand } = require('./db-command.cjs');

const MIGRATION = '2026-10-request-type-v1';
const TARGETS = [['tickets', 'My workspace'], ['beta_tickets', 'Beta simulation']];
const stamp = at => at.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const note = (text, at) => ({ text, time: stamp(at), at, actor: 'JarcTech Ticket (data migration)', view: 'System' });

runDbCommand('Usage: npm run db:migrate-request-types -- --confirm-db <database-name> [--revert] [--dry-run]', async (db, args, name) => {
  const revert = Boolean(args.revert), dry = Boolean(args['dry-run']);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const summary = {};
  console.log(`${dry ? 'Dry run: ' : ''}${revert ? 'Reverting' : 'Applying'} ${MIGRATION} in database ${name}.`);
  for (const [collection, label] of TARGETS) {
    if (!existing.has(collection)) { console.log(`- ${label}: no ${collection} collection, skipped.`); continue; }
    const records = db.collection(collection);
    const docs = await records.find(revert ? { typeSource: MIGRATION } : { type: { $exists: false } }, { projection: { _id: 1, id: 1, project: 1, version: 1, type: 1 } }).toArray();
    const counts = { Ticket: 0, Project: 0, reverted: 0, skipped: 0 };
    for (const d of docs) {
      const type = typeof d.project === 'string' && d.project ? 'Project' : 'Ticket';
      if (dry) { counts[revert ? 'reverted' : type]++; continue; }
      const at = new Date();
      // Each write applies only to the version that was read, so a record saved meanwhile is left for the next run.
      const { modifiedCount } = revert
        ? await records.updateOne({ _id: d._id, version: d.version, typeSource: MIGRATION }, { $unset: { type: '', typeSource: '' }, $inc: { version: 1 }, $set: { updatedAt: at }, $push: { history: note(`Request type classification removed (migration ${MIGRATION} reverted).`, at) } })
        : await records.updateOne({ _id: d._id, version: d.version, type: { $exists: false } }, { $set: { type, typeSource: MIGRATION, updatedAt: at }, $inc: { version: 1 }, $push: { history: note(`Request type set to ${type} (existing record ${type === 'Project' ? 'with' : 'without'} a linked project; migration ${MIGRATION}).`, at) } });
      if (modifiedCount) counts[revert ? 'reverted' : type]++; else counts.skipped++;
    }
    summary[collection] = counts;
    console.log(`- ${label} (${collection}): ${revert ? `${counts.reverted} reverted` : `${counts.Project} Project, ${counts.Ticket} Ticket`}${counts.skipped ? `, ${counts.skipped} changed meanwhile (run again)` : ''}${dry ? ' (not written)' : ''}.`);
  }
  const changed = Object.values(summary).some(c => c.Ticket || c.Project || c.reverted);
  if (!dry && changed) await db.collection('events').insertOne({ type: 'migration.request-types', at: new Date(), actorId: null, subjectId: null, migration: MIGRATION, direction: revert ? 'revert' : 'apply', summary });
  console.log(dry ? 'Nothing was written.' : changed ? 'Done. Recorded in the audit log.' : 'Done. Nothing needed changing.');
});
