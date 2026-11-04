/* Guided next actions: the "Needs your action" home queues, the next-step panel and progress tracker on every
   request, the working-area layout of request details, "Show me", and guided form validation.
   Presentation and navigation only. Which step comes next, and whether it is yours, comes from
   WorkflowCore.nextStep, which tries the real workflow actions; every save still goes through perform(), so the
   server (or WorkflowCore in local modes) checks it again. Classic script loaded after completion.js; it wraps
   detail(), changeDetail(), and open() once every script has loaded, so it sees the sections the others add. */

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The caller's capacities on a request, built like the server's (My workspace) or as the simulated view.
function guideContexts(t) {
  if (!accounts) return [WorkflowCore.simulatedContext(role, { time: stamp })];
  const staff = ['Admin', 'Developer'].includes(signedIn.role);
  const common = {
    time: stamp,
    actorFor: () => ({ id: me, name: signedIn.displayName }),
    isRequester: x => Boolean(x.requester && x.requester.id === me),
    isWorker: x => staff && x.devId === me,
    sameParty: x => sameParty(x),
    assignee: id => { const d = signedIn.role === 'Admin' && (server.developers || []).find(x => x.id === String(id)); return d ? { dev: d.name, devId: d.id } : null; },
    owners: ownerChoices(t)
  };
  return [...(staff ? [{ ...common, view: signedIn.role }] : []), ...(common.isRequester(t) ? [{ ...common, view: 'Requestor' }] : [])];
}
// Cached per request version and view: every saved change adds an activity entry, so the key changes with it.
const stepCache = new Map();
function stepFor(t) {
  const key = [role, t.id, t.version || '', t.status, t.history.length, (t.tasks || []).filter(x => x.done).length, (t.evidence || []).length].join('|');
  if (!stepCache.has(key)) { if (stepCache.size > 2000) stepCache.clear(); stepCache.set(key, WorkflowCore.nextStep(t, guideContexts(t))); }
  return stepCache.get(key);
}

// Who takes a step, in words.
function whoActs(step, t) {
  if (step.party === 'worker') return `${t.dev || 'The assigned worker'} (worker)`;
  if (step.party === 'requestor') return step.independent ? `An Admin other than the worker (independent review, because ${independentReason(t)})` : `${t.name} (Requestor)`;
  return 'An Admin';
}
// Simulated modes only: which view takes the step (never offered in My workspace).
function handoffView(step, t) {
  if (accounts) return null;
  if (step.party === 'admin') return 'Admin';
  if (step.party === 'requestor') return 'Requestor';
  return Object.keys(WorkflowCore.IDENTITIES).find(v => WorkflowCore.IDENTITIES[v] === t.dev) || null;
}
function switchView(next, id) {
  const select = $('#demo-role');
  select.value = next;
  select.dispatchEvent(new Event('change'));
  const reopen = () => { if (visible().some(x => x.id === id)) detail(id); };
  if (shared) window.addEventListener('jarc-workspace-loaded', reopen, { once: true }); else reopen();
}

