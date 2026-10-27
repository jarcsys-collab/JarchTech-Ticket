// In-app notifications, stored per workspace (My workspace: "notifications"; beta simulation: "beta_notifications").
// Who receives them is decided by an addressing scheme:
//   simulated (beta)  admin, developer:<test identity> (the assigned worker: a sample developer, or the Admin test
//                     identity when the Admin view assigned the work to itself), requestor:sample, member:<userId>.
//                     Simulated inboxes are never real people found by name, and are never emailed.
//   accounts (mine)   user:<userId> for the requestor and the assigned worker, and "admins", the shared inbox read by
//                     every active Admin account (checked when read, so a role change applies at once).
// Each notification is one document per inbox and record version (or reminder stage), with a unique key, so retries,
// repeated saves, and repeated reminder runs never duplicate it. Read state is per signed-in member (readBy). The
// acting inbox is never notified, and the actor's copy of any other inbox starts as read.
const { ObjectId } = require('mongodb');
const WorkflowCore = require('../../public/workflow-core.js');
const { HttpError } = require('../http.cjs');

const ADMIN = 'admin', SAMPLE_REQUESTOR = 'requestor:sample', ADMINS = 'admins';
const PAGE = 20, MAX_PAGE = 50, MAX_TEXT = 280;
const ID = /^[0-9a-f]{24}$/;
const developerInbox = name => `developer:${name}`;
const requestorInbox = t => (t.requester && !t.requester.sample && t.requester.id ? `member:${t.requester.id}` : SAMPLE_REQUESTOR);

// Simulated inboxes for the beta workspace; the simulated view is chosen per request.
const simulated = {
  inboxesFor(user, view) {
    if (view === 'Admin') return [ADMIN, developerInbox(WorkflowCore.SIM_ADMIN)];
    if (view === 'Developer') return [developerInbox(WorkflowCore.SAMPLE_DEVELOPER)];
    if (view === 'Requestor') return [SAMPLE_REQUESTOR, `member:${user._id}`];
    throw new HttpError(400, 'invalid-view');
  },
  label: (user, view) => ({ Admin: `Admin inbox (simulated) · work assigned to ${WorkflowCore.SIM_ADMIN} (Admin test identity)`, Developer: `Developer inbox · ${WorkflowCore.SAMPLE_DEVELOPER} (sample developer)`, Requestor: 'Requestor inbox · sample requests and your own requests' }[view]),
  resolve: (to, ticket, before) => ({ admin: ADMIN, requestor: requestorInbox(ticket), developer: ticket.dev ? developerInbox(ticket.dev) : null, 'previous-developer': before && before.dev ? developerInbox(before.dev) : null }[to]),
  own: (actor, view, ticket) => new Set(view === 'Requestor' ? [requestorInbox(ticket)] : simulated.inboxesFor(actor, view))
};
// Real accounts for My workspace. The view is the capacity the actor acted in (Admin, Developer, or Requestor).
const accounts = {
  inboxesFor: user => [`user:${user._id}`, ...(user.role === 'Admin' ? [ADMINS] : [])],
  label: user => (user.role === 'Admin' ? 'Your notifications and the shared Admin inbox' : 'Your notifications'),
  resolve: (to, ticket, before) => ({
    admin: ADMINS,
    requestor: ticket.requester && ticket.requester.id ? `user:${ticket.requester.id}` : null,
    developer: ticket.devId ? `user:${ticket.devId}` : null,
    'previous-developer': before && before.devId && before.devId !== ticket.devId ? `user:${before.devId}` : null
  }[to]),
  own: (actor, view) => new Set([`user:${actor._id}`, ...(view === 'Admin' ? [ADMINS] : [])])
};

