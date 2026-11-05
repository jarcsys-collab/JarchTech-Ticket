// My workspace: the company's real tickets, projects, comments, attachments, and notifications, stored in the
// tickets, ticket_changes, attachments, files.*, and notifications collections. Access comes only from the signed-in
// account, read from the database on every request (so role and status changes apply at once):
//   Requestor  their own requests (requester.id is always the signed-in account; the browser cannot choose it)
//   Developer  work assigned to them (devId) and their own requests; they plan and deliver their assigned work
//   Admin      every request: review, assign (to an active Developer or themselves), decide, approve, close, and archive
//              or delete finished requests. Archived requests are visible to Admins only until restored.
// The assigned worker (devId) is a Developer, or an Admin who assigned the work to themselves; they receive the
// delivery reminders. A member acts in each capacity they hold on a ticket: their role, and Requestor as its owner.
// Beta simulation views and sample people never apply here. The request handling is server/workspace/engine.cjs.
const { ObjectId } = require('mongodb');
const { WORK_COLLECTIONS } = require('../schema.cjs');
const { HttpError, readJson, sendJson } = require('../http.cjs');
const { createWorkspace } = require('../workspace/engine.cjs');
const { accounts } = require('../workspace/notifications.cjs');

const WORKSPACE = 'main';
const EMAIL_RETRY = /^\/api\/v1\/work\/email\/([0-9a-f]{24})\/retry$/;

function createWork({ db, log = console, now = () => new Date(), recordEvent = async () => {}, settings, attachmentQuotaBytes, email = null }) {
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
  const notArchived = { archived: { $exists: false } }; // archived requests are the Admins' until restored
  const visibility = user => (admin(user) ? {} : user.role === 'Developer' ? { $or: [{ devId: uidOf(user) }, { 'requester.id': uidOf(user) }], ...notArchived } : { 'requester.id': uidOf(user), ...notArchived });
  // Admins assign to active Developers or to themselves; Developers see the same list for task owners only.
  async function assignees(user) {
    if (admin(user)) return [...await activeDevelopers(), { id: uidOf(user), name: nameOf(user), role: 'Admin', self: true }];
    return user.role === 'Developer' ? activeDevelopers() : [];
  }

  // For Admins: accounts that cannot act on a request any more, so the screens can say what needs reassigning or review.
  async function accountFlags(user) {
    if (!admin(user)) return {};
    const flagged = await users.find({ $or: [{ status: { $ne: 'active' } }, { role: 'Requestor' }] }, { projection: { status: 1 } }).toArray();
    const admins = await users.find({ role: 'Admin', status: 'active' }, { projection: { _id: 1 } }).toArray();
    return { cannotWork: flagged.map(u => String(u._id)), disabled: flagged.filter(u => u.status !== 'active').map(u => String(u._id)), activeAdmins: admins.map(u => String(u._id)) };
  }
  // The Requestor's account is disabled: nobody can confirm for them, so an Admin other than the worker reviews instead.
  async function requesterGone(ticket) {
    if (!ticket.requester || !/^[0-9a-f]{24}$/.test(String(ticket.requester.id))) return false;
    const owner = await users.findOne({ _id: new ObjectId(ticket.requester.id) }, { projection: { status: 1 } });
    return !owner || owner.status !== 'active';
  }

  // The Requestor and the worker are one account, and it is an active Admin: they complete the request themselves. Read
  // fresh on every action, so if that account stops being an active Admin, the independent review applies again.
  const sameAccount = t => Boolean(t.devId && t.requester && t.requester.id === t.devId);
  async function selfServedByAdmin(ticket) {
    if (!sameAccount(ticket) || !/^[0-9a-f]{24}$/.test(ticket.devId)) return false;
    return Boolean(await users.findOne({ _id: new ObjectId(ticket.devId), role: 'Admin', status: 'active' }, { projection: { _id: 1 } }));
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
    canSee: async (user, t) => admin(user) || (!t.archived && (assigned(user, t) || owns(user, t))),
    retention: { canManage: admin, outbox: 'email_outbox' },
    async contexts(user, ticket) {
      const people = await assignees(user);
      const gone = admin(user) && await requesterGone(ticket);
      const selfServed = await selfServedByAdmin(ticket);
      // The current worker stays selectable while eligible (another Admin who assigned it to themselves, for example),
      // so an Admin can change the priority without reassigning the work.
      const keeps = admin(user) && ticket.devId && /^[0-9a-f]{24}$/.test(ticket.devId) && await users.findOne({ _id: new ObjectId(ticket.devId), status: 'active', role: { $in: ['Admin', 'Developer'] } }, { projection: { _id: 1 } });
      const common = {
        actorFor: () => ({ id: uidOf(user), name: nameOf(user) }),
        isRequester: t => owns(user, t),
        isWorker: t => assigned(user, t),
        // The Requestor and the worker are the same account: an Admin must review for the Requestor side, unless that
        // account is itself an active Admin.
        sameParty: t => gone || (sameAccount(t) && !selfServed),
        // This Admin is both, so they take each side themselves, as separate actions.
        selfService: t => selfServed && admin(user) && owns(user, t) && assigned(user, t),
        assignee: id => {
          if (keeps && String(id) === ticket.devId) return { dev: ticket.dev, devId: ticket.devId };
          const d = admin(user) && people.find(x => x.id === String(id));
          return d ? { dev: d.name, devId: d.id } : null;
        },
        assigneeError: 'Choose an active Developer, or assign it to yourself.',
        owners: [...new Set([...people.map(d => d.name), ...(ticket.dev ? [ticket.dev] : [])])]
      };
      const out = [];
      if (admin(user) || user.role === 'Developer') out.push({ ...common, view: user.role });
      if (owns(user, ticket)) out.push({ ...common, view: 'Requestor' });
      return out;
    },
    creationView: () => 'Requestor',
    extras: async user => ({ developers: await assignees(user), ...await accountFlags(user) }),
    async routes(req, res, pathname, user, url) {
      const read = ['GET', 'HEAD'].includes(req.method);
      if (pathname === '/api/v1/work/people' && read) { sendJson(req, res, 200, await policy.extras(user)); return true; }
      // Email delivery status, retry of a failed message, and a test message to yourself: Admins only.
      const retry = EMAIL_RETRY.exec(pathname), test = pathname === '/api/v1/work/email/test';
      if (!email || !((pathname === '/api/v1/work/email' && read) || ((retry || test) && req.method === 'POST'))) return false;
      if (!admin(user)) throw new HttpError(403, 'admin-only');
      if (read) sendJson(req, res, 200, await email.status(url.searchParams.get('status')));
      else if (test) sendJson(req, res, 202, await email.sendTest(user));
      else {
        const body = (await readJson(req)) || {};
        const result = await email.retry(retry[1], { force: body.force === true });
        await recordEvent('email.retried', { actorId: user._id, message: retry[1] });
        sendJson(req, res, 202, result);
      }
      return true;
    }
  };
  return createWorkspace({ db, policy, log, now, recordEvent, settings, attachmentQuotaBytes, email });
}

module.exports = { WORKSPACE, createWork };