// How each step appears in details: the sections that form the working area, the primary button, and the control it
// uses (click: the same button the section shows; focus: the field to fill in).
const STEP_UI = {
  'provide-info': { sections: ['information', 'activity'], button: 'Add the information', focus: '#comment-form textarea' },
  review: { sections: ['admin', 'details'], button: 'Start the review', click: '[data-section="admin"] [data-action="Under review"]' },
  resume: { sections: ['admin', 'details'], button: 'Resume the review', click: '[data-section="admin"] [data-action="Under review"]' },
  assign: { sections: ['admin', 'details'], button: 'Choose an assignee', focus: '#assignee' },
  'schedule-meeting': { sections: ['planning', 'meeting-plan', 'details'], button: 'Schedule the meeting', click: '#schedule, #edit-meeting' },
  'confirm-meeting': { sections: ['meeting', 'details'], button: 'Confirm the meeting', click: '#confirm-meeting' },
  'record-agreement': { sections: ['agreement', 'meeting', 'details'], button: 'Record the agreement', click: '#record-agreement' },
  'confirm-agreement-worker': { sections: ['agreement'], button: 'Review and confirm', review: '[data-section="agreement"]', focus: '#confirm-agreement' },
  'confirm-agreement': { sections: ['agreement'], button: 'Review and confirm', review: '[data-section="agreement"]', focus: '#confirm-agreement' },
  'create-project': { sections: ['planning', 'agreement'], button: 'Create the timeline', click: '#create-project' },
  start: { sections: ['planning', 'tasks', 'details'], button: t => (WorkflowCore.typeOf(t) === 'Project' ? 'Start development' : 'Start work'), click: '[data-action="In progress"]' },
  tasks: { sections: ['tasks', 'project'], button: 'Go to the open tasks', focus: '[data-task]:not(:checked)' },
  'add-evidence': { sections: ['evidence', 'confirmations'], button: 'Add evidence', focus: '#evidence-form [name=url0]' },
  'worker-complete': { sections: ['evidence', 'confirmations'], button: 'Mark my work done', click: '#worker-complete' },
  'requestor-confirm': { sections: t => ['evidence', 'confirmations', WorkflowCore.agreementOf(t) ? 'agreement' : 'details'], button: 'Review the evidence', review: '[data-section="evidence"]', focus: '#requestor-confirm' },
  'legacy-return': { sections: ['confirmations', 'evidence'], button: 'Return to the worker', click: '[data-section="confirmations"] [data-reason="In progress"]' },
  'legacy-return-admin': { sections: ['confirmations', 'evidence'], button: 'Return to the worker', click: '[data-section="confirmations"] [data-reason="In progress"]' },
  close: { sections: ['confirmations', 'evidence'], button: 'Close the request', click: '[data-section="confirmations"] [data-action="Closed"]' },
  release: { sections: ['confirmations', 'evidence'], button: 'Confirm release / handover', click: '[data-section="confirmations"] [data-action="Released"]' }
};
const valueOf = (v, t) => (typeof v === 'function' ? v(t) : v);
const inDialog = sel => $('#dialog-content') && $('#dialog-content').querySelector(sel);

