// Server-stored ticket workspace engine, shared by My workspace (real accounts and roles, server/work) and the beta
// simulation (switchable views on shared test data, server/beta). A policy object decides who may see a record and
// in which capacity (Requestor, Admin, Developer) a member may act; everything else is common:
// - Every action is checked by WorkflowCore against that capacity and the record's current status before it is stored.
// - Every write carries the record version it was based on; a stale version is refused (409) instead of overwriting.
// - Creation requests carry a requestId, so a repeated submission returns the first result instead of a duplicate.
// - Activity entries record the signed-in actor and the capacity (view) they acted in.
// - Attachments are uploaded first, then added to a new request or a comment by id; downloads follow ticket access.
// - Saved actions notify the inboxes involved; search reads the records the member may see, page by page.
// - Records that a member may not see answer "not found", in every route (lists, search, details, files, actions).
const WorkflowCore = require('../../public/workflow-core.js');
const TL = require('../../public/timeline-core.js');
const ListFilter = require('../../public/list-filter.js');
const DeadlineCore = require('../../public/deadline-core.js');
const { HttpError, readJson, sendJson } = require('../http.cjs');
const { missingSchema } = require('../schema.cjs');
const { AttachmentError, createAttachments } = require('./attachments.cjs');
const { changeEvents, createNotifications, ticketEvents } = require('./notifications.cjs');

