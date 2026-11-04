// The move from beta to official use, as an explicit, repeatable, data-preserving step. It changes no record:
// - checks that every collection and index the official app needs exists, and creates any that are missing (additions only);
// - fingerprints the beta collections and records that in the audit log (release.official), once;
// - run again, or with --verify, it recomputes the fingerprints and reports whether the beta records are still untouched.
// Beta records stay in their own collections, unread by the official app. Nothing is deleted, converted, or moved.
//   npm run db:official-release -- --confirm-db <MONGODB_DB_NAME> [--verify]
const { fail, runDbCommand } = require('./db-command.cjs');
const { BETA_NAMES, fingerprint } = require('./db-snapshot.cjs');
const { COLLECTIONS, missingSchema } = require('../server/schema.cjs');

const usage = 'Usage: npm run db:official-release -- --confirm-db <database-name> [--verify]';
const EVENT = 'release.official';

const compare = (recorded, now) => BETA_NAMES.filter(n => !recorded[n] || recorded[n].count !== now[n].count || recorded[n].sha256 !== now[n].sha256);

runDbCommand(usage, async (db, args, name) => {
  const events = db.collection('events');
  const missing = await missingSchema(db, Object.keys(COLLECTIONS));
  const prior = await events.findOne({ type: EVENT }, { sort: { at: 1 } });
  const now = await fingerprint(db, BETA_NAMES);

  if (args.verify === true) {
    if (!prior) throw fail(`${name} has no official release record yet. Run without --verify first.`);
    const changed = compare(prior.betaFingerprint, now);
    if (missing.length) console.log(`Schema: missing ${missing.join(', ')}.`); else console.log('Schema: everything the app needs exists.');
    for (const n of BETA_NAMES) console.log(`- ${n}: ${now[n].count} document(s)${changed.includes(n) ? ' CHANGED' : ', unchanged'}`);
    if (changed.length) throw fail(`Beta records changed since the release was recorded (${changed.join(', ')}).`);
    console.log(`Beta records in ${name} are unchanged since ${prior.at.toISOString()}.`);
    return;
  }

  // Additions only. A validator is never changed here: that needs more rights than the app's user, and none is needed.
  for (const entry of missing) {
    const [collection, index] = splitMissing(entry);
    if (!index) { await db.createCollection(collection, { validator: COLLECTIONS[collection].validator, validationLevel: 'strict', validationAction: 'error' }); console.log(`- created collection ${collection}`); }
    const specs = index ? COLLECTIONS[collection].indexes.filter(i => i.name === index) : COLLECTIONS[collection].indexes;
    for (const { key, ...options } of specs) { await db.collection(collection).createIndex(key, options); console.log(`- created index ${collection}.${options.name}`); }
  }
  if (await missingSchema(db, Object.keys(COLLECTIONS)).then(m => m.length)) throw fail('The schema is still incomplete. Nothing was recorded.');

  if (prior) {
    const changed = compare(prior.betaFingerprint, now);
    console.log(`Already recorded on ${prior.at.toISOString()}; nothing new to record.`);
    if (changed.length) throw fail(`Beta records changed since then (${changed.join(', ')}).`);
    console.log('Beta records are unchanged.');
    return;
  }
  await events.insertOne({ type: EVENT, at: new Date(), actorId: null, subjectId: null, betaFingerprint: now });
  for (const n of BETA_NAMES) console.log(`- ${n}: ${now[n].count} document(s) preserved`);
  console.log(`Recorded the official release in ${name}. No records were changed. Beta records stay separate and are not used by the official app.`);
});

// missingSchema reports "collection" or "collection.index"; collection names may contain dots (files.files).
function splitMissing(entry) {
  if (COLLECTIONS[entry]) return [entry, null];
  const name = Object.keys(COLLECTIONS).find(c => entry.startsWith(c + '.') && COLLECTIONS[c].indexes.some(i => `${c}.${i.name}` === entry));
  if (!name) throw fail(`Unexpected schema item: ${entry}`);
  return [name, entry.slice(name.length + 1)];
}
