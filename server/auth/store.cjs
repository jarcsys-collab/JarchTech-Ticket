// Users, admission, sessions, and the audit log in MongoDB.
// Signing in with Microsoft never creates a user or grants a role: only an admin invitation (or the
// one-time bootstrap command) does.
const { ObjectId } = require('mongodb');
const { ROLES } = require('../schema.cjs');
const { randomToken, sha256 } = require('./tokens.cjs');

const IDLE_MS = 8 * 60 * 60 * 1000;
const ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class StoreError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const normalizeEmail = value => String(value || '').trim().toLowerCase();
const publicUser = u => ({ id: String(u._id), email: u.email, displayName: u.displayName || u.email, role: u.role, status: u.status, linked: Boolean(u.entraObjectId), lastSignInAt: u.lastSignInAt || null });

// Personal Microsoft accounts sign in through this fixed consumer tenant, or appear as guests whose home
// identity provider is live.com.
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const isPersonalAccount = claims => /(^|\/\/)live\.com\b/i.test(String(claims.idp || '')) || String(claims.idp || '').includes(CONSUMER_TENANT);
// The only role ever given automatically (tenant-members policy). It is a constant, never read from a claim.
const AUTO_ADMIT_ROLE = 'Requestor';

// Guests (B2B) carry an `idp` claim naming their home identity provider, or `acct` = 1 when that optional claim is enabled.
function isGuest(claims, tenantId) {
  if (claims.acct === 1 || claims.acct === '1') return true;
  if (!claims.idp) return false;
  return claims.idp !== claims.iss && claims.idp !== `https://sts.windows.net/${tenantId}/`;
}