// Expands the section holding the element, scrolls to it, and focuses it.
function showMe(selector, scrollTo) {
  const el = inDialog(selector);
  if (!el) return false;
  for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
  const target = (scrollTo && inDialog(scrollTo)) || el;
  if (target !== el) { const d = target.closest('details'); if (d) d.open = true; }
  target.scrollIntoView({ block: target === el ? 'center' : 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  if (!el.matches('a,button,input,select,textarea,summary,[tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  return true;
}

// ---- Progress tracker ----
function trackerItems(t) {
  const c = WorkflowCore.completionOf(t), project = WorkflowCore.typeOf(t) === 'Project';
  return [
    ['Submitted', true],
    ['Assigned', Boolean(t.dev)],
    ...(project ? [['Agreement locked', Boolean(WorkflowCore.agreementOf(t))], ['Timeline', Boolean(t.project)]] : []),
    [project ? 'Development' : 'Work started', ['In progress', ...WorkflowCore.COMPLETING, 'Closed'].includes(t.status) || Boolean(c.worker)],
    ['Worker done', Boolean(c.worker)],
    ['Requestor confirmed', Boolean(c.requestor)],
    ...(project ? [['Handover', ['Released', 'Closed'].includes(t.status)]] : []),
    ['Closed', t.status === 'Closed']
  ];
}
function tracker(t) {
  if (['Rejected', 'Cancelled'].includes(t.status)) return `<p class="tracker-ended">${pill(t.status)} This request is ${t.status.toLowerCase()} and needs no further steps.</p>`;
  const items = trackerItems(t);
  const currentAt = items.findIndex(([, done]) => !done);
  return `<ol class="tracker" aria-label="Progress">${items.map(([label, done], i) => `<li class="${done ? 'done' : i === currentAt ? 'current' : 'todo'}"${i === currentAt ? ' aria-current="step"' : ''}><span class="tracker-mark" aria-hidden="true">${done ? '✓' : i === currentAt ? '●' : '○'}</span>${esc(label)}<span class="sr-only">${done ? ': done' : i === currentAt ? ': current step' : ': not yet'}</span></li>`).join('')}</ol>`;
}

// ---- Next-step panel ----
function nextStepPanel(t, step) {
  if (!step) {
    const closed = t.status === 'Closed';
    return `<section class="next-step done" id="next-step" data-guide-view="${esc(role)}" aria-labelledby="ns-title"><p class="ns-eyebrow">Next step</p><h3 id="ns-title" tabindex="-1">${closed ? 'Nothing more to do' : `This request is ${esc(t.status.toLowerCase())}`}</h3><p>${closed ? 'Both confirmations were recorded and an Admin closed the request. The history stays below.' : 'No further workflow steps apply. The history stays below.'}</p></section>`;
  }
  const ui = STEP_UI[step.key] || {};
  const mine = Boolean(step.mine);
  // The capacity the step belongs to (a self-assigned Admin acts as the worker).
  const as = step.party === 'worker' ? 'as the worker' : step.party === 'admin' ? 'as Admin' : step.mine === 'Admin' ? 'as the independent reviewer' : 'as the Requestor';
  const who = mine ? `You${as ? ` (${as})` : ''}` : whoActs(step, t);
  const view = !mine && handoffView(step, t);
  const handoff = !mine && !accounts ? (view
    ? `<p class="ns-handoff"><span aria-hidden="true">⇄</span> Simulation: switch to the <b>${esc(view)}</b> view to ${esc(step.title.charAt(0).toLowerCase() + step.title.slice(1))}. <button type="button" class="secondary" data-switch-view="${esc(view)}">Switch to ${esc(view)}</button></p>`
    : `<p class="ns-handoff"><span aria-hidden="true">⇄</span> Simulation: no view acts as ${esc(t.dev)}. In the Admin view, reassign it to ${esc(WorkflowCore.SAMPLE_DEVELOPER)} or to yourself to continue.</p>`) : '';
  const primary = mine && (ui.click || ui.focus) ? `<button type="button" class="primary" id="ns-primary">${esc(valueOf(ui.button, t))}</button>` : '';
  const showMeButton = (!mine || ui.click) && valueOf(ui.sections, t) ? '<button type="button" class="secondary" id="ns-show">Show me</button>' : '';
  const changes = state.changes.filter(c => c.ticket === t.id).map(c => ({ c, s: WorkflowCore.nextChangeStep(c, t, guideContexts(t)) })).filter(x => x.s && x.s.mine);
  return `<section class="next-step ${mine ? 'mine' : 'waiting'}" id="next-step" data-guide-view="${esc(role)}" aria-labelledby="ns-title">
    <p class="ns-eyebrow">${mine ? 'Next step · your action' : 'Next step · waiting for someone else'}</p>
    <h3 id="ns-title" tabindex="-1">${esc(step.title)}</h3>
    <p class="ns-who"><b>Who:</b> ${esc(who)}</p>
    <p class="ns-why">${esc(step.explain)}</p>
    ${mine ? '' : '<p class="ns-wait">Nothing is needed from you right now.</p>'}
    ${primary || showMeButton ? `<div class="actions">${primary}${showMeButton}</div>` : ''}
    ${handoff}
    ${changes.length ? `<p class="ns-also">Also for you: ${changes.map(x => `<button type="button" class="link-button" data-open-change="${esc(x.c.id)}">${esc(x.c.id)}: ${esc(x.s.title)}</button>`).join(' ')}</p>` : ''}
    <div id="ns-notice" role="status"></div>
  </section>`;
}

// Moves the step's sections into the working area; every other section becomes a collapsed, labelled group.
function arrange(t, step) {
  const work = $('#work-area'), support = $('#support-area');
  if (!work || !support) return;
  const keys = step ? valueOf((STEP_UI[step.key] || {}).sections, t) || [] : ['confirmations', 'evidence', 'details'];
  for (const key of keys) for (const el of document.querySelectorAll(`#support-area [data-section="${key}"]`)) work.append(el);
  if (!work.children.length) { const d = document.querySelector('#support-area [data-section="details"]'); if (d) work.append(d); }
  for (const el of work.querySelectorAll(':scope > [data-section]')) {
    if (el.firstElementChild && el.firstElementChild.tagName === 'H3') continue;
    const h = document.createElement('h3'); h.textContent = el.dataset.title || ''; el.prepend(h);
  }
  const panels = $('#workflow-panels');
  for (const el of [...support.querySelectorAll('[data-section]')]) {
    if (el.closest('details.support') || (el.parentElement !== support && el.parentElement !== panels)) continue;
    const box = document.createElement('details');
    box.className = 'support';
    const first = el.firstElementChild;
    const title = el.dataset.title || (first && first.tagName === 'H3' ? first.textContent : 'More');
    if (first && first.tagName === 'H3' && !el.classList.contains('project-summary')) first.remove();
    box.innerHTML = `<summary>${esc(title)}${el.dataset.count ? ` <small>(${esc(el.dataset.count)})</small>` : ''}</summary>`;
    el.before(box); box.append(el);
  }
  const missing = document.querySelector('#dialog-content [data-keep="top"]');
  if (missing) $('#tracker-slot').after(missing);
  if (!support.children.length || ![...support.children].some(x => x.id !== 'workflow-panels' || x.children.length)) support.hidden = true;
}

function guideDetail(t) {
  const step = stepFor(t);
  $('#next-step-slot').innerHTML = nextStepPanel(t, step);
  $('#tracker-slot').innerHTML = tracker(t);
  arrange(t, step);
  if (WorkflowCore.typeOf(t) === 'Project') $('.drawer').classList.add('wide-drawer');
  const ui = step && STEP_UI[step.key] || {};
  // One primary action: the panel's. The same control in the section below becomes a secondary button.
  for (const b of document.querySelectorAll('#work-area .primary, #support-area .primary')) if (!b.closest('form')) b.classList.replace('primary', 'secondary');
  const primary = $('#ns-primary');
  if (primary) primary.onclick = () => {
    if (ui.click) { const el = inDialog(ui.click); if (el) el.click(); else toast('That action is not available any more. Refresh and try again.'); }
    else showMe(ui.focus, ui.review);
  };
  if ($('#ns-show')) $('#ns-show').onclick = () => {
    const keys = valueOf(ui.sections, t) || ['confirmations'];
    const target = (ui.focus && step.mine && inDialog(ui.focus) && ui.focus) || (ui.click && step.mine && inDialog(ui.click) && ui.click) || keys.map(k => `[data-section="${k}"]`).find(sel => inDialog(sel));
    if (target) showMe(target, ui.review);
  };
  document.querySelectorAll('[data-switch-view]').forEach(b => b.onclick = () => switchView(b.dataset.switchView, t.id));
  document.querySelectorAll('#next-step [data-open-change]').forEach(b => b.onclick = () => changeDetail(b.dataset.openChange));
  setTimeout(() => { const h = $('#ns-title'); if (h && !$('#overlay').hidden) h.focus({ preventScroll: true }); }, 0);
}

// ---- Home: "Needs your action" ----
const QUEUE_TITLES = {
  Admin: { admin: 'Administrative reviews', work: 'Your assigned work', requests: 'Your own requests' },
  Developer: { work: 'Your assigned work', requests: 'Your own requests' },
  Requestor: { requests: 'Needs your action' }
};
const QUEUE_EMPTY = { admin: 'No reviews, assignments, approvals, or closures are waiting.', work: 'Nothing assigned to you needs action.', requests: 'None of your requests needs anything from you.' };
function actionHome(items) {
  const queues = { admin: [], work: [], requests: [] };
  let waiting = 0;
  for (const t of items) {
    const contexts = guideContexts(t), s = stepFor(t);
    if (role === 'Admin' && workerStuck(t)) queues.admin.push({ t, s: { title: 'Reassign this work: the worker can no longer act' } });
    if (s && s.mine) queues[s.party === 'worker' ? 'work' : s.party === 'admin' || s.mine === 'Admin' ? 'admin' : 'requests'].push({ t, s });
    else if (s) waiting++;
    for (const c of state.changes.filter(x => x.ticket === t.id)) {
      const cs = WorkflowCore.nextChangeStep(c, t, contexts);
      if (cs && cs.mine) queues[cs.party === 'worker' ? 'work' : cs.party === 'admin' ? 'admin' : 'requests'].push({ t, c, s: cs });
    }
  }
  const titles = QUEUE_TITLES[role] || QUEUE_TITLES.Requestor;
  const total = Object.values(queues).reduce((n, q) => n + q.length, 0);
  const shown = Object.keys(titles).filter(k => k !== 'requests' || role === 'Requestor' || queues.requests.length);
  const item = ({ t, c, s }) => `<li><button type="button" class="queue-item" ${c ? `data-open-change="${esc(c.id)}"` : `data-open-ticket="${esc(t.id)}"`}><span class="qi-step">${esc(s.title)}</span><span class="qi-req">${esc(c ? `${c.id} · ${c.title} (scope change on ${t.id})` : `${t.id} · ${t.title}`)}</span>${typePill(WorkflowCore.typeOf(t))}</button></li>`;
  return `<section class="home" aria-labelledby="home-title">
    <div class="home-head"><h2 id="home-title">Needs your action</h2><p class="home-summary"><b>${total}</b> need${total === 1 ? 's' : ''} you · <b>${waiting}</b> waiting on others. The bell shows what changed; this list shows what needs you.</p></div>
    <div class="queues">${shown.map(k => `<section class="queue" aria-labelledby="queue-${k}"><h3 id="queue-${k}">${esc(titles[k])} <span class="count">${queues[k].length}</span></h3>${queues[k].length ? `<ul>${queues[k].slice(0, 8).map(item).join('')}</ul>${queues[k].length > 8 ? `<p class="read-only">And ${queues[k].length - 8} more. Use the list below to find them.</p>` : ''}` : `<p class="queue-empty">${QUEUE_EMPTY[k]}</p>`}</section>`).join('')}</div>
  </section>`;
}
function wireHome() {
  document.querySelectorAll('.home [data-open-ticket]').forEach(b => b.onclick = () => detail(b.dataset.openTicket));
  document.querySelectorAll('.home [data-open-change]').forEach(b => b.onclick = () => changeDetail(b.dataset.openChange));
}

// ---- Scope changes: a compact next-step line ----
function guideChange(c, t) {
  const s = WorkflowCore.nextChangeStep(c, t, guideContexts(t));
  const who = s ? (s.mine ? 'You' : s.party === 'worker' ? `${t.dev || 'The assigned worker'} (worker)` : s.party === 'requestor' ? `${t.name} (Requestor)` : 'An Admin') : '';
  const view = s && !s.mine && handoffView(s, t);
  const box = document.createElement('section');
  box.className = `next-step ${s && s.mine ? 'mine' : s ? 'waiting' : 'done'}`;
  box.id = 'next-step';
  box.dataset.guideView = role;
  box.innerHTML = s ? `<p class="ns-eyebrow">${s.mine ? 'Next step · your action' : 'Next step · waiting for someone else'}</p><h3 id="ns-title" tabindex="-1">${esc(s.title)}</h3><p class="ns-who"><b>Who:</b> ${esc(who)}</p>${s.mine ? '<div class="actions"><button type="button" class="secondary" id="ns-show">Show me</button></div>' : '<p class="ns-wait">Nothing is needed from you right now.</p>'}${view ? `<p class="ns-handoff"><span aria-hidden="true">⇄</span> Simulation: switch to the <b>${esc(view)}</b> view for this step. <button type="button" class="secondary" data-switch-view="${esc(view)}">Switch to ${esc(view)}</button></p>` : ''}`
    : `<p class="ns-eyebrow">Next step</p><h3 id="ns-title" tabindex="-1">Nothing more to do on this change</h3>`;
  const anchor = $('#dialog-content h2');
  (anchor && anchor.nextElementSibling ? anchor.nextElementSibling : anchor).after(box);
  if ($('#ns-show')) $('#ns-show').onclick = () => showMe('#dialog-content form button:not([type=button]), #dialog-content .actions button[data-cstatus], #agree-change, #approve-change, #dialog-content form textarea');
  box.querySelectorAll('[data-switch-view]').forEach(b => b.onclick = () => { switchView(b.dataset.switchView, t.id); });
}

// ---- Guided forms: required labels, field-level errors, and a linked error summary, shown only on submit ----
let fieldSeq = 0;
const labelText = el => {
  const label = el.closest('label');
  if (!label) return el.name || 'This field';
  return [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim() || el.name;
};
function messageFor(el) {
  const v = el.validity, label = labelText(el);
  if (el.dataset.missing && v.valueMissing) return el.dataset.missing;
  if (el.dataset.unknown && v.customError) return el.dataset.unknown;
  if (v.valueMissing) return el.type === 'checkbox' ? `Confirm: ${label}` : el.tagName === 'SELECT' ? `Choose ${label.toLowerCase()}.` : `Enter ${label.toLowerCase()}.`;
  if (v.typeMismatch && el.type === 'url') return 'Enter a complete link that starts with https:// or http://.';
  if (v.typeMismatch && el.type === 'email') return 'Enter a work email address, like name@jarcgroup.ph.';
  if (v.badInput || v.rangeUnderflow || v.rangeOverflow) return `Enter a valid ${label.toLowerCase()}.`;
  if (v.tooLong) return `${label} is too long.`;
  return el.validationMessage || `Check ${label.toLowerCase()}.`;
}
function clearFieldError(el) {
  const err = el.id && document.getElementById(`${el.id}-error`);
  if (err) err.remove();
  el.removeAttribute('aria-invalid');
  if (el.dataset.describedBy !== undefined) { if (el.dataset.describedBy) el.setAttribute('aria-describedby', el.dataset.describedBy); else el.removeAttribute('aria-describedby'); }
  const form = el.form, summary = form && form.querySelector('.error-summary');
  if (summary) {
    const link = summary.querySelector(`a[href="#${CSS.escape(el.id)}"]`);
    if (link) link.closest('li').remove();
    if (!summary.querySelector('li')) summary.remove();
  }
}
// errors: [{ field, message }]. Shows each next to its field and in a summary at the top that links to them.
function formErrors(form, errors) {
  form.querySelectorAll('.error-summary').forEach(x => x.remove());
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) clearFieldError(el);
  if (!errors.length) return;
  for (const { field, message } of errors) {
    if (!field.id) field.id = `field-${++fieldSeq}`;
    if (field.dataset.describedBy === undefined) field.dataset.describedBy = field.getAttribute('aria-describedby') || '';
    const err = document.createElement('span');
    err.className = 'field-error'; err.id = `${field.id}-error`;
    err.innerHTML = `<span aria-hidden="true">⚠ </span>${esc(message)}`;
    (field.type === 'checkbox' ? field.closest('label') : field).after(err);
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', [field.dataset.describedBy, err.id].filter(Boolean).join(' '));
  }
  const summary = document.createElement('div');
  summary.className = 'error-summary'; summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
  summary.innerHTML = `<p><b>${errors.length === 1 ? 'There is a problem' : `There are ${errors.length} problems`}</b></p><ul>${errors.map(({ field, message }) => `<li><a href="#${esc(field.id)}">${esc(message)}</a></li>`).join('')}</ul>`;
  form.prepend(summary);
  summary.querySelectorAll('a').forEach(a => a.onclick = e => { e.preventDefault(); showMe(`#${CSS.escape(a.getAttribute('href').slice(1))}`); });
  summary.focus();
}
function enhanceForms(root) {
  for (const form of root.querySelectorAll('form:not([data-guided])')) {
    form.dataset.guided = '1';
    form.noValidate = true;
    let required = false;
    for (const el of form.querySelectorAll('input[required], select[required], textarea[required]')) {
      required = true;
      const label = el.closest('label');
      if (!label || label.querySelector('.req')) continue;
      const star = [...label.childNodes].find(n => n.nodeType === 3 && n.textContent.includes('*'));
      const mark = document.createElement('span');
      mark.className = 'req'; mark.innerHTML = '<span aria-hidden="true">*</span><span class="sr-only"> (required)</span>';
      if (star) { star.textContent = star.textContent.replace(/\s*\*\s*/, ' '); star.after(mark); }
      else if (el.type !== 'checkbox') label.insertBefore(mark, el);
    }
    if (required && !form.querySelector('.form-note')) form.insertAdjacentHTML('afterbegin', '<p class="form-note"><span aria-hidden="true">*</span> marks a required field.</p>');
  }
}
function installGuidedForms() {
  const host = $('#dialog-content');
  host.addEventListener('submit', e => {
    const form = e.target;
    if (!form.matches || !form.matches('form[data-guided]')) return;
    const invalid = [...form.elements].filter(el => el.willValidate && !el.checkValidity());
    if (!invalid.length) { formErrors(form, []); return; }
    e.preventDefault(); e.stopPropagation(); // the form's own handler never sees an incomplete entry
    formErrors(form, invalid.map(field => ({ field, message: messageFor(field) })));
  }, true);
  const clear = e => { if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true' && (e.target.type === 'checkbox' ? e.target.checked : e.target.value)) clearFieldError(e.target); };
  host.addEventListener('input', clear);
  host.addEventListener('change', clear);
}

// ---- Updates from another session ----
function staleNotice(ids) {
  if (!current || (ids.length && !ids.includes(current)) || !$('#ns-notice')) return;
  $('#ns-notice').innerHTML = '<div class="ns-stale"><b>Someone else changed this request.</b> Your typed text is kept. Show the latest version to see the current next step, then try again. <button type="button" class="secondary" id="ns-latest">Show the latest version</button></div>';
  $('#ns-latest').onclick = () => refresh(current);
}

document.addEventListener('DOMContentLoaded', () => {
  installGuidedForms();
  const openBefore = open;
  open = function (html) { openBefore(html); enhanceForms($('#dialog-content')); };
  const detailBefore = detail;
  detail = function (id) {
    detailBefore(id);
    const t = state.tickets.find(x => x.id === id);
    if (t && $('#next-step-slot')) guideDetail(t);
    enhanceForms($('#dialog-content'));
  };
  const changeBefore = changeDetail;
  changeDetail = function (id) {
    changeBefore(id);
    const c = state.changes.find(x => x.id === id), t = c && state.tickets.find(x => x.id === c.ticket);
    if (c && t) guideChange(c, t);
  };
  window.addEventListener('jarc-workspace-conflict', e => staleNotice((e.detail && e.detail.ids) || []));
  if (shared && simulated) document.body.classList.add('simulated');
  render();
});
