// Collections, validators, and indexes for sign-in and the shared beta workspace. Created only by the explicit
// `npm run db:setup` command; the running server never creates or changes them, it only checks (read-only) that they exist.
const { isDeepStrictEqual } = require('node:util');
const { statuses: TICKET_STATUSES } = require('../public/ticket-core.js');
const { CHANGE_STATUSES } = require('../public/workflow-core.js');

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
  },
  // Shared beta simulation workspace (BETA_SIMULATION=enabled): test tickets with their projects, tasks, comments,
  // and activity, and linked scope changes. Kept apart from sign-in data and from any future real ticket records.
  beta_tickets: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['workspace', 'id', 'title', 'status', 'priority', 'tasks', 'history', 'requester', 'version', 'createdAt', 'updatedAt'],
      properties: {
        workspace: { enum: ['beta'] },
        id: { bsonType: 'string', pattern: '^JRC-[0-9]+$' },
        title: { bsonType: 'string', maxLength: 150 },
        status: { enum: TICKET_STATUSES },
        priority: { enum: ['Low', 'Medium', 'High', 'Critical'] },
        tasks: { bsonType: 'array', maxItems: 200 },
        history: { bsonType: 'array', maxItems: 2000 },
        requester: { bsonType: 'object', required: ['name', 'sample'] },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        requestId: { bsonType: 'string' },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' }
      }
    } },
    indexes: [
      { key: { workspace: 1, id: 1 }, name: 'workspace_id', unique: true },
      { key: { workspace: 1, requestId: 1 }, name: 'workspace_request', unique: true, partialFilterExpression: { requestId: { $type: 'string' } } },
      // List search: newest first, optionally narrowed by status, developer, or the member's own requests.
      { key: { workspace: 1, createdAt: -1, id: -1 }, name: 'workspace_created' },
      { key: { workspace: 1, status: 1, createdAt: -1 }, name: 'workspace_status_created' },
      { key: { workspace: 1, dev: 1, createdAt: -1 }, name: 'workspace_dev_created' },
      { key: { workspace: 1, 'requester.id': 1 }, name: 'workspace_requester' }
    ]
  },
  beta_changes: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['workspace', 'id', 'ticket', 'title', 'status', 'history', 'version', 'createdAt', 'updatedAt'],
      properties: {
        workspace: { enum: ['beta'] },
        id: { bsonType: 'string', pattern: '^CR-[0-9]+$' },
        ticket: { bsonType: 'string', pattern: '^JRC-[0-9]+$' },
        title: { bsonType: 'string', maxLength: 150 },
        status: { enum: CHANGE_STATUSES },
        history: { bsonType: 'array', maxItems: 2000 },
        version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
        requestId: { bsonType: 'string' },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' }
      }
    } },
    indexes: [
      { key: { workspace: 1, id: 1 }, name: 'workspace_id', unique: true },
      { key: { workspace: 1, requestId: 1 }, name: 'workspace_request', unique: true, partialFilterExpression: { requestId: { $type: 'string' } } },
      { key: { workspace: 1, ticket: 1 }, name: 'workspace_ticket' }
    ]
  },
  // Beta attachment records (server/beta/attachments.cjs). File bytes live in the beta-only GridFS bucket below.
  beta_attachments: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['workspace', 'name', 'ext', 'size', 'state', 'uploadedBy', 'uploadedAt'],
      properties: {
        workspace: { enum: ['beta'] },
        name: { bsonType: 'string', minLength: 1, maxLength: 120 },
        ext: { bsonType: 'string', maxLength: 5 },
        size: { bsonType: ['int', 'long', 'double'], minimum: 1, maximum: 10485760 },
        state: { enum: ['pending', 'claimed', 'attached'] },
        uploadedBy: { bsonType: 'string' },
        uploadedAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
        ticket: nullable('string')
      }
    } },
    indexes: [
      { key: { workspace: 1, state: 1, expiresAt: 1 }, name: 'workspace_state_expires' },
      { key: { workspace: 1, uploadedBy: 1, state: 1 }, name: 'workspace_uploader_state' },
      { key: { workspace: 1, ticket: 1 }, name: 'workspace_ticket' },
      { key: { claim: 1 }, name: 'claim', partialFilterExpression: { claim: { $type: 'string' } } }
    ]
  },
  // In-app notifications (server/beta/notifications.cjs): one per simulated inbox and record version; readBy holds
  // the signed-in members who have read it.
  beta_notifications: {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['workspace', 'key', 'inbox', 'type', 'title', 'record', 'kind', 'readBy', 'createdAt'],
      properties: {
        workspace: { enum: ['beta'] },
        key: { bsonType: 'string' },
        inbox: { bsonType: 'string', pattern: '^(admin|requestor:sample|developer:.+|member:[0-9a-f]{24})$' },
        title: { bsonType: 'string', maxLength: 150 },
        text: { bsonType: 'string', maxLength: 300 },
        record: { bsonType: 'string', pattern: '^(JRC|CR)-[0-9]+$' },
        kind: { enum: ['ticket', 'change'] },
        readBy: { bsonType: 'array', maxItems: 5000 },
        createdAt: { bsonType: 'date' }
      }
    } },
    indexes: [
      { key: { workspace: 1, key: 1 }, name: 'workspace_key', unique: true },
      { key: { workspace: 1, inbox: 1, createdAt: -1, _id: -1 }, name: 'workspace_inbox_created' }
    ]
  },
  // GridFS bucket for beta attachment bytes. Index names match the ones the MongoDB driver expects, so it never
  // creates its own.
  'beta_files.files': {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['length', 'filename', 'uploadDate', 'metadata'],
      properties: { metadata: { bsonType: 'object', required: ['workspace', 'uploadedBy'], properties: { workspace: { enum: ['beta'] } } } }
    } },
    indexes: [
      { key: { filename: 1, uploadDate: 1 }, name: 'filename_1_uploadDate_1' },
      { key: { 'metadata.workspace': 1, uploadDate: 1 }, name: 'workspace_uploaded' }
    ]
  },
  'beta_files.chunks': {
    validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['files_id', 'n', 'data'],
      properties: { files_id: { bsonType: 'objectId' }, n: { bsonType: 'int', minimum: 0 }, data: { bsonType: 'binData' } }
    } },
    indexes: [{ key: { files_id: 1, n: 1 }, name: 'files_id_1_n_1', unique: true }]
  }
};
// Sign-in needs the core collections; the beta workspace needs its own only when BETA_SIMULATION is enabled.
const CORE_COLLECTIONS = ['users', 'sessions', 'events'];
const BETA_COLLECTIONS = ['beta_tickets', 'beta_changes', 'beta_attachments', 'beta_notifications', 'beta_files.files', 'beta_files.chunks'];

