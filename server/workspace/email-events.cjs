// Which saved action emails whom, and whether a queued message still makes sense when its turn comes.
//   audience  requester  the account that made the request
//             worker     the assigned worker (a Developer, or an Admin who assigned the work to themselves)
//             reviewer   whoever confirms for the Requestor side: normally the Requestor; an Admin other than the worker if
//                        the Requestor's account is disabled or they are also the (non-Admin) worker
//             admins     every active Admin
const WorkflowCore = require('../../public/workflow-core.js');
const DeadlineCore = require('../../public/deadline-core.js');

const { closable, completionOf } = WorkflowCore; // closable: the same rule the server applies to closing
const draftSide = (before, after) => {
  const was = before.agreementDraft || {}, now = after.agreementDraft;
  if (!now || (after.agreements || []).length) return null; // locked by this confirmation: nobody else is waiting
  return now.requestor && !was.requestor && !now.worker ? 'worker' : null;
};

// What this action asks of whom: [{ event, audience, data }], most specific first, because one person gets one email.
function planTicketEmails(before, after, action, input = {}) {
  const out = [];
  const mail = (event, audience, data = {}) => out.push({ event, audience, data });
  switch (action) {
    case 'assign':
      if (after.devId && before.devId !== after.devId) mail(before.devId ? 'reassigned' : 'assigned', 'worker');
      break;
    case 'schedule-meeting': mail('meeting-proposed', 'reviewer', { meeting: after.meeting }); break;
    case 'edit-meeting': mail('meeting-changed', 'reviewer', { meeting: after.meeting }); break;
    case 'confirm-meeting': mail('meeting-confirmed', 'worker', { meeting: after.meeting }); break;
    case 'record-agreement': mail('agreement-confirm', 'reviewer'); break;
    case 'confirm-agreement': if (draftSide(before, after) === 'worker') mail('agreement-worker', 'worker'); break;
    case 'worker-complete': mail('completion-review', 'reviewer'); break;
    case 'reason': if (input.status === 'In progress') mail('returned', 'worker'); break;
    case 'status': if (after.status === 'Closed' && before.status !== 'Closed') { mail('closed', 'requester'); mail('closed', 'worker'); } break;
    default:
  }
  if (!closable(before) && closable(after)) mail('ready-to-close', 'admins');
  return out;
}

// Why a queued message should no longer go, or null if it still should. The workflow rule is rechecked, not the wording:
// a message about a meeting that has since changed, or work returned before it was sent, is left unsent.
function staleReason(item, t, user, changes, { now, settings }) {
  const uid = String(user._id), data = item.data || {};
  const c = completionOf(t), draft = t.agreementDraft;
  const open = !WorkflowCore.FINAL.includes(t.status);
  const stillAddressed = {
    requester: () => t.requester && t.requester.id === uid,
    worker: () => t.devId === uid,
    reviewer: () => (t.requester && t.requester.id === uid) || (user.role === 'Admin' && t.devId !== uid),
    admins: () => user.role === 'Admin'
  }[item.audience];
  if (stillAddressed && !stillAddressed()) return 'no-longer-involved';
  const needed = {
    assigned: () => open, reassigned: () => open,
    'meeting-proposed': () => open && t.meeting === data.meeting && !t.meetingConfirmed,
    'meeting-changed': () => open && t.meeting === data.meeting && !t.meetingConfirmed,
    'meeting-confirmed': () => open && t.meeting === data.meeting && t.meetingConfirmed,
    'agreement-confirm': () => open && Boolean(draft) && !draft.requestor,
    'agreement-worker': () => open && Boolean(draft) && !draft.worker,
    'completion-review': () => WorkflowCore.COMPLETING.includes(t.status) && Boolean(c.worker) && !c.requestor,
    returned: () => t.status === 'In progress',
    'ready-to-close': () => closable(t),
    closed: () => t.status === 'Closed',
    // A reminder stands only while the same reminder is still due, for the same record and the same audience.
    reminder: () => {
      if (!data.type) return true; // queued by an earlier version, which recorded no stage
      if (data.to === 'developer' && t.devId !== uid) return false;
      if (data.to === 'requestor' && !(t.requester && t.requester.id === uid)) return false;
      if (data.to === 'admin' && user.role !== 'Admin') return false;
      return DeadlineCore.reminders(t, changes, { now, settings }).some(r => r.type === data.type && r.stage === data.stage && r.record === item.record);
    }
  }[item.event];
  return needed && !needed() ? 'no-longer-needed' : null;
}

module.exports = { planTicketEmails, staleReason };
