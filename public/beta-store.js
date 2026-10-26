/* Shared beta simulation workspace client. The server adds this script only when BETA_SIMULATION=enabled.
   Records come from and are saved to the server (MongoDB) for every signed-in beta member; nothing here reads or
   writes browser storage except the remembered simulation view. A failed save is reported and never falls back to
   browser storage; dialogs stay open so typed text can be retried.
   Also reads list searches, notifications, and single tickets, and uploads attachments (beta-features.js shows them).
   Events on window: jarc-beta-loaded after records load or refresh, jarc-beta-saved after a successful save. */
(function () {
  const VIEW_KEY = 'jarc-beta-view';
  const VIEWS = ['Requestor', 'Admin', 'Developer'];
  let view = 'Requestor';
  try { const saved = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(saved)) view = saved; } catch {}
  let hooks = null, status = 'loading', busy = false, lastLoaded = 0;
  let pendingCreate = null; // { key, requestId }: a retry of the same failed submission reuses its requestId

  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
  function setSaveStatus(text, state) {
    const el = document.querySelector('.save');
    if (!el) return;
    el.lastChild.textContent = ' ' + text;
    el.dataset.state = state;
  }
  async function request(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }
  const signal = name => window.dispatchEvent(new CustomEvent(name));
  // While a save is in flight, the open dialog's buttons are disabled so a second click cannot repeat it.
  function lockDialog(locked) {
    const content = document.querySelector('#dialog-content');
    if (!content) return;
    content.setAttribute('aria-busy', String(locked));
    content.querySelectorAll('form button:not([type=button])').forEach(b => { if (locked) { if (!b.disabled) { b.disabled = true; b.dataset.saving = '1'; } } else if (b.dataset.saving) { b.disabled = false; delete b.dataset.saving; } });
  }
  // Reads (search, notifications, one ticket). Resolves to { ok, status, data, message }; never throws.
  async function read(url) {
    try {
      const res = await request('GET', url);
      return { ...res, message: res.ok ? '' : res.status === 401 ? 'Your session has ended. Sign in again, then retry.' : res.status === 503 && res.data.error === 'beta-not-set-up' ? 'The shared beta workspace has not been set up yet.' : res.data.message || 'The shared beta workspace could not be reached. Try again.' };
    } catch { return { ok: false, status: 0, data: {}, message: 'Could not reach the shared beta workspace. Check your connection and try again.' }; }
  }
  function explain(res) {
    if (res.status === 401) return 'Your session has ended. Sign in again (for example in another tab), then retry. Your entry is still here.';
    if (res.status === 503 && res.data.error === 'beta-not-set-up') return 'The shared beta workspace has not been set up yet.';
    if (res.status >= 500 || !res.data.message) return 'The shared beta workspace could not save this change. Your entry is still here; try again.';
    return res.data.message;
  }

  async function load() {
    status = 'loading';
    try {
      const res = await request('GET', '/api/v1/beta/workspace');
      if (!res.ok) throw new Error(explain(res));
      status = 'ready'; lastLoaded = Date.now();
      api.ready = true;
      setSaveStatus('Saved to shared beta', 'saved');
      hooks.replace(res.data);
      signal('jarc-beta-loaded');
    } catch (err) {
      status = 'error'; api.ready = false; api.error = err.message || 'The shared beta workspace could not be reached.';
      setSaveStatus('Not connected', 'error');
      hooks.replace({ tickets: [], changes: [], notices: [] });
    }
  }

  async function refresh() {
    if (busy || status === 'loading') return;
    if (!api.ready) return load();
    try {
      const res = await request('GET', '/api/v1/beta/workspace');
      if (!res.ok) throw new Error(explain(res));
      lastLoaded = Date.now();
      hooks.replace(res.data);
      signal('jarc-beta-loaded');
    } catch { setSaveStatus('Could not refresh; showing the last loaded records', 'error'); }
  }

  // Sends one workflow action. Resolves to the server's updated records, or null when not saved.
  async function send(url, body, onConflict) {
    if (busy) { toast('Still saving the previous change…'); return null; }
    busy = true;
    lockDialog(true);
    setSaveStatus('Saving to shared beta…', 'saving');
    try {
      const res = await request('POST', url, body);
      if (res.ok) { setSaveStatus('Saved to shared beta', 'saved'); setTimeout(() => signal('jarc-beta-saved')); return res.data; }
      setSaveStatus('Not saved', 'error');
      toast(explain(res));
      if (res.status === 409) onConflict(res.data);
      return null;
    } catch {
      setSaveStatus('Not saved', 'error');
      toast('Could not reach the shared beta workspace. Your entry is still here; check your connection and try again.');
      return null;
    } finally { busy = false; lockDialog(false); }
  }
  const conflictRefresh = data => { if ((data.tickets && data.tickets.length) || (data.changes && data.changes.length)) hooks.merge(data); else refresh(); };

  const api = {
    ready: false,
    error: '',
    view,
    start(h) {
      hooks = h;
      const select = document.querySelector('#demo-role');
      if (select) select.addEventListener('change', e => {
        if (!VIEWS.includes(e.target.value)) return;
        view = api.view = e.target.value;
        try { localStorage.setItem(VIEW_KEY, view); } catch {}
        refresh();
      });
      // Shared records may have changed while the tab was hidden.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastLoaded > 5000) refresh(); });
      load();
    },
    refresh,
    search: params => read('/api/v1/beta/search?' + new URLSearchParams(params)),
    ticket: id => read('/api/v1/beta/tickets/' + encodeURIComponent(id)),
    unread: v => read('/api/v1/beta/notifications/unread?view=' + encodeURIComponent(v)),
    notifications: (v, before) => read('/api/v1/beta/notifications?' + new URLSearchParams({ view: v, ...(before ? { before } : {}) })),
    async markRead(v, ids) {
      try {
        const res = await request('POST', '/api/v1/beta/notifications/read', ids === 'all' ? { view: v, all: true } : { view: v, ids });
        return { ...res, message: res.ok ? '' : res.status === 401 ? 'Your session has ended. Sign in again, then retry.' : 'Could not update the notification. Try again.' };
      } catch { return { ok: false, status: 0, data: {}, message: 'Could not reach the shared beta workspace. Try again.' }; }
    },
    // Uploads one file with progress. Returns { promise, abort }; the promise resolves to { ok, data, message }.
    upload(file, onProgress) {
      const xhr = new XMLHttpRequest();
      const promise = new Promise(resolve => {
        xhr.open('POST', '/api/v1/beta/attachments');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
          let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
          const ok = xhr.status === 201;
          resolve({ ok, status: xhr.status, data, message: ok ? '' : xhr.status === 401 ? 'Your session has ended. Sign in again, then upload the file again.' : data.message || 'The file could not be uploaded. Try again.' });
        };
        xhr.onerror = () => resolve({ ok: false, status: 0, data: {}, message: 'The upload could not reach the server. Check your connection and try again.' });
        xhr.onabort = () => resolve({ ok: false, status: 0, data: {}, aborted: true, message: 'Upload cancelled.' });
        xhr.send(file);
      });
      return { promise, abort: () => xhr.abort() };
    },
    // Removes an upload that is not yet part of a ticket. Failures are harmless: unused uploads are cleaned up later.
    removeAttachment: id => request('DELETE', '/api/v1/beta/attachments/' + encodeURIComponent(id)).catch(() => null),
    act({ kind, id, action, input, view: v, version }) {
      return send(`/api/v1/beta/${kind === 'ticket' ? 'tickets' : 'changes'}/${encodeURIComponent(id)}/actions`, { view: v, version, action, input }, conflictRefresh);
    },
    async create({ kind, ticketId, ticketVersion, input, view: v }) {
      const key = JSON.stringify({ kind, ticketId, input });
      if (!pendingCreate || pendingCreate.key !== key) pendingCreate = { key, requestId: randomId() };
      const url = kind === 'ticket' ? '/api/v1/beta/tickets' : `/api/v1/beta/tickets/${encodeURIComponent(ticketId)}/changes`;
      const result = await send(url, { view: v, requestId: pendingCreate.requestId, ticketVersion, input }, conflictRefresh);
      if (result) pendingCreate = null;
      return result;
    },
    async reset() {
      const result = await send('/api/v1/beta/reset', { confirm: 'RESET' }, () => refresh());
      if (!result) return false;
      hooks.replace(result);
      return true;
    },
    // Shown in place of the ticket list until the shared records load (or when they cannot be loaded).
    renderStatus() {
      const app = document.querySelector('#app');
      document.querySelector('#page-title').textContent = 'Beta simulation workspace';
      const select = document.querySelector('#demo-role');
      if (select) select.value = view; // keep the selector in step with the remembered view while loading
      if (status === 'error') {
        app.innerHTML = `<section class="board" id="beta-status"><div class="banner"><strong>The shared beta records could not be loaded.</strong><br>${esc(api.error)}</div><p>Nothing was changed, and no browser-only records are used instead.</p><div class="actions"><button class="primary" id="beta-retry">Try again</button></div></section>`;
        document.querySelector('#beta-retry').onclick = () => load();
      } else {
        app.innerHTML = '<section class="board" id="beta-status"><div class="empty">Loading shared beta records…</div></section>';
      }
    }
  };
  window.JARC_BETA = api;
})();
