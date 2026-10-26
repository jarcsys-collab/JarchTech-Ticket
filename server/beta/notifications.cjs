// In-app notifications for the shared beta workspace, stored in beta_notifications.
// Recipients are simulated inboxes, never real people found by name:
//   admin                 the Admin view
//   developer:<name>      a sample developer (the Developer view acts as the first sample developer)
//   requestor:sample      the Requestor view's shared sample requests
//   member:<userId>       the signed-in member who submitted the request, seen in their own Requestor view
// Each notification is one document per inbox and record version (unique key), so retries and repeated saves never
// duplicate it. Read state is per signed-in member (readBy). The acting view's own inbox is never notified, and the
// actor's copy of any other inbox starts as read, so nobody gets an unread alert for their own action.
const { ObjectId } = require('mongodb');
const WorkflowCore = require('../../public/workflow-core.js');
const { HttpError } = require('../http.cjs');

const ADMIN = 'admin', SAMPLE_REQUESTOR = 'requestor:sample';
const PAGE = 20, MAX_PAGE = 50, MAX_TEXT = 280;
const ID = /^[0-9a-f]{24}$/;
const developerInbox = name => `developer:${name}`;
const requestorInbox = t => (t.requester && !t.requester.sample && t.requester.id ? `member:${t.requester.id}` : SAMPLE_REQUESTOR);

// The inboxes a member sees in a simulated view.
function inboxesFor(view, userId) {
  if (view === 'Admin') return [ADMIN];
  if (view === 'Developer') return [developerInbox(WorkflowCore.SAMPLE_DEVELOPER)];
  if (view === 'Requestor') return [SAMPLE_REQUESTOR, `member:${userId}`];
  throw new HttpError(400, 'invalid-view');
}
function inboxLabel(view) {
  return { Admin: 'Admin inbox (simulated)', Developer: `Developer inbox · ${WorkflowCore.SAMPLE_DEVELOPER} (sample developer)`, Requestor: 'Requestor inbox · sample requests and your own requests' }[view];
}

// Who hears about a ticket action: [{ type, title, to: ['admin' | 'requestor' | 'developer' | 'previous-developer'] }].
function ticketEvents(before, after, action, input = {}) {
  const e = (type, title, ...to) => ({ type, title, to });
  switch (action) {
    case 'created': return [e('submitted', 'New request submitted', 'admin')];
    case 'comment': return [e('comment', 'New comment', 'admin', 'requestor', 'developer')];
    case 'assign': {
      const out = [e('assigned', before.dev === after.dev ? 'Assignment updated' : 'Assigned to you', 'developer'), e('assigned', before.dev === after.dev ? 'Priority updated' : 'Developer assigned', 'requestor')];
      if (before.dev && before.dev !== after.dev) out.push(e('reassigned', 'Reassigned to another developer', 'previous-developer'));
      return out;
    }
    case 'reason': return {
      'Waiting for information': [e('info-requested', 'Information requested', 'requestor')],
      Rejected: [e('status', 'Request rejected', 'requestor', 'developer')],
      'On hold': [e('status', 'Put on hold', 'requestor', 'developer')],
      'In progress': [e('returned', 'Returned for correction', 'developer', 'admin')],
      Cancelled: [e('status', 'Request cancelled', 'admin', 'developer')]
    }[input.status] || [];
    case 'status': return {
      'Under review': before.status === 'Waiting for information' ? [e('status', 'Information provided', 'admin')] : [e('status', 'Under review', 'requestor')],
      'In progress': [e('status', 'Development started', 'requestor')],
      'Ready for release': [e('status', 'Delivery accepted', 'developer', 'admin')],
      Released: [e('status', 'Released', 'admin', 'requestor')],
      Closed: [e('status', 'Ticket closed', 'requestor', 'developer')]
    }[after.status] || [];
    case 'schedule-meeting': case 'edit-meeting': return [e('meeting', 'Meeting proposed: please confirm', 'requestor')];
    case 'confirm-meeting': return [e('meeting', 'Meeting confirmed', 'developer')];
    case 'create-project': return [e('project', 'Project created', 'requestor', 'admin')];
    case 'submit-acceptance': return [e('acceptance', 'Acceptance requested', 'requestor')];
    default: return []; // task and scope edits: visible in activity, no alert
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
    case 'approve': return [e('change', 'Scope change approved', 'developer', 'requestor')];
    case 'decision': return input.status === 'In progress'
      ? [e('returned', 'Change returned for correction', 'developer')]
      : [e('change', `Scope change ${String(input.status || '').toLowerCase()}`, 'requestor', 'developer')];
    case 'submit-test': return [e('acceptance', 'Change acceptance requested', 'requestor')];
    default: return [];
  }
}

