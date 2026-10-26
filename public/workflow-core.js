// Ticket, project, and linked-change workflow rules, shared by the browser (local and inspection modes) and the
// server (shared beta workspace). Every action checks the view (Requestor, Admin, or Developer) and the current
// status before changing anything, then mutates the record in place and returns the activity notes to record.
// Messages are user-facing and match the prototype's existing wording.
(function (root) {
  const TicketCore = typeof module !== 'undefined' ? require('./ticket-core.js') : root.TicketCore;
  const TL = typeof module !== 'undefined' ? require('./timeline-core.js') : root.TicketTimeline;
  const people = TicketCore.people; // sample developers; the Developer view acts as the first one
  const SAMPLE_DEVELOPER = people[0];
  const VIEWS = ['Requestor', 'Admin', 'Developer'];
  const DEPARTMENTS = ['Sales', 'Operations', 'Finance', 'Human Resources', 'Procurement', 'Customer Service', 'IT'];
  const CATEGORIES = ['New feature', 'Enhancement', 'Bug / issue', 'Access request'];
  const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
  const EARLY = ['Submitted', 'Under review', 'Waiting for information', 'On hold'];
  const FINAL = ['Closed', 'Rejected', 'Cancelled'];
  const ACTIVE_WORK = ['Planning', 'In progress'];
  const CHANGE_STATUSES = ['Submitted', 'Assessment', 'Awaiting approval', 'Approved', 'Deferred', 'Rejected', 'In progress', 'Awaiting acceptance', 'Accepted', 'Released', 'Closed'];

  class WorkflowError extends Error {
    constructor(code, message) { super(message); this.code = code; } // code: forbidden | invalid | state
  }
  const fail = (code, message) => { throw new WorkflowError(code, message); };
  const text = (value, label, { required = true, max = 5000 } = {}) => {
    const v = String(value ?? '').trim();
    if (required && !v) fail('invalid', `${label} is required.`);
    if (v.length > max) fail('invalid', `${label} is too long (maximum ${max} characters).`);
    return v;
  };
  const isDate = v => TL.day(v) !== null;

  // Who the caller is acting as. ctx: { view, isRequester(ticket), isAssignee(ticket), developer(input), owners }.
  // The beta workspace and local modes act as the sample developer; My workspace supplies real-account checks.
  function roles(ctx, ticket) {
    if (!VIEWS.includes(ctx.view)) fail('invalid', 'Choose a Requestor, Admin, or Developer view.');
    return {
      admin: ctx.view === 'Admin',
      dev: ctx.view === 'Developer' && (ctx.isAssignee ? ctx.isAssignee(ticket) : ticket.dev === SAMPLE_DEVELOPER),
      req: ctx.view === 'Requestor' && (!ctx.isRequester || ctx.isRequester(ticket))
    };
  }
  const allow = (ok, message = 'This action is not available in the current view.') => { if (!ok) fail('forbidden', message); };
  const inState = (ok, message = 'This ticket has moved on since it was opened. Refresh and try again.') => { if (!ok) fail('state', message); };

  function validateProjectTasks(tasks, target) {
    if (!tasks.length) return 'Add at least one task.';
    for (const task of tasks) {
      const err = TL.validateTask(task); if (err) return err;
      if (task.end > target) return 'A task ends after the confirmed target date. Update the scope target or task dates.';
    }
    return '';
  }
  function readTask(input, owners = people) {
    const task = {};
    for (const key of ['title', 'requirement', 'criteria', 'start', 'end', 'owner']) task[key] = String(input?.[key] ?? '').trim();
    if (task.title.length > 150) fail('invalid', 'Task name is too long (maximum 150 characters).');
    if (task.owner && !owners.includes(task.owner)) fail('invalid', owners === people ? 'Choose a task owner from the sample developers.' : 'Choose a task owner from the active developers.');
    return task;
  }

  // New ticket from the request form. Field order matches the prototype's stored records.
  function createTicket(input, nextId) {
    const t = { ...input };
    text(t.title, 'Request summary', { max: 150 });
    text(t.description, 'Request description');
    // date is the requestor's requested target; requestedDate keeps it after an agreed delivery date replaces date.
    return { ticket: { ...t, id: nextId, status: 'Submitted', priority: 'Medium', dev: '', tasks: [], history: [], requestedDate: t.date }, notes: ['Ticket submitted. Admin notified.'] };
  }

  // Applies one ticket action. Returns the notes to add to the ticket's activity, in order.
  function ticketAction(t, action, input = {}, ctx) {
    const { admin, dev, req } = roles(ctx, t);
    switch (action) {
      case 'comment': {
        const comment = text(input.comment, 'Comment', { max: 2000 });
        return [`${ctx.view}: ${comment}`];
      }
      case 'status': {
        const to = input.status;
        const rules = {
          'Under review': (admin && EARLY.includes(t.status)) || (req && t.status === 'Waiting for information'),
          'In progress': dev && ACTIVE_WORK.includes(t.status),
          'Ready for release': req && t.status === 'Awaiting acceptance',
          Released: dev && t.status === 'Ready for release',
          Closed: admin && t.status === 'Released'
        };
        if (!(to in rules)) fail('invalid', 'Unknown status change.');
        allow(VIEWS.includes(ctx.view) && (to !== 'In progress' || dev) && rulesView(to, { admin, dev, req }));
        inState(rules[to]);
        if (to === 'In progress' && t.tasks.every(x => x.done)) fail('invalid', 'Add or reopen a task before starting development');
        t.status = to;
        return [`${ctx.view}: status changed to ${t.status}.`];
      }
      case 'reason': {
        const status = input.status;
        const rules = {
          'Waiting for information': admin && EARLY.includes(t.status),
          Rejected: admin && EARLY.includes(t.status),
          'On hold': admin && !FINAL.includes(t.status),
          'In progress': req && t.status === 'Awaiting acceptance',
          Cancelled: req && EARLY.includes(t.status)
        };
        if (!(status in rules)) fail('invalid', 'Unknown decision.');
        allow((['In progress', 'Cancelled'].includes(status) ? req : admin));
        inState(rules[status]);
        const reason = text(input.reason, 'Reason', { max: 2000 });
        t.status = status;
        if (status === 'In progress' && t.tasks.length) t.tasks[t.tasks.length - 1].done = false;
        return [`${ctx.view}: ${status}. ${reason}`];
      }
      case 'assign': {
        allow(admin);
        if (FINAL.includes(t.status)) fail('state', 'This ticket is no longer active');
        const d = String(input.dev || '');
        if (!d) fail('invalid', 'Choose a developer first');
        // Real accounts: ctx.developer resolves an active Developer account to { dev: name, devId }.
        const assignee = ctx.developer ? ctx.developer(d) : people.includes(d) ? { dev: d } : null;
        if (!assignee) fail('invalid', ctx.developer ? 'Choose an active Developer account.' : 'Choose one of the sample developers.');
        if (!PRIORITIES.includes(input.priority)) fail('invalid', 'Choose a priority.');
        Object.assign(t, assignee); t.priority = input.priority;
        if (EARLY.includes(t.status)) t.status = 'Assigned';
        return [`Admin assigned ${t.dev}. Priority: ${t.priority}.`];
      }
      case 'schedule-meeting': {
        allow(dev);
        inState(!t.project && ['Assigned', 'Meeting scheduled'].includes(t.status));
        const meeting = meetingInput(input);
        Object.assign(t, meeting, { meetingConfirmed: false, status: 'Meeting scheduled' });
        return ['Meeting proposed. Requestor confirmation requested.'];
      }
      case 'edit-meeting': {
        allow(dev);
        inState(t.meeting && !['Closed', 'Released', 'Rejected'].includes(t.status));
        Object.assign(t, meetingInput(input), { meetingConfirmed: false });
        if (!t.project) t.status = 'Meeting scheduled';
        return ['Planning meeting updated; requestor confirmation requested.'];
      }
      case 'confirm-meeting': {
        allow(req);
        inState(t.meeting && !t.meetingConfirmed);
        t.meetingConfirmed = true;
        return ['Requestor confirmed the meeting schedule.'];
      }
      case 'create-project': {
        allow(dev);
        inState(!t.project && ['Assigned', 'Meeting scheduled'].includes(t.status), t.project ? 'This ticket already has a project.' : undefined);
        const scope = scopeInput(input);
        const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(x => readTask(x, ctx.owners));
        const error = validateProjectTasks(tasks, scope.date);
        if (error) fail('invalid', error);
        // The confirmed target becomes the agreed delivery date (dueDate); the requested date is kept.
        Object.assign(t, {
          project: 'PRJ-' + t.id.split('-')[1], projectName: scope.projectName,
          requirements: scope.requirements, notes: scope.requirements, criteria: scope.criteria,
          requestedDate: t.requestedDate || t.date, date: scope.date, dueDate: scope.date, status: 'Planning', tasks: tasks.map(x => ({ ...x, done: false }))
        });
        return ['Project created with agreed requirements, acceptance criteria, and a task timeline. Requestor added; admin notified.'];
      }
      case 'toggle-task': {
        allow(dev);
        inState(ACTIVE_WORK.includes(t.status));
        const task = t.tasks[Number(input.index)];
        if (!task || !Number.isInteger(Number(input.index))) fail('invalid', 'That task no longer exists. Refresh and try again.');
        task.done = Boolean(input.done);
        return [`${task.done ? 'Completed' : 'Reopened'} task: ${task.title}`];
      }
      case 'save-task': {
        allow(dev);
        inState(t.project && ACTIVE_WORK.includes(t.status));
        const index = input.index === null || input.index === undefined ? null : Number(input.index);
        if (index !== null && !t.tasks[index]) fail('invalid', 'That task no longer exists. Refresh and try again.');
        const next = readTask(input.task, ctx.owners);
        const error = TL.validateTask(next); if (error) fail('invalid', error);
        if (next.end > t.date) fail('invalid', 'Task ends after the project target. Update project details first.');
        next.done = Boolean(input.task && input.task.done);
        if (index === null) t.tasks.push(next); else t.tasks[index] = next;
        return [`${index === null ? 'Added' : 'Updated'} dated task: ${next.title}.`];
      }
      case 'edit-scope': {
        allow(dev);
        inState(t.project && ACTIVE_WORK.includes(t.status));
        const next = scopeInput(input);
        if (t.tasks.some(x => x.end && x.end > next.date)) fail('invalid', 'Target date cannot precede a saved task end date.');
        Object.assign(t, next, { dueDate: next.date });
        return ['Project planning details updated.'];
      }
      case 'submit-acceptance': {
        allow(dev);
        inState(ACTIVE_WORK.includes(t.status));
        if (!t.tasks.length || t.tasks.some(x => !x.done)) fail('invalid', 'Complete all project tasks, including internal testing, first');
        const summary = text(input.summary, 'Testing summary', { max: 2000 });
        t.status = 'Awaiting acceptance';
        return ['Internal testing passed. Requestor acceptance requested. ' + summary];
      }
      default: fail('invalid', 'Unknown action.');
    }
  }
  function rulesView(to, { admin, dev, req }) {
    return { 'Under review': admin || req, 'In progress': dev, 'Ready for release': req, Released: dev, Closed: admin }[to];
  }
  function meetingInput(input) {
    const meeting = text(input.meeting, 'Date and time', { max: 40 });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(meeting)) fail('invalid', 'Enter the meeting date and time.');
    return { meeting, location: text(input.location, 'Location', { max: 200 }) };
  }
  function scopeInput(input) {
    const scope = { projectName: String(input.projectName ?? '').trim(), requirements: String(input.requirements ?? '').trim(), criteria: String(input.criteria ?? '').trim(), date: String(input.date ?? '') };
    if (!scope.projectName || !scope.requirements || !scope.criteria) fail('invalid', 'Complete the project name, requirements, and criteria.');
    if (scope.projectName.length > 150) fail('invalid', 'Project name is too long (maximum 150 characters).');
    if (!isDate(scope.date)) fail('invalid', 'Enter a valid confirmed target date.');
    return scope;
  }

  // New linked change from a ticket with a project.
  function createChange(t, input, nextId, ctx) {
    roles(ctx, t);
    inState(Boolean(t.project), 'Scope changes are linked to tickets that have a project.');
    const c = { ...input, id: nextId, ticket: t.id, status: 'Submitted', impact: '', history: [] };
    text(c.title, 'Change summary', { max: 150 });
    text(c.reason, 'Business reason');
    text(c.criteria, 'Acceptance criteria');
    return { change: c, changeNotes: ['Change submitted. Admin review requested.'], ticketNotes: [`${c.id} linked: ${c.title}. Original work continues unless explicitly put on hold.`] };
  }

  // Applies one change action. Returns { notes, ticketEffect } where ticketEffect(ticket) applies any change to the
  // original ticket (approval adds a task; release and closure complete it) and returns that ticket's notes.
  function changeAction(c, t, action, input = {}, ctx) {
    const { admin, dev, req } = roles(ctx, t);
    const completeTask = ticket => { const task = ticket.tasks.find(x => x.title.startsWith(c.id + ':')); if (task) task.done = true; return []; };
    switch (action) {
      case 'status': {
        const to = input.status;
        const rules = {
          Assessment: admin && ['Submitted', 'Deferred'].includes(c.status),
          'In progress': dev && c.status === 'Approved',
          Accepted: req && c.status === 'Awaiting acceptance',
          Released: dev && c.status === 'Accepted',
          Closed: admin && c.status === 'Released'
        };
        if (!(to in rules)) fail('invalid', 'Unknown change status.');
        allow({ Assessment: admin, 'In progress': dev, Accepted: req, Released: dev, Closed: admin }[to]);
        inState(rules[to], 'This change has moved on since it was opened. Refresh and try again.');
        c.status = to;
        return { notes: [`${ctx.view}: change moved to ${c.status}.`], ticketEffect: ['Released', 'Closed'].includes(to) ? completeTask : null };
      }
      case 'assess': {
        allow(dev);
        inState(c.status === 'Assessment', 'This change has moved on since it was opened. Refresh and try again.');
        const impact = text(input.impact, 'Impact assessment');
        const effort = text(input.effort, 'Effort estimate', { max: 100 });
        if (!isDate(input.date)) fail('invalid', 'Enter a valid revised delivery date.');
        Object.assign(c, { impact, effort, date: input.date }, { status: 'Awaiting approval', requestorAgreed: false });
        return { notes: ['Developer assessed impact. Requestor agreement requested.'], ticketEffect: null };
      }
      case 'agree': {
        allow(req);
        inState(c.status === 'Awaiting approval' && !c.requestorAgreed, 'This change has moved on since it was opened. Refresh and try again.');
        c.requestorAgreed = true;
        return { notes: ['Requestor agreed to revised scope, estimate, and target date. Admin approval requested.'], ticketEffect: null };
      }
      case 'approve': {
        allow(admin);
        inState(c.status === 'Awaiting approval' && c.requestorAgreed, 'The requestor must agree before approval.');
        c.status = 'Approved'; c.approvedBy = 'Admin'; c.approvedAt = ctx.time();
        return {
          notes: ['Admin approved change. Project plan updated.'],
          ticketEffect: ticket => {
            ticket.tasks.push({ title: `${c.id}: ${c.title}`, done: false });
            if (!['Closed', 'Released'].includes(ticket.status)) { ticket.date = c.date; ticket.dueDate = c.date; }
            return [`${c.id} approved and added to the project plan. Revised change target: ${c.date}.`];
          }
        };
      }
      case 'decision': {
        const next = input.status;
        const rules = {
          Deferred: admin && ['Assessment', 'Awaiting approval', 'Deferred'].includes(c.status),
          Rejected: admin && ['Assessment', 'Awaiting approval', 'Deferred'].includes(c.status),
          'In progress': req && c.status === 'Awaiting acceptance'
        };
        if (!(next in rules)) fail('invalid', 'Unknown decision.');
        allow(next === 'In progress' ? req : admin);
        inState(rules[next], 'This change has moved on since it was opened. Refresh and try again.');
        const reason = text(input.reason, 'Reason', { max: 2000 });
        if (next === 'Deferred' && !isDate(input.reviewDate)) fail('invalid', 'Enter a valid review date.');
        c.status = next;
        if (input.reviewDate) c.reviewDate = input.reviewDate;
        return { notes: [`${ctx.view}: ${next}. ${reason}`], ticketEffect: null };
      }
      case 'submit-test': {
        allow(dev);
        inState(c.status === 'In progress', 'This change has moved on since it was opened. Refresh and try again.');
        const results = text(input.results, 'Testing results', { max: 2000 });
        c.status = 'Awaiting acceptance';
        return { notes: ['Internal testing passed. ' + results], ticketEffect: null };
      }
      default: fail('invalid', 'Unknown action.');
    }
  }

  const api = { WorkflowError, VIEWS, SAMPLE_DEVELOPER, DEPARTMENTS, CATEGORIES, PRIORITIES, CHANGE_STATUSES, validateProjectTasks, createTicket, ticketAction, createChange, changeAction };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WorkflowCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
