/* Requirements agreement, completion evidence, and the two completion confirmations, shown in ticket details.
   Classic script loaded after projects.js; it wraps detail() the same way and fills #workflow-panels. Every action
   goes through perform() (app.js), so the server (or WorkflowCore in local modes) checks it again.
   - Agreement (Projects): the worker records the meeting notes, requirements, and acceptance criteria; the worker and
     the Requestor confirm separately; then it is locked. Later versions come only from approved scope changes.
   - Evidence: files (signed-in workspaces; workspace-features.js adds the uploader) and http/https links, with a
     delivery and testing summary. Links open in a new tab without the app's context; files always download.
   - Confirmations: who confirmed and what is still pending, and the Admin's closure gate. */

// A link from the record, rendered only if it is still a plain http or https address.
function evidenceLink(item) {
  const url = WorkflowCore.safeUrl(item.url);
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(item.label || url)}</a> <small class="link-host">${esc(new URL(url).host)}</small>` : `<span>${esc(item.label || 'Link')} (not a safe link)</span>`;
}
function evidenceFile(item) {
  const f = item.file;
  const href = window.JARC_SERVER ? `${window.JARC_SERVER.base}/attachments/${encodeURIComponent(f.id)}/download` : '';
  return href ? `<a href="${href}" download="${esc(f.name)}"><span aria-hidden="true">📎</span> ${esc(f.name)}</a> <small>${esc(AttachmentRules.formatSize(f.size))}</small>` : `<span>📎 ${esc(f.name)}</span>`;
}
const confirmedBy = c => c ? `<span class="confirmed">✓ ${esc(c.name)}</span> <small>${esc(c.view)} · ${esc(c.time || '')}</small>` : '<span class="pending">Pending</span>';

function agreementPanel(t, dev) {
  if (WorkflowCore.typeOf(t) !== 'Project') return '';
  const versions = Array.isArray(t.agreements) ? t.agreements : [];
  const current = versions[versions.length - 1];
  const draft = t.agreementDraft;
  const reviewer = canReview(t);
  let body;
  if (current) {
    body = `<div class="agreement locked"><div class="agreement-head"><b>Agreement v${current.version}</b> <span class="pill teal">Locked</span> <small>${esc(current.source === 'Requirements meeting' ? 'From the requirements meeting' : `From approved scope change ${current.source}`)} · ${esc(current.lockedAt || '')}</small></div>
      <div class="scope-summary"><div><h4>Agreed requirements</h4><p>${esc(current.requirements)}</p></div><div><h4>Acceptance criteria</h4><p>${esc(current.criteria)}</p></div></div>
      ${current.notes ? `<p class="read-only">${current.source === 'Requirements meeting' ? 'Meeting notes' : 'Impact assessment'}: ${esc(current.notes)}</p>` : ''}
      <ul class="confirmations">${current.source === 'Requirements meeting'
        ? `<li><span>Worker</span>${confirmedBy(current.worker)}</li><li><span>Requestor</span>${confirmedBy(current.requestor)}</li>`
        : `<li><span>Requestor agreed</span>${confirmedBy(current.requestor)}</li><li><span>Admin approved</span>${confirmedBy(current.approvedBy)}</li>`}</ul></div>
      ${versions.length > 1 ? `<details class="agreement-versions"><summary>Earlier versions (${versions.length - 1})</summary>${versions.slice(0, -1).reverse().map(v => `<div class="agreement"><b>v${v.version}</b> <small>${esc(v.source)} · ${esc(v.lockedAt || '')}</small><p>${esc(v.requirements)}</p><p class="read-only">Criteria: ${esc(v.criteria)}</p></div>`).join('')}</details>` : ''}
      <p class="read-only">Locked: the agreement cannot be edited. New or changed requirements go through a scope change request with explicit approval, which adds a new version.</p>`;
  } else if (draft) {
    body = `<div class="agreement"><div class="agreement-head"><b>Agreement draft</b> <span class="pill purple">Awaiting confirmation</span> <small>Recorded by ${esc(draft.recordedBy.name)} · ${esc(draft.recordedBy.time || '')}</small></div>
      <div class="scope-summary"><div><h4>Agreed requirements</h4><p>${esc(draft.requirements)}</p></div><div><h4>Acceptance criteria</h4><p>${esc(draft.criteria)}</p></div></div>
      <p class="read-only">Meeting notes: ${esc(draft.notes)}</p>
      <ul class="confirmations"><li><span>Worker</span>${confirmedBy(draft.worker)}</li><li><span>Requestor</span>${confirmedBy(draft.requestor)}</li></ul>
      <p class="read-only">The agreement locks when both have confirmed. ${dev && !draft.requestor ? 'Editing the draft clears any confirmation.' : ''}</p></div>
      <div class="actions">${dev && !draft.worker ? '<button class="primary" id="confirm-agreement">Confirm agreement (worker)</button>' : ''}${reviewer && !draft.requestor ? '<button class="primary" id="confirm-agreement">Confirm agreement</button>' : ''}${dev ? '<button class="secondary" id="record-agreement">Edit draft</button>' : ''}</div>`;
  } else {
    const ready = t.meeting && t.meetingConfirmed;
    body = `<p class="read-only">${!t.meeting ? 'No requirements meeting yet. A Project needs one before development.' : !t.meetingConfirmed ? 'Waiting for the Requestor to confirm the meeting.' : 'After the meeting, the worker records the agreed requirements and acceptance criteria.'}</p>${dev && ready ? '<div class="actions"><button class="primary" id="record-agreement">Record agreement</button></div>' : ''}`;
  }
  return `<section class="workflow-panel"><h3>Requirements agreement</h3>${body}</section>`;
}

function evidencePanel(t, dev) {
  const items = (t.evidence || []).map((x, i) => ({ ...x, i })).filter(x => !x.removed);
  const removed = (t.evidence || []).filter(x => x.removed).length;
  const working = t.status === 'In progress';
  if (!items.length && !(dev && working) && !['Awaiting acceptance', 'Ready for release', 'Released', 'Closed'].includes(t.status)) return '';
  return `<section class="workflow-panel"><h3>Completion evidence</h3>
    ${items.length ? `<ul class="evidence-list">${items.map(x => `<li>${x.kind === 'link' ? evidenceLink(x) : evidenceFile(x)}<small>Added by ${esc(x.added ? x.added.name : 'worker')} · ${esc(x.added ? x.added.time : '')}</small>${dev && working ? `<button type="button" class="secondary remove-evidence" data-evidence="${x.i}">Remove<span class="sr-only"> ${esc(x.kind === 'link' ? x.label : x.file.name)}</span></button>` : ''}</li>`).join('')}</ul>` : '<p class="read-only">No evidence yet. The worker adds at least one file or deliverable link before marking the work done.</p>'}
    ${removed ? `<p class="read-only">${removed} earlier item(s) removed; see the activity.</p>` : ''}
    ${WorkflowCore.completionOf(t).summary ? `<h4>Delivery and testing summary</h4><p class="summary-text">${esc(WorkflowCore.completionOf(t).summary)}</p>` : ''}
    ${dev && working ? `<form id="evidence-form"><div class="field-grid">${[0, 1].map(n => `<label>Link label<input name="label${n}" maxlength="150" placeholder="e.g. Test report"></label><label>Link (http or https)<input name="url${n}" type="url" maxlength="2000" placeholder="https://"></label>`).join('')}</div><p class="read-only">Links are shown as plain links that open in a new tab; JarcTech Ticket never opens them itself.</p><div class="actions"><button class="secondary">Add evidence</button></div></form>` : ''}
  </section>`;
}

function confirmationPanel(t, dev) {
  const c = WorkflowCore.completionOf(t);
  const project = WorkflowCore.typeOf(t) === 'Project';
  const completing = WorkflowCore.COMPLETING.includes(t.status);
  if (!completing && t.status !== 'In progress' && t.status !== 'Closed' && !c.log.length && !(t.corrections || []).length) return '';
  const admin = canAdmin(), reviewer = canReview(t);
  const gate = WorkflowCore.closable(t) ? '<span class="confirmed">Ready: an Admin can close this request.</span>'
    : t.status === 'Closed' ? 'Closed.'
    : !c.worker ? 'Waiting for the worker to add evidence and mark the work done.'
    : !c.requestor ? `Waiting for ${sameParty(t) ? 'an Admin to review independently (the Requestor is also the worker)' : 'the Requestor to review the evidence and confirm'}.`
    : 'Waiting for the worker to confirm the release or handover.';
  const buttons = [
    dev && t.status === 'In progress' ? '<button class="primary" id="worker-complete">Mark my work done</button>' : '',
    dev && completing && !c.worker ? '<button class="primary" id="worker-complete">Record my completion</button>' : '',
    dev && t.status === 'Awaiting acceptance' && c.worker && !c.requestor ? '<button class="secondary" id="withdraw-completion">Withdraw my completion</button>' : '',
    reviewer && completing && c.worker && !c.requestor ? '<button class="primary" id="requestor-confirm">Confirm completion</button>' : '',
    reviewer && ['Awaiting acceptance', 'Ready for release'].includes(t.status) ? '<button class="secondary" data-reason="In progress">Return for correction</button>' : '',
    dev && t.status === 'Ready for release' && c.worker && c.requestor ? `<button class="${project ? 'primary' : 'secondary'}" data-action="Released">Confirm release / handover</button>` : '',
    admin && WorkflowCore.closable(t) ? '<button class="primary" data-action="Closed">Close request</button>' : '',
    admin && !reviewer && completing ? '<button class="secondary" data-reason="In progress">Return for correction</button>' : ''
  ].join('');
  return `<section class="workflow-panel"><h3>Completion confirmations</h3>
    <ul class="confirmations"><li><span>Worker${t.dev ? ` (${esc(t.dev)})` : ''}</span>${confirmedBy(c.worker)}</li><li><span>Requestor${sameParty(t) ? ' side (independent Admin review)' : ` (${esc(t.name)})`}</span>${confirmedBy(c.requestor)}</li>${project ? `<li><span>Release / handover</span>${t.status === 'Released' || t.status === 'Closed' ? '<span class="confirmed">✓ Recorded</span>' : '<span class="pending">Pending</span>'}</li>` : ''}</ul>
    <p class="closure-gate"><b>Closure:</b> ${gate} An Admin can close only after both confirmations${project ? ' and the release or handover' : ''}; one confirmation never counts as both.</p>
    ${buttons ? `<div class="actions">${buttons}</div>` : ''}
    ${(t.corrections || []).length ? `<details class="corrections" open><summary>Corrections (${t.corrections.length})</summary>${t.corrections.slice().reverse().map(x => `<div class="event">Round ${x.round}: ${esc(x.reason)}<small>${esc(x.time || '')} · ${esc(x.name)} (${esc(x.view)})</small></div>`).join('')}</details>` : ''}
    ${c.log.length ? `<details class="corrections"><summary>Cleared confirmations (${c.log.length})</summary>${c.log.slice().reverse().map(x => `<div class="event">${esc(x.reason)} Worker: ${esc(x.worker ? x.worker.name : 'none')} · Requestor: ${esc(x.requestor ? x.requestor.name : 'none')}<small>${esc(x.time || '')}</small></div>`).join('')}</details>` : ''}
  </section>`;
}

function agreementForm(t) {
  const d = t.agreementDraft || { notes: '', requirements: t.description, criteria: t.criteria || '' };
  open(`<div class="tagline">${t.id} · REQUIREMENTS AGREEMENT</div><h2>${t.agreementDraft ? 'Edit agreement draft' : 'Record the agreement'}</h2><p>Meeting: ${esc((t.meeting || '').replace('T', ' · '))} · ${esc(t.location || '')}. The worker and the Requestor each confirm this; then it is locked.</p><form id="agreement-form"><div class="field-grid"><label class="full">Meeting notes *<textarea name="notes" required>${esc(d.notes)}</textarea></label><label class="full">Agreed requirements *<textarea name="requirements" required>${esc(d.requirements)}</textarea></label><label class="full">Acceptance criteria *<textarea name="criteria" required>${esc(d.criteria)}</textarea></label></div><div class="actions"><button class="primary">Save and request confirmations</button><button type="button" class="secondary" id="agreement-back">Back to ticket</button></div></form>`);
  $('#agreement-back').onclick = () => detail(t.id);
  $('#agreement-form').onsubmit = e => { e.preventDefault(); perform('ticket', t.id, 'record-agreement', Object.fromEntries(new FormData(e.target)), () => refresh(t.id)); };
}

function completeForm(t) {
  if (WorkflowCore.typeOf(t) === 'Project' && t.tasks.some(x => !x.done)) return toast('Complete all project tasks, including internal testing, first');
  if (!WorkflowCore.activeEvidence(t).length) return toast('Add at least one evidence file or deliverable link first.');
  open(`<div class="tagline">${t.id} · WORKER COMPLETION</div><h2>Mark my work done</h2><p>The Requestor then reviews your evidence and confirms independently. An Admin closes the request only after both confirmations.</p><form id="complete-form"><label>Delivery and testing summary *<textarea name="summary" required placeholder="What was delivered and tested? Where can the Requestor check it?">${esc(WorkflowCore.completionOf(t).summary || '')}</textarea></label><label class="task"><input type="checkbox" required>The work meets the acceptance criteria and the evidence supports it.</label><div class="actions"><button class="primary">Confirm my work is done</button></div></form>`);
  $('#complete-form').onsubmit = e => { e.preventDefault(); perform('ticket', t.id, 'worker-complete', { summary: new FormData(e.target).get('summary') }, () => refresh(t.id)); };
}

const detailBeforeCompletion = detail;
detail = function (id) {
  detailBeforeCompletion(id);
  const t = state.tickets.find(x => x.id === id), host = $('#workflow-panels');
  if (!t || !host) return;
  const dev = canDev(t);
  const missing = WorkflowCore.missingSteps(t);
  host.innerHTML = (missing.length ? `<div class="banner missing-steps"><b>Steps not recorded for this request</b>${t.typeSource ? ' (created before request types and dual confirmation)' : ''}: ${missing.map(esc).join('; ')}. Nothing has been filled in on anyone's behalf.</div>` : '')
    + agreementPanel(t, dev) + evidencePanel(t, dev) + confirmationPanel(t, dev);
  host.querySelectorAll('[data-action]').forEach(b => b.onclick = () => perform('ticket', id, 'status', { status: b.dataset.action }, () => refresh(id)));
  host.querySelectorAll('[data-reason]').forEach(b => b.onclick = () => reason(t, b.dataset.reason));
  host.querySelectorAll('#record-agreement').forEach(b => b.onclick = () => agreementForm(t));
  host.querySelectorAll('#confirm-agreement').forEach(b => b.onclick = () => perform('ticket', id, 'confirm-agreement', {}, () => refresh(id)));
  host.querySelectorAll('[data-evidence]').forEach(b => b.onclick = () => perform('ticket', id, 'remove-evidence', { index: Number(b.dataset.evidence) }, () => refresh(id)));
  if ($('#worker-complete')) $('#worker-complete').onclick = () => completeForm(t);
  if ($('#withdraw-completion')) $('#withdraw-completion').onclick = () => perform('ticket', id, 'withdraw-completion', {}, () => refresh(id));
  if ($('#requestor-confirm')) $('#requestor-confirm').onclick = () => perform('ticket', id, 'requestor-confirm', {}, () => refresh(id));
  if ($('#evidence-form')) $('#evidence-form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const links = [0, 1].map(n => ({ label: String(f.get('label' + n) || '').trim(), url: String(f.get('url' + n) || '').trim() })).filter(l => l.url);
    if (links.some(l => !WorkflowCore.safeUrl(l.url))) return toast('Links must be complete http:// or https:// addresses.');
    if (!links.length) return toast('Add a deliverable link or attach a file.');
    perform('ticket', id, 'add-evidence', { links }, () => refresh(id));
  };
};
render();
