// Collections, validators, and indexes for sign-in. Created only by the explicit `npm run db:setup` command;
// the running server never creates or changes them, it only checks (read-only) that they exist.

const ROLES = ['Requestor', 'Admin', 'Developer'];
const STATUSES = ['invited', 'active', 'disabled'];
const nullable = type => ({ bsonType: [type, 'null'] });

const COLLECTIONS = {
  users: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['email', 'role', 'status', 'createdAt', 'updatedAt'],
      properties: {
        email: { bsonType: 'string', pattern: '^[^A-Z\\s@]+@[^A-Z\\s@]+$' },
        displayName: { bsonType: 'string' },
        role: { enum: ROLES },
        status: { enum: STATUSES },
        tenantId: nullable('string'),
        entraObjectId: nullable('string'),
        invitedBy: nullable('objectId'),
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        activatedAt: nullable('date'),
        lastSignInAt: nullable('date')
      }
    } },
    indexes: [
      { key: { email: 1 }, name: 'email_unique', unique: true },
      { key: { tenantId: 1, entraObjectId: 1 }, name: 'entra_identity_unique', unique: true, partialFilterExpression: { entraObjectId: { $type: 'string' } } }
    ]
  },
  sessions: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'userId', 'createdAt', 'lastSeenAt', 'expiresAt', 'absoluteExpiresAt'],
      properties: {
        _id: { bsonType: 'string' }, // SHA-256 of the cookie value; the cookie value itself is never stored
        userId: { bsonType: 'objectId' },
        createdAt: { bsonType: 'date' },
        lastSeenAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
        absoluteExpiresAt: { bsonType: 'date' }
      }
    } },
    indexes: [
      { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
      { key: { userId: 1 }, name: 'user' }
    ]
  },
  events: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['type', 'at'],
      properties: { type: { bsonType: 'string' }, at: { bsonType: 'date' }, actorId: nullable('objectId'), subjectId: nullable('objectId') }
    } },
    indexes: [{ key: { at: -1 }, name: 'at' }, { key: { subjectId: 1, at: -1 }, name: 'subject_at' }]
  }
};

// Idempotent: creates missing collections and indexes and refreshes validators. Returns a summary of actions.
async function ensureSchema(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const actions = [];
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (existing.has(name)) { await db.command({ collMod: name, validator: spec.validator, validationLevel: 'strict', validationAction: 'error' }); actions.push(`validator updated: ${name}`); }
    else { await db.createCollection(name, { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' }); actions.push(`collection created: ${name}`); }
    const names = new Set((await db.collection(name).indexes()).map(i => i.name));
    for (const { key, ...options } of spec.indexes) {
      if (names.has(options.name)) continue;
      await db.collection(name).createIndex(key, options);
      actions.push(`index created: ${name}.${options.name}`);
    }
  }
  return actions;
}

// Read-only: lists what is missing. An empty list means the schema is ready.
async function missingSchema(db) {
  const missing = [];
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    let names;
    try { names = new Set((await db.collection(name).indexes()).map(i => i.name)); }
    catch (err) { if (err.codeName === 'NamespaceNotFound' || err.code === 26) { missing.push(name); continue; } throw err; }
    for (const index of spec.indexes) if (!names.has(index.name)) missing.push(`${name}.${index.name}`);
  }
  return missing;
}

module.exports = { COLLECTIONS, ROLES, STATUSES, ensureSchema, missingSchema };
