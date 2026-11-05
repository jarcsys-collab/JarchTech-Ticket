// Archiving and permanent deletion of past requests, for real Admin accounts in My workspace only (policy.retention).
// The beta simulation and its views never reach this: they have no such routes.
//
// Archive: the normal way to take a finished request out of active lists. It only sets `archived` on the request (and
// skips any queued reminder email); nothing is removed, and Restore takes it back. Records without the field are simply
// active, so existing records need no migration.
//
// Delete: removes the request with its project and tasks (both stored on the request), its scope changes, notifications,
// queued reminder email, and the files only it uses. A file a retained record also uses is kept, and handed to that
// record. A minimal audit entry stays: who, when, the IDs, and counts, never the content.
//
// Deletion spans several collections, so it is recoverable rather than transactional, like scope change effects: the
// request is first marked `deleting` (which hides it everywhere) with a summary, then the audit entry is written, then
// the linked records go, and the request itself last. If the process stops part-way, the next scheduler run finishes it.
const { randomUUID } = require('node:crypto');
const WorkflowCore = require('../../public/workflow-core.js');

const DELETED = 'request.deleted';
const MAX_LOG = 50;
const ACTIVE = Object.freeze({ archived: { $exists: false }, deleting: { $exists: false } });
const ARCHIVED = Object.freeze({ archived: { $exists: true }, deleting: { $exists: false } });
const number = id => Number(String(id).split('-')[1]) || 0;