function createStore(db, { now = () => new Date() } = {}) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const events = db.collection('events');
  const record = (type, { actorId = null, subjectId = null, ...details } = {}) => events.insertOne({ type, at: now(), actorId, subjectId, ...details });

  // Decides whether a verified Microsoft sign-in may use the app. Returns { user } or { denied: reason }.
  // accessPolicy 'invite-only': only invited people. 'tenant-members': members of the configured tenant
  // without an account are added as Requestor. Roles are never taken from sign-in claims in either policy.
  async function admit(claims, tenantId, { accessPolicy = 'invite-only' } = {}) {
    const deny = async (reason, extra = {}) => { await record('signin.denied', { reason, entraObjectId: claims.oid || null, ...extra }); return { denied: reason }; };
    if (String(claims.tid || '').toLowerCase() === CONSUMER_TENANT) return deny('personal-account');
    if (String(claims.tid || '').toLowerCase() !== tenantId) return deny('wrong-tenant');
    if (!claims.oid) return deny('missing-identity');
    if (isGuest(claims, tenantId)) return deny(isPersonalAccount(claims) ? 'personal-account' : 'guest');

    let user = await users.findOne({ tenantId, entraObjectId: claims.oid });
    const email = normalizeEmail(claims.email || claims.preferred_username);
    if (!user && accessPolicy === 'tenant-members') {
      const result = await admitMember(claims, tenantId, email);
      if (result.denied) return deny(result.denied, { email: email || null });
      user = result.user;
    }
    if (!user && EMAIL.test(email)) {
      // First sign-in of an invited person: bind the invitation to the permanent Entra object ID, once.
      const at = now();
      user = await users.findOneAndUpdate(
        { email, status: 'invited', entraObjectId: null },
        { $set: { tenantId, entraObjectId: claims.oid, status: 'active', displayName: claims.name || email, activatedAt: at, updatedAt: at } },
        { returnDocument: 'after' }
      );
      if (user) await record('user.activated', { subjectId: user._id, email });
    }
    if (!user) {
      const byEmail = EMAIL.test(email) ? await users.findOne({ email }) : null;
      return deny(byEmail && byEmail.status === 'disabled' ? 'disabled' : 'not-invited', { email: email || null });
    }
    if (user.status !== 'active') return deny(user.status === 'disabled' ? 'disabled' : 'not-invited', { email: user.email });
    const at = now();
    await users.updateOne({ _id: user._id }, { $set: { lastSignInAt: at, displayName: claims.name || user.displayName, updatedAt: at } });
    await record('signin.success', { subjectId: user._id });
    return { user: { ...user, displayName: claims.name || user.displayName } };
  }

  // Tenant-members policy, for a verified member with no account linked to their object ID yet.
  // An existing invitation for their email is honoured with its invited role. Otherwise a new account is
  // created as Requestor (always: no claim can choose the role). A disabled or conflicting record with the
  // same email is never bypassed.
  async function admitMember(claims, tenantId, email) {
    if (!EMAIL.test(email)) return { denied: 'missing-identity' };
    const existing = await users.findOne({ email });
    if (existing) {
      if (existing.status === 'disabled') return { denied: 'disabled' };
      if (existing.entraObjectId) return { denied: 'account-conflict' }; // same email, different Microsoft account
      return { user: null }; // an invitation: bound below exactly as in invite-only mode
    }
    const at = now();
    const doc = { email, role: AUTO_ADMIT_ROLE, status: 'active', displayName: claims.name || email, tenantId, entraObjectId: claims.oid, invitedBy: null, autoAdmitted: true, createdAt: at, updatedAt: at, activatedAt: at, lastSignInAt: null };
    try {
      const { insertedId } = await users.insertOne(doc);
      doc._id = insertedId;
    } catch (err) {
      if (err.code !== 11000) throw err;
      // A simultaneous first sign-in created it a moment ago: use that record if it is this account.
      const raced = await users.findOne({ tenantId, entraObjectId: claims.oid });
      return raced ? { user: raced } : { denied: 'account-conflict' };
    }
    await record('user.auto-admitted', { subjectId: doc._id, email, role: AUTO_ADMIT_ROLE });
    return { user: doc };
  }

  // A new random session per sign-in. Only its SHA-256 hash is stored.
  async function createSession(userId) {
    const token = randomToken(32);
    const at = now();
    await sessions.insertOne({ _id: sha256(token), userId, createdAt: at, lastSeenAt: at, expiresAt: new Date(at.getTime() + IDLE_MS), absoluteExpiresAt: new Date(at.getTime() + ABSOLUTE_MS) });
    return token;
  }

  // Returns { session, user } for a valid, unexpired session of an active user; otherwise null (and removes it).
  async function getSession(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const id = sha256(token);
    const session = await sessions.findOne({ _id: id });
    if (!session) return null;
    const at = now();
    if (at >= session.expiresAt || at >= session.absoluteExpiresAt) { await sessions.deleteOne({ _id: id }); return null; }
    const user = await users.findOne({ _id: session.userId });
    if (!user || user.status !== 'active') { await sessions.deleteOne({ _id: id }); return null; }
    if (at - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(Math.min(at.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime()));
      await sessions.updateOne({ _id: id }, { $set: { lastSeenAt: at, expiresAt } });
    }
    return { session, user };
  }

  const deleteSession = token => token ? sessions.deleteOne({ _id: sha256(token) }) : null;

  async function listUsers() {
    return (await users.find({}, { sort: { email: 1 } }).toArray()).map(publicUser);
  }

  async function inviteUser({ email, role, displayName }, actor) {
    email = normalizeEmail(email);
    if (!EMAIL.test(email)) throw new StoreError(400, 'invalid-email');
    if (!ROLES.includes(role)) throw new StoreError(400, 'invalid-role');
    const at = now();
    const doc = { email, role, status: 'invited', displayName: String(displayName || '').trim().slice(0, 120) || email, tenantId: null, entraObjectId: null, invitedBy: actor ? actor._id : null, createdAt: at, updatedAt: at, activatedAt: null, lastSignInAt: null };
    try { const { insertedId } = await users.insertOne(doc); doc._id = insertedId; }
    catch (err) { if (err.code === 11000) throw new StoreError(409, 'already-exists'); throw err; }
    await record('user.invited', { actorId: actor ? actor._id : null, subjectId: doc._id, email, role });
    return publicUser(doc);
  }

  // Role and status changes by an Admin. Admins cannot change themselves, and the last active Admin stays.
  async function updateUser(id, changes, actor) {
    let _id;
    try { _id = new ObjectId(String(id)); } catch { throw new StoreError(404, 'not-found'); }
    const set = {};
    if ('role' in changes) { if (!ROLES.includes(changes.role)) throw new StoreError(400, 'invalid-role'); set.role = changes.role; }
    if ('status' in changes) { if (!['active', 'disabled'].includes(changes.status)) throw new StoreError(400, 'invalid-status'); set.status = changes.status; }
    if (!Object.keys(set).length) throw new StoreError(400, 'nothing-to-change');
    if (actor._id.equals(_id)) throw new StoreError(403, 'cannot-change-self');
    const target = await users.findOne({ _id });
    if (!target) throw new StoreError(404, 'not-found');
    if (set.status === 'active' && target.status === 'invited') throw new StoreError(409, 'invitation-not-accepted');
    // Re-enabling someone who never signed in restores their invitation; only a sign-in can make them active.
    if (set.status === 'active' && !target.entraObjectId) set.status = 'invited';
    const losesAdmin = target.role === 'Admin' && target.status === 'active' && ((set.role && set.role !== 'Admin') || set.status === 'disabled');
    if (losesAdmin && await users.countDocuments({ role: 'Admin', status: 'active', _id: { $ne: _id } }) === 0) throw new StoreError(409, 'last-admin');
    await users.updateOne({ _id }, { $set: { ...set, updatedAt: now() } });
    if (set.status === 'disabled') await sessions.deleteMany({ userId: _id });
    await record('user.updated', { actorId: actor._id, subjectId: _id, changes: set, previous: { role: target.role, status: target.status } });
    return publicUser({ ...target, ...set });
  }

  // The person's own settings (currently only email reminders, which are off unless they turn them on).
  async function setPreferences(user, { emailReminders }) {
    await users.updateOne({ _id: user._id }, { $set: { emailReminders: emailReminders === true, updatedAt: now() } });
    await record('user.preferences', { actorId: user._id, subjectId: user._id, emailReminders: emailReminders === true });
  }

  return { setPreferences, admit, createSession, getSession, deleteSession, listUsers, inviteUser, updateUser, publicUser, record };
}

module.exports = { ABSOLUTE_MS, AUTO_ADMIT_ROLE, CONSUMER_TENANT, IDLE_MS, StoreError, createStore, isGuest };
