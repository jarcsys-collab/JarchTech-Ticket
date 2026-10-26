// Ticket and project list search and filters. Shared by the browser (local and inspection modes filter here) and
// the server (the shared beta workspace searches MongoDB with the same rules and limits).
(function (root) {
  const TicketCore = typeof module !== 'undefined' ? require('./ticket-core.js') : root.TicketCore;
  const WorkflowCore = typeof module !== 'undefined' ? require('./workflow-core.js') : root.WorkflowCore;
  const UNASSIGNED = 'Unassigned';
  const PAGE_SIZE = 25;
  const MAX_PAGE_SIZE = 50;
  const MAX_QUERY = 100;
  const SCOPES = ['tickets', 'projects'];
  const CHOICES = {
    status: TicketCore.statuses,
    priority: WorkflowCore.PRIORITIES,
    department: WorkflowCore.DEPARTMENTS,
    dev: [UNASSIGNED, ...TicketCore.people]
  };
  const LABELS = { status: 'status', priority: 'priority', department: 'department', dev: 'developer' };
  const empty = () => ({ q: '', status: '', priority: '', department: '', dev: '' });

  class FilterError extends Error {}

  // Validates search parameters (from a form or a query string). Throws FilterError with a user-facing message.
  function normalize(input = {}) {
    const get = key => { const v = typeof input.get === 'function' ? input.get(key) : input[key]; return v === undefined || v === null ? '' : String(v); };
    const filters = empty();
    filters.q = get('q').replace(/\s+/g, ' ').trim();
    if (filters.q.length > MAX_QUERY) throw new FilterError(`Search text is too long (maximum ${MAX_QUERY} characters).`);
    for (const key of Object.keys(CHOICES)) {
      const v = get(key);
      if (v && !CHOICES[key].includes(v)) throw new FilterError(`Choose a ${LABELS[key]} from the list.`);
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
  function matches(t, f, scope = 'tickets') {
    if (scope === 'projects' && !t.project) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![t.id, t.project, t.title, t.projectName, t.description].some(v => String(v || '').toLowerCase().includes(q))) return false;
    }
    if (f.status && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.department && t.department !== f.department) return false;
    if (f.dev && (f.dev === UNASSIGNED ? Boolean(t.dev) : t.dev !== f.dev)) return false;
    return true;
  }
  // One page of matching records, newest first as given.
  function page(items, { filters, scope, page: n, pageSize }) {
    const all = items.filter(t => matches(t, filters, scope));
    return { items: all.slice((n - 1) * pageSize, n * pageSize), total: all.length, page: n, pageSize };
  }
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const api = { UNASSIGNED, PAGE_SIZE, MAX_PAGE_SIZE, MAX_QUERY, SCOPES, CHOICES, FilterError, empty, normalize, activeCount, matches, page, escapeRegex };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ListFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
