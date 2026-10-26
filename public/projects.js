/* Project planning and Gantt views. Uses the ticket state and workflow in app.js. */
const TL = TicketTimeline;
$('#demo-role').onchange = e => {
  role = e.target.value;
  view = 'Tickets'; resetListFilters(); layout = 'table'; // a new view starts from an unfiltered list
  close(); render();
};

// Give only new sample data a dated example schedule. Existing records keep their dates.
if (isNewDemo) {
  SampleData.dateSampleProjects(state, TL);
  save();
}

const baseTicketDetail = detail;
detail = function (id) {
  baseTicketDetail(id);
  const t = state.tickets.find(x => x.id === id);
  const dev = canDev(t);
  if ($('#create-project')) $('#create-project').onclick = () => projectSetup(t);
  if ($('#add-task')) $('#add-task').onclick = () => editProjectTask(t, null, false);
  if (t.project) {
    const heading = document.createElement('section');
    heading.className = 'project-summary';
    heading.innerHTML = `<h3>${esc(t.projectName || t.title)}</h3><p>${esc(t.requirements || t.notes || t.description)}</p><div class="actions"><button class="primary" id="open-gantt">View project Gantt chart →</button></div>`;
    $('#comment-form').before(heading);
    $('#open-gantt').onclick = () => projectView(id);
  }
  const changes = state.changes.filter(c => c.ticket === id);
  if (changes.length) {
    const section = document.createElement('section');
    section.innerHTML = `<h3>Linked change requests</h3>${changes.map(c => `<button class="linked-change" data-linked-change="${c.id}"><span>${esc(c.id)} · ${esc(c.title)}</span>${pill(c.status)}</button>`).join('')}`;
    $('#comment-form').before(section);
    section.querySelectorAll('[data-linked-change]').forEach(b => b.onclick = () => changeDetail(b.dataset.linkedChange));
  }
  if (dev && t.meeting && !['Closed', 'Released', 'Rejected'].includes(t.status) && !$('#schedule')) {
    const section = document.createElement('section');
    section.innerHTML = '<h3>Requirements planning</h3><button class="secondary" id="edit-meeting">Edit planning meeting</button>';
    $('#comment-form').before(section);
    $('#edit-meeting').onclick = () => planningMeeting(t);
  }
};

function planningMeeting(t) {
  open(`<h2>Planning and requirements meeting</h2><p>Keep meeting details with the ticket. Confirm requirements and acceptance criteria before creating the project.</p><form id="planning-meeting"><div class="field-grid"><label>Date and time *<input name="meeting" type="datetime-local" required value="${esc(t.meeting || '')}"></label><label>Location *<input name="location" required value="${esc(t.location || 'JARC meeting room')}"></label></div><button class="primary">Send meeting proposal</button></form>`);
  $('#planning-meeting').onsubmit = e => {
    e.preventDefault();
    perform('ticket', t.id, 'edit-meeting', Object.fromEntries(new FormData(e.target)), () => refresh(t.id));
  };
}

function projectSetup(t, draft = null) {
  const d = draft || { projectName: t.title, requirements: t.notes || t.description, criteria: t.criteria || '', date: t.date };
  open(`<div class="tagline">${t.id} · PROJECT CREATION · STEP 1 OF 2</div><h2>Define the project</h2><p>Record the project name and the requirements agreed during planning.</p><form id="project-scope"><div class="field-grid"><label class="full">Project name *<input name="projectName" maxlength="150" required value="${esc(d.projectName)}"></label><label class="full">Agreed requirements / meeting notes *<textarea name="requirements" required>${esc(d.requirements)}</textarea></label><label class="full">Project acceptance criteria *<textarea name="criteria" required>${esc(d.criteria)}</textarea></label><label class="full">Confirmed target date *<input type="date" name="date" required value="${esc(d.date)}"></label></div><div class="actions"><button class="primary">Next: tasks and timeline →</button><button type="button" class="secondary" id="cancel-project">Back to ticket</button></div></form>`);
  $('#cancel-project').onclick = () => detail(t.id);
  $('#project-scope').onsubmit = e => {
    e.preventDefault();
    const next = { ...d, ...Object.fromEntries(new FormData(e.target)) };
    if (!next.projectName.trim() || !next.requirements.trim() || !next.criteria.trim()) return toast('Complete the project name, requirements, and criteria.');
    projectTaskSetup(t, next);
  };
}

