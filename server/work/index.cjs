// My workspace: the company's real tickets, projects, comments, attachments, and notifications, stored in the
// tickets, ticket_changes, attachments, files.*, and notifications collections. Access comes only from the signed-in
// account, read from the database on every request (so role and status changes apply at once):
//   Requestor  their own requests (requester.id is always the signed-in account; the browser cannot choose it)
//   Developer  their own requests and work assigned to their account (devId)
//   Admin      everything; assigns work to active Developer accounts
// A member acts in each capacity they hold on a ticket: Admin by role, Developer when assigned, Requestor as its
// owner. Beta simulation views and sample people never apply here. The request handling is server/workspace/engine.cjs.
const { WORK_COLLECTIONS } = require('../schema.cjs');
const { sendJson } = require('../http.cjs');
const { createWorkspace } = require('../workspace/engine.cjs');
const { accounts } = require('../workspace/notifications.cjs');

const WORKSPACE = 'main';

function createWork({ db, log = console, now = () => new Date(), recordEvent = async () => {}, settings }) {
  const users = db.collection('users');
  const uidOf = user => String(user._id);
  // Active Developer accounts: the only people normal work can be assigned to.
  const activeDevelopers = async () => (await users.find({ role: 'Developer', status: 'active' }, { projection: { displayName: 1, email: 1 }, sort: { displayName: 1, email: 1 } }).toArray())
    .map(u => ({ id: String(u._id), name: u.displayName || u.email }));
  const visibility = user => {
    const uid = uidOf(user);
    if (user.role === 'Admin') return {};
    if (user.role === 'Developer') return { $or: [{ 'requester.id': uid }, { devId: uid }] };
    return { 'requester.id': uid };
  };
  const owns = (user, t) => Boolean(t.requester && t.requester.id === uidOf(user));
  const assigned = (user, t) => user.role === 'Developer' && t.devId === uidOf(user);

  const policy = {
    label: 'My workspace',
    workspace: WORKSPACE,
    base: '/api/v1/work',
    simulated: false,
    // Numbers start above the beta simulation's, so a ticket number never means two different records.
    floors: { ticket: 2000, change: 500 },
    names: { tickets: 'tickets', changes: 'ticket_changes', attachments: 'attachments', notifications: 'notifications', bucket: 'files' },
    schema: WORK_COLLECTIONS,
    notSetUp: { error: 'workspace-not-set-up', message: 'My workspace has not been set up yet. Ask the owner to run the database setup.' },
    addressing: accounts,
    visible: async user => visibility(user),
    canSee: async (user, t) => user.role === 'Admin' || owns(user, t) || assigned(user, t),
    searchScope: async user => visibility(user),
    async contexts(user, ticket) {
      const devs = ['Admin', 'Developer'].includes(user.role) ? await activeDevelopers() : [];
      const common = {
        isRequester: t => owns(user, t),
        isAssignee: t => assigned(user, t),
        developer: id => { const d = devs.find(x => x.id === String(id)); return d ? { dev: d.name, devId: d.id } : null; },
        owners: devs.map(d => d.name)
      };
      const out = [];
      if (user.role === 'Admin') out.push({ ...common, view: 'Admin' });
      if (assigned(user, ticket)) out.push({ ...common, view: 'Developer' });
      if (owns(user, ticket)) out.push({ ...common, view: 'Requestor' });
      return out;
    },
    creationView: () => 'Requestor',
    // Admins and Developers need the active Developer accounts (assignment and task owners); Requestors do not.
    extras: async user => ({ developers: ['Admin', 'Developer'].includes(user.role) ? await activeDevelopers() : [] }),
    async routes(req, res, pathname, user) {
      if (pathname !== '/api/v1/work/people' || !['GET', 'HEAD'].includes(req.method)) return false;
      sendJson(req, res, 200, await policy.extras(user));
      return true;
    }
  };
  return createWorkspace({ db, policy, log, now, recordEvent, settings });
}

module.exports = { WORKSPACE, createWork };
