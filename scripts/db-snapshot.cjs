// Shared by the backup, restore, and official-release commands. Logical snapshots of a database as gzip-compressed
// Extended JSON, one document per line, plus a manifest with document counts and content fingerprints. Everything
// here works with the app's own readWrite database user and needs no extra tools or paid backup plan.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { BSON } = require('mongodb');
const { EJSON } = BSON;

// Sign-in sessions are short-lived and left out: a restore simply asks people to sign in again.
const SKIPPED = ['sessions'];
const FORMAT = 1;
const BATCH = 200;

const serialize = doc => EJSON.stringify(doc, { relaxed: false });

// A fingerprint of one collection's documents, in _id order: { count, sha256 }. Reads only.
async function fingerprintCollection(db, name) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  for await (const doc of db.collection(name).find({}).sort({ _id: 1 })) {
    hash.update(serialize(doc)); hash.update('\n');
    count++;
  }
  return { count, sha256: hash.digest('hex') };
}
async function fingerprint(db, names) {
  const out = {};
  for (const name of names) out[name] = await fingerprintCollection(db, name);
  return out;
}
const listNames = async db => (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.')).sort();

// Writes <dir>/<collection>.ejson.gz for every collection and manifest.json last, so a manifest means a complete backup.
async function backup(db, dbName, dir, { now = new Date(), skip = SKIPPED } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error(`${dir} already holds a backup. Choose a new folder.`);
  const collections = {};
  for (const name of (await listNames(db)).filter(n => !skip.includes(n))) {
    const file = `${name}.ejson.gz`;
    const docHash = crypto.createHash('sha256');
    let count = 0;
    async function* lines() {
      for await (const doc of db.collection(name).find({}).sort({ _id: 1 })) {
        const text = serialize(doc);
        docHash.update(text); docHash.update('\n');
        count++;
        yield text + '\n';
      }
    }
    await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(path.join(dir, file)));
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
    const options = await db.listCollections({ name }).next();
    collections[name] = { file, count, sha256: docHash.digest('hex'), fileSha256: fileHash, bytes: fs.statSync(path.join(dir, file)).size, options: options ? options.options || {} : {}, indexes: await db.collection(name).indexes() };
  }
  const manifest = { format: FORMAT, database: dbName, createdAt: now.toISOString(), skipped: skip, collections };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`No manifest.json in ${dir}: this is not a complete backup.`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.format !== FORMAT) throw new Error(`Unknown backup format ${manifest.format}.`);
  return manifest;
}
async function* docsIn(dir, entry) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, entry.file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line;
}
// Checks every file against its manifest entry without touching any database. Throws on the first difference.
async function verifyBackup(dir) {
  const manifest = readManifest(dir);
  for (const [name, entry] of Object.entries(manifest.collections)) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, entry.file))).digest('hex');
    if (fileHash !== entry.fileSha256) throw new Error(`${entry.file} is damaged: its checksum does not match the manifest.`);
    const hash = crypto.createHash('sha256');
    let count = 0;
    for await (const line of docsIn(dir, entry)) { hash.update(line); hash.update('\n'); count++; }
    if (count !== entry.count || hash.digest('hex') !== entry.sha256) throw new Error(`${name}: the contents do not match the manifest.`);
  }
  return manifest;
}

// Restores a verified backup. Without replace, every target collection must be empty, so a restore can never overwrite
// data by accident. With replace, the listed collections are emptied first (their indexes and validators stay).
async function restore(db, dir, { replace = false, log = () => {} } = {}) {
  const manifest = await verifyBackup(dir);
  const existing = new Set(await listNames(db));
  const names = Object.keys(manifest.collections);
  if (!replace) {
    for (const name of names) {
      if (existing.has(name) && await db.collection(name).estimatedDocumentCount() > 0) throw new Error(`Refusing: ${name} already has records. Restore into an empty database, or pass --replace to replace these collections.`);
    }
  }
  const out = {};
  for (const name of names) {
    const entry = manifest.collections[name];
    if (!existing.has(name)) await db.createCollection(name, entry.options.validator ? { validator: entry.options.validator, validationLevel: entry.options.validationLevel, validationAction: entry.options.validationAction } : {});
    const collection = db.collection(name);
    if (replace) await collection.deleteMany({});
    const present = new Set((await collection.indexes()).map(i => i.name));
    for (const { v, ns, key, name: indexName, ...options } of entry.indexes) if (!present.has(indexName)) await collection.createIndex(key, { name: indexName, ...options });
    let batch = [], count = 0;
    const flush = async () => { if (batch.length) { await collection.insertMany(batch, { ordered: true, bypassDocumentValidation: true }); count += batch.length; batch = []; } };
    for await (const line of docsIn(dir, entry)) { batch.push(EJSON.parse(line, { relaxed: false })); if (batch.length >= BATCH) await flush(); }
    await flush();
    out[name] = count;
    log(`- ${name}: ${count} document(s)`);
  }
  const after = await fingerprint(db, names);
  for (const name of names) {
    if (after[name].count !== manifest.collections[name].count || after[name].sha256 !== manifest.collections[name].sha256) throw new Error(`${name} was restored but does not match the backup.`);
  }
  return { database: manifest.database, createdAt: manifest.createdAt, restored: out };
}

module.exports = { BETA_NAMES: ['beta_tickets', 'beta_changes', 'beta_attachments', 'beta_notifications', 'beta_files.files', 'beta_files.chunks'], SKIPPED, backup, fingerprint, listNames, readManifest, restore, verifyBackup };