function taskFields(task = {}, index = 0, owner = '') {
  return `<fieldset class="plan-task"><legend>Task ${index + 1}</legend><div class="field-grid"><label class="full">Task name *<input name="title" required maxlength="150" value="${esc(task.title || '')}"></label><label class="full">Agreed requirement *<textarea name="requirement" required>${esc(task.requirement || '')}</textarea></label><label class="full">Task acceptance criteria *<textarea name="criteria" required>${esc(task.criteria || '')}</textarea></label><label>Start date *<input name="start" type="date" required value="${esc(task.start || '')}"></label><label>End date *<input name="end" type="date" required value="${esc(task.end || '')}"></label><label class="full">Task owner<select name="owner">${options(ownerChoices(), task.owner || owner)}</select></label></div><button type="button" class="secondary danger remove-task">Remove task</button></fieldset>`;
}
function readTaskFields(container) {
  return [...container.querySelectorAll('.plan-task')].map(el => Object.fromEntries(
    [...el.querySelectorAll('[name]')].map(input => [input.name, input.value.trim()])
  ));
}
function projectTaskSetup(t, draft) {
  const tasks = draft.tasks || [{ title: '', requirement: '', criteria: '', owner: t.dev }];
  open(`<div class="tagline">${t.id} · PROJECT CREATION · STEP 2 OF 2</div><h2>Tasks and timeline</h2><p>${esc(draft.projectName)} · Target ${esc(draft.date)}. Each task becomes a row in the Gantt chart.</p><form id="project-tasks"><div id="task-fields">${tasks.map((x, i) => taskFields(x, i, t.dev)).join('')}</div><div class="actions"><button type="button" class="secondary" id="another-task">＋ Add another task</button></div><label class="task"><input name="agreed" type="checkbox" required>Project scope, criteria, and schedule are agreed with the requestor.</label><div class="actions"><button class="primary">Create project & view Gantt</button><button type="button" class="secondary" id="back-scope">← Back to scope</button></div></form>`);
  function wireRemove() {
    document.querySelectorAll('.remove-task').forEach(b => b.onclick = () => {
      if ($$('.plan-task').length === 1) return toast('Keep at least one project task.');
      b.closest('fieldset').remove();
    });
  }
  wireRemove();
  $('#another-task').onclick = () => {
    $('#task-fields').insertAdjacentHTML('beforeend', taskFields({}, $$('.plan-task').length, t.dev)); wireRemove();
  };
  $('#back-scope').onclick = () => projectSetup(t, { ...draft, tasks: readTaskFields($('#task-fields')) });
  $('#project-tasks').onsubmit = e => {
    e.preventDefault(); const tasks = readTaskFields($('#task-fields'));
    const error = WorkflowCore.validateProjectTasks(tasks, draft.date);
    if (error) return toast(error);
    const scope = { projectName: draft.projectName, requirements: draft.requirements, criteria: draft.criteria, date: draft.date, tasks };
    perform('ticket', t.id, 'create-project', scope, () => { render(); projectView(t.id); });
  };
}
function $$(selector) { return [...document.querySelectorAll(selector)]; }

