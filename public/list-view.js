/* Ticket and project list: search, filters, result count, empty states, and pages.
   Classic script loaded before app.js; it reads app.js state (view, role, state, shared, accounts, server, visible)
   only when called. Local and inspection modes filter the records in this browser. Signed-in workspaces search the
   records you may see on the server, one page at a time. Filters stay set while details open and close, and reset when the
   sidebar section or the simulated view changes. */
let filters = ListFilter.empty(), listPage = 1, listSeq = 0, searchTimer = null;

function resetListFilters() { filters = ListFilter.empty(); listPage = 1; }

const deadlineCtx = () => ({ today: workspaceToday(), settings: deadlineSettings });
// Counts of overdue work, work due soon, and tickets waiting on a decision, as quick filters.
function attentionBar(items) {
  const count = attention => items.filter(t => ListFilter.matches(t, { ...ListFilter.empty(), attention }, 'tickets', deadlineCtx())).length;
  const parts = [['Overdue', count('Overdue'), 'overdue'], ['Due soon', count('Due soon'), 'due soon'], ['Awaiting decision', count('Awaiting decision'), 'awaiting a decision']];
  return `<div class="attention" role="group" aria-label="Needs attention">${parts.map(([key, n, text]) => `<button type="button" class="attention-item ${key === 'Overdue' && n ? 'overdue' : key === 'Due soon' && n ? 'due-soon' : ''}" data-attention="${key}" aria-pressed="${filters.attention === key}"><strong>${n}</strong> ${text}</button>`).join('')}<span class="read-only">Dates are calendar days in ${esc(deadlineSettings.timezone)}.</span></div>`;
}
function wireAttention() {
  document.querySelectorAll('[data-attention]').forEach(b => b.onclick = () => {
    filters.attention = filters.attention === b.dataset.attention ? '' : b.dataset.attention;
    listPage = 1; render();
  });
}
// Admin overview: Tickets and Projects by stage, plus overdue work. Each count opens the matching records below.
const STAGE_HINTS = {
  new: 'Not yet assigned to a worker',
  active: 'Assigned; planning, meeting, agreement, or on hold',
  'awaiting-worker': 'In progress, or a Project awaiting its release or handover',
  'awaiting-requestor': 'Worker marked done; Requestor to review the evidence',
  ready: 'Both confirmations recorded: close it',
  closed: 'Closed after both confirmations'
};
function adminOverview(items) {
  const today = deadlineCtx();
  const count = (type, test) => items.filter(t => (!type || WorkflowCore.typeOf(t) === type) && test(t)).length;
  const overdue = t => { const d = DeadlineCore.deadline(t, today.today, today.settings); return Boolean(d && d.state === 'overdue'); };
  const cell = (type, stage, n, label) => `<button type="button" class="overview-count${n ? '' : ' zero'}" data-overview-stage="${stage}" data-overview-type="${type}" aria-pressed="${filters.stage === stage && filters.type === type || (stage === 'overdue' && filters.attention === 'Overdue' && filters.type === type)}" aria-label="${esc(label)}: ${n} ${type ? type + 's' : 'requests'}">${n}</button>`;
  const rows = [...WorkflowCore.STAGES.map(([key, label]) => [key, label, t => WorkflowCore.stageOf(t) === key]), ['overdue', 'Overdue (any stage)', overdue]];
  return `<section class="overview" aria-labelledby="overview-title"><div class="overview-head"><h2 id="overview-title">Admin overview</h2><span class="read-only">Choose a number to see those records. Overdue uses the agreed delivery dates.</span></div><div class="table-wrap"><table class="overview-table"><thead><tr><th>STAGE</th><th>TICKETS</th><th>PROJECTS</th><th>ALL</th></tr></thead><tbody>${rows.map(([key, label, test]) => `<tr class="${key === 'ready' ? 'ready' : key === 'overdue' ? 'overdue-row' : ''}"><td><b>${esc(label)}</b><small>${esc(STAGE_HINTS[key] || 'Agreed delivery date has passed')}</small></td><td>${cell('Ticket', key, count('Ticket', test), label)}</td><td>${cell('Project', key, count('Project', test), label)}</td><td>${cell('', key, count('', test), label)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function wireOverview() {
  document.querySelectorAll('[data-overview-stage]').forEach(b => b.onclick = () => {
    const stage = b.dataset.overviewStage, type = b.dataset.overviewType;
    resetListFilters();
    if (stage === 'overdue') filters.attention = 'Overdue'; else filters.stage = stage;
    filters.type = type;
    view = 'Tickets';
    render();
    $('#records')?.scrollIntoView({ block: 'start' });
  });
}
const confirmations = t => {
  const c = WorkflowCore.completionOf(t);
  const mark = (label, x) => `<span class="conf ${x ? 'yes' : 'no'}" title="${esc(label)}: ${x ? 'confirmed by ' + esc(x.name) : 'pending'}">${x ? '✓' : '○'} ${label}</span>`;
  return `${mark('Worker', c.worker)}${mark('Requestor', c.requestor)}`;
};

function filterBar() {
  const select = (key, all, label, values) => `<select id="${key}-filter" data-filter="${key}" aria-label="Filter by ${label}"><option value="">${all}</option>${values.map(v => { const [value, text] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(value)}" ${filters[key] === value ? 'selected' : ''}>${esc(text)}</option>`; }).join('')}</select>`;
  // My workspace filters by assignee account (Admin or Developer); the simulation and local modes by sample name.
  const devValues = accounts ? [ListFilter.UNASSIGNED, ...(server.developers || []).map(d => [d.id, d.name])] : ListFilter.CHOICES.dev;
  return `<input class="search" type="search" data-filter="q" maxlength="${ListFilter.MAX_QUERY}" aria-label="Search by ID, summary, or description" placeholder="Search ${view === 'Projects' ? 'project or ticket ID' : 'ticket ID'}, summary, description…" value="${esc(filters.q)}">`
    + select('status', 'All statuses', 'status', ListFilter.CHOICES.status)
    + select('priority', 'All priorities', 'priority', ListFilter.CHOICES.priority)
    + select('department', 'All departments', 'department', ListFilter.CHOICES.department)
    + select('type', 'Tickets and Projects', 'request type', ListFilter.CHOICES.type)
    + select('stage', 'Any stage', 'overview stage', WorkflowCore.STAGES)
    // Only Admins see everyone's work, so only they get an assignee filter.
    + (role === 'Admin' ? select('dev', 'All assignees', 'assignee', devValues) : '')
    + select('attention', 'Any deadline', 'deadline or decision', ListFilter.CHOICES.attention)
    + `<button type="button" class="secondary" id="clear-filters" ${ListFilter.activeCount(filters) ? '' : 'disabled'}>Clear filters</button>`;
}

function wireFilters() {
  document.querySelectorAll('[data-filter]').forEach(el => {
    const key = el.dataset.filter;
    el[key === 'q' ? 'oninput' : 'onchange'] = () => {
      filters[key] = el.value; listPage = 1;
      $('#clear-filters').disabled = !ListFilter.activeCount(filters);
      clearTimeout(searchTimer);
      if (key === 'q' && shared) searchTimer = setTimeout(records, 300); else records();
    };
  });
  $('#clear-filters').onclick = () => { resetListFilters(); render(); $('.search').focus(); };
}

function records() {
  if (!$('#records')) return;
  const scope = view === 'Projects' ? 'projects' : 'tickets';
  let query;
  try { query = ListFilter.normalize({ ...filters, scope, page: listPage }, { accounts }); }
  catch (err) { return showList({ error: err.message }); }
  if (!shared) return showList(ListFilter.page(visible(), query, deadlineCtx()));
  const seq = ++listSeq;
  $('#records').setAttribute('aria-busy', 'true');
  $('#result-count').textContent = 'Searching shared records…';
  server.search({ ...query.filters, scope, page: query.page, pageSize: query.pageSize, view: role }).then(r => {
    if (seq !== listSeq) return; // a newer search replaced this one
    if (!r.ok) return showList({ error: r.message });
    // Keep the newest copy of each record so details open on what the search returned.
    for (const rec of r.data.items) {
      const i = state.tickets.findIndex(x => x.id === rec.id);
      if (i < 0) state.tickets.push(rec); else if ((rec.version || 0) >= (state.tickets[i].version || 0)) state.tickets[i] = rec;
    }
    showList({ ...r.data, items: r.data.items.map(rec => state.tickets.find(x => x.id === rec.id)) });
  });
}

function showList(r) {
  const el = $('#records');
  if (!el) return;
  el.removeAttribute('aria-busy');
  const noun = view === 'Projects' ? 'project' : 'ticket';
  if (r.error) {
    $('#result-count').textContent = '';
    $('#pager').innerHTML = '';
    el.innerHTML = `<div class="empty" role="alert"><strong>The list could not be loaded.</strong><br>${esc(r.error)}<div class="actions centered"><button class="secondary" id="retry-list">Try again</button></div></div>`;
    $('#retry-list').onclick = records;
    return;
  }
  const { items, total, page, pageSize } = r;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total && page > pages) { listPage = pages; return records(); }
  const filtered = ListFilter.activeCount(filters) > 0;
  $('#result-count').textContent = !total ? (filtered ? `No matching ${noun}s` : '')
    : `${total} ${filtered ? 'matching ' : ''}${noun}${total === 1 ? '' : 's'}${pages > 1 ? ` · showing ${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)}` : ''}`;
  if (!items.length) {
    el.innerHTML = filtered
      ? `<div class="empty"><strong>No ${noun}s match these filters.</strong><br>Try different search words, or clear the filters to see every ${noun} in this view.<div class="actions centered"><button class="secondary" id="empty-clear">Clear filters</button></div></div>`
      : '<div class="empty">No records here yet. New work will appear as you move through the workflow.</div>';
    if ($('#empty-clear')) $('#empty-clear').onclick = () => { resetListFilters(); render(); $('.search').focus(); };
  } else {
    el.innerHTML = `<div class="group-title">⌄ &nbsp; ${view === 'Projects' ? 'Projects' : listTitle()} <small>${total} records</small></div><div class="table-wrap"><table><thead><tr><th>${view === 'Projects' ? 'PROJECT / REQUEST' : 'REQUEST'}</th><th>TYPE</th><th>STATUS</th><th>PRIORITY</th><th>ASSIGNEE</th><th>DELIVERY DATE</th><th>CONFIRMATIONS</th><th>PROGRESS</th></tr></thead><tbody>${items.map(t => `<tr data-id="${esc(t.id)}" tabindex="0"><td><span class="ticket-name">${esc(view === 'Projects' ? (t.projectName || t.title) : t.title)}</span><span class="ticket-id">${view === 'Projects' ? esc(t.project) + ' · ' : ''}${esc(t.id)} &nbsp; · &nbsp; ${esc(t.department)}</span></td><td>${typePill(WorkflowCore.typeOf(t))}</td><td>${pill(t.status)}</td><td>${pill(t.priority)}</td><td>${person(t.dev)}</td><td>${DeadlineCore.dueDate(t) ? dueText(t) : `<span class="requested">Requested ${esc(DeadlineCore.formatDate(DeadlineCore.requestedDate(t)))}</span>`}</td><td class="conf-cell">${confirmations(t)}</td><td>${prog(t)}</td></tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-id]').forEach(x => {
      const openRecord = () => view === 'Projects' ? projectView(x.dataset.id) : detail(x.dataset.id);
      x.onclick = openRecord;
      x.onkeydown = e => { if (e.key === 'Enter') openRecord(); };
    });
  }
  $('#pager').innerHTML = pages > 1 ? `<nav class="pager" aria-label="${noun} pages"><button class="secondary" id="prev-page" ${page <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${page} of ${pages}</span><button class="secondary" id="next-page" ${page >= pages ? 'disabled' : ''}>Next →</button></nav>` : '';
  if ($('#prev-page')) $('#prev-page').onclick = () => { listPage = page - 1; records(); };
  if ($('#next-page')) $('#next-page').onclick = () => { listPage = page + 1; records(); };
}