// Resolves events to notification documents for one saved record version.
// ticket: the linked ticket after the save (for its requester and developer); before: the ticket before (assign).
function build({ events, record, kind, target, version, ticket, before, text, actor, view, at, workspace }) {
  const actorId = String(actor._id);
  const own = new Set(inboxesFor(view, actorId).filter(x => view !== 'Requestor' || x === requestorInbox(ticket)));
  const resolve = to => ({ admin: ADMIN, requestor: requestorInbox(ticket), developer: ticket.dev ? developerInbox(ticket.dev) : null, 'previous-developer': before && before.dev ? developerInbox(before.dev) : null }[to]);
  const docs = [], seen = new Set();
  for (const ev of events) for (const to of ev.to) {
    const inbox = resolve(to);
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

function createNotifications({ db, workspace, log = console, stamp }) {
  const notes = db.collection('beta_notifications');
  const toClient = (d, uid) => ({ id: d._id.toHexString(), type: d.type, title: d.title, text: d.text, record: d.record, kind: d.kind, target: d.target, ticket: d.ticket, actor: d.actorName, actorView: d.actorView, time: stamp(d.createdAt), at: d.createdAt, read: d.readBy.includes(uid) });

  // Stores notifications for a save that already succeeded. A failure here is logged, never undoes the save.
  async function deliver(args) {
    const docs = build({ workspace, ...args });
    if (!docs.length) return 0;
    try { return (await notes.insertMany(docs, { ordered: false })).insertedCount; }
    catch (err) {
      const dupes = (err.writeErrors ? [].concat(err.writeErrors) : []).every(w => (w.code ?? w.err?.code) === 11000);
      if (err.code !== 11000 && !dupes) log.error(`Beta notifications not stored for ${args.record}: ${err.name}`);
      return err.result?.insertedCount ?? 0;
    }
  }

  async function unread(user, view) {
    const uid = String(user._id);
    return notes.countDocuments({ workspace, inbox: { $in: inboxesFor(view, uid) }, readBy: { $ne: uid } });
  }

  async function list(user, params) {
    const view = params.get('view'), uid = String(user._id);
    const inboxes = inboxesFor(view, uid);
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
    return { inbox: inboxLabel(view), items: page.map(d => toClient(d, uid)), unread: await unread(user, view), next: docs.length > limit && last ? `${last.createdAt.toISOString()}_${last._id.toHexString()}` : null };
  }

  // Marks some (ids) or all notifications in the view's inboxes as read for this member only.
  async function markRead(user, body) {
    const uid = String(user._id);
    const inboxes = inboxesFor(body.view, uid);
    const filter = { workspace, inbox: { $in: inboxes }, readBy: { $ne: uid } };
    if (body.all !== true) {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_PAGE || !body.ids.every(x => ID.test(String(x)))) throw new HttpError(400, 'invalid-ids');
      filter._id = { $in: body.ids.map(x => new ObjectId(x)) };
    }
    await notes.updateMany(filter, { $addToSet: { readBy: uid } });
    return { unread: await unread(user, body.view) };
  }

  const reset = async () => (await notes.deleteMany({ workspace })).deletedCount;

  return { deliver, list, unread, markRead, reset };
}

module.exports = { ADMIN, SAMPLE_REQUESTOR, build, changeEvents, createNotifications, developerInbox, inboxLabel, inboxesFor, requestorInbox, ticketEvents };