function projectView(id) {
  const t = state.tickets.find(x => x.id === id);
  if (!t?.project) return detail(id);
  const editable = canDev(t) && ['Planning', 'In progress'].includes(t.status);
  const chart = TL.timeline(t.tasks);
  const unscheduled = t.tasks.filter(x => TL.day(x.start) === null || TL.day(x.end) === null).length;
  open(`<div class="tagline">${t.project} / ${t.id}</div><h2>${esc(t.projectName || t.title)}</h2><p>Project Gantt chart · ${esc(t.name)} · ${esc(t.dev || 'Unassigned')}</p><div class="actions"><button class="secondary" id="back-ticket">← Ticket details</button>${editable?'<button class="primary" id="timeline-add">＋ Add dated task</button><button class="secondary" id="edit-scope">Edit project details</button>':''}${pill(t.status)}</div><div class="scope-summary"><div><h3>Agreed requirements</h3><p>${esc(t.requirements || t.notes || t.description)}</p></div><div><h3>Acceptance criteria</h3><p>${esc(t.criteria || 'Not recorded yet.')}</p></div></div><div class="gantt-summary"><span>${t.tasks.filter(x => x.done).length} / ${t.tasks.length} tasks complete</span>${prog(t)}<span>Target: ${esc(t.date)}</span></div>${t.tasks.some(x => x.scheduleSource === 'demo')?'<p class="read-only">Sample task dates are illustrative demo data.</p>':''}${unscheduled?`<div class="banner">${unscheduled} task(s) have no saved schedule. The developer can add dates; existing tasks are preserved.</div>`:''}<div class="gantt-scroll"><div class="gantt" role="region" aria-label="Project Gantt chart"><div class="gantt-head"><span>Task / requirement</span><div class="gantt-axis">${chart?chart.ticks.map(x => `<span>${x.slice(5)}</span>`).join(''):'No dated tasks yet'}</div></div>${t.tasks.map((task, i) => `<div class="gantt-row"><button class="gantt-task" data-project-task="${i}"><b>${task.done?'✓ ':''}${esc(task.title)}</b><small>${esc(task.owner || t.dev)} · ${task.start?esc(task.start)+' → '+esc(task.end):'Unscheduled'}</small><small>${esc(task.requirement || 'Requirement not recorded')}</small></button><div class="gantt-lane">${chart?.bars[i]?`<button data-project-task="${i}" class="gantt-bar ${task.done?'done':''}" style="left:${chart.bars[i].left}%;width:${chart.bars[i].width}%" aria-label="${esc(task.title)}: ${esc(task.start)} to ${esc(task.end)}, ${task.done?'complete':'incomplete'}"><span>${chart.bars[i].days}d</span></button>`:'<span class="unscheduled">Schedule needed</span>'}</div></div>`).join('')}</div></div><p class="read-only">Click a task or bar to view its requirement, criteria, owner, and dates. ${editable?'You can edit tasks and mark them complete.':'Task updates are managed by the assignee.'}</p>`);
  $('.drawer').classList.add('wide-drawer');
  $('#back-ticket').onclick = () => detail(id);
  if ($('#timeline-add')) $('#timeline-add').onclick = () => editProjectTask(t, null, true);
  if ($('#edit-scope')) $('#edit-scope').onclick = () => editScope(t);
  $$('[data-project-task]').forEach(b => b.onclick = () => editProjectTask(t, Number(b.dataset.projectTask), true));
}

function editProjectTask(t, index, returnToGantt) {
  const task = index === null ? {} : t.tasks[index];
  const editable = canDev(t) && ['Planning', 'In progress'].includes(t.status);
  const back = () => returnToGantt ? projectView(t.id) : detail(t.id);
  open(`<div class="tagline">${t.project} · TASK DETAIL</div><h2>${index === null?'Add dated project task':'Project task'}</h2><form id="dated-task-form">${taskFields(task, index || 0, t.dev)}<label class="task"><input name="done" type="checkbox" ${task.done?'checked':''}>Task complete</label><div class="actions">${editable?'<button class="primary">Save task</button>':''}<button type="button" class="secondary" id="task-back">Back to project</button></div></form>`);
  $('.remove-task').remove();
  if (!editable) $$('#dated-task-form input, #dated-task-form textarea, #dated-task-form select').forEach(x => x.disabled = true);
  $('#task-back').onclick = back;
  $('#dated-task-form').onsubmit = e => {
    e.preventDefault(); if (!editable) return;
    const next = readTaskFields(e.target)[0];
    const error = TL.validateTask(next); if (error) return toast(error);
    if (next.end > t.date) return toast('Task ends after the project target. Update project details first.');
    next.done = e.target.elements.done.checked;
    perform('ticket', t.id, 'save-task', { index, task: next }, () => { render(); back(); });
  };
}
function editScope(t) {
  open(`<h2>Edit project details</h2><form id="edit-project"><div class="field-grid"><label class="full">Project name *<input name="projectName" required value="${esc(t.projectName || t.title)}"></label><label class="full">Agreed requirements *<textarea name="requirements" required>${esc(t.requirements || t.notes || t.description)}</textarea></label><label class="full">Project acceptance criteria *<textarea name="criteria" required>${esc(t.criteria)}</textarea></label><label class="full">Confirmed target date *<input type="date" name="date" required value="${esc(t.date)}"></label></div><p>Keep approved scope changes in the linked change workflow.</p><div class="actions"><button class="primary">Save project details</button></div></form>`);
  $('#edit-project').onsubmit = e => {
    e.preventDefault(); const next = Object.fromEntries(new FormData(e.target));
    if (t.tasks.some(x => x.end && x.end > next.date)) return toast('Target date cannot precede a saved task end date.');
    perform('ticket', t.id, 'edit-scope', next, () => { render(); projectView(t.id); });
  };
}

// Every drawer starts at its top; returning from Gantt does not retain a wide panel.
const baseOpen = open;
open = function (html) { $('.drawer').classList.remove('wide-drawer'); baseOpen(html); $('.drawer').scrollTop = 0; };
render();
