// My workspace: the company's real tickets, projects, comments, attachments, and notifications, stored in the
// tickets, ticket_changes, attachments, files.*, and notifications collections. Access comes only from the signed-in
// account, read from the database on every request (so role and status changes apply at once):
//   Requestor  their own requests (requester.id is always the signed-in account; the browser cannot choose it)
//   Admin      every ticket: review, prioritize, assign, decide, and do the delivery work
//   Developer  everything an Admin can do (user management is separate, in server/auth, and Developer-only)
// Work is assigned to an active Admin or Developer account (devId), who receives the delivery reminders.
// A member acts in each capacity they hold on a ticket: their staff role, and Requestor as its owner. Beta simulation
// views and sample people never apply here. The request handling is server/workspace/engine.cjs.
const { WORK_COLLECTIONS } = require('../schema.cjs');
const { sendJson } = require('../http.cjs');
const { createWorkspace } = require('../workspace/engine.cjs');
const { accounts } = require('../workspace/notifications.cjs');

const WORKSPACE = 'main';
const STAFF = ['Admin', 'Developer'];

function createWork({ db, log = console, now = () => new Date(), recordEvent = async () => {}, settings }) {
  const users = db.collection('users');
  const uidOf = user => String(user._id);
  // Active Admin and Developer accounts: the people normal work can be assigned to.
  const activeAssignees = async () => (await users.find({ role: { $in: STAFF }, status: 'active' }, { projection: { displayName: 1, email: 1, role: 1 }, sort: { displayName: 1, email: 1 } }).toArray())
    .map(u => ({ id: String(u._id), name: u.displayName || u.email, role: u.role }));
  const staff = user => STAFF.includes(user.role);
  const visibility = user => (staff(user) ? {} : { 'requester.id': uidOf(user) });
  const owns = (user, t) => Boolean(t.requester && t.requester.id === uidOf(user));

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
    canSee: async (user, t) => staff(user) || owns(user, t),
    searchScope: async user => visibility(user),
    async contexts(user, ticket) {
      const people = staff(user) ? await activeAssignees() : [];
      const common = {
        isRequester: t => owns(user, t),
        developer: id => { const d = people.find(x => x.id === String(id)); return d ? { dev: d.name, devId: d.id } : null; },
        owners: people.map(d => d.name)
      };
      const out = [];
      if (staff(user)) out.push({ ...common, view: user.role });
      if (owns(user, ticket)) out.push({ ...common, view: 'Requestor' });
      return out;
    },
    creationView: () => 'Requestor',
    // Admins and Developers need the active assignees (assignment and task owners); Requestors do not.
    extras: async user => ({ developers: staff(user) ? await activeAssignees() : [] }),
    async routes(req, res, pathname, user) {
      if (pathname !== '/api/v1/work/people' || !['GET', 'HEAD'].includes(req.method)) return false;
      sendJson(req, res, 200, await policy.extras(user));
      return true;
    }
  };
  return createWorkspace({ db, policy, log, now, recordEvent, settings });
}

module.exports = { WORKSPACE, createWork };
