/* Signed-in workspace extras: in-app notifications (including due-date reminders) and attachments, for My workspace
   and the beta simulation. The server adds this script last in signed-in mode; it does nothing during local
   inspection. Uses the app.js and projects.js globals (shared, simulated, state, role, detail, projectView,
   changeDetail, open, toast) and window.JARC_SERVER.
   My workspace notifications go to your account (and the shared Admin inbox for Admins). The simulation uses simulated
   role and test-identity inboxes. Read state is per signed-in member. Completion evidence (completion.js) can also
   carry files, uploaded here like comment attachments.
   The unread count refreshes after saves, when the tab becomes visible, when the view changes, and every
   POLL_MS while the tab is visible. */
(function () {
  if (typeof shared === 'undefined' || !shared) return;
  const B = window.JARC_SERVER, R = window.AttachmentRules;
  const POLL_MS = 60000;
  const bell = $('#notifications'), badge = $('#notice-count');

  // ---- Notifications ----
  let unreadCount = 0, items = [], next = null, inboxLabel = '';
  function showBadge(n) {
    unreadCount = n;
    badge.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
    bell.setAttribute('aria-label', n ? `Notifications: ${n} unread` : 'Notifications: none unread');
  }
  async function refreshUnread() {
    if (!B.ready) return;
    const r = await B.unread(role);
    if (r.ok) showBadge(r.data.unread);
  }
  const panelOpen = () => Boolean($('#notification-list')) && !$('#overlay').hidden;

  function openPanel() {
    open(`<div class="tagline">IN-APP NOTIFICATIONS</div><h2>Notifications</h2><p id="inbox-label">Loading…</p><div class="actions"><button class="secondary" id="mark-all" disabled>Mark all as read</button><button class="secondary" id="reload-notifications">Refresh</button></div><div id="notification-list" aria-live="polite" aria-busy="true"><div class="empty">Loading notifications…</div></div>
      <details class="activity-feed"><summary>Shared workspace activity (everyone)</summary>${state.notices.slice(0, 40).map(n => `<div class="notice">${esc(n.text)}<small>${esc(n.time)}</small></div>`).join('') || '<p>No activity yet.</p>'}</details>`);
    $('#mark-all').onclick = markAll;
    $('#reload-notifications').onclick = () => loadPage(false);
    loadPage(false);
  }
  async function loadPage(more) {
    const list = $('#notification-list');
    if (!list) return;
    list.setAttribute('aria-busy', 'true');
    if (more) $('#older').disabled = true;
    const r = await B.notifications(role, more ? next : null);
    if (!panelOpen()) return;
    list.removeAttribute('aria-busy');
    if (!r.ok) {
      if (more) { $('#older').disabled = false; return toast(r.message); }
      list.innerHTML = `<div class="empty" role="alert">${esc(r.message)}<div class="actions centered"><button class="secondary" id="retry-notifications">Try again</button></div></div>`;
      $('#retry-notifications').onclick = () => loadPage(false);
      return;
    }
    items = more ? items.concat(r.data.items) : r.data.items;
    next = r.data.next; inboxLabel = r.data.inbox;
    showBadge(r.data.unread);
    renderPanel();
  }
  function renderPanel() {
    $('#inbox-label').innerHTML = `<strong>${esc(inboxLabel)}</strong><br>${simulated ? 'Simulated recipients for the shared beta test data: nothing is emailed or sent to the people named in sample records.' : `Notifications for your account, including due-date reminders and escalations. Email: ${window.JARC_SESSION.emailDelivery === 'enabled' ? 'available (turn it on under Settings)' : 'not enabled, so notifications are in-app only'}.`} Read and unread are tracked for you only.`;
    $('#mark-all').disabled = !unreadCount;
    $('#notification-list').innerHTML = !items.length
      ? `<div class="empty">No notifications for the ${esc(role)} view yet. Assignments, comments, requests for information, meeting proposals, acceptance requests, and returned corrections will appear here.</div>`
      : `<ul class="notifications">${items.map(n => `<li class="notification${n.read ? '' : ' unread'}"><button class="notification-open" data-open="${n.id}"><b>${n.read ? '' : '<span class="sr-only">Unread: </span>'}${esc(n.title)}</b><span>${esc(n.text)}</span><small>${esc(n.time)} · ${n.reminder ? 'Automatic reminder' : `${esc(n.actor)} (${esc(n.actorView)}${simulated ? ' view' : ''})`}</small></button>${n.read ? '' : `<button class="secondary mark-read" data-read="${n.id}">Mark read<span class="sr-only">: ${esc(n.title)}</span></button>`}</li>`).join('')}</ul>${next ? '<div class="actions centered"><button class="secondary" id="older">Show older</button></div>' : ''}`;
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openNotification(items.find(n => n.id === b.dataset.open)));
    document.querySelectorAll('[data-read]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      if (await mark([b.dataset.read])) renderPanel(); else b.disabled = false;
    });
    if ($('#older')) $('#older').onclick = () => loadPage(true);
  }
  async function mark(ids) {
    const r = await B.markRead(role, ids);
    if (!r.ok) { toast(r.message); return false; }
    for (const n of items) if (ids === 'all' || ids.includes(n.id)) n.read = true;
    showBadge(r.data.unread);
    return true;
  }
  async function markAll() {
    $('#mark-all').disabled = true;
    if (await mark('all')) renderPanel(); else $('#mark-all').disabled = false;
  }
  // Marks the notification read, then opens its ticket, project Gantt view, or linked change.
  async function openNotification(n) {
    if (!n) return;
    if (!n.read) mark([n.id]);
    if (!state.tickets.some(t => t.id === n.ticket) || (n.kind === 'change' && !state.changes.some(c => c.id === n.record))) {
      const r = await B.ticket(n.ticket);
      if (!r.ok) return toast(r.status === 404 ? `${n.record} is not available${simulated ? ' (the beta workspace may have been reset)' : ' to you any more'}.` : r.message);
      for (const [list, key] of [[state.tickets, 'tickets'], [state.changes, 'changes']]) for (const rec of r.data[key]) { const i = list.findIndex(x => x.id === rec.id); if (i < 0) list.push(rec); else list[i] = rec; }
    }
    const t = state.tickets.find(x => x.id === n.ticket);
    if (n.kind === 'change' && state.changes.some(c => c.id === n.record)) changeDetail(n.record);
    else if (n.target === 'project' && t.project) projectView(t.id);
    else detail(t.id);
  }

  bell.onclick = openPanel;
  showBadge(0);
  window.addEventListener('jarc-workspace-loaded', refreshUnread);
  window.addEventListener('jarc-workspace-saved', refreshUnread);
  $('#demo-role').addEventListener('change', () => { showBadge(0); refreshUnread(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshUnread(); });
  setInterval(() => { if (document.visibilityState === 'visible') refreshUnread(); }, POLL_MS);
  refreshUnread();

  // ---- Attachments ----
  // Adds a file picker to a form. Files upload as soon as they are chosen, with progress and per-file errors.
  // Returns { ids, busy } for the form's submit handler.
  function uploader(form, before) {
    const box = document.createElement('div');
    box.className = 'uploader';
    const inputId = 'files-' + Math.random().toString(36).slice(2);
    box.innerHTML = `<label for="${inputId}">Attachments (optional)</label><input id="${inputId}" type="file" multiple accept="${R.ACCEPT}" aria-describedby="${inputId}-hint"><p class="read-only" id="${inputId}-hint">${esc(R.SUMMARY)} ${simulated ? 'Screenshots and supporting files are visible to everyone in the beta workspace once submitted.' : 'Once submitted, files are visible to the people who can see this ticket.'} Files are checked for type and size; they are not scanned for malware.</p><ul class="upload-list" aria-live="polite"></ul>`;
    form.insertBefore(box, before);
    const input = box.querySelector('input'), list = box.querySelector('.upload-list');
    const entries = [];
    const submit = form.querySelector('button:not([type=button])');
    const active = () => entries.filter(e => e.state !== 'error');
    function draw() {
      list.innerHTML = entries.map((e, i) => `<li class="upload ${e.state}"><span class="upload-name">${esc(e.name)}</span><small>${esc(R.formatSize(e.size))}</small>${e.state === 'uploading' ? `<progress max="100" value="${Math.round(e.progress * 100)}" aria-label="Uploading ${esc(e.name)}"></progress><small>${Math.round(e.progress * 100)}%</small>` : e.state === 'done' ? '<small class="ok">Uploaded</small>' : `<small class="error" role="alert">${esc(e.message)}</small>`}<span class="upload-actions">${e.state === 'error' && e.file && e.retry ? `<button type="button" class="secondary" data-retry="${i}">Retry</button>` : ''}<button type="button" class="secondary" data-remove="${i}">${e.state === 'uploading' ? 'Cancel' : 'Remove'}<span class="sr-only"> ${esc(e.name)}</span></button></span></li>`).join('');
      list.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => remove(Number(b.dataset.remove)));
      list.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => start(entries[Number(b.dataset.retry)]));
      if (submit) submit.disabled = entries.some(e => e.state === 'uploading');
    }
    function start(e) {
      Object.assign(e, { state: 'uploading', progress: 0, message: '' });
      const job = B.upload(e.file, p => { e.progress = p; draw(); });
      e.abort = job.abort;
      draw();
      job.promise.then(r => {
        if (!entries.includes(e)) return; // removed while uploading
        if (r.ok) Object.assign(e, { state: 'done', id: r.data.attachment.id, name: r.data.attachment.name });
        else Object.assign(e, { state: 'error', message: r.message, retry: r.status === 0 || r.status >= 500 || r.status === 401 });
        draw();
      });
    }
    function remove(i) {
      const [e] = entries.splice(i, 1);
      if (!e) return;
      if (e.state === 'uploading' && e.abort) e.abort();
      if (e.state === 'done') B.removeAttachment(e.id);
      draw();
    }
    input.onchange = () => {
      for (const file of input.files) {
        let message = R.precheck(file.name, file.size);
        if (!message && active().length >= R.MAX_PER_SUBMISSION) message = `${file.name}: attach up to ${R.MAX_PER_SUBMISSION} files at a time.`;
        const e = { file, name: R.safeName(file.name) || file.name, size: file.size, state: 'error', message };
        entries.push(e);
        if (!message) start(e);
      }
      input.value = '';
      draw();
    };
    return {
      ids: () => entries.filter(e => e.state === 'done').map(e => e.id),
      busy: () => entries.some(e => e.state === 'uploading')
    };
  }

  // New request form: optional attachments.
  const baseNewRequest = $('#new-ticket').onclick;
  $('#new-ticket').onclick = () => {
    baseNewRequest();
    const form = $('#request-form');
    if (!form) return;
    const files = uploader(form, form.querySelector('.actions'));
    form.onsubmit = e => {
      e.preventDefault();
      if (files.busy()) return toast('Wait for the uploads to finish, or remove them.');
      createRecord('ticket', null, { ...Object.fromEntries(new FormData(form)), attachments: files.ids() }, id => { close(); view = 'Tickets'; render(); toast(`${id} created successfully`); });
    };
  };

  // Ticket details: an attachments summary, attachments on comments (a comment can be files only), and evidence files.
  const baseDetail = detail;
  detail = function (id) {
    baseDetail(id);
    const t = state.tickets.find(x => x.id === id), form = $('#comment-form');
    if (!t || !form) return;
    const all = t.history.flatMap(h => (h.attachments || []).map(f => ({ ...f, by: h.actor || h.view, time: h.time })));
    if (all.length) {
      const section = document.createElement('section');
      section.className = 'ticket-files';
      section.innerHTML = `<h3>Attachments <small>(${all.length})</small></h3><ul class="file-links">${all.map(f => `<li><a href="${B.base}/attachments/${encodeURIComponent(f.id)}/download" download="${esc(f.name)}"><span aria-hidden="true">📎</span> ${esc(f.name)}</a> <small>${esc(R.formatSize(f.size))} · ${esc(f.by || '')} · ${esc(f.time)}</small></li>`).join('')}</ul>`;
      $('.timeline').previousElementSibling.before(section);
    }
    const text = form.querySelector('textarea');
    text.required = false;
    const files = uploader(form, form.querySelector('.actions'));
    form.onsubmit = e => {
      e.preventDefault();
      if (files.busy()) return toast('Wait for the uploads to finish, or remove them.');
      if (!text.value.trim() && !files.ids().length) { text.focus(); return toast('Write a comment or attach a file.'); }
      perform('ticket', id, 'comment', { comment: text.value, attachments: files.ids() }, () => refresh(id));
    };
    // Evidence: files and links together. The server accepts only your own uploads as evidence files.
    const evidence = $('#evidence-form');
    if (evidence) {
      const proof = uploader(evidence, evidence.querySelector('.actions'));
      evidence.querySelector('.uploader label').textContent = 'Evidence files';
      evidence.onsubmit = e => {
        e.preventDefault();
        if (proof.busy()) return toast('Wait for the uploads to finish, or remove them.');
        const f = new FormData(evidence);
        const links = [0, 1].map(n => ({ label: String(f.get('label' + n) || '').trim(), url: String(f.get('url' + n) || '').trim() })).filter(l => l.url);
        if (links.some(l => !WorkflowCore.safeUrl(l.url))) return toast('Links must be complete http:// or https:// addresses.');
        if (!links.length && !proof.ids().length) return toast('Attach a file or add a deliverable link.');
        perform('ticket', id, 'add-evidence', { links, attachments: proof.ids() }, () => refresh(id));
      };
    }
  };
})();
