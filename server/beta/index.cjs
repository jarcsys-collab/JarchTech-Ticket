// Shared beta simulation workspace (BETA_SIMULATION=enabled): test tickets, projects, tasks, comments, activity, and
// linked changes stored in MongoDB, shared by every signed-in beta member.
// - The simulated view (Requestor, Admin, Developer) is chosen per request and only ever applies to these two beta
//   collections. It never changes real roles or reaches any other API.
// - Every action is checked by WorkflowCore against the view and the record's current status before it is stored.
// - Every write carries the record version it was based on; a stale version is refused (409) instead of overwriting.
// - Creation requests carry a requestId, so a repeated submission returns the first result instead of a duplicate.
// - Activity entries record both the signed-in actor and the simulated view.
// - Attachments (attachments.cjs) are uploaded first, then added to a new request or a comment by id.
// - Saved actions notify the simulated inboxes involved (notifications.cjs); search reads the shared records page by page.
const WorkflowCore = require('../../public/workflow-core.js');
const SampleData = require('../../public/sample-data.js');
const TL = require('../../public/timeline-core.js');
const ListFilter = require('../../public/list-filter.js');
const { HttpError, readJson, sendJson } = require('../http.cjs');
const { BETA_COLLECTIONS, missingSchema } = require('../schema.cjs');
const { AttachmentError, createAttachments } = require('./attachments.cjs');
const { changeEvents, createNotifications, ticketEvents } = require('./notifications.cjs');

const WORKSPACE = 'beta';
const RESET_PHRASE = 'RESET';
const MAX_NOTICES = 40;
const ACTION_PATH = /^\/api\/v1\/beta\/(tickets|changes)\/((?:JRC|CR)-\d{1,9})\/actions$/;
const CHANGE_CREATE_PATH = /^\/api\/v1\/beta\/tickets\/(JRC-\d{1,9})\/changes$/;
const TICKET_PATH = /^\/api\/v1\/beta\/tickets\/(JRC-\d{1,9})$/;
const FILE_PATH = /^\/api\/v1\/beta\/attachments\/([0-9a-f]{24})$/;
const DOWNLOAD_PATH = /^\/api\/v1\/beta\/attachments\/([0-9a-f]{24})\/download$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const stamp = date => date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

class Conflict extends Error {
  constructor(message, payload) { super(message); this.payload = payload; }
}

// Sample records for the shared workspace: the local demo sample, with its illustrative dated schedule.
function sampleDocuments(at) {
  const sample = SampleData.dateSampleProjects(SampleData.seed(), TL);
  const base = at.getTime();
  const stampDoc = (doc, i) => ({ ...doc, workspace: WORKSPACE, version: 1, createdAt: new Date(base - i), updatedAt: new Date(base - i) });
  return {
    tickets: sample.tickets.map((t, i) => stampDoc({ ...t, requester: { id: null, name: t.name, sample: true } }, i)),
    changes: sample.changes.map(stampDoc)
  };
}

// Inserts the sample records. Refuses if the workspace already has records unless replace is true, in which case
// only the beta workspace records are deleted first.
async function seedWorkspace(db, { replace = false, now = () => new Date() } = {}) {
  const tickets = db.collection('beta_tickets'), changes = db.collection('beta_changes');
  const existing = await tickets.countDocuments({ workspace: WORKSPACE }) + await changes.countDocuments({ workspace: WORKSPACE });
  if (existing && !replace) return { seeded: false, existing };
  const removed = replace ? (await tickets.deleteMany({ workspace: WORKSPACE })).deletedCount + (await changes.deleteMany({ workspace: WORKSPACE })).deletedCount : 0;
  const docs = sampleDocuments(now());
  await tickets.insertMany(docs.tickets);
  if (docs.changes.length) await changes.insertMany(docs.changes);
  return { seeded: true, removed, tickets: docs.tickets.length, changes: docs.changes.length };
}

