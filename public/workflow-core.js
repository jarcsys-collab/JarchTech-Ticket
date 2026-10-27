// Ticket, project, and linked-change workflow rules, shared by the browser (local and inspection modes) and the
// server (My workspace and the shared beta simulation). Every action checks the capacity the caller acts in and the
// record's current status before changing anything, then mutates the record in place and returns the activity notes
// to record. Messages are user-facing.
//
// Roles (finalized by the owner):
//   Requestor  submits and tracks their own requests, confirms meetings and agreements, reviews the evidence, and
//              confirms completion (or returns the work for correction).
//   Developer  the IT worker assigned to a request: planning, meetings, agreements, tasks, timelines, evidence, and
//              the worker's completion confirmation. No assignment authority and no user management.
//   Admin      every request: review, request information, assign to an active Developer or themselves, reject,
//              hold, approve scope changes, and close. An Admin who assigns work to themselves is its worker.
//
// Request types: a Ticket is simple work; a Project needs a confirmed requirements meeting, an agreement confirmed by
// both the worker and the Requestor (then locked), and a timeline before development. The request category
// (bug, enhancement, ...) is separate.
//
// Completion: the worker supplies evidence and marks the work done; the Requestor independently confirms it. Only with
// both current confirmations can an Admin close the request (Projects also need the release/handover first).
// Returning work for correction, reassigning it, or an approved scope change clears earlier confirmations, so a stale
// confirmation can never close changed work. Cleared confirmations stay in completion.log.
(function (root) {
  const TicketCore = typeof module !== 'undefined' ? require('./ticket-core.js') : root.TicketCore;
  const TL = typeof module !== 'undefined' ? require('./timeline-core.js') : root.TicketTimeline;
  const people = TicketCore.people; // sample developers (local demo, inspection, and the beta simulation)
  const SAMPLE_DEVELOPER = people[0];
  // Fictional test identities for simulated views, so switching views shows independent confirmations.
  const SIM_ADMIN = 'Alex Admin';
  const IDENTITIES = { Admin: SIM_ADMIN, Developer: SAMPLE_DEVELOPER };
  const VIEWS = ['Requestor', 'Admin', 'Developer'];
  const STAFF = ['Admin', 'Developer'];
  const TYPES = ['Ticket', 'Project'];
  const DEPARTMENTS = ['Sales', 'Operations', 'Finance', 'Human Resources', 'Procurement', 'Customer Service', 'IT'];
  const CATEGORIES = ['New feature', 'Enhancement', 'Bug / issue', 'Access request'];
  const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
  const EARLY = ['Submitted', 'Under review', 'Waiting for information', 'On hold'];
  const FINAL = ['Closed', 'Rejected', 'Cancelled'];
  const ACTIVE_WORK = ['Planning', 'In progress'];
  const PLANNING = ['Assigned', 'Meeting scheduled'];
  const COMPLETING = ['Awaiting acceptance', 'Ready for release', 'Released'];
  const CHANGE_STATUSES = ['Submitted', 'Assessment', 'Awaiting approval', 'Approved', 'Deferred', 'Rejected', 'In progress', 'Awaiting acceptance', 'Accepted', 'Released', 'Closed'];
  const MAX_EVIDENCE = 40;
  const MAX_LINKS = 10;
  // Overview stages: each open or closed request is in exactly one (overdue is counted separately).
  const STAGES = [
    ['new', 'New / unassigned'],
    ['active', 'Active (assigned, planning)'],
    ['awaiting-worker', 'Awaiting worker completion'],
    ['awaiting-requestor', 'Awaiting Requestor confirmation'],
    ['ready', 'Ready for Admin closure'],
    ['closed', 'Closed']
  ];

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
  const typeOf = t => (TYPES.includes(t.type) ? t.type : t.project ? 'Project' : 'Ticket');
  const agreementOf = t => (Array.isArray(t.agreements) && t.agreements.length ? t.agreements[t.agreements.length - 1] : null);
  const completionOf = t => t.completion || { round: 1, worker: null, requestor: null, log: [] };
  const activeEvidence = t => (t.evidence || []).filter(x => !x.removed);
  const bothConfirmed = t => { const c = completionOf(t); return Boolean(c.worker && c.requestor); };
  // Closure gate: both current confirmations, and for a Project the release/handover as well.
  const closable = t => bothConfirmed(t) && (t.status === 'Released' || (t.status === 'Ready for release' && typeOf(t) === 'Ticket'));

  // A link supplied as evidence: http or https only, no embedded credentials. Returns the normalized URL or ''.
  function safeUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > 2000 || /[\s<>"'`]/.test(raw)) return '';
    let u;
    try { u = new URL(raw); } catch { return ''; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname) return '';
    return u.href;
  }

  // Context for simulated views (local demo, inspection, and the beta simulation). Each staff view is one fictional
  // identity, so the worker and the Requestor are always different people. isRequester(ticket) decides which requests
  // the Requestor view owns (default: all it can see).
  function simulatedContext(view, { isRequester = () => true, time } = {}) {
    return {
      view, time,
      actorFor: t => ({ id: `sim:${view}`, name: view === 'Requestor' ? (t && t.name) || 'Requestor' : IDENTITIES[view] }),
      isRequester,
      isWorker: t => Boolean(IDENTITIES[view]) && t.dev === IDENTITIES[view],
      sameParty: () => false,
      // Admins assign to a sample developer or to themselves (the Admin test identity). Developers cannot assign.
      assignee: name => (people.includes(name) || (view === 'Admin' && name === SIM_ADMIN) ? { dev: name } : null),
      assigneeError: 'Choose a sample developer, or assign it to yourself.',
      owners: [...people, SIM_ADMIN]
    };
  }

  // Who the caller is acting as on this ticket. ctx: { view, actorFor(t), isRequester(t), isWorker(t), sameParty(t),
  // assignee(value), owners, time() }. My workspace builds it from the signed-in account; other modes use
  // simulatedContext.
  function roles(ctx, t) {
    if (!VIEWS.includes(ctx.view)) fail('invalid', 'Choose a Requestor, Admin, or Developer view.');
    const admin = ctx.view === 'Admin';
    const worker = STAFF.includes(ctx.view) && Boolean(t.dev) && Boolean(ctx.isWorker && ctx.isWorker(t));
    const req = ctx.view === 'Requestor' && (!ctx.isRequester || ctx.isRequester(t));
    // When the Requestor is also the worker, an Admin other than the worker reviews for the Requestor side.
    const reviewer = admin && !worker && Boolean(ctx.sameParty && ctx.sameParty(t));
    return { admin, worker, req, reviewer, any: admin || worker || req };
  }
  const allow = (ok, message = 'This action is not available in the current view.') => { if (!ok) fail('forbidden', message); };
  const inState = (ok, message = 'This ticket has moved on since it was opened. Refresh and try again.') => { if (!ok) fail('state', message); };
  const actorOf = (ctx, t) => (ctx.actorFor ? ctx.actorFor(t) : { id: `view:${ctx.view}`, name: ctx.view });
  const stamp = ctx => (ctx.time ? ctx.time() : '');
  const record = (ctx, t, extra = {}) => { const a = actorOf(ctx, t); return { name: a.name, id: a.id, view: ctx.view, time: stamp(ctx), ...extra }; };
  // The Requestor-side confirmation (agreement or completion), from the Requestor or an independent reviewer, never
  // from the account that confirmed as the worker.
  function requestorSide(ctx, t, r, workerConfirmation) {
    const same = Boolean(ctx.sameParty && ctx.sameParty(t));
    allow(r.reviewer || (r.req && !same), same && !r.admin ? 'The Requestor is also the worker on this request, so a different Admin must confirm it independently.' : undefined);
    if (workerConfirmation && workerConfirmation.id === actorOf(ctx, t).id) fail('forbidden', 'The worker\'s confirmation cannot also count as the Requestor\'s. A different person must confirm.');
  }

  // Clears both completion confirmations (kept in the log) when the deliverable changes. Returns notes.
  function invalidate(t, why, ctx) {
    const c = completionOf(t);
    const had = c.worker || c.requestor;
    t.completion = { round: c.round + (had ? 1 : 0), worker: null, requestor: null, log: [...(c.log || []), ...(had ? [{ event: 'cleared', reason: why, worker: c.worker, requestor: c.requestor, time: stamp(ctx) }] : [])] };
    return had ? [`Completion confirmations cleared: ${why}`] : [];
  }

  function validateProjectTasks(tasks, target) {
    if (!tasks.length) return 'Add at least one task.';
    for (const task of tasks) {
      const err = TL.validateTask(task); if (err) return err;
      if (task.end > target) return 'A task ends after the delivery target. Choose a later target or earlier task dates.';
    }
    return '';
  }
  function readTask(input, owners = people) {
    const task = {};
    for (const key of ['title', 'requirement', 'criteria', 'start', 'end', 'owner']) task[key] = String(input?.[key] ?? '').trim();
    if (task.title.length > 150) fail('invalid', 'Task name is too long (maximum 150 characters).');
    if (task.owner && !owners.includes(task.owner)) fail('invalid', owners === people ? 'Choose a task owner from the sample developers.' : 'Choose a task owner from the list.');
    return task;
  }

  // New request from the form. Field order matches the prototype's stored records.
  function createTicket(input, nextId) {
    const t = { ...input };
    text(t.title, 'Request summary', { max: 150 });
    text(t.description, 'Request description');
    if (!TYPES.includes(t.type)) fail('invalid', 'Choose a request type: Ticket or Project.');
    // date is the requestor's requested target; requestedDate keeps it after an agreed delivery date replaces date.
    return { ticket: { ...t, id: nextId, status: 'Submitted', priority: 'Medium', dev: '', tasks: [], history: [], requestedDate: t.date, evidence: [], completion: { round: 1, worker: null, requestor: null, log: [] } }, notes: [`${t.type} submitted. Admin notified.`] };
  }

  // Applies one ticket action. Returns the notes to add to the ticket's activity, in order.
  function ticketAction(t, action, input = {}, ctx) {
    const r = roles(ctx, t);
    const { admin, worker, req } = r;
    const type = typeOf(t);
    const agreement = agreementOf(t);
    switch (action) {
      case 'comment': {
        allow(r.any || r.reviewer);
        const comment = text(input.comment, 'Comment', { max: 2000 });
        return [`${ctx.view}: ${comment}`];
      }
      case 'status': {
        const to = input.status;
        if (to === 'Under review') {
          allow(admin || req);
          inState((admin && EARLY.includes(t.status)) || (req && t.status === 'Waiting for information'));
        } else if (to === 'In progress') {
          allow(worker, 'Only the assigned worker can start the work.');
          if (type === 'Project') {
            inState(agreement && t.project && t.status === 'Planning', !agreement ? 'A Project needs a confirmed requirements meeting and a locked agreement before development.' : !t.project ? 'Create the project timeline first.' : undefined);
            if (t.tasks.every(x => x.done)) fail('invalid', 'Add or reopen a task before starting development');
          } else inState(PLANNING.includes(t.status));
        } else if (to === 'Released') {
          allow(worker, 'Only the assigned worker confirms the release or handover.');
          inState(t.status === 'Ready for release' && bothConfirmed(t), 'Both completion confirmations are needed before the release or handover.');
        } else if (to === 'Closed') {
          allow(admin, 'Only an Admin can close a request.');
          inState(closable(t), !bothConfirmed(t) ? 'An Admin can close only after both the worker and the Requestor have confirmed completion.' : 'Confirm the release or handover first.');
        } else fail('invalid', 'Unknown status change.');
        t.status = to;
        return [`${ctx.view}: status changed to ${t.status}.`];
      }
      case 'reason': {
        const status = input.status;
        if (status === 'In progress') {
          // Return for correction: from the Requestor (or independent reviewer) while confirming, or from an Admin
          // before closure. Clears both confirmations; the reason is kept.
          allow(req || r.reviewer || admin);
          inState(admin ? COMPLETING.includes(t.status) : ['Awaiting acceptance', 'Ready for release'].includes(t.status));
        } else {
          const rules = {
            'Waiting for information': admin && EARLY.includes(t.status),
            Rejected: admin && EARLY.includes(t.status),
            'On hold': admin && !FINAL.includes(t.status),
            Cancelled: req && EARLY.includes(t.status)
          };
          if (!(status in rules)) fail('invalid', 'Unknown decision.');
          allow(status === 'Cancelled' ? req : admin);
          inState(rules[status]);
        }
        const reason = text(input.reason, 'Reason', { max: 2000 });
        const notes = [];
        if (status === 'In progress') {
          const c = completionOf(t);
          t.corrections = [...(t.corrections || []), { round: c.round, reason, ...record(ctx, t) }];
          notes.push(`${ctx.view}: Returned for correction. ${reason}`, ...invalidate(t, 'returned for correction.', ctx));
          if (t.tasks.length && t.tasks.every(x => x.done)) t.tasks[t.tasks.length - 1].done = false;
        } else {
          notes.push(`${ctx.view}: ${status}. ${reason}`);
          // Work put on hold after completion must be confirmed again when it resumes.
          if (status === 'On hold' && COMPLETING.includes(t.status)) notes.push(...invalidate(t, 'put on hold.', ctx));
        }
        t.status = status;
        return notes;
      }
      case 'assign': {
        allow(admin, 'Only an Admin assigns work.');
        if (FINAL.includes(t.status)) fail('state', 'This ticket is no longer active');
        inState(!['Ready for release', 'Released'].includes(t.status), 'Both confirmations are recorded. Return the work for correction before reassigning it.');
        const value = String(input.dev || '');
        if (!value) fail('invalid', 'Choose an assignee first');
        const assignee = ctx.assignee ? ctx.assignee(value) : null;
        if (!assignee) fail('invalid', ctx.assigneeError || 'Choose an active Developer, or assign it to yourself.');
        if (!PRIORITIES.includes(input.priority)) fail('invalid', 'Choose a priority.');
        const changed = assignee.dev !== t.dev || (assignee.devId || '') !== (t.devId || '');
        const notes = [];
        Object.assign(t, assignee); t.priority = input.priority;
        if (EARLY.includes(t.status)) t.status = 'Assigned';
        const self = actorOf(ctx, t).name === t.dev && admin && ctx.isWorker && ctx.isWorker(t);
        notes.push(`${ctx.view} ${self ? 'assigned it to themselves' : `assigned ${t.dev}`}. Priority: ${t.priority}.`);
        if (changed && t.status === 'Awaiting acceptance') { notes.push(...invalidate(t, `reassigned to ${t.dev}.`, ctx)); t.status = 'In progress'; }
        return notes;
      }
      case 'set-type': {
        allow(admin, 'Only an Admin changes the request type.');
        inState(!t.project && [...EARLY, ...PLANNING].includes(t.status) && !agreement, 'The request type can change only before planning is agreed.');
        if (!TYPES.includes(input.type)) fail('invalid', 'Choose Ticket or Project.');
        if (input.type === type) fail('invalid', `This request is already a ${type}.`);
        t.type = input.type;
        delete t.typeSource; // no longer the migration's classification
        if (t.type === 'Ticket') delete t.agreementDraft;
        return [`Admin changed the request type to ${t.type}.`];
      }
      case 'schedule-meeting': case 'edit-meeting': {
        allow(worker, 'Only the assigned worker schedules the requirements meeting.');
        inState(!agreement && (PLANNING.includes(t.status) || (t.project && ACTIVE_WORK.includes(t.status))), agreement ? 'The agreement is locked. Use a scope change request for new requirements.' : undefined);
        Object.assign(t, meetingInput(input), { meetingConfirmed: false });
        if (!t.project) t.status = 'Meeting scheduled';
        const notes = [t.meeting && action === 'edit-meeting' ? 'Requirements meeting updated; Requestor confirmation requested.' : 'Meeting proposed. Requestor confirmation requested.'];
        if (t.agreementDraft) { delete t.agreementDraft; notes.push('The unconfirmed agreement draft was withdrawn because the meeting changed.'); }
        return notes;
      }
      case 'confirm-meeting': {
        requestorSide(ctx, t, r, null);
        inState(t.meeting && !t.meetingConfirmed);
        t.meetingConfirmed = true;
        t.meetingConfirmedBy = record(ctx, t);
        return [`${r.reviewer ? 'Independent reviewer' : 'Requestor'} confirmed the meeting schedule.`];
      }
      case 'record-agreement': {
        allow(worker, 'Only the assigned worker records the agreement.');
        inState(type === 'Project', 'Agreements are for Projects. An Admin can change the request type.');
        inState(!agreement, 'The agreement is locked. Use a scope change request for new requirements.');
        inState(PLANNING.includes(t.status) || (t.project && ACTIVE_WORK.includes(t.status)));
        inState(t.meeting && t.meetingConfirmed, 'Hold the requirements meeting first: schedule it and have the Requestor confirm it.');
        const draft = {
          meeting: { at: t.meeting, location: t.location || '' },
          notes: text(input.notes, 'Meeting notes', { max: 5000 }),
          requirements: text(input.requirements, 'Agreed requirements', { max: 5000 }),
          criteria: text(input.criteria, 'Acceptance criteria', { max: 5000 }),
          recordedBy: record(ctx, t), worker: null, requestor: null
        };
        const replaced = Boolean(t.agreementDraft);
        t.agreementDraft = draft;
        return [`${replaced ? 'Agreement draft updated' : 'Requirements agreement recorded'}. Worker and Requestor confirmations requested.`];
      }
      case 'confirm-agreement': {
        const draft = t.agreementDraft;
        inState(draft && !agreement, agreement ? 'The agreement is already locked.' : 'There is no agreement to confirm yet.');
        let side;
        if (worker) { inState(!draft.worker, 'You have already confirmed this agreement.'); side = 'worker'; }
        else { requestorSide(ctx, t, r, draft.worker); inState(!draft.requestor, 'The Requestor side has already confirmed this agreement.'); side = 'requestor'; }
        draft[side] = record(ctx, t);
        const notes = [`${side === 'worker' ? 'Worker' : r.reviewer ? 'Independent reviewer' : 'Requestor'} confirmed the requirements agreement.`];
        if (draft.worker && draft.requestor) {
          const version = { version: 1, source: 'Requirements meeting', meeting: draft.meeting, notes: draft.notes, requirements: draft.requirements, criteria: draft.criteria, recordedBy: draft.recordedBy, worker: draft.worker, requestor: draft.requestor, lockedAt: stamp(ctx) };
          t.agreements = [...(t.agreements || []), version];
          delete t.agreementDraft;
          Object.assign(t, { requirements: version.requirements, criteria: version.criteria, notes: version.notes });
          notes.push('Agreement v1 locked. Later changes need an approved scope change.');
        }
        return notes;
      }
      case 'create-project': {
        allow(worker, 'Only the assigned worker creates the project timeline.');
        inState(type === 'Project', 'Tickets do not need a project. An Admin can change the request type.');
        inState(!t.project && PLANNING.includes(t.status), t.project ? 'This ticket already has a project.' : undefined);
        inState(agreement, 'A Project needs a confirmed requirements meeting and a locked agreement before its timeline.');
        const projectName = text(input.projectName, 'Project name', { max: 150 });
        if (!isDate(input.date)) fail('invalid', 'Enter a valid delivery target date.');
        const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(x => readTask(x, ctx.owners));
        const error = validateProjectTasks(tasks, input.date);
        if (error) fail('invalid', error);
        // The delivery target becomes the agreed delivery date (dueDate); the requested date is kept.
        Object.assign(t, {
          project: 'PRJ-' + t.id.split('-')[1], projectName,
          requestedDate: t.requestedDate || t.date, date: input.date, dueDate: input.date, status: 'Planning', tasks: tasks.map(x => ({ ...x, done: false }))
        });
        return [`Project timeline created from agreement v${agreement.version}: ${tasks.length} task(s), delivery target ${input.date}. Requestor and Admin notified.`];
      }
      case 'toggle-task': {
        allow(worker, 'Task progress is updated by the assigned worker.');
        inState(ACTIVE_WORK.includes(t.status));
        const task = t.tasks[Number(input.index)];
        if (!task || !Number.isInteger(Number(input.index))) fail('invalid', 'That task no longer exists. Refresh and try again.');
        task.done = Boolean(input.done);
        return [`${task.done ? 'Completed' : 'Reopened'} task: ${task.title}`];
      }
      case 'save-task': {
        allow(worker, 'Tasks are managed by the assigned worker.');
        inState(t.project && ACTIVE_WORK.includes(t.status));
        const index = input.index === null || input.index === undefined ? null : Number(input.index);
        if (index !== null && !t.tasks[index]) fail('invalid', 'That task no longer exists. Refresh and try again.');
        const next = readTask(input.task, ctx.owners);
        const error = TL.validateTask(next); if (error) fail('invalid', error);
        const target = t.dueDate || t.date;
        if (next.end > target) fail('invalid', 'Task ends after the agreed delivery target. Only an approved scope change moves the target.');
        next.done = Boolean(input.task && input.task.done);
        const before = index === null ? null : t.tasks[index];
        if (index === null) t.tasks.push(next); else t.tasks[index] = { ...before, ...next };
        // Scheduling changes are recorded with their old and new values.
        const moved = before && (before.start !== next.start || before.end !== next.end) ? ` Schedule changed from ${before.start || 'unscheduled'} → ${before.end || 'unscheduled'} to ${next.start} → ${next.end}.` : '';
        const owner = before && (before.owner || '') !== next.owner ? ` Owner changed from ${before.owner || 'none'} to ${next.owner || 'none'}.` : '';
        return [`${index === null ? `Added dated task: ${next.title} (${next.start} → ${next.end}).` : `Updated task: ${next.title}.`}${moved}${owner}`];
      }
      case 'edit-scope':
        fail('state', 'Agreed requirements and the delivery target are locked. Request a scope change instead.');
        break;
      case 'add-evidence': {
        allow(worker, 'Evidence is supplied by the assigned worker.');
        inState(t.status === 'In progress', 'Start the work before adding evidence.');
        const files = Array.isArray(input.files) ? input.files : []; // set by the server from the claimed uploads
        const links = (Array.isArray(input.links) ? input.links : []).filter(l => l && String(l.url || '').trim());
        if (links.length > MAX_LINKS) fail('invalid', `Add up to ${MAX_LINKS} links at a time.`);
        const items = links.map(l => {
          const url = safeUrl(l.url);
          if (!url) fail('invalid', 'Links must be complete http:// or https:// addresses.');
          return { kind: 'link', url, label: text(l.label, 'Link label', { required: false, max: 150 }) || url };
        }).concat(files.map(f => ({ kind: 'file', file: { id: f.id, name: f.name, size: f.size, type: f.type } })));
        if (!items.length) fail('invalid', 'Attach a file or add a deliverable link.');
        if (activeEvidence(t).length + items.length > MAX_EVIDENCE) fail('invalid', `Keep evidence to ${MAX_EVIDENCE} items. Remove an older item first.`);
        const by = record(ctx, t, { round: completionOf(t).round });
        t.evidence = [...(t.evidence || []), ...items.map(x => ({ ...x, added: by }))];
        return [`Evidence added: ${items.map(x => x.kind === 'link' ? x.label : x.file.name).join(', ')}.`];
      }
      case 'remove-evidence': {
        allow(worker, 'Evidence is managed by the assigned worker.');
        inState(t.status === 'In progress', 'Evidence can change only while the work is in progress.');
        const item = (t.evidence || [])[Number(input.index)];
        if (!item || item.removed || !Number.isInteger(Number(input.index))) fail('invalid', 'That evidence item no longer exists. Refresh and try again.');
        item.removed = record(ctx, t);
        return [`Evidence removed: ${item.kind === 'link' ? item.label : item.file.name}.`];
      }
      case 'worker-complete': {
        allow(worker, 'Only the assigned worker confirms their work is done.');
        const c = completionOf(t);
        // In progress, or a record from before dual confirmation that is missing the worker's confirmation.
        inState(t.status === 'In progress' || (COMPLETING.includes(t.status) && !c.worker));
        if (type === 'Project' && !agreement) fail('state', 'Record and confirm the requirements agreement first.');
        if (type === 'Project' && (!t.tasks.length || t.tasks.some(x => !x.done))) fail('invalid', 'Complete all project tasks, including internal testing, first');
        if (!activeEvidence(t).length) fail('invalid', 'Add at least one evidence file or deliverable link before marking the work done.');
        const summary = text(input.summary, 'Delivery and testing summary', { max: 2000 });
        const notes = t.status === 'In progress' && c.requestor ? invalidate(t, 'the work was completed again.', ctx) : [];
        const current = completionOf(t);
        t.completion = { ...current, worker: record(ctx, t, { round: current.round }), summary };
        if (t.status === 'In progress') t.status = 'Awaiting acceptance';
        return [...notes, `Worker marked the work done. Requestor confirmation requested. ${summary}`];
      }
      case 'withdraw-completion': {
        allow(worker);
        const c = completionOf(t);
        inState(t.status === 'Awaiting acceptance' && c.worker && !c.requestor);
        const notes = ['Worker withdrew their completion to change the deliverable.', ...invalidate(t, 'the worker withdrew their completion.', ctx)];
        t.status = 'In progress';
        return notes;
      }
      case 'requestor-confirm': {
        const c = completionOf(t);
        requestorSide(ctx, t, r, c.worker);
        inState(c.worker && !c.requestor && COMPLETING.includes(t.status), !c.worker ? 'The worker has not marked the work done yet.' : undefined);
        t.completion = { ...c, requestor: record(ctx, t, { round: c.round }) };
        if (t.status === 'Awaiting acceptance') t.status = 'Ready for release';
        return [`${r.reviewer ? 'Independent reviewer' : 'Requestor'} reviewed the evidence and confirmed completion.${type === 'Ticket' ? ' Ready for Admin closure.' : ' Release or handover next, then Admin closure.'}`];
      }
      case 'submit-acceptance':
        fail('state', 'Add evidence and use "Mark my work done" instead.');
        break;
      default: fail('invalid', 'Unknown action.');
    }
  }
  function meetingInput(input) {
    const meeting = text(input.meeting, 'Date and time', { max: 40 });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(meeting)) fail('invalid', 'Enter the meeting date and time.');
    return { meeting, location: text(input.location, 'Location', { max: 200 }) };
  }

  // New linked change from a ticket with a project.
  function createChange(t, input, nextId, ctx) {
    const r = roles(ctx, t);
    allow(r.any || r.reviewer);
    inState(Boolean(t.project), 'Scope changes are linked to tickets that have a project.');
    const c = { ...input, id: nextId, ticket: t.id, status: 'Submitted', impact: '', history: [] };
    text(c.title, 'Change summary', { max: 150 });
    text(c.reason, 'Business reason');
    text(c.criteria, 'Acceptance criteria');
    return { change: c, changeNotes: ['Change submitted. Admin review requested.'], ticketNotes: [`${c.id} linked: ${c.title}. Original work continues unless explicitly put on hold.`] };
  }

  // Applies one change action. Returns { notes, ticketEffect } where ticketEffect(ticket) applies any change to the
  // original ticket (approval adds a task, a new agreement version, and the revised target; release and closure
  // complete the task) and returns that ticket's notes.
  function changeAction(c, t, action, input = {}, ctx) {
    const r = roles(ctx, t);
    const { admin, worker } = r;
    const req = r.req || r.reviewer;
    const moved = 'This change has moved on since it was opened. Refresh and try again.';
    const completeTask = ticket => { const task = ticket.tasks.find(x => x.title.startsWith(c.id + ':')); if (task) task.done = true; return []; };
    switch (action) {
      case 'status': {
        const to = input.status;
        const rules = {
          Assessment: admin && ['Submitted', 'Deferred'].includes(c.status),
          'In progress': worker && c.status === 'Approved',
          Accepted: req && c.status === 'Awaiting acceptance',
          Released: worker && c.status === 'Accepted',
          Closed: admin && c.status === 'Released'
        };
        if (!(to in rules)) fail('invalid', 'Unknown change status.');
        allow({ Assessment: admin, 'In progress': worker, Accepted: req, Released: worker, Closed: admin }[to]);
        inState(rules[to], moved);
        c.status = to;
        return { notes: [`${ctx.view}: change moved to ${c.status}.`], ticketEffect: ['Released', 'Closed'].includes(to) ? completeTask : null };
      }
      case 'assess': {
        allow(worker, 'The assigned worker assesses the impact.');
        inState(c.status === 'Assessment', moved);
        const impact = text(input.impact, 'Impact assessment');
        const effort = text(input.effort, 'Effort estimate', { max: 100 });
        if (!isDate(input.date)) fail('invalid', 'Enter a valid revised delivery date.');
        Object.assign(c, { impact, effort, date: input.date }, { status: 'Awaiting approval', requestorAgreed: false });
        return { notes: ['Worker assessed impact. Requestor agreement requested.'], ticketEffect: null };
      }
      case 'agree': {
        allow(req);
        inState(c.status === 'Awaiting approval' && !c.requestorAgreed, moved);
        c.requestorAgreed = true;
        c.requestorAgreedBy = record(ctx, t);
        return { notes: ['Requestor agreed to revised scope, estimate, and target date. Admin approval requested.'], ticketEffect: null };
      }
      case 'approve': {
        allow(admin, 'Only an Admin approves scope changes.');
        inState(c.status === 'Awaiting approval' && c.requestorAgreed, 'The requestor must agree before approval.');
        const approval = record(ctx, t);
        c.status = 'Approved'; c.approvedBy = approval.name; c.approvedAt = approval.time;
        return {
          notes: ['Admin approved change. Project plan updated.'],
          ticketEffect: ticket => {
            const notes = [];
            ticket.tasks.push({ title: `${c.id}: ${c.title}`, done: false });
            const open = !['Closed', 'Released'].includes(ticket.status);
            const previous = ticket.dueDate || ticket.date;
            if (open) { ticket.date = c.date; ticket.dueDate = c.date; }
            // A new agreement version; the earlier versions are kept unchanged.
            const prior = agreementOf(ticket);
            if (prior) {
              ticket.agreements = [...ticket.agreements, {
                version: prior.version + 1, source: c.id,
                requirements: `${prior.requirements}\n\n${c.id}: ${c.title}. ${c.reason}`, criteria: `${prior.criteria}\n\n${c.id}: ${c.criteria}`,
                notes: c.impact, requestor: c.requestorAgreedBy || null, approvedBy: approval, lockedAt: approval.time
              }];
              Object.assign(ticket, { requirements: agreementOf(ticket).requirements, criteria: agreementOf(ticket).criteria });
            }
            notes.push(`${c.id} approved and added to the project plan${prior ? ` as agreement v${prior.version + 1}` : ''}.${open && previous !== c.date ? ` Delivery target changed from ${previous || 'not set'} to ${c.date}.` : ''}`);
            if (['Awaiting acceptance', 'Ready for release'].includes(ticket.status)) {
              notes.push(...invalidate(ticket, `the agreed scope changed (${c.id}).`, ctx));
              ticket.status = 'In progress';
            }
            return notes;
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
        inState(rules[next], moved);
        const reason = text(input.reason, 'Reason', { max: 2000 });
        if (next === 'Deferred' && !isDate(input.reviewDate)) fail('invalid', 'Enter a valid review date.');
        c.status = next;
        if (input.reviewDate) c.reviewDate = input.reviewDate;
        return { notes: [`${ctx.view}: ${next}. ${reason}`], ticketEffect: null };
      }
      case 'submit-test': {
        allow(worker);
        inState(c.status === 'In progress', moved);
        const results = text(input.results, 'Testing results', { max: 2000 });
        c.status = 'Awaiting acceptance';
        return { notes: ['Internal testing passed. ' + results], ticketEffect: null };
      }
      default: fail('invalid', 'Unknown action.');
    }
  }

  // The overview stage of a request (see STAGES), or 'ended' for rejected and cancelled requests.
  function stageOf(t) {
    if (t.status === 'Closed') return 'closed';
    if (FINAL.includes(t.status)) return 'ended';
    if (!t.dev) return 'new';
    if (t.status === 'In progress') return 'awaiting-worker';
    if (!COMPLETING.includes(t.status)) return 'active';
    const c = completionOf(t);
    if (!c.worker) return 'awaiting-worker';
    if (!c.requestor) return 'awaiting-requestor';
    return closable(t) ? 'ready' : 'awaiting-worker'; // a Project awaiting its release or handover
  }

  // Steps a record's status implies but that were never recorded: typically records from before locked agreements and
  // dual confirmation (a project without an agreement, or a completed request without confirmations). Nothing is
  // filled in on anyone's behalf; the labels say what is missing.
  function missingSteps(t) {
    const out = [];
    const c = completionOf(t);
    if (typeOf(t) === 'Project' && t.project && !FINAL.includes(t.status)) {
      if (!t.meeting) out.push('Requirements meeting not scheduled');
      else if (!t.meetingConfirmed) out.push('Requirements meeting not confirmed by the Requestor');
      if (!agreementOf(t)) out.push(t.agreementDraft ? 'Agreement awaiting confirmation' : 'Requirements agreement not recorded');
    }
    if (COMPLETING.includes(t.status) || t.status === 'Closed') {
      if (!c.worker) out.push('Worker completion not recorded');
      if (!c.requestor && t.status !== 'Awaiting acceptance') out.push('Requestor confirmation not recorded');
    }
    return out;
  }

  const api = { WorkflowError, VIEWS, STAFF, TYPES, STAGES, SAMPLE_DEVELOPER, SIM_ADMIN, IDENTITIES, DEPARTMENTS, CATEGORIES, PRIORITIES, CHANGE_STATUSES, EARLY, FINAL, COMPLETING, MAX_EVIDENCE, validateProjectTasks, createTicket, ticketAction, createChange, changeAction, simulatedContext, roles, typeOf, agreementOf, completionOf, activeEvidence, bothConfirmed, closable, stageOf, missingSteps, safeUrl };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WorkflowCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