// Who hears about a ticket action: [{ type, title, to: ['admin' | 'requestor' | 'developer' | 'previous-developer'] }].
// 'developer' is the assigned worker (a Developer, or an Admin who assigned the work to themselves).
function ticketEvents(before, after, action, input = {}) {
  const e = (type, title, ...to) => ({ type, title, to });
  switch (action) {
    case 'created': return [e('submitted', 'New request submitted', 'admin')];
    case 'comment': return [e('comment', 'New comment', 'admin', 'requestor', 'developer')];
    case 'assign': {
      const out = [e('assigned', before.dev === after.dev ? 'Assignment updated' : 'Assigned to you', 'developer'), e('assigned', before.dev === after.dev ? 'Priority updated' : 'Worker assigned', 'requestor')];
      if (before.dev && before.dev !== after.dev) out.push(e('reassigned', 'Reassigned to someone else', 'previous-developer'));
      return out;
    }
    case 'reason': return {
      'Waiting for information': [e('info-requested', 'Information requested', 'requestor')],
      Rejected: [e('status', 'Request rejected', 'requestor', 'developer')],
      'On hold': [e('status', 'Put on hold', 'requestor', 'developer')],
      'In progress': [e('returned', 'Returned for correction: confirmations cleared', 'developer', 'admin', 'requestor')],
      Cancelled: [e('status', 'Request cancelled', 'admin', 'developer')]
    }[input.status] || [];
    case 'status': return {
      'Under review': before.status === 'Waiting for information' ? [e('status', 'Information provided', 'admin')] : [e('status', 'Under review', 'requestor')],
      'In progress': [e('status', 'Work started', 'requestor')],
      Released: [e('status', 'Released or handed over: ready for Admin closure', 'admin', 'requestor')],
      Closed: [e('status', 'Request closed', 'requestor', 'developer')]
    }[after.status] || [];
    case 'set-type': return [e('status', `Request type changed to ${after.type}`, 'requestor', 'developer')];
    case 'schedule-meeting': case 'edit-meeting': return [e('meeting', 'Meeting proposed: please confirm', 'requestor')];
    case 'confirm-meeting': return [e('meeting', 'Meeting confirmed', 'developer')];
    case 'record-agreement': return [e('agreement', 'Requirements agreement: please confirm', 'requestor')];
    case 'confirm-agreement': return after.agreements && after.agreements.length && !(before.agreements && before.agreements.length)
      ? [e('agreement', 'Agreement confirmed by both sides and locked', 'requestor', 'developer', 'admin')]
      : [e('agreement', 'Agreement confirmed by one side: yours is needed', 'requestor', 'developer')];
    case 'create-project': return [e('project', 'Project timeline created', 'requestor', 'admin')];
    case 'worker-complete': return [e('completion', 'Work marked done: please review the evidence and confirm', 'requestor')];
    case 'withdraw-completion': return [e('completion', 'Worker withdrew their completion', 'requestor')];
    case 'requestor-confirm': {
      const ready = after.status === 'Released' || (after.status === 'Ready for release' && after.type !== 'Project' && !(!after.type && after.project));
      return [e('completion', 'Requestor confirmed completion', 'developer'), ...(ready ? [e('completion', 'Both confirmations recorded: ready for closure', 'admin')] : [])];
    }
    default: return []; // task and evidence edits: visible in activity, no alert
  }
}
function changeEvents(change, action, input = {}) {
  const e = (type, title, ...to) => ({ type, title, to });
  switch (action) {
    case 'created': return [e('change', 'Scope change submitted', 'admin')];
    case 'status': return {
      Assessment: [e('change', 'Impact assessment requested', 'developer')],
      'In progress': [e('change', 'Change work started', 'requestor')],
      Accepted: [e('change', 'Change accepted', 'developer', 'admin')],
      Released: [e('change', 'Change released', 'admin', 'requestor')],
      Closed: [e('change', 'Change closed', 'requestor', 'developer')]
    }[change.status] || [];
    case 'assess': return [e('change', 'Scope change: your agreement is requested', 'requestor')];
    case 'agree': return [e('change', 'Scope change: approval requested', 'admin')];
    case 'approve': return [e('change', 'Scope change approved: new agreement version', 'developer', 'requestor')];
    case 'decision': return input.status === 'In progress'
      ? [e('returned', 'Change returned for correction', 'developer')]
      : [e('change', `Scope change ${String(input.status || '').toLowerCase()}`, 'requestor', 'developer')];
    case 'submit-test': return [e('acceptance', 'Change acceptance requested', 'requestor')];
    default: return [];
  }
}

// Resolves events to notification documents for one saved record version.
// ticket: the linked ticket after the save (for its requester and worker); before: the ticket before (assign).
function build({ events, record, kind, target, version, ticket, before, text, actor, view, at, workspace, addressing = simulated }) {
  const actorId = String(actor._id);
  const own = addressing.own(actor, view, ticket);
  const docs = [], seen = new Set();
  for (const ev of events) for (const to of ev.to) {
    const inbox = addressing.resolve(to, ticket, before);
    if (!inbox || own.has(inbox) || seen.has(inbox)) continue;
    seen.add(inbox);
    docs.push({
      workspace, key: `${record}:${version}:${inbox}`, inbox, type: ev.type, title: ev.title,
      text: String(text || '').slice(0, MAX_TEXT), record, kind, target, ticket: ticket.id,
      actorId, actorName: actor.displayName || actor.email, actorView: view, readBy: [actorId], createdAt: at
    });
  }
  return docs;
}

