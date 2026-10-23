// Shared beta simulation workspace (BETA_SIMULATION=enabled): test tickets, projects, tasks, comments, activity, and
// linked changes stored in MongoDB, shared by every signed-in beta member.
// - The simulated view (Requestor, Admin, Developer) is chosen per request and only ever applies to these two beta
//   collections. It never changes real roles or reaches any other API.
// - Every action is checked by WorkflowCore against the view and the record's current status before it is stored.
// - Every write carries the record version it was based on; a stale version is refused (409) instead of overwriting.
// - Creation requests carry a requestId, so a repeated submission returns the first result instead of a duplicate.
// - Activity entries record both the signed-in actor and the simulated view.
const WorkflowCore = require('../../public/workflow-core.js');
const SampleData = require('../../public/sample-data.js');
const TL = require('../../public/timeline-core.js');
const { HttpError, readJson, sendJson } = require('../http.cjs');
const { BETA_COLLECTIONS, missingSchema } = require('../schema.cjs');

const WORKSPACE = 'beta';
const RESET_PHRASE = 'RESET';
const MAX_NOTICES = 40;
const ACTION_PATH = /^\/api\/v1\/beta\/(tickets|changes)\/((?:JRC|CR)-\d{1,9})\/actions$/;
const CHANGE_CREATE_PATH = /^\/api\/v1\/beta\/tickets\/(JRC-\d{1,9})\/changes$/;
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
  const toClient = ({ _id, workspace, requestId, ...rest }) => rest;
  const entry = (text, actor, view, at) => ({ text, time: stamp(at), at, actor: actor.displayName || actor.email, actorId: String(actor._id), view });
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
  async function insertNew(collection, prefix, floor, requestId, build) {
    const prior = await collection.findOne({ workspace: WORKSPACE, requestId });
    if (prior) return { doc: prior, duplicate: true };
    for (let attempt = 0; attempt < 5; attempt++) {
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
    const { doc, duplicate } = await insertNew(tickets, 'JRC', 1000, body.requestId, id => {
      const { ticket, notes } = WorkflowCore.createTicket(input, id);
      return { ...ticket, history: notes.map(n => entry(n, actor, view, at)), workspace: WORKSPACE, requester: { id: String(actor._id), name: input.name, sample: false }, version: 1, requestId: body.requestId, createdAt: at, updatedAt: at };
    });
    return { created: doc.id, duplicate, tickets: [toClient(doc)] };
  }

  async function ticketAction(actor, id, body) {
    const current = await tickets.findOne({ workspace: WORKSPACE, id });
    if (!current) throw new HttpError(404, 'not-found');
    if (body.version !== current.version) throw await conflict('tickets', id);
    const next = clone(current);
    const at = now();
    const notes = WorkflowCore.ticketAction(next, body.action, body.input || {}, ctxFor(actor, body.view));
    next.history.push(...notes.map(n => entry(n, actor, body.view, at)));
    if (!await replaceIfCurrent(tickets, current, next)) throw await conflict('tickets', id);
    return { tickets: [toClient(await tickets.findOne({ _id: current._id }))] };
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
    return { changes: [toClient(await changes.findOne({ _id: current._id }))], tickets: [toClient(await tickets.findOne({ _id: ticket._id }))] };
  }

  async function reset(actor, body) {
    if (body?.confirm !== RESET_PHRASE) throw new HttpError(400, 'confirmation-required');
    const result = await seedWorkspace(db, { replace: true, now });
    await recordEvent('beta.reset', { actorId: actor._id, removed: result.removed, seededTickets: result.tickets, seededChanges: result.changes });
    log.log(`Beta workspace reset by a signed-in member (${result.removed} records replaced by ${result.tickets + result.changes} samples).`);
    return {};
  }

  // Routes under /api/v1/beta. The caller (signed-in API) has already checked the session and the request origin.
  async function handle(req, res, pathname, user) {
    const missing = await missingSchema(db, BETA_COLLECTIONS);
    if (missing.length) return sendJson(req, res, 503, { error: 'beta-not-set-up', message: 'The shared beta workspace has not been set up yet.' });
    try {
      let result;
      if (pathname === '/api/v1/beta/workspace' && req.method === 'GET') return sendJson(req, res, 200, await workspace());
      if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'method-not-allowed' });
      const body = (await readJson(req)) || {};
      const action = ACTION_PATH.exec(pathname), changeCreate = CHANGE_CREATE_PATH.exec(pathname);
      if (pathname === '/api/v1/beta/tickets') result = await createTicket(user, body);
      else if (changeCreate) result = await createChange(user, changeCreate[1], body);
      else if (action && action[1] === 'tickets' && action[2].startsWith('JRC-')) result = await ticketAction(user, action[2], body);
      else if (action && action[1] === 'changes' && action[2].startsWith('CR-')) result = await changeAction(user, action[2], body);
      else if (pathname === '/api/v1/beta/reset') result = await reset(user, body);
      else return sendJson(req, res, 404, { error: 'not-found' });
      return sendJson(req, res, result.created && !result.duplicate ? 201 : 200, { ...result, notices: await notices(), ...(pathname === '/api/v1/beta/reset' ? await workspace() : {}) });
    } catch (err) {
      if (err instanceof Conflict) return sendJson(req, res, 409, { error: 'conflict', message: err.message, ...err.payload });
      if (err instanceof WorkflowCore.WorkflowError) {
        const status = { forbidden: 403, invalid: 400, state: 409 }[err.code] || 400;
        return sendJson(req, res, status, { error: err.code, message: err.message });
      }
      throw err;
    }
  }

  return { handle, workspace, seed: options => seedWorkspace(db, { now, ...options }) };
}

module.exports = { RESET_PHRASE, WORKSPACE, createBeta, seedWorkspace };
