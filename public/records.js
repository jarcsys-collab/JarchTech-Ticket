/* Archiving and permanent deletion of finished requests, in ticket details and the Archived view. My workspace, real
   Admin accounts only: nothing here runs in the local demo, the inspection preview, or the beta simulation. The server
   checks the account, the record's state and version, and the typed ID again on every action.
   Classic script loaded after completion.js and before guide.js, which then places these sections.
   Archive is the normal way to take a request out of active lists, and Restore undoes it. Delete permanently explains
   exactly what goes, and needs the request ID typed in. */
const canManageRecords = () => accounts && signedIn && signedIn.role === 'Admin';

function archiveDialog(t) {
  open(`<div class="tagline">${esc(t.id)} · ARCHIVE</div><h2>Archive this request?</h2>
    <p class="record-name"><b>${esc(t.id)}</b> · ${esc(t.title)}</p>
    <ul class="record-effects"><li>It leaves the active lists, the dashboard, and every queue, and appears under <b>Archived</b>.</li><li>It sends no more reminders.</li><li>Only Admins can see it while it is archived. The Requestor and the worker cannot open it until it is restored.</li><li><b>Nothing is deleted.</b> You can restore it at any time.</li></ul>
    <div class="actions"><button class="primary" id="archive-confirm">Archive ${esc(t.id)}</button><button type="button" class="secondary" id="archive-back">Back to request</button></div>`);
  $('#archive-back').onclick = () => detail(t.id);
  $('#archive-confirm').onclick = () => server.archive(t).then(r => { if (!r) return; mergeShared(r); render(); detail(t.id); toast(`${t.id} archived`); });
}

function restoreRecord(t) {
  return server.restore(t).then(r => { if (!r) return false; mergeShared(r); toast(`${t.id} restored to the active lists`); return true; });
}

const listOf = (items, html) => (items.length ? `<ul>${items.map(x => `<li>${html(x)}</li>`).join('')}</ul>` : '');
async function deleteDialog(t) {
  open(`<div class="tagline">${esc(t.id)} · DELETE PERMANENTLY</div><h2>Delete this request permanently?</h2><p class="record-name"><b>${esc(t.id)}</b> · ${esc(t.title)}</p><div id="delete-plan" aria-live="polite" aria-busy="true"><div class="empty">Checking what this would affect…</div></div>`);
  const r = await server.deletionPreview(t.id);
  const host = $('#delete-plan');
  if (!host) return; // the dialog was closed meanwhile
  host.removeAttribute('aria-busy');
  if (!r.ok) { host.innerHTML = `<div class="banner" role="alert">${esc(r.message)}</div><div class="actions"><button type="button" class="secondary" id="delete-back">Back to request</button></div>`; $('#delete-back').onclick = () => detail(t.id); return; }
  const p = r.data;
  const bytes = p.attachments.remove.reduce((n, f) => n + f.size, 0);
  host.innerHTML = `${p.blockers.length ? `<div class="banner" role="alert"><b>This request cannot be deleted yet.</b>${listOf(p.blockers, esc)}</div>` : ''}
    <h3>What will be deleted</h3>
    <ul class="record-effects">
      <li>The request, with its description, requirements, agreement, evidence, and full activity (${p.activity} ${p.activity === 1 ? 'entry' : 'entries'}).</li>
      ${p.project ? `<li>Project <b>${esc(p.project.id)}</b> · ${esc(p.project.name)}.</li>` : '<li>No linked project.</li>'}
      <li>${p.tasks.length ? `${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}:${listOf(p.tasks, esc)}` : 'No tasks.'}</li>
      <li>${p.changes.length ? `${p.changes.length} scope change${p.changes.length === 1 ? '' : 's'}:${listOf(p.changes, c => `${esc(c.id)} · ${esc(c.title)} (${esc(c.status)})`)}` : 'No scope changes.'}</li>
      <li>${p.attachments.remove.length ? `${p.attachments.remove.length} attached file${p.attachments.remove.length === 1 ? '' : 's'} (${esc(AttachmentRules.formatSize(bytes))}):${listOf(p.attachments.remove, f => esc(f.name))}` : 'No attached files.'}</li>
      <li>${p.notifications} notification${p.notifications === 1 ? '' : 's'} about it, and any queued reminder email.</li>
    </ul>
    ${p.attachments.keep.length ? `<h3>What will be kept</h3><p>These files are also used by a request that stays, so they are not deleted:</p>${listOf(p.attachments.keep, f => `${esc(f.name)} (used by ${esc(f.retainedBy)})`)}` : ''}
    <p>A minimal audit entry stays: who deleted it, when, its ID, and the counts above. <b>This cannot be undone</b> from the app, and the ID is never used again. To keep the record, archive it instead.</p>
    ${p.canDelete ? `<form id="delete-form"><label>Type <b>${esc(p.id)}</b> to confirm *<input name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="delete-hint"></label><p class="read-only" id="delete-hint">The button is available once the ID matches exactly.</p><div class="actions"><button class="primary danger-solid" id="delete-confirm" disabled>Delete ${esc(p.id)} permanently</button><button type="button" class="secondary" id="delete-back">Back to request</button></div></form>` : '<div class="actions"><button type="button" class="secondary" id="delete-back">Back to request</button></div>'}`;
  $('#delete-back').onclick = () => detail(t.id);
  const form = $('#delete-form');
  if (!form) return;
  enhanceDeleteForm(form, p);
}
function enhanceDeleteForm(form, p) {
  const input = form.elements.confirm, button = $('#delete-confirm');
  input.oninput = () => { button.disabled = input.value !== p.id; };
  form.onsubmit = e => {
    e.preventDefault();
    if (input.value !== p.id) return;
    server.deleteRequest({ id: p.id, version: p.version, confirm: input.value }).then(r => {
      if (!r) return;
      state.tickets = state.tickets.filter(x => x.id !== p.id);
      state.changes = state.changes.filter(c => c.ticket !== p.id);
      if (r.notices) state.notices = r.notices;
      close(); render();
      toast(`${p.id} was permanently deleted`);
    });
  };
  input.focus();
}

