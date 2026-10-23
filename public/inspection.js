/* Beta inspection mode. The server loads this only when INSPECTION_MODE=enabled, before app.js.
   Signed-in people can preview the Requestor, Admin, and Developer views on sample records kept in this browser
   under their own storage prefix. It never changes the signed-in account, the server role, or server data, and
   normal browser records (and their recovery backups) are never read or written while inspecting. */
(function () {
  const VIEW_KEY = 'jarc-inspection-view';
  const PREFIX = 'jarc-inspection:';
  const VIEWS = ['Requestor', 'Admin', 'Developer'];
  let local = null;
  try { local = window.localStorage; } catch {}
  let view = null;
  try { view = local && local.getItem(VIEW_KEY); } catch {}
  const active = VIEWS.includes(view);

  // A Storage-like view of only the sample keys, so the app's usual load, save, backup, and recovery code runs
  // unchanged on the sample copy.
  const sampleKeys = () => {
    const out = [];
    for (let i = 0; i < local.length; i++) { const k = local.key(i); if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length)); }
    return out;
  };
  const storage = local && {
    getItem: k => local.getItem(PREFIX + k),
    setItem: (k, v) => local.setItem(PREFIX + k, v),
    removeItem: k => local.removeItem(PREFIX + k),
    key: i => sampleKeys()[i] ?? null,
    get length() { return sampleKeys().length; }
  };

  function remember(next) {
    try { if (next) local.setItem(VIEW_KEY, next); else local.removeItem(VIEW_KEY); return true; } catch { return false; }
  }

  window.JARC_INSPECTION = Object.freeze({
    available: true,
    active,
    view: active ? view : null,
    views: VIEWS,
    storage,
    enter(next) { if (remember(VIEWS.includes(next) ? next : 'Requestor')) location.reload(); },
    setView(next) { if (VIEWS.includes(next)) remember(next); },
    exit() { remember(null); location.reload(); },
    forget() { remember(null); }, // used on sign-out, without reloading
    reset() {
      try { for (const k of sampleKeys()) local.removeItem(PREFIX + k); } catch {}
      location.reload();
    }
  });
})();
