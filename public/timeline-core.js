// Shared date logic. Browser global and CommonJS export keep tests dependency-free.
(function (root) {
  const DAY = 86400000;
  function day(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const n = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? n : null;
  }
  function date(n) { return new Date(n).toISOString().slice(0, 10); }
  function validateTask(task) {
    if (!String(task.title || '').trim()) return 'Enter a task name.';
    if (!String(task.requirement || '').trim()) return 'Record the agreed requirement.';
    if (!String(task.criteria || '').trim()) return 'Record task acceptance criteria.';
    const start = day(task.start), end = day(task.end);
    if (start === null || end === null) return 'Enter valid start and end dates.';
    if (end < start) return 'Task end date must be on or after its start date.';
    if ((end - start) / DAY > 3650) return 'Keep an individual task within 10 years.';
    return '';
  }
  function timeline(tasks) {
    const valid = tasks.filter(t => day(t.start) !== null && day(t.end) !== null && day(t.end) >= day(t.start));
    if (!valid.length) return null;
    const start = Math.min(...valid.map(t => day(t.start))) - DAY;
    const end = Math.max(...valid.map(t => day(t.end))) + 2 * DAY;
    const span = (end - start) / DAY;
    return {
      start: date(start), end: date(end), span,
      ticks: Array.from({ length: 6 }, (_, i) => date(start + Math.round(span * i / 5) * DAY)),
      bars: tasks.map(t => {
        const a = day(t.start), b = day(t.end);
        return a === null || b === null || b < a ? null : {
          left: ((a - start) / DAY) / span * 100,
          width: ((b - a) / DAY + 1) / span * 100,
          days: (b - a) / DAY + 1
        };
      })
    };
  }
  const api = { DAY, day, date, validateTask, timeline };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TicketTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis);