// Ticket details: the banner on an archived request (which takes no further actions until restored), and for Admins the
// archive and delete controls on any finished request.
const detailBeforeRecords = detail;
detail = function (id) {
  detailBeforeRecords(id);
  const t = state.tickets.find(x => x.id === id);
  if (!t || !accounts) return;
  if (t.archived) {
    document.querySelectorAll('#comment-form, #new-change, [data-section="admin"]').forEach(el => el.remove());
    $('.req-head').insertAdjacentHTML('afterend', `<div class="banner archived-banner"><b>Archived</b> by ${esc(t.archived.by.name)} · ${esc(t.archived.time)}. Read-only until an Admin restores it. It is out of the active lists and sends no reminders.</div>`);
  }
  if (!canManageRecords() || !WorkflowCore.FINAL.includes(t.status)) return;
  const section = document.createElement('section');
  Object.assign(section.dataset, { section: 'records', title: 'Archive or delete' });
  section.innerHTML = `<p class="read-only">${t.archived ? 'Restore puts this request back in the active lists, exactly as it was.' : 'Archive takes this finished request out of the active lists. Nothing is deleted, and you can restore it.'}</p><div class="actions">${t.archived ? '<button class="secondary" id="restore-record">Restore</button>' : '<button class="secondary" id="archive-record">Archive</button>'}<button class="secondary danger" id="delete-record">Delete permanently</button></div>`;
  $('[data-section="activity"]').before(section);
  if ($('#archive-record')) $('#archive-record').onclick = () => archiveDialog(t);
  if ($('#restore-record')) $('#restore-record').onclick = () => restoreRecord(t).then(ok => { if (ok) { render(); detail(id); } });
  $('#delete-record').onclick = () => deleteDialog(t);
};

// The Archived view opens a record with its linked changes, which the active workspace does not load.
async function openArchived(id) {
  const r = await server.ticket(id);
  if (!r.ok) return toast(r.message);
  mergeShared(r.data);
  detail(id);
}
// The audit entries, below the Archived list. They hold no request content.
async function loadDeletionLog() {
  const host = $('#deletion-log');
  if (!host) return;
  const r = await server.deletions();
  if (!$('#deletion-log')) return;
  host.innerHTML = !r.ok ? `<p class="read-only">${esc(r.message)}</p>` : !r.data.items.length ? '<p class="read-only">No request has been deleted.</p>'
    : `<ul class="deletion-items">${r.data.items.map(d => `<li><b>${esc(d.ticket)}</b> ${esc(d.type)}, ${esc(d.status)}${d.project ? ` · ${esc(d.project)}` : ''}<small>Deleted by ${esc(d.by)} · ${esc(d.time)} · ${d.counts.tasks} task(s), ${d.counts.changes} scope change(s), ${d.counts.filesRemoved} file(s) removed${d.counts.filesKept ? `, ${d.counts.filesKept} kept` : ''}</small></li>`).join('')}</ul>`;
}