const MAX_NOTICES = 40;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const stampIn = timezone => date => date.toLocaleString('en-PH', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

class Conflict extends Error {
  constructor(message, payload) { super(message); this.payload = payload; }
}

// policy: see server/beta/index.cjs and server/work/index.cjs. settings: deadline settings (timezone, dueSoonDays).
function createWorkspace({ db, policy, log = console, now = () => new Date(), recordEvent = async () => {}, settings = DeadlineCore.DEFAULTS }) {
  const WORKSPACE = policy.workspace;
  const names = policy.names;
  const base = policy.base.replace(/[/]/g, '\\/');
  const ACTION_PATH = new RegExp(`^${base}\\/(tickets|changes)\\/((?:JRC|CR)-\\d{1,9})\\/actions$`);
  const CHANGE_CREATE_PATH = new RegExp(`^${base}\\/tickets\\/(JRC-\\d{1,9})\\/changes$`);
  const TICKET_PATH = new RegExp(`^${base}\\/tickets\\/(JRC-\\d{1,9})$`);
  const FILE_PATH = new RegExp(`^${base}\\/attachments\\/([0-9a-f]{24})$`);
  const DOWNLOAD_PATH = new RegExp(`^${base}\\/attachments\\/([0-9a-f]{24})\\/download$`);
  const stamp = stampIn(settings.timezone);
  const tickets = db.collection(names.tickets);
  const changes = db.collection(names.changes);
  const files = createAttachments({
    db, workspace: WORKSPACE, log, now,
    names: { attachments: names.attachments, bucket: names.bucket, tickets: names.tickets },
    canSeeTicket: async (actor, id) => { const t = id && await tickets.findOne({ workspace: WORKSPACE, id }); return Boolean(t && await policy.canSee(actor, t)); }
  });
  const notify = createNotifications({ db, workspace: WORKSPACE, collection: names.notifications, addressing: policy.addressing, log, stamp });
  const toClient = ({ _id, workspace, requestId, ...rest }) => rest;
  const entry = (text, actor, view, at, attachments) => ({ text, time: stamp(at), at, actor: actor.displayName || actor.email, actorId: String(actor._id), view, ...(attachments ? { attachments } : {}) });
  const withFiles = (text, claimed) => claimed ? `${text} (${claimed.list.length} attachment${claimed.list.length === 1 ? '' : 's'})` : text;
  const notFound = () => new HttpError(404, 'not-found');

  // A visible ticket by id, or 404 (also when it exists but this member may not see it).
  async function visibleTicket(user, id) {
    const t = await tickets.findOne({ workspace: WORKSPACE, id });
    if (!t || !await policy.canSee(user, t)) throw notFound();
    return t;
  }
  // Runs fn(ctx) for each capacity the member has on this ticket until one is allowed. Each try works on fresh copies,
  // so a refused capacity changes nothing. Reports the most useful refusal if none is allowed.
  function tryAs(contexts, fn) {
    let refusal = null;
    for (const ctx of contexts) {
      try { return { ctx, ...fn({ ...ctx, time: () => stamp(now()) }) }; }
      catch (err) {
        if (!(err instanceof WorkflowCore.WorkflowError)) throw err;
        if (!refusal || (refusal.code === 'forbidden' && err.code !== 'forbidden')) refusal = err;
      }
    }
    throw refusal || new WorkflowCore.WorkflowError('forbidden', 'This action is not available to you.');
  }

  async function notices(filter) {
    const ts = await tickets.find({ workspace: WORKSPACE, ...filter }, { projection: { id: 1, history: 1 } }).toArray();
    const cs = await changes.find({ workspace: WORKSPACE, ticket: { $in: ts.map(t => t.id) } }, { projection: { id: 1, history: 1 } }).toArray();
    return [...ts, ...cs]
      .flatMap(d => d.history.map((h, i) => ({ text: `${d.id} · ${h.text}`, time: h.time, at: h.at ? new Date(h.at).getTime() : 0, i })))
      .sort((a, b) => b.at - a.at || b.i - a.i)
      .slice(0, MAX_NOTICES)
      .map(({ text, time }) => ({ text, time }));
  }
  // Everything this member may see, for the dashboard and details. (Lists are searched page by page.)
  async function workspace(user) {
    const filter = await policy.visible(user);
    const ts = await tickets.find({ workspace: WORKSPACE, ...filter }).sort({ createdAt: -1, id: -1 }).toArray();
    const cs = await changes.find({ workspace: WORKSPACE, ticket: { $in: ts.map(t => t.id) } }).sort({ createdAt: -1, id: -1 }).toArray();
    return { tickets: ts.map(toClient), changes: cs.map(toClient), notices: await notices(filter), ...(policy.extras ? await policy.extras(user) : {}) };
  }
  async function nextId(collection, prefix, floor) {
    const docs = await collection.find({ workspace: WORKSPACE }, { projection: { id: 1 } }).toArray();
    return `${prefix}-${Math.max(floor, ...docs.map(d => Number(d.id.split('-')[1]) || 0)) + 1}`;
  }
  // Inserts with a fresh sequential id; a repeated requestId returns the record created by the first submission.
  // Simultaneous submissions can pick the same number; each retry waits a short random moment so they spread out.
  async function insertNew(collection, prefix, floor, requestId, build) {
    const prior = await collection.findOne({ workspace: WORKSPACE, requestId });
    if (prior) return { doc: prior, duplicate: true };
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, Math.random() * 25 * attempt));
      const doc = build(await nextId(collection, prefix, floor));
      try { await collection.insertOne(doc); return { doc, duplicate: false }; }
      catch (err) {
        if (err.code !== 11000) throw err;
        const again = await collection.findOne({ workspace: WORKSPACE, requestId });
        if (again) return { doc: again, duplicate: true };
      }
    }
    throw new Error('Could not allocate a record number. Try again.');
  }
  // Writes a new version only if nobody else saved since `doc` was read. A status change restarts statusSince,
  // which reminders use to measure how long something has waited.
  async function replaceIfCurrent(collection, doc, next, at = now()) {
    const { _id, ...fields } = next; // _id is immutable; the filter identifies the record
    if (fields.status !== doc.status) fields.statusSince = at;
    const { matchedCount } = await collection.replaceOne({ _id: doc._id, version: doc.version }, { ...fields, version: doc.version + 1, updatedAt: at });
    return matchedCount === 1;
  }
  // Working copy for WorkflowCore. Leaves out _id (an ObjectId, which structuredClone would turn into a plain object).
  const clone = ({ _id, ...doc }) => structuredClone(doc);
  const conflict = async (kind, id) => {
    const collection = kind === 'tickets' ? tickets : changes;
    const latest = await collection.findOne({ workspace: WORKSPACE, id });
    return new Conflict('This record was changed in another session. The latest version is now shown; review it and try again.', { [kind]: latest ? [toClient(latest)] : [] });
  };

  async function createTicket(actor, body) {
    const view = policy.creationView(body);
    if (!REQUEST_ID.test(String(body.requestId || ''))) throw new HttpError(400, 'invalid-request-id');
    const raw = body.input || {};
    if (!WorkflowCore.DEPARTMENTS.includes(raw.department)) throw new WorkflowCore.WorkflowError('invalid', 'Choose a department.');
    if (!WorkflowCore.CATEGORIES.includes(raw.category)) throw new WorkflowCore.WorkflowError('invalid', 'Choose a request category.');
    if (TL.day(raw.date) === null) throw new WorkflowCore.WorkflowError('invalid', 'Enter a valid requested target date.');
    if (String(raw.criteria || '').length > 5000) throw new WorkflowCore.WorkflowError('invalid', 'Acceptance criteria is too long (maximum 5000 characters).');
    // The requester is always the signed-in member, whatever the form says. Field order matches the request form.
    const input = { title: String(raw.title || '').trim(), name: actor.displayName || actor.email, department: raw.department, date: raw.date, category: raw.category, description: String(raw.description || '').trim(), criteria: String(raw.criteria || '').trim() };
    const at = now();
    const prior = await tickets.findOne({ workspace: WORKSPACE, requestId: body.requestId });
    if (prior) {
      if (prior.requester.id !== String(actor._id)) throw new HttpError(409, 'request-id-in-use');
      return { created: prior.id, duplicate: true, tickets: [toClient(prior)] };
    }
    const claimed = await files.claim(actor, raw.attachments);
    let result;
    try {
      result = await insertNew(tickets, 'JRC', policy.floors ? policy.floors.ticket : 1000, body.requestId, id => {
        const { ticket, notes } = WorkflowCore.createTicket(input, id);
        return { ...ticket, history: notes.map((n, i) => entry(n, actor, view, at, i === 0 && claimed ? claimed.list : null)), workspace: WORKSPACE, requester: { id: String(actor._id), name: input.name, sample: false }, version: 1, requestId: body.requestId, statusSince: at, createdAt: at, updatedAt: at };
      });
    } catch (err) { await files.release(claimed); throw err; }
    const { doc, duplicate } = result;
    if (duplicate) { await files.release(claimed); return { created: doc.id, duplicate, tickets: [toClient(doc)] }; }
    await files.finish(claimed, doc.id);
    await notify.deliver({ events: ticketEvents(null, doc, 'created'), record: doc.id, kind: 'ticket', target: 'ticket', version: doc.version, ticket: doc, text: withFiles(`${doc.id} · ${doc.title}`, claimed), actor, view, at });
    return { created: doc.id, duplicate, tickets: [toClient(doc)] };
  }

  async function ticketAction(actor, id, body) {
    const current = await visibleTicket(actor, id);
    if (body.version !== current.version) throw await conflict('tickets', id);
    const at = now();
    const input = { ...(body.input || {}) };
    const contexts = await policy.contexts(actor, current, body);
    // Only comments carry attachments. A comment may be files only; it then gets a short note.
    const claimed = body.action === 'comment' ? await files.claim(actor, input.attachments) : null;
    let saved = null, next, ctx;
    try {
      if (claimed && !String(input.comment || '').trim()) input.comment = `Shared ${claimed.list.length} attachment${claimed.list.length === 1 ? '' : 's'}.`;
      ({ ctx, next } = tryAs(contexts, c => {
        const copy = clone(current);
        const notes = WorkflowCore.ticketAction(copy, body.action, input, c);
        copy.history.push(...notes.map(n => entry(n, actor, c.view, at, claimed ? claimed.list : null)));
        return { next: copy };
      }));
      if (!await replaceIfCurrent(tickets, current, next, at)) throw await conflict('tickets', id);
      saved = await tickets.findOne({ _id: current._id });
    } catch (err) { await files.release(claimed); throw err; }
    await files.finish(claimed, id);
    await notify.deliver({ events: ticketEvents(current, saved, body.action, input), record: id, kind: 'ticket', target: ['create-project', 'edit-scope'].includes(body.action) ? 'project' : 'ticket', version: saved.version, ticket: saved, before: current, text: withFiles(`${id} · ${next.history[next.history.length - 1].text}`, claimed), actor, view: ctx.view, at });
    return { tickets: [toClient(saved)] };
  }

  async function createChange(actor, ticketId, body) {
    if (!REQUEST_ID.test(String(body.requestId || ''))) throw new HttpError(400, 'invalid-request-id');
    const ticket = await visibleTicket(actor, ticketId);
    const prior = await changes.findOne({ workspace: WORKSPACE, requestId: body.requestId });
    if (prior) {
      if (prior.ticket !== ticketId) throw new HttpError(409, 'request-id-in-use');
      return { created: prior.id, duplicate: true, changes: [toClient(prior)], tickets: [toClient(await tickets.findOne({ workspace: WORKSPACE, id: prior.ticket }))] };
    }
    if (body.ticketVersion !== ticket.version) throw await conflict('tickets', ticketId);
    const at = now();
    const contexts = await policy.contexts(actor, ticket, body);
    const input = { title: String(body.input?.title || '').trim(), reason: String(body.input?.reason || '').trim(), criteria: String(body.input?.criteria || '').trim() };
    let ticketNotes = [], view = null;
    const { doc, duplicate } = await insertNew(changes, 'CR', policy.floors ? policy.floors.change : 200, body.requestId, id => {
      const made = tryAs(contexts, c => ({ made: WorkflowCore.createChange(clone(ticket), input, id, c) }));
      ticketNotes = made.made.ticketNotes; view = made.ctx.view;
      return { ...made.made.change, history: made.made.changeNotes.map(n => entry(n, actor, view, at)), workspace: WORKSPACE, version: 1, requestId: body.requestId, statusSince: at, createdAt: at, updatedAt: at };
    });
    if (duplicate) return { created: doc.id, duplicate: true, changes: [toClient(doc)], tickets: [toClient(await tickets.findOne({ _id: ticket._id }))] };
    const nextTicket = clone(ticket);
    nextTicket.history.push(...ticketNotes.map(n => entry(n, actor, view, at)));
    if (!await replaceIfCurrent(tickets, ticket, nextTicket, at)) {
      await changes.deleteOne({ _id: doc._id }); // keep the pair consistent: no change without its ticket note
      throw await conflict('tickets', ticketId);
    }
    await notify.deliver({ events: changeEvents(doc, 'created'), record: doc.id, kind: 'change', target: 'change', version: doc.version, ticket: nextTicket, text: `${doc.id} · ${doc.title} (linked to ${ticketId})`, actor, view, at });
    return { created: doc.id, duplicate: false, changes: [toClient(doc)], tickets: [toClient(await tickets.findOne({ _id: ticket._id }))] };
  }

  async function changeAction(actor, id, body) {
    const current = await changes.findOne({ workspace: WORKSPACE, id });
    if (!current) throw notFound();
    let ticket = await visibleTicket(actor, current.ticket);
    if (body.version !== current.version) throw await conflict('changes', id);
    const at = now();
    const contexts = await policy.contexts(actor, ticket, body);
    const { ctx, next, result } = tryAs(contexts, c => {
      const copy = clone(current);
      const r = WorkflowCore.changeAction(copy, clone(ticket), body.action, body.input || {}, c);
      copy.history.push(...r.notes.map(n => entry(n, actor, c.view, at)));
      return { next: copy, result: r };
    });
    if (!await replaceIfCurrent(changes, current, next, at)) throw await conflict('changes', id);
    // Approval and release also update the original ticket; retry briefly if the ticket was saved meanwhile.
    if (result.ticketEffect) {
      for (let attempt = 0; ; attempt++) {
        const nextTicket = clone(ticket);
        const ticketNotes = result.ticketEffect(nextTicket);
        nextTicket.history.push(...ticketNotes.map(n => entry(n, actor, ctx.view, at)));
        if (await replaceIfCurrent(tickets, ticket, nextTicket, at)) break;
        if (attempt >= 4) { log.error(`${policy.label}: ${id} saved but ticket ${current.ticket} could not be updated after retries.`); break; }
        ticket = await tickets.findOne({ _id: ticket._id });
      }
    }
    const savedChange = await changes.findOne({ _id: current._id }), savedTicket = await tickets.findOne({ _id: ticket._id });
    await notify.deliver({ events: changeEvents(savedChange, body.action, body.input || {}), record: id, kind: 'change', target: 'change', version: savedChange.version, ticket: savedTicket, text: `${id} · ${next.history[next.history.length - 1].text}`, actor, view: ctx.view, at });
    return { changes: [toClient(savedChange)], tickets: [toClient(savedTicket)] };
  }

  async function reset(actor, body) {
    if (!policy.reset) throw notFound();
    if (body?.confirm !== policy.reset.phrase) throw new HttpError(400, 'confirmation-required');
    const result = await policy.reset.seed(db, { replace: true, now });
    const removedFiles = (await files.reset()).removed, removedNotifications = await notify.reset();
    await recordEvent(policy.reset.event, { actorId: actor._id, removed: result.removed, removedFiles, removedNotifications, seededTickets: result.tickets, seededChanges: result.changes });
    log.log(`${policy.label} reset by a signed-in member (${result.removed} records replaced by ${result.tickets + result.changes} samples).`);
    return {};
  }

  // One page of the tickets (or projects) this member may see, searched and filtered in the database.
  async function search(actor, params) {
    let query;
    try { query = ListFilter.normalize(params, { accounts: !policy.simulated }); }
    catch (err) { if (err instanceof ListFilter.FilterError) throw new WorkflowCore.WorkflowError('invalid', err.message); throw err; }
    const { filters: f, scope, page, pageSize } = query;
    const and = [{ workspace: WORKSPACE }, await policy.searchScope(actor, params)];
    if (scope === 'projects') and.push({ project: { $type: 'string' } });
    if (f.q) {
      const rx = { $regex: ListFilter.escapeRegex(f.q), $options: 'i' };
      and.push({ $or: ['id', 'project', 'title', 'projectName', 'description'].map(k => ({ [k]: rx })) });
    }
    for (const k of ['status', 'priority', 'department']) if (f[k]) and.push({ [k]: f[k] });
    if (f.dev) and.push(f.dev === ListFilter.UNASSIGNED ? { dev: { $in: ['', null] } } : policy.simulated ? { dev: f.dev } : { devId: f.dev });
    if (f.attention) and.push(attentionFilter(f.attention));
    const filter = { $and: and };
    const [total, docs] = await Promise.all([
      tickets.countDocuments(filter),
      tickets.find(filter).sort({ createdAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray()
    ]);
    return { items: docs.map(toClient), total, page, pageSize };
  }
  // The same rules as DeadlineCore, as a query: agreed delivery dates are YYYY-MM-DD strings in the workspace timezone.
  function attentionFilter(kind) {
    if (kind === 'Awaiting decision') {
      return { $or: [{ status: { $in: ListFilter.AWAITING } }, { meeting: { $type: 'string', $ne: '' }, meetingConfirmed: { $ne: true }, project: { $in: [null, ''] }, status: { $in: ['Assigned', 'Meeting scheduled'] } }] };
    }
    const today = DeadlineCore.today(now(), settings.timezone);
    const range = kind === 'Overdue' ? { $lt: today } : { $gte: today, $lte: DeadlineCore.addDays(today, settings.dueSoonDays) };
    return { status: { $in: DeadlineCore.DELIVERY }, $or: [{ dueDate: { $type: 'string', $ne: '', ...range } }, { dueDate: { $exists: false }, project: { $type: 'string' }, date: { $type: 'string', ...range } }] };
  }
  async function getTicket(user, id) {
    const t = await visibleTicket(user, id);
    return { tickets: [toClient(t)], changes: (await changes.find({ workspace: WORKSPACE, ticket: id }).toArray()).map(toClient) };
  }

  // Routes under the policy's base path. The caller (signed-in API) has already checked the session and the request
  // origin. The schema check is read-only and cached once it passes (db:setup only ever adds collections and indexes).
  let schemaReady = false;
  async function handle(req, res, pathname, user) {
    if (!schemaReady) {
      const missing = await missingSchema(db, policy.schema);
      if (missing.length) return sendJson(req, res, 503, policy.notSetUp);
      schemaReady = true;
    }
    const url = new URL(req.url, 'http://workspace.invalid');
    const get = req.method === 'GET' || req.method === 'HEAD';
    const at = path => pathname === policy.base + path;
    try {
      let result;
      const ticketMatch = TICKET_PATH.exec(pathname), fileMatch = FILE_PATH.exec(pathname), downloadMatch = DOWNLOAD_PATH.exec(pathname);
      if (at('/workspace') && get) { files.sweepSoon(); return sendJson(req, res, 200, await workspace(user)); }
      if (at('/search') && get) return sendJson(req, res, 200, await search(user, url.searchParams));
      if (ticketMatch && get) return sendJson(req, res, 200, await getTicket(user, ticketMatch[1]));
      if (at('/notifications') && get) return sendJson(req, res, 200, await notify.list(user, url.searchParams));
      if (at('/notifications/unread') && get) return sendJson(req, res, 200, { unread: await notify.unread(user, url.searchParams.get('view')) });
      if (downloadMatch && get) return await files.download(req, res, user, downloadMatch[1]);
      if (fileMatch && req.method === 'DELETE') return sendJson(req, res, 200, await files.remove(user, fileMatch[1]));
      if (at('/attachments') && req.method === 'POST') {
        if (policy.canUpload && !policy.canUpload(user)) throw notFound();
        return sendJson(req, res, 201, await files.upload(req, user));
      }
      if (policy.routes) { const handled = await policy.routes(req, res, pathname, user, url); if (handled) return; }
      if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'method-not-allowed' });
      const body = (await readJson(req)) || {};
      const action = ACTION_PATH.exec(pathname), changeCreate = CHANGE_CREATE_PATH.exec(pathname);
      if (at('/tickets')) result = await createTicket(user, body);
      else if (changeCreate) result = await createChange(user, changeCreate[1], body);
      else if (action && action[1] === 'tickets' && action[2].startsWith('JRC-')) result = await ticketAction(user, action[2], body);
      else if (action && action[1] === 'changes' && action[2].startsWith('CR-')) result = await changeAction(user, action[2], body);
      else if (at('/reset') && policy.reset) result = await reset(user, body);
      else if (at('/notifications/read')) return sendJson(req, res, 200, await notify.markRead(user, body));
      else return sendJson(req, res, 404, { error: 'not-found' });
      return sendJson(req, res, result.created && !result.duplicate ? 201 : 200, { ...result, notices: await notices(await policy.visible(user)), ...(at('/reset') ? await workspace(user) : {}) });
    } catch (err) {
      if (err instanceof AttachmentError) {
        // An upload refused part-way may leave unread request data; close the connection rather than read it all.
        return sendJson(req, res, err.status, { error: err.code, message: err.message }, req.complete ? {} : { Connection: 'close' });
      }
      if (err instanceof Conflict) return sendJson(req, res, 409, { error: 'conflict', message: err.message, ...err.payload });
      if (err instanceof WorkflowCore.WorkflowError) {
        const status = { forbidden: 403, invalid: 400, state: 409 }[err.code] || 400;
        return sendJson(req, res, status, { error: err.code, message: err.message });
      }
      throw err;
    }
  }

  // For the reminder scheduler: active records, and delivery of reminder notifications.
  const scan = async () => {
    const ts = await tickets.find({ workspace: WORKSPACE, status: { $nin: ['Closed', 'Rejected', 'Cancelled', 'Released'] } }).toArray();
    const cs = await changes.find({ workspace: WORKSPACE, ticket: { $in: ts.map(t => t.id) }, status: { $in: ['Submitted', 'Awaiting approval', 'Awaiting acceptance'] } }).toArray();
    return ts.map(t => ({ ticket: t, changes: cs.filter(c => c.ticket === t.id) }));
  };

  return { handle, workspace, files, notify, scan, policy, seed: options => policy.reset && policy.reset.seed(db, { now, ...options }) };
}

module.exports = { Conflict, createWorkspace };
