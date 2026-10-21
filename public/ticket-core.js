// Ticket data rules and safe browser-storage access. Browser global and CommonJS export keep tests dependency-free.
(function (root) {
  const STORAGE_KEY = 'jarc-helpdesk-v1';
  const BACKUP_PREFIX = STORAGE_KEY + '-backup-';
  const statuses = ['Submitted', 'Under review', 'Waiting for information', 'Assigned', 'Meeting scheduled', 'Planning', 'In progress', 'Awaiting acceptance', 'Ready for release', 'Released', 'Closed', 'On hold', 'Rejected', 'Cancelled'];
  const people = ['Miguel Santos', 'Elyza Cruz', 'Paolo Reyes'];
  // Demo identities used by the role selector. Not authentication.
  const DEMO_DEVELOPER = people[0];
  const DEMO_REQUESTOR = 'Adriane Venzon';

  const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const message = err => (err && err.message) || String(err);

  // The fields the app reads without guards. Anything else is left exactly as stored.
  function validState(s) {
    return isRecord(s) && Array.isArray(s.tickets) && Array.isArray(s.changes) && Array.isArray(s.notices)
      && s.tickets.every(t => isRecord(t) && typeof t.id === 'string' && Array.isArray(t.tasks) && Array.isArray(t.history))
      && s.changes.every(c => isRecord(c) && typeof c.id === 'string' && Array.isArray(c.history));
  }

  // Copy the exact raw value to a new key. Reuses an identical earlier backup so reloads do not pile up copies.
  function backup(storage, raw, now) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(BACKUP_PREFIX) && storage.getItem(key) === raw) return { key, error: null };
      }
      const base = BACKUP_PREFIX + new Date(now).toISOString().replace(/[:.]/g, '-');
      let key = base;
      for (let n = 2; storage.getItem(key) !== null; n++) key = base + '-' + n;
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) throw new Error('The backup copy did not match the stored value.');
      return { key, error: null };
    } catch (err) {
      return { key: null, error: message(err) };
    }
  }

  function recovery(reason, raw, copy, error) {
    return {
      state: { tickets: [], changes: [], notices: [] },
      isNew: false,
      recovery: { reason, raw, backupKey: copy.key, backupError: copy.error, error: error || null }
    };
  }

  // Never writes to STORAGE_KEY. Invalid or unreadable data puts the session in recovery instead of loading samples.
  function load(storage, seed, now = Date.now()) {
    let raw;
    try {
      if (!storage) throw new Error('Browser storage is unavailable.');
      raw = storage.getItem(STORAGE_KEY);
    } catch (err) {
      return recovery('read-failed', null, { key: null, error: 'Nothing could be read, so no backup was made.' }, message(err));
    }
    if (raw === null) return { state: seed(), isNew: true, recovery: null };
    let state;
    try { state = JSON.parse(raw); }
    catch (err) { return recovery('unreadable', raw, backup(storage, raw, now), message(err)); }
    if (!validState(state)) return recovery('invalid', raw, backup(storage, raw, now), null);
    return { state, isNew: false, recovery: null };
  }

  function save(storage, state, session) {
    if (session.recovery) return { ok: false, reason: 'recovery' };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'write-failed', error: message(err) };
    }
  }

  // Explicit user action only. Removes the main record so the next load starts fresh; backups are kept.
  function reset(storage) {
    try {
      storage.removeItem(STORAGE_KEY);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  function visibleTickets(tickets, role, developer = DEMO_DEVELOPER, requestor = DEMO_REQUESTOR) {
    return tickets.filter(t => role === 'Admin' || (role === 'Developer' ? t.dev === developer : t.name === requestor));
  }

  function progress(t) {
    return t.tasks?.length ? Math.round(t.tasks.filter(x => x.done).length / t.tasks.length * 100) : 0;
  }

  const api = { STORAGE_KEY, BACKUP_PREFIX, statuses, people, DEMO_DEVELOPER, DEMO_REQUESTOR, validState, load, save, reset, visibleTickets, progress };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TicketCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
