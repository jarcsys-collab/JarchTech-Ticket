// Shared beta simulation workspace (BETA_SIMULATION=enabled): test tickets, projects, tasks, comments, activity,
// attachments, notifications, and linked changes stored in the beta_* collections, shared by every signed-in member.
// - The simulated view (Requestor, Admin, Developer) is chosen per request and only ever applies to these beta
//   collections. It never changes real roles, never reaches My workspace records, and never emails anyone.
// - Every member reads the whole shared workspace (test data); requestor actions apply to the member's own requests
//   and the shared sample requests. Admin and Developer views both manage and deliver work, as the real roles do;
//   the simulation never manages real accounts (the Developer view is labelled with the first sample developer).
// The request handling itself is the shared engine in server/workspace/engine.cjs.
const WorkflowCore = require('../../public/workflow-core.js');
const SampleData = require('../../public/sample-data.js');
const TL = require('../../public/timeline-core.js');
const { HttpError } = require('../http.cjs');
const { BETA_COLLECTIONS } = require('../schema.cjs');
const { createWorkspace } = require('../workspace/engine.cjs');
const { simulated } = require('../workspace/notifications.cjs');

const WORKSPACE = 'beta';
const RESET_PHRASE = 'RESET';

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

const view = v => { if (!WorkflowCore.VIEWS.includes(v)) throw new HttpError(400, 'invalid-view'); return v; };
const policy = {
  label: 'Beta workspace',
  workspace: WORKSPACE,
  base: '/api/v1/beta',
  simulated: true,
  names: { tickets: 'beta_tickets', changes: 'beta_changes', attachments: 'beta_attachments', notifications: 'beta_notifications', bucket: 'beta_files' },
  schema: BETA_COLLECTIONS,
  notSetUp: { error: 'beta-not-set-up', message: 'The shared beta workspace has not been set up yet.' },
  addressing: simulated,
  // Shared test data: every signed-in beta member sees every beta record.
  visible: async () => ({}),
  canSee: async () => true,
  // Lists follow the simulated view: Admin and Developer (staff) see every beta record; Requestor sees own and sample requests.
  searchScope: async (user, params) => {
    const v = view(params.get('view'));
    if (v === 'Requestor') return { $or: [{ 'requester.sample': true }, { 'requester.id': String(user._id) }] };
    return {};
  },
  // One capacity: the simulated view. Requestor actions apply to the member's own and the sample requests.
  contexts: async (user, ticket, body) => [{ view: body.view, isRequester: t => Boolean(t.requester && (t.requester.sample || t.requester.id === String(user._id))) }],
  creationView: body => view(body.view),
  reset: { phrase: RESET_PHRASE, event: 'beta.reset', seed: seedWorkspace }
};

function createBeta({ db, log = console, now = () => new Date(), recordEvent = async () => {}, settings }) {
  return createWorkspace({ db, policy, log, now, recordEvent, settings });
}

module.exports = { RESET_PHRASE, WORKSPACE, createBeta, policy, seedWorkspace };