// Idempotent: creates missing collections and indexes and refreshes validators. Returns a summary of actions.
async function ensureSchema(db) {
  // Full listing (not nameOnly) so an unchanged validator is left alone: collMod needs more than readWrite rights.
  const existing = new Map((await db.listCollections({}).toArray()).map(c => [c.name, c.options || {}]));
  const actions = [];
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    const current = existing.get(name);
    if (current && isDeepStrictEqual(current.validator, spec.validator) && current.validationLevel === 'strict' && current.validationAction === 'error') actions.push(`validator unchanged: ${name}`);
    else if (current) { await db.command({ collMod: name, validator: spec.validator, validationLevel: 'strict', validationAction: 'error' }); actions.push(`validator updated: ${name}`); }
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

// Read-only: lists what is missing from the named collections (sign-in collections by default). Empty means ready.
async function missingSchema(db, names = CORE_COLLECTIONS) {
  const missing = [];
  for (const [name, spec] of Object.entries(COLLECTIONS).filter(([n]) => names.includes(n))) {
    let names;
    try { names = new Set((await db.collection(name).indexes()).map(i => i.name)); }
    catch (err) { if (err.codeName === 'NamespaceNotFound' || err.code === 26) { missing.push(name); continue; } throw err; }
    for (const index of spec.indexes) if (!names.has(index.name)) missing.push(`${name}.${index.name}`);
  }
  return missing;
}

module.exports = { BETA_COLLECTIONS, COLLECTIONS, CORE_COLLECTIONS, ROLES, STATUSES, ensureSchema, missingSchema };