function createBeta({ db, log = console, now = () => new Date(), recordEvent = async () => {} }) {
  const tickets = db.collection('beta_tickets');
  const changes = db.collection('beta_changes');
  const files = createAttachments({ db, workspace: WORKSPACE, log, now });
  const notify = createNotifications({ db, workspace: WORKSPACE, log, stamp });
  const toClient = ({ _id, workspace, requestId, ...rest }) => rest;
  const entry = (text, actor, view, at, attachments) => ({ text, time: stamp(at), at, actor: actor.displayName || actor.email, actorId: String(actor._id), view, ...(attachments ? { attachments } : {}) });
  const withFiles = (text, claimed) => claimed ? `${text} (${claimed.list.length} attachment${claimed.list.length === 1 ? '' : 's'})` : text;
  const ctxFor = (actor, view) => ({
    view,
    time: () => stamp(now()),
    // Requestor actions apply to the member's own requests and to the shared sample requests.
    isRequester: t => Boolean(t.requester && (t.requester.sample || t.requester.id === String(actor._id)))
  });

  async function notices() {
    const [ts, cs] = await Promise.all([tickets.find({ workspace: WORKSPACE }, { projection: { id: 1, history: 1 } }).toArray(), changes.find({ workspace: WORKSPACE }, { projection: { id: 1, history: 1 } }).toArray()]);
    return [...ts, ...cs]
      .flatMap(d => d.history.map((h, i) => ({ text: `${d.id} · ${h.text}`, time: h.time, at: h.at ? new Date(h.at).getTime() : 0, i })))
      .sort((a, b) => b.at - a.at || b.i - a.i)
      .slice(0, MAX_NOTICES)
      .map(({ text, time }) => ({ text, time }));
  }
  async function workspace() {
    const [ts, cs, ns] = await Promise.all([
      tickets.find({ workspace: WORKSPACE }).sort({ createdAt: -1, id: -1 }).toArray(),
      changes.find({ workspace: WORKSPACE }).sort({ createdAt: -1, id: -1 }).toArray(),
      notices()
    ]);
    return { tickets: ts.map(toClient), changes: cs.map(toClient), notices: ns };
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
  // Writes a new version only if nobody else saved since `doc` was read.
  async function replaceIfCurrent(collection, doc, next) {
    const { _id, ...fields } = next; // _id is immutable; the filter identifies the record
    const { matchedCount } = await collection.replaceOne({ _id: doc._id, version: doc.version }, { ...fields, version: doc.version + 1, updatedAt: now() });
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
    const view = body.view;
    if (!WorkflowCore.VIEWS.includes(view)) throw new HttpError(400, 'invalid-view');
    if (!REQUEST_ID.test(String(body.requestId || ''))) throw new HttpError(400, 'invalid-request-id');
    const raw = body.input || {};
    if (!WorkflowCore.DEPARTMENTS.includes(raw.department)) throw new WorkflowCore.WorkflowError('invalid', 'Choose a department.');
    if (!WorkflowCore.CATEGORIES.includes(raw.category)) throw new WorkflowCore.WorkflowError('invalid', 'Choose a request category.');
    if (TL.day(raw.date) === null) throw new WorkflowCore.WorkflowError('invalid', 'Enter a valid target date.');
    if (String(raw.criteria || '').length > 5000) throw new WorkflowCore.WorkflowError('invalid', 'Acceptance criteria is too long (maximum 5000 characters).');
    // The requester is always the signed-in member, whatever the form says. Field order matches the request form.
    const input = { title: String(raw.title || '').trim(), name: actor.displayName || actor.email, department: raw.department, date: raw.date, category: raw.category, description: String(raw.description || '').trim(), criteria: String(raw.criteria || '').trim() };
    const at = now();
    const prior = await tickets.findOne({ workspace: WORKSPACE, requestId: body.requestId });
    if (prior) return { created: prior.id, duplicate: true, tickets: [toClient(prior)] };
    const claimed = await files.claim(actor, raw.attachments);
    let result;
    try {
      result = await insertNew(tickets, 'JRC', 1000, body.requestId, id => {
        const { ticket, notes } = WorkflowCore.createTicket(input, id);
        return { ...ticket, history: notes.map((n, i) => entry(n, actor, view, at, i === 0 && claimed ? claimed.list : null)), workspace: WORKSPACE, requester: { id: String(actor._id), name: input.name, sample: false }, version: 1, requestId: body.requestId, createdAt: at, updatedAt: at };
      });
    } catch (err) { await files.release(claimed); throw err; }
    const { doc, duplicate } = result;
    if (duplicate) { await files.release(claimed); return { created: doc.id, duplicate, tickets: [toClient(doc)] }; }
    await files.finish(claimed, doc.id);
    await notify.deliver({ events: ticketEvents(null, doc, 'created'), record: doc.id, kind: 'ticket', target: 'ticket', version: doc.version, ticket: doc, text: withFiles(`${doc.id} · ${doc.title}`, claimed), actor, view, at });
    return { created: doc.id, duplicate, tickets: [toClient(doc)] };
  }

  async function ticketAction(actor, id, body) {
    const current = await tickets.findOne({ workspace: WORKSPACE, id });
    if (!current) throw new HttpError(404, 'not-found');
    if (body.version !== current.version) throw await conflict('tickets', id);
    const next = clone(current);
    const at = now();
    const input = { ...(body.input || {}) };
    // Only comments carry attachments. A comment may be files only; it then gets a short note.
    const claimed = body.action === 'comment' ? await files.claim(actor, input.attachments) : null;
    let saved = null;
    try {
      if (claimed && !String(input.comment || '').trim()) input.comment = `Shared ${claimed.list.length} attachment${claimed.list.length === 1 ? '' : 's'}.`;
      const notes = WorkflowCore.ticketAction(next, body.action, input, ctxFor(actor, body.view));
      next.history.push(...notes.map(n => entry(n, actor, body.view, at, claimed ? claimed.list : null)));
      if (!await replaceIfCurrent(tickets, current, next)) throw await conflict('tickets', id);
      saved = await tickets.findOne({ _id: current._id });
    } catch (err) { await files.release(claimed); throw err; }
    await files.finish(claimed, id);
    await notify.deliver({ events: ticketEvents(current, saved, body.action, input), record: id, kind: 'ticket', target: body.action === 'create-project' ? 'project' : 'ticket', version: saved.version, ticket: saved, before: current, text: withFiles(`${id} · ${next.history[next.history.length - 1].text}`, claimed), actor, view: body.view, at });
    return { tickets: [toClient(saved)] };
  }

  async function createChange(actor, ticketId, body) {
    if (!REQUEST_ID.test(String(body.requestId || ''))) throw new HttpError(400, 'invalid-request-id');
    const prior = await changes.findOne({ workspace: WORKSPACE, requestId: body.requestId });
    if (prior) return { created: prior.id, duplicate: true, changes: [toClient(prior)], tickets: [toClient(await tickets.findOne({ workspace: WORKSPACE, id: prior.ticket }))] };
    const ticket = await tickets.findOne({ workspace: WORKSPACE, id: ticketId });
    if (!ticket) throw new HttpError(404, 'not-found');
    if (body.ticketVersion !== ticket.version) throw await conflict('tickets', ticketId);
    const at = now();
    const ctx = ctxFor(actor, body.view);
    const input = { title: String(body.input?.title || '').trim(), reason: String(body.input?.reason || '').trim(), criteria: String(body.input?.criteria || '').trim() };
    let ticketNotes = [];
    const { doc, duplicate } = await insertNew(changes, 'CR', 200, body.requestId, id => {
      const made = WorkflowCore.createChange(clone(ticket), input, id, ctx);
      ticketNotes = made.ticketNotes;
      return { ...made.change, history: made.changeNotes.map(n => entry(n, actor, body.view, at)), workspace: WORKSPACE, version: 1, requestId: body.requestId, createdAt: at, updatedAt: at };
    });
    if (duplicate) return { created: doc.id, duplicate: true, changes: [toClient(doc)], tickets: [toClient(await tickets.findOne({ _id: ticket._id }))] };
    const nextTicket = clone(ticket);
    nextTicket.history.push(...ticketNotes.map(n => entry(n, actor, body.view, at)));
    if (!await replaceIfCurrent(tickets, ticket, nextTicket)) {
      await changes.deleteOne({ _id: doc._id }); // keep the pair consistent: no change without its ticket note
      throw await conflict('tickets', ticketId);
    }
    await notify.deliver({ events: changeEvents(doc, 'created'), record: doc.id, kind: 'change', target: 'change', version: doc.version, ticket: nextTicket, text: `${doc.id} · ${doc.title} (linked to ${ticketId})`, actor, view: body.view, at });
    return { created: doc.id, duplicate: false, changes: [toClient(doc)], tickets: [toClient(await tickets.findOne({ _id: ticket._id }))] };
  }

  async function changeAction(actor, id, body) {
    const current = await changes.findOne({ workspace: WORKSPACE, id });
    if (!current) throw new HttpError(404, 'not-found');
    if (body.version !== current.version) throw await conflict('changes', id);
    let ticket = await tickets.findOne({ workspace: WORKSPACE, id: current.ticket });
    if (!ticket) throw new HttpError(404, 'not-found');
    const at = now();
    const ctx = ctxFor(actor, body.view);
    const next = clone(current);
    const result = WorkflowCore.changeAction(next, clone(ticket), body.action, body.input || {}, ctx);
    next.history.push(...result.notes.map(n => entry(n, actor, body.view, at)));
    if (!await replaceIfCurrent(changes, current, next)) throw await conflict('changes', id);
    // Approval and release also update the original ticket; retry briefly if the ticket was saved meanwhile.
    if (result.ticketEffect) {
      for (let attempt = 0; ; attempt++) {
        const nextTicket = clone(ticket);
        const ticketNotes = result.ticketEffect(nextTicket);
        nextTicket.history.push(...ticketNotes.map(n => entry(n, actor, body.view, at)));
        if (await replaceIfCurrent(tickets, ticket, nextTicket)) break;
        if (attempt >= 4) { log.error(`Beta: ${id} saved but ticket ${current.ticket} could not be updated after retries.`); break; }
        ticket = await tickets.findOne({ _id: ticket._id });
      }
    }
    const savedChange = await changes.findOne({ _id: current._id }), savedTicket = await tickets.findOne({ _id: ticket._id });
    await notify.deliver({ events: changeEvents(savedChange, body.action, body.input || {}), record: id, kind: 'change', target: 'change', version: savedChange.version, ticket: savedTicket, text: `${id} · ${next.history[next.history.length - 1].text}`, actor, view: body.view, at });
    return { changes: [toClient(savedChange)], tickets: [toClient(savedTicket)] };
  }

  async function reset(actor, body) {
    if (body?.confirm !== RESET_PHRASE) throw new HttpError(400, 'confirmation-required');
    const result = await seedWorkspace(db, { replace: true, now });
    const removedFiles = (await files.reset()).removed, removedNotifications = await notify.reset();
    await recordEvent('beta.reset', { actorId: actor._id, removed: result.removed, removedFiles, removedNotifications, seededTickets: result.tickets, seededChanges: result.changes });
    log.log(`Beta workspace reset by a signed-in member (${result.removed} records replaced by ${result.tickets + result.changes} samples).`);
    return {};
  }

  // One page of the tickets (or projects) the simulated view can see, searched and filtered in the database.
  async function search(actor, params) {
    let query;
    try { query = ListFilter.normalize(params); }
    catch (err) { if (err instanceof ListFilter.FilterError) throw new WorkflowCore.WorkflowError('invalid', err.message); throw err; }
    const view = params.get('view');
    if (!WorkflowCore.VIEWS.includes(view)) throw new HttpError(400, 'invalid-view');
    const { filters: f, scope, page, pageSize } = query;
    const and = [{ workspace: WORKSPACE }];
    if (view === 'Developer') and.push({ dev: WorkflowCore.SAMPLE_DEVELOPER });
    if (view === 'Requestor') and.push({ $or: [{ 'requester.sample': true }, { 'requester.id': String(actor._id) }] });
    if (scope === 'projects') and.push({ project: { $type: 'string' } });
    if (f.q) {
      const rx = { $regex: ListFilter.escapeRegex(f.q), $options: 'i' };
      and.push({ $or: ['id', 'project', 'title', 'projectName', 'description'].map(k => ({ [k]: rx })) });
    }
    for (const k of ['status', 'priority', 'department']) if (f[k]) and.push({ [k]: f[k] });
    if (f.dev) and.push(f.dev === ListFilter.UNASSIGNED ? { dev: { $in: ['', null] } } : { dev: f.dev });
    const filter = { $and: and };
    const [total, docs] = await Promise.all([
      tickets.countDocuments(filter),
      tickets.find(filter).sort({ createdAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray()
    ]);
    return { items: docs.map(toClient), total, page, pageSize };
  }
  async function getTicket(id) {
    const t = await tickets.findOne({ workspace: WORKSPACE, id });
    if (!t) throw new HttpError(404, 'not-found');
    return { tickets: [toClient(t)], changes: (await changes.find({ workspace: WORKSPACE, ticket: id }).toArray()).map(toClient) };
  }

  // Routes under /api/v1/beta. The caller (signed-in API) has already checked the session and the request origin.
  // The schema check is read-only and cached once it passes (db:setup only ever adds collections and indexes).
  let schemaReady = false;
  async function handle(req, res, pathname, user) {
    if (!schemaReady) {
      const missing = await missingSchema(db, BETA_COLLECTIONS);
      if (missing.length) return sendJson(req, res, 503, { error: 'beta-not-set-up', message: 'The shared beta workspace has not been set up yet.' });
      schemaReady = true;
    }
    const url = new URL(req.url, 'http://beta.invalid');
    const get = req.method === 'GET' || req.method === 'HEAD';
    try {
      let result;
      const ticketMatch = TICKET_PATH.exec(pathname), fileMatch = FILE_PATH.exec(pathname), downloadMatch = DOWNLOAD_PATH.exec(pathname);
      if (pathname === '/api/v1/beta/workspace' && get) { files.sweepSoon(); return sendJson(req, res, 200, await workspace()); }
      if (pathname === '/api/v1/beta/search' && get) return sendJson(req, res, 200, await search(user, url.searchParams));
      if (ticketMatch && get) return sendJson(req, res, 200, await getTicket(ticketMatch[1]));
      if (pathname === '/api/v1/beta/notifications' && get) return sendJson(req, res, 200, await notify.list(user, url.searchParams));
      if (pathname === '/api/v1/beta/notifications/unread' && get) return sendJson(req, res, 200, { unread: await notify.unread(user, url.searchParams.get('view')) });
      if (downloadMatch && get) return await files.download(req, res, user, downloadMatch[1]);
      if (fileMatch && req.method === 'DELETE') return sendJson(req, res, 200, await files.remove(user, fileMatch[1]));
      if (pathname === '/api/v1/beta/attachments' && req.method === 'POST') return sendJson(req, res, 201, await files.upload(req, user));
      if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'method-not-allowed' });
      const body = (await readJson(req)) || {};
      const action = ACTION_PATH.exec(pathname), changeCreate = CHANGE_CREATE_PATH.exec(pathname);
      if (pathname === '/api/v1/beta/tickets') result = await createTicket(user, body);
      else if (changeCreate) result = await createChange(user, changeCreate[1], body);
      else if (action && action[1] === 'tickets' && action[2].startsWith('JRC-')) result = await ticketAction(user, action[2], body);
      else if (action && action[1] === 'changes' && action[2].startsWith('CR-')) result = await changeAction(user, action[2], body);
      else if (pathname === '/api/v1/beta/reset') result = await reset(user, body);
      else if (pathname === '/api/v1/beta/notifications/read') return sendJson(req, res, 200, await notify.markRead(user, body));
      else return sendJson(req, res, 404, { error: 'not-found' });
      return sendJson(req, res, result.created && !result.duplicate ? 201 : 200, { ...result, notices: await notices(), ...(pathname === '/api/v1/beta/reset' ? await workspace() : {}) });
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

  return { handle, workspace, files, seed: options => seedWorkspace(db, { now, ...options }) };
}

module.exports = { RESET_PHRASE, WORKSPACE, createBeta, seedWorkspace };
