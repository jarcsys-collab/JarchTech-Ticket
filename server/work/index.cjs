// My workspace: the company's real tickets, projects, comments, attachments, and notifications, stored in the
// tickets, ticket_changes, attachments, files.*, and notifications collections. Access comes only from the signed-in
// account, read from the database on every request (so role and status changes apply at once):
//   Requestor  their own requests (requester.id is always the signed-in account; the browser cannot choose it)
//   Developer  work assigned to them (devId) and their own requests; they plan and deliver their assigned work
//   Admin      every request: review, assign (to an active Developer or themselves), decide, approve, and close
// The assigned worker (devId) is a Developer, or an Admin who assigned the work to themselves; they receive the
// delivery reminders. A member acts in each capacity they hold on a ticket: their role, and Requestor as its owner.
// Beta simulation views and sample people never apply here. The request handling is server/workspace/engine.cjs.
const { WORK_COLLECTIONS } = require('../schema.cjs');
const { sendJson } = require('../http.cjs');
const { createWorkspace } = require('../workspace/engine.cjs');
const { accounts } = require('../workspace/notifications.cjs');

const WORKSPACE = 'main';

function createWork({ db, log = console, now = () => new Date(), recordEvent = async () => {}, settings }) {
  const users = db.collection('users');
  const uidOf = user => String(user._id);
  const nameOf = user => user.displayName || user.email;
  // Active Developer accounts: the people an Admin can assign work to (besides themselves).
  const activeDevelopers = async () => (await users.find({ role: 'Developer', status: 'active' }, { projection: { displayName: 1, email: 1, role: 1 }, sort: { displayName: 1, email: 1 } }).toArray())
    .map(u => ({ id: String(u._id), name: u.displayName || u.email, role: u.role }));
  const admin = user => user.role === 'Admin';
  const owns = (user, t) => Boolean(t.requester && t.requester.id === uidOf(user));
  // Assignment counts only while the account is a Developer or Admin: someone who becomes a Requestor loses it at once.
  const assigned = (user, t) => ['Admin', 'Developer'].includes(user.role) && Boolean(t.devId && t.devId === uidOf(user));
  const visibility = user => (admin(user) ? {} : user.role === 'Developer' ? { $or: [{ devId: uidOf(user) }, { 'requester.id': uidOf(user) }] } : { 'requester.id': uidOf(user) });
  // Admins assign to active Developers or to themselves; Developers see the same list for task owners only.
  async function assignees(user) {
    if (admin(user)) return [...await activeDevelopers(), { id: uidOf(user), name: nameOf(user), role: 'Admin', self: true }];
    return user.role === 'Developer' ? activeDevelopers() : [];
  }

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
    canSee: async (user, t) => admin(user) || assigned(user, t) || owns(user, t),
    async contexts(user, ticket) {
      const people = await assignees(user);
      const common = {
        actorFor: () => ({ id: uidOf(user), name: nameOf(user) }),
        isRequester: t => owns(user, t),
        isWorker: t => assigned(user, t),
        // The Requestor and the worker are the same account: an Admin must review for the Requestor side.
        sameParty: t => Boolean(t.devId && t.requester && t.requester.id === t.devId),
        assignee: id => { const d = admin(user) && people.find(x => x.id === String(id)); return d ? { dev: d.name, devId: d.id } : null; },
        assigneeError: 'Choose an active Developer, or assign it to yourself.',
        owners: [...new Set([...people.map(d => d.name), ...(ticket.dev ? [ticket.dev] : [])])]
      };
      const out = [];
      if (admin(user) || user.role === 'Developer') out.push({ ...common, view: user.role });
      if (owns(user, ticket)) out.push({ ...common, view: 'Requestor' });
      return out;
    },
    creationView: () => 'Requestor',
    extras: async user => ({ developers: await assignees(user) }),
    async routes(req, res, pathname, user) {
      if (pathname !== '/api/v1/work/people' || !['GET', 'HEAD'].includes(req.method)) return false;
      sendJson(req, res, 200, await policy.extras(user));
      return true;
    }
  };
  return createWorkspace({ db, policy, log, now, recordEvent, settings });
}

module.exports = { WORKSPACE, createWork };
