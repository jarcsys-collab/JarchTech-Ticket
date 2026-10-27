// Due dates, reminders, and escalation rules. Shared by the browser (deadline labels and the attention summary) and
// the server's reminder scheduler. All dates are calendar dates (YYYY-MM-DD) in the workspace timezone
// (Asia/Manila by default), compared as whole days, so there is no timezone drift.
//   requested date  what the requestor asked for (requestedDate; before agreement it is also `date`)
//   agreed delivery the confirmed project target (dueDate; older records: `date` once a project exists)
(function (root) {
  const TL = typeof module !== 'undefined' ? require('./timeline-core.js') : root.TicketTimeline;
  const DEFAULTS = Object.freeze({
    timezone: 'Asia/Manila',
    dueSoonDays: 2,            // remind the assigned worker this many days before the agreed delivery date
    escalateOverdueDays: 2,    // escalate to Admins once delivery is this many days overdue
    acceptanceDays: 2,         // remind the requestor after completed work has awaited their confirmation this long
    escalateAcceptanceDays: 5, // escalate to Admins after acceptance has waited this long
    pendingDays: 2             // remind whoever must act (review, meeting, agreement, information, release, closure, scope change)
  });
  // Statuses in which the agreed delivery date is the assigned worker's to meet. Other statuses pause or end it.
  const DELIVERY = ['Assigned', 'Meeting scheduled', 'Planning', 'In progress'];
  const DAY_MS = 86400000;

  function today(now = new Date(), timezone = DEFAULTS.timezone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
  const valid = v => TL.day(v) !== null;
  const dueDate = t => (valid(t.dueDate) ? t.dueDate : t.project && valid(t.date) ? t.date : '');
  const requestedDate = t => (valid(t.requestedDate) ? t.requestedDate : !t.project && valid(t.date) ? t.date : '');
  // Whole days from the calendar date a to b (b - a).
  const days = (a, b) => Math.round((TL.day(b) - TL.day(a)) / DAY_MS);
  const addDays = (date, n) => TL.date(TL.day(date) + n * DAY_MS);
  // Whole days a record has been in its current state.
  const age = (rec, now) => Math.floor((now - new Date(rec.statusSince || rec.updatedAt || now).getTime()) / DAY_MS);

  // { due, days, state } for active delivery work with an agreed date; state is overdue, due-soon, or on-track.
  function deadline(t, todayDate, settings = DEFAULTS) {
    const due = dueDate(t);
    if (!due || !DELIVERY.includes(t.status)) return null;
    const left = days(todayDate, due);
    return { due, days: left, state: left < 0 ? 'overdue' : left <= settings.dueSoonDays ? 'due-soon' : 'on-track' };
  }
  // Who must act next on a ticket, if it is waiting on a decision or confirmation rather than on the work itself.
  // 'developer' means the assigned worker (a Developer, or an Admin who assigned the work to themselves).
  function awaiting(t) {
    const c = t.completion || {};
    const project = t.type === 'Project' || (!t.type && Boolean(t.project));
    if (['Awaiting acceptance', 'Ready for release', 'Released'].includes(t.status)) {
      if (!c.worker) return t.status === 'Awaiting acceptance' ? { who: 'requestor', what: 'acceptance' } : { who: 'developer', what: 'completion' };
      if (!c.requestor) return { who: 'requestor', what: 'acceptance' };
      if (t.status === 'Ready for release' && project) return { who: 'developer', what: 'release' };
      return { who: 'admin', what: 'closure' };
    }
    if (t.status === 'Waiting for information') return { who: 'requestor', what: 'information' };
    if (['Submitted', 'Under review'].includes(t.status)) return { who: 'admin', what: 'review' };
    if (t.meeting && !t.meetingConfirmed && !(t.agreements && t.agreements.length) && ['Assigned', 'Meeting scheduled', 'Planning', 'In progress'].includes(t.status)) return { who: 'requestor', what: 'meeting' };
    const d = t.agreementDraft;
    if (d && !(t.agreements && t.agreements.length)) return d.worker && !d.requestor ? { who: 'requestor', what: 'agreement' } : { who: 'developer', what: 'agreement' };
    return null;
  }
  function changeAwaiting(c) {
    if (c.status === 'Awaiting approval') return c.requestorAgreed ? { who: 'admin', what: 'change-approval' } : { who: 'requestor', what: 'change-agreement' };
    if (c.status === 'Awaiting acceptance') return { who: 'requestor', what: 'change-acceptance' };
    if (c.status === 'Submitted') return { who: 'admin', what: 'change-review' };
    return null;
  }
  const TITLES = {
    'due-soon': d => `Delivery due ${d.days === 0 ? 'today' : `in ${d.days} day${d.days === 1 ? '' : 's'}`}`,
    overdue: () => 'Overdue: the agreed delivery date has passed',
    'escalate-overdue': d => `Escalated: delivery overdue by ${-d.days} days`,
    acceptance: () => 'Reminder: completed work awaiting your confirmation',
    'escalate-acceptance': () => 'Escalated: Requestor confirmation is overdue',
    completion: () => 'Reminder: record your completion confirmation',
    agreement: () => 'Reminder: requirements agreement awaiting confirmation',
    closure: () => 'Reminder: both confirmations recorded, ready for Admin closure',
    information: () => 'Reminder: information requested from you',
    review: () => 'Reminder: request awaiting review',
    release: () => 'Reminder: confirmed work awaiting release or handover',
    meeting: () => 'Reminder: planning meeting awaiting your confirmation',
    'change-agreement': () => 'Reminder: scope change awaiting your agreement',
    'change-approval': () => 'Reminder: scope change awaiting approval',
    'change-acceptance': () => 'Reminder: scope change awaiting your acceptance',
    'change-review': () => 'Reminder: scope change awaiting review'
  };

  // Reminders due now for one ticket and its linked changes. Each has a stage that identifies the deadline or state
  // it is about, so it is sent once per stage; a changed date or a new state is a new stage. Completed, cancelled,
  // rejected, and paused work produces none.
  // Returns [{ type, title, to: 'admin' | 'requestor' | 'developer', stage, record, kind, target }].
  function reminders(t, changes = [], { now = new Date(), settings = DEFAULTS } = {}) {
    const out = [];
    const add = (type, to, stage, extra = {}) => out.push({ type, title: TITLES[type](extra.d), to, stage, record: extra.record || t.id, kind: extra.kind || 'ticket', target: extra.target || (t.project ? 'project' : 'ticket') });
    const d = deadline(t, today(now, settings.timezone), settings);
    if (d && d.state === 'due-soon') add('due-soon', 'developer', d.due, { d });
    if (d && d.state === 'overdue') {
      add('overdue', 'developer', d.due, { d });
      if (-d.days >= settings.escalateOverdueDays) add('escalate-overdue', 'admin', d.due, { d });
    }
    const wait = awaiting(t), since = new Date(t.statusSince || t.updatedAt || now).toISOString();
    if (wait && wait.what === 'acceptance') {
      if (age(t, now) >= settings.acceptanceDays) add('acceptance', 'requestor', since);
      if (age(t, now) >= settings.escalateAcceptanceDays) add('escalate-acceptance', 'admin', since);
    } else if (wait && age(t, now) >= settings.pendingDays) {
      add(wait.what, wait.who, wait.what === 'meeting' ? `${since}|${t.meeting}` : wait.what === 'agreement' ? `${since}|${wait.who}` : since);
    }
    for (const c of changes) {
      const w = changeAwaiting(c);
      if (w && age(c, now) >= settings.pendingDays) add(w.what, w.who, new Date(c.statusSince || c.updatedAt || now).toISOString(), { record: c.id, kind: 'change', target: 'change' });
    }
    return out;
  }

  // Short labels for lists and details.
  function label(t, todayDate, settings = DEFAULTS) {
    const d = deadline(t, todayDate, settings);
    if (!d) return null;
    if (d.state === 'overdue') return { state: 'overdue', text: `Overdue ${-d.days} day${d.days === -1 ? '' : 's'}` };
    if (d.state === 'due-soon') return { state: 'due-soon', text: d.days === 0 ? 'Due today' : `Due in ${d.days} day${d.days === 1 ? '' : 's'}` };
    return { state: 'on-track', text: `Due in ${d.days} days` };
  }
  function formatDate(value) {
    if (!valid(value)) return '';
    const [y, m, dd] = value.split('-').map(Number);
    return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
  }

  const api = { DEFAULTS, DELIVERY, today, dueDate, requestedDate, deadline, awaiting, changeAwaiting, reminders, label, formatDate, days, addDays };
  if (typeof module !== 'undefined') module.exports = api;
  else root.DeadlineCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