function createNotifications({ db, workspace, collection = 'beta_notifications', addressing = simulated, log = console, stamp }) {
  const notes = db.collection(collection);
  const toClient = (d, uid) => ({ id: d._id.toHexString(), type: d.type, title: d.title, text: d.text, record: d.record, kind: d.kind, target: d.target, ticket: d.ticket, actor: d.actorName || 'JarcTech Ticket', actorView: d.actorView || 'Reminder', reminder: Boolean(d.reminder), time: stamp(d.createdAt), at: d.createdAt, read: d.readBy.includes(uid) });

  // Inserts documents whose keys are not stored yet. Returns the inserted documents.
  async function insertNew(docs) {
    if (!docs.length) return [];
    const existing = new Set((await notes.find({ workspace, key: { $in: docs.map(d => d.key) } }, { projection: { key: 1 } }).toArray()).map(d => d.key));
    const fresh = docs.filter(d => !existing.has(d.key));
    if (!fresh.length) return [];
    try { await notes.insertMany(fresh, { ordered: false }); return fresh; }
    catch (err) {
      const errors = err.writeErrors ? [].concat(err.writeErrors) : [];
      if (err.code !== 11000 && !errors.every(w => (w.code ?? w.err?.code) === 11000)) throw err;
      const failed = new Set(errors.map(w => w.index ?? w.err?.index));
      return fresh.filter((d, i) => !failed.has(i)); // another instance stored the rest a moment ago
    }
  }

  // Stores notifications for a save that already succeeded. A failure here is logged, never undoes the save.
  async function deliver(args) {
    try { return await insertNew(build({ workspace, addressing, ...args })); }
    catch (err) { log.error(`Notifications not stored for ${args.record}: ${err.name}`); return []; }
  }

  // Reminder and escalation notifications from the scheduler. key identifies the reminder stage per inbox.
  async function remind(items, at) {
    const docs = [];
    for (const r of items) {
      const inbox = addressing.resolve(r.to, r.ticket);
      if (!inbox) continue;
      docs.push({ workspace, key: `${r.record}:reminder:${r.type}:${r.stage}:${inbox}`, inbox, type: r.type, title: r.title, text: `${r.record} · ${r.title}`.slice(0, MAX_TEXT), record: r.record, kind: r.kind, target: r.target, ticket: r.ticket.id, reminder: true, readBy: [], createdAt: at });
    }
    return insertNew(docs);
  }

  async function unread(user, view) {
    const uid = String(user._id);
    return notes.countDocuments({ workspace, inbox: { $in: addressing.inboxesFor(user, view) }, readBy: { $ne: uid } });
  }

  async function list(user, params) {
    const view = params.get('view'), uid = String(user._id);
    const inboxes = addressing.inboxesFor(user, view);
    const limit = params.get('limit') ? Number(params.get('limit')) : PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, 'invalid-limit');
    const filter = { workspace, inbox: { $in: inboxes } };
    if (params.get('before')) {
      const [at, id] = String(params.get('before')).split('_');
      if (!ID.test(id || '') || Number.isNaN(Date.parse(at))) throw new HttpError(400, 'invalid-cursor');
      filter.$or = [{ createdAt: { $lt: new Date(at) } }, { createdAt: new Date(at), _id: { $lt: new ObjectId(id) } }];
    }
    const docs = await notes.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];
    return { inbox: addressing.label(user, view), items: page.map(d => toClient(d, uid)), unread: await unread(user, view), next: docs.length > limit && last ? `${last.createdAt.toISOString()}_${last._id.toHexString()}` : null };
  }

  // Marks some (ids) or all notifications in the member's inboxes as read for this member only.
  async function markRead(user, body) {
    const uid = String(user._id);
    const filter = { workspace, inbox: { $in: addressing.inboxesFor(user, body.view) }, readBy: { $ne: uid } };
    if (body.all !== true) {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_PAGE || !body.ids.every(x => ID.test(String(x)))) throw new HttpError(400, 'invalid-ids');
      filter._id = { $in: body.ids.map(x => new ObjectId(x)) };
    }
    await notes.updateMany(filter, { $addToSet: { readBy: uid } });
    return { unread: await unread(user, body.view) };
  }

  const reset = async () => (await notes.deleteMany({ workspace })).deletedCount;

  return { deliver, remind, list, unread, markRead, reset };
}

module.exports = { ADMIN, ADMINS, SAMPLE_REQUESTOR, accounts, build, changeEvents, createNotifications, developerInbox, inboxesFor: simulated.inboxesFor, requestorInbox, simulated, ticketEvents };
