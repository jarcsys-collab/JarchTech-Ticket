// Ticket and project list search and filters. Shared by the browser (local and inspection modes filter here) and
// the server (the shared beta workspace searches MongoDB with the same rules and limits).
(function (root) {
  const TicketCore = typeof module !== 'undefined' ? require('./ticket-core.js') : root.TicketCore;
  const WorkflowCore = typeof module !== 'undefined' ? require('./workflow-core.js') : root.WorkflowCore;
  const DeadlineCore = typeof module !== 'undefined' ? require('./deadline-core.js') : root.DeadlineCore;
  const UNASSIGNED = 'Unassigned';
  const PAGE_SIZE = 25;
  const MAX_PAGE_SIZE = 50;
  const MAX_QUERY = 100;
  const SCOPES = ['tickets', 'projects'];
  const CHOICES = {
    status: TicketCore.statuses,
    priority: WorkflowCore.PRIORITIES,
    department: WorkflowCore.DEPARTMENTS,
    dev: [UNASSIGNED, ...TicketCore.people],
    attention: ['Overdue', 'Due soon', 'Awaiting decision']
  };
  const LABELS = { status: 'status', priority: 'priority', department: 'department', dev: 'developer', attention: 'deadline or decision' };
  const ACCOUNT_ID = /^[0-9a-f]{24}$/;
  const AWAITING = ['Awaiting acceptance', 'Waiting for information', 'Submitted', 'Under review', 'Ready for release'];
  const empty = () => ({ q: '', status: '', priority: '', department: '', dev: '', attention: '' });

  class FilterError extends Error {}

  // Validates search parameters (from a form or a query string). Throws FilterError with a user-facing message.
  // options.accounts: My workspace, where the developer filter is a Developer account id (or Unassigned).
  function normalize(input = {}, options = {}) {
    const get = key => { const v = typeof input.get === 'function' ? input.get(key) : input[key]; return v === undefined || v === null ? '' : String(v); };
    const filters = empty();
    filters.q = get('q').replace(/\s+/g, ' ').trim();
    if (filters.q.length > MAX_QUERY) throw new FilterError(`Search text is too long (maximum ${MAX_QUERY} characters).`);
    for (const key of Object.keys(CHOICES)) {
      const v = get(key);
      const ok = key === 'dev' && options.accounts ? v === UNASSIGNED || ACCOUNT_ID.test(v) : CHOICES[key].includes(v);
      if (v && !ok) throw new FilterError(`Choose a ${LABELS[key]} from the list.`);
      filters[key] = v;
    }
    const scope = get('scope') || 'tickets';
    if (!SCOPES.includes(scope)) throw new FilterError('Choose tickets or projects.');
    const page = get('page') ? Number(get('page')) : 1;
    const pageSize = get('pageSize') ? Number(get('pageSize')) : PAGE_SIZE;
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new FilterError('Choose a valid page.');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new FilterError(`Page size must be 1 to ${MAX_PAGE_SIZE}.`);
    return { filters, scope, page, pageSize };
  }
  const activeCount = f => Object.values(f).filter(Boolean).length;

  // Search matches the ticket or project ID, the summary (or project name), and the description, ignoring case.
  // A decision is awaited when the ticket waits on review, information, acceptance, release, or meeting confirmation.
  const awaitingDecision = t => AWAITING.includes(t.status) || Boolean(DeadlineCore.awaiting(t));
  // ctx: { today, settings } for the deadline filters (workspace timezone).
  function matches(t, f, scope = 'tickets', ctx = {}) {
    if (scope === 'projects' && !t.project) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![t.id, t.project, t.title, t.projectName, t.description].some(v => String(v || '').toLowerCase().includes(q))) return false;
    }
    if (f.status && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.department && t.department !== f.department) return false;
    if (f.dev && (f.dev === UNASSIGNED ? Boolean(t.dev) : (ACCOUNT_ID.test(f.dev) ? t.devId : t.dev) !== f.dev)) return false;
    if (f.attention) {
      const d = DeadlineCore.deadline(t, ctx.today || DeadlineCore.today(), ctx.settings || DeadlineCore.DEFAULTS);
      if (f.attention === 'Overdue' && !(d && d.state === 'overdue')) return false;
      if (f.attention === 'Due soon' && !(d && d.state === 'due-soon')) return false;
      if (f.attention === 'Awaiting decision' && !awaitingDecision(t)) return false;
    }
    return true;
  }
  // One page of matching records, newest first as given.
  function page(items, { filters, scope, page: n, pageSize }, ctx = {}) {
    const all = items.filter(t => matches(t, filters, scope, ctx));
    return { items: all.slice((n - 1) * pageSize, n * pageSize), total: all.length, page: n, pageSize };
  }
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const api = { AWAITING, UNASSIGNED, PAGE_SIZE, MAX_PAGE_SIZE, MAX_QUERY, SCOPES, CHOICES, FilterError, empty, normalize, activeCount, matches, page, escapeRegex };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ListFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