function createRetention({ db, workspace, tickets, changes, notifications, outbox, files, helpers, canManage, recordEvent = async () => {}, log = console, now = () => new Date() }) {
  const { visibleTicket, settle, replaceIfCurrent, conflict, clone, entry, toClient, stamp, faults } = helpers;
  const events = db.collection('events');
  const notes = db.collection(notifications);
  const mail = outbox ? db.collection(outbox) : null;
  const refuse = (code, message) => new WorkflowCore.WorkflowError(code, message);

  // A visible request this account may manage. Someone who cannot see it gets "not found", as on every other route.
  async function managed(actor, id) {
    const t = await visibleTicket(actor, id);
    if (!canManage(actor)) throw refuse('forbidden', 'Only an Admin can archive, restore, or delete a request.');
    return t;
  }
  // Why a request cannot be archived or deleted yet. Open work and undecided scope changes must be finished first.
  async function blockers(t) {
    const out = [];
    if (!WorkflowCore.FINAL.includes(t.status)) out.push(`Only closed, rejected, or cancelled requests can be archived or deleted. This one is ${t.status}.`);
    const open = await changes.find({ workspace, ticket: t.id, status: { $nin: WorkflowCore.CHANGE_SETTLED } }, { projection: { id: 1 } }).toArray();
    for (const c of open) out.push(`Scope change ${c.id} is still open. Finish, defer, or reject it first.`);
    return out;
  }
  const keysOf = (t, cs) => new RegExp(`^(${[t.id, ...cs.map(c => c.id)].join('|')}):`);

  async function archive(actor, id, body) {
    await settle(id);
    const t = await managed(actor, id);
    if (t.archived) throw refuse('state', `${id} is already archived.`);
    if (body.version !== t.version) throw await conflict('tickets', id);
    const [problem] = await blockers(t);
    if (problem) throw refuse('state', problem);
    const at = now(), name = actor.displayName || actor.email;
    const next = clone(t);
    next.archived = { at, time: stamp(at), by: { id: String(actor._id), name } };
    if (next.history.length < 2000) next.history.push(entry('Archived: removed from active lists. Nothing was deleted.', actor, 'Admin', at, null, 'Admin'));
    if (!await replaceIfCurrent(tickets, t, next, at)) throw await conflict('tickets', id);
    const cs = await changes.find({ workspace, ticket: id }, { projection: { id: 1 } }).toArray();
    if (mail) await mail.updateMany({ status: 'pending', key: { $regex: keysOf(t, cs) } }, { $set: { status: 'skipped' } });
    await recordEvent('request.archived', { actorId: actor._id, ticket: id });
    return { tickets: [toClient(await tickets.findOne({ _id: t._id }))] };
  }

  async function restore(actor, id, body) {
    const t = await managed(actor, id);
    if (!t.archived) throw refuse('state', `${id} is not archived.`);
    if (body.version !== t.version) throw await conflict('tickets', id);
    const at = now();
    const next = clone(t);
    delete next.archived;
    if (next.history.length < 2000) next.history.push(entry('Restored from the archive.', actor, 'Admin', at, null, 'Admin'));
    if (!await replaceIfCurrent(tickets, t, next, at)) throw await conflict('tickets', id);
    await recordEvent('request.restored', { actorId: actor._id, ticket: id });
    return { tickets: [toClient(await tickets.findOne({ _id: t._id }))], changes: (await changes.find({ workspace, ticket: id }).toArray()).map(toClient) };
  }

  // Exactly what deleting this request would affect, for the confirmation. Changes nothing.
  async function preview(actor, id) {
    const t = await managed(actor, id);
    const cs = await changes.find({ workspace, ticket: id }, { projection: { id: 1, title: 1, status: 1 } }).toArray();
    const plan = await files.removalPlan(t);
    const problems = await blockers(t);
    return {
      id: t.id, title: t.title, type: WorkflowCore.typeOf(t), status: t.status, version: t.version, archived: Boolean(t.archived),
      project: t.project ? { id: t.project, name: t.projectName || t.title } : null,
      tasks: (t.tasks || []).map(x => x.title),
      changes: cs.map(c => ({ id: c.id, title: c.title, status: c.status })),
      attachments: { remove: plan.remove.map(d => ({ name: d.name, size: d.size })), keep: plan.keep.map(k => ({ name: k.doc.name, retainedBy: k.retainedBy })) },
      activity: (t.history || []).length,
      notifications: await notes.countDocuments({ workspace, ticket: id }),
      canDelete: !problems.length, blockers: problems
    };
  }

  // Finishes a marked deletion. Safe to repeat from any point: every step skips what is already gone.
  async function finish(t) {
    const { key, actor, at, summary } = t.deleting;
    // The audit entry comes first, so nothing is removed without one, and the number stays retired from then on.
    await events.updateOne({ type: DELETED, deletionKey: key }, { $setOnInsert: { at: new Date(at), actorId: actor.id, subjectId: null, actorName: actor.name, ...summary } }, { upsert: true });
    if (faults.beforeDeleteLinked) faults.beforeDeleteLinked();
    await files.removeForTicket(t);
    const cs = await changes.find({ workspace, ticket: t.id }, { projection: { id: 1 } }).toArray();
    await notes.deleteMany({ workspace, ticket: t.id });
    // Reminder email is addressed by record number; the numbers come from the summary if the changes are already gone.
    if (mail) await mail.deleteMany({ key: { $regex: new RegExp(`^(${[t.id, ...summary.changes, ...cs.map(c => c.id)].join('|')}):`) } });
    await changes.deleteMany({ workspace, ticket: t.id });
    if (faults.beforeDeleteRequest) faults.beforeDeleteRequest();
    await tickets.deleteOne({ _id: t._id });
  }

  async function remove(actor, id, body) {
    await settle(id);
    const t = await managed(actor, id);
    if (body.confirm !== t.id) throw refuse('invalid', `Type the request ID exactly (${t.id}) to delete it permanently.`);
    if (body.version !== t.version) throw await conflict('tickets', id);
    const [problem] = await blockers(t);
    if (problem) throw refuse('state', problem);
    const at = now();
    const cs = await changes.find({ workspace, ticket: id }, { projection: { id: 1 } }).toArray();
    const plan = await files.removalPlan(t);
    const summary = { ticket: t.id, requestType: WorkflowCore.typeOf(t), requestStatus: t.status, project: t.project || null, changes: cs.map(c => c.id), counts: { tasks: (t.tasks || []).length, changes: cs.length, filesRemoved: plan.remove.length, filesKept: plan.keep.length } };
    const next = clone(t);
    next.deleting = { key: randomUUID(), at, actor: { id: actor._id, name: actor.displayName || actor.email }, summary };
    if (!await replaceIfCurrent(tickets, t, next, at)) throw await conflict('tickets', id);
    await finish(await tickets.findOne({ _id: t._id }));
    log.log(`My workspace: a request was permanently deleted by an Admin (${t.id}).`);
    return { deleted: id, deletedChanges: summary.changes };
  }

  // Scheduler: finishes any deletion a restart interrupted.
  async function recover() {
    let finished = 0;
    for (const t of await tickets.find({ workspace, deleting: { $exists: true } }).toArray()) {
      try { await finish(t); finished++; }
      catch (err) { log.error(`${t.id}: an interrupted deletion could not finish yet (${err.name}); it will be retried.`); }
    }
    if (finished) log.log(`My workspace: finished ${finished} interrupted deletion(s).`);
    return finished;
  }

  // Numbers of deleted records stay retired, so an ID never comes to mean a different request.
  async function retiredNumbers(prefix) {
    const docs = await events.find({ type: DELETED }, { projection: { ticket: 1, changes: 1 } }).toArray();
    return docs.flatMap(d => (prefix === 'JRC' ? [d.ticket] : d.changes || [])).map(number);
  }

  // The audit entries, newest first. They hold no request content.
  async function deletions(actor) {
    if (!canManage(actor)) throw refuse('forbidden', 'Only an Admin can see the deletion log.');
    const docs = await events.find({ type: DELETED }).sort({ at: -1 }).limit(MAX_LOG).toArray();
    return { items: docs.map(d => ({ ticket: d.ticket, type: d.requestType, status: d.requestStatus, project: d.project, changes: d.changes, counts: d.counts, by: d.actorName, time: stamp(d.at), at: d.at })) };
  }

  return { archive, restore, preview, remove, recover, retiredNumbers, deletions };
}

module.exports = { ACTIVE, ARCHIVED, DELETED, createRetention };
