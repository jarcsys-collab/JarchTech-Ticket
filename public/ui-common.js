/* Shared display helpers and dialog handling. Loaded after ticket-core.js and before recovery-view.js, app.js, and projects.js.
   Classic script: these top-level names are shared with the later scripts. projects.js wraps `open`, so it stays a function declaration.
   `close` resets `current`, which app.js declares; it only runs after app.js has loaded. */
const $ = s => document.querySelector(s), esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(t) {
  $('#toast').textContent = t;
  $('#toast').style.display = 'block';
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => $('#toast').style.display = 'none', 3000);
}

function pill(s) {
  let c = ['Closed', 'Approved', 'Accepted', 'Released'].includes(s) ? 'teal'
    : ['Rejected', 'Critical'].includes(s) ? 'red'
    : ['High', 'Submitted', 'Waiting for information', 'Deferred'].includes(s) ? 'amber'
    : ['In progress', 'Assigned', 'Under review', 'Assessment', 'Ready for release'].includes(s) ? 'blue'
    : ['Planning', 'Awaiting acceptance', 'Meeting scheduled', 'Medium'].includes(s) ? 'purple'
    : 'gray';
  return `<span class="pill ${c}">${esc(s)}</span>`;
}
function progress(t) { return TicketCore.progress(t); }
function prog(t) { return `<div class="progress"><span class="track"><i style="width:${progress(t)}%"></i></span>${progress(t)}%</div>`; }
function person(n) { return n ? `<span class="person"><span class="mini-avatar">${esc(n.split(' ').map(x => x[0]).join(''))}</span>${esc(n)}</span>` : '<span style="color:#a0abad">Unassigned</span>'; }

// Download links for files attached to an activity entry. Downloads require sign-in and access to the request.
function fileLinks(list) {
  if (!list || !list.length) return '';
  return `<ul class="file-links">${list.map(f => `<li><a href="${window.JARC_SERVER ? window.JARC_SERVER.base : '/api/v1/work'}/attachments/${encodeURIComponent(f.id)}/download" download="${esc(f.name)}"><span aria-hidden="true">📎</span> ${esc(f.name)}</a> <small>${esc(AttachmentRules.formatSize(f.size))}</small></li>`).join('')}</ul>`;
}

// Agreed delivery date with an overdue or due-soon label, in the workspace timezone (Asia/Manila by default).
const deadlineSettings = { ...DeadlineCore.DEFAULTS, ...(window.JARC_SESSION && window.JARC_SESSION.deadlines || {}) };
const workspaceToday = () => DeadlineCore.today(new Date(), deadlineSettings.timezone);
function deadlineChip(t) {
  const l = DeadlineCore.label(t, workspaceToday(), deadlineSettings);
  return l && l.state !== 'on-track' ? ` <span class="deadline ${l.state}">${esc(l.text)}</span>` : '';
}
function dueText(t) {
  const due = DeadlineCore.dueDate(t);
  return due ? esc(DeadlineCore.formatDate(due)) + deadlineChip(t) : 'Not agreed yet';
}

// Searchable dropdown (an editable combobox with a list of choices). The field holds the chosen text, so forms read it
// as usual; anything not on the list is invalid. Nothing is chosen until the person chooses it.
// Keyboard: type to search; Down or Up opens and moves; Home, End, and Page keys move in the open list; Enter chooses;
// Esc closes the list (a second Esc reaches the dialog). Works by touch, with scrolling that never chooses by accident.
let comboSeq = 0;
function comboField({ label, name, placeholder, options, missing, unknown }) {
  const id = `combo-${++comboSeq}`;
  return `<label class="combo-field">${esc(label)} *<span class="combo" data-combo='${esc(JSON.stringify(options))}'><input id="${id}" name="${esc(name)}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="${esc(placeholder)}" data-missing="${esc(missing)}" data-unknown="${esc(unknown)}"><button type="button" class="combo-toggle" tabindex="-1" aria-hidden="true">▾</button><ul class="combo-list" id="${id}-list" role="listbox" aria-label="${esc(label)} choices" hidden></ul><span class="sr-only" role="status" id="${id}-status"></span></span></label>`;
}
function wireCombos(root) {
  root.querySelectorAll('[data-combo]').forEach(box => {
    const options = JSON.parse(box.dataset.combo);
    const input = box.querySelector('input'), list = box.querySelector('ul'), toggle = box.querySelector('.combo-toggle'), status = box.querySelector('[role=status]');
    let shown = [], active = -1;
    const isOpen = () => !list.hidden;
    const exact = text => options.find(o => o.toLowerCase() === text.trim().toLowerCase());
    // Empty is "missing" (the browser's required check); text that is not a choice is its own error.
    const validate = () => input.setCustomValidity(input.value.trim() && !options.includes(input.value) ? 'unknown' : '');
    function highlight(i) {
      active = i;
      list.querySelectorAll('[role=option]').forEach((li, n) => li.classList.toggle('active', n === i));
      const el = i >= 0 ? list.children[i] : null;
      if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    }
    function draw(query) {
      const q = query.trim().toLowerCase();
      shown = q ? options.filter(o => o.toLowerCase().includes(q)) : options;
      list.innerHTML = shown.length
        ? shown.map((o, i) => `<li role="option" id="${input.id}-o${i}" aria-selected="${o === input.value}" class="${o === input.value ? 'chosen' : ''}">${esc(o)}</li>`).join('')
        : '<li class="combo-empty" role="presentation">No matches</li>';
      status.textContent = shown.length ? `${shown.length} choice${shown.length === 1 ? '' : 's'}` : 'No matches';
      highlight(-1);
    }
    function show(query = '') {
      draw(query);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      const chosen = shown.indexOf(input.value);
      if (chosen >= 0) highlight(chosen);
      list.scrollIntoView({ block: 'nearest' });
    }
    function hide() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
    function choose(value) {
      input.value = value;
      validate();
      hide();
      input.dispatchEvent(new Event('change', { bubbles: true })); // clears a field error shown earlier
    }
    input.addEventListener('input', () => {
      const match = exact(input.value);
      if (match && match !== input.value) input.value = match;
      validate();
      if (document.activeElement === input) show(match ? '' : input.value); else hide();
    });
    input.addEventListener('click', () => { if (!isOpen()) show(''); });
    input.addEventListener('blur', () => hide());
    input.addEventListener('keydown', e => {
      const move = to => { e.preventDefault(); if (!isOpen()) return show(options.includes(input.value) ? '' : input.value); if (shown.length) highlight(Math.max(0, Math.min(shown.length - 1, to))); };
      if (e.key === 'ArrowDown') return move(active + 1);
      if (e.key === 'ArrowUp') return move(active < 0 ? shown.length - 1 : active - 1);
      if (e.key === 'PageDown' && isOpen()) return move(active + 5);
      if (e.key === 'PageUp' && isOpen()) return move(active - 5);
      if (e.key === 'Home' && isOpen()) return move(0);
      if (e.key === 'End' && isOpen()) return move(shown.length - 1);
      if (e.key === 'Enter' && isOpen()) {
        e.preventDefault();
        if (active >= 0) choose(shown[active]);
        else if (shown.length === 1) choose(shown[0]);
        return;
      }
      if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); hide(); return; }
      if (e.key === 'Tab' && isOpen() && active >= 0) choose(shown[active]);
    });
    // Keeps focus in the field while pressing, so a tap or a scroll of the list does not close it.
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => { e.preventDefault(); /* the surrounding label would click the field and reopen the list */ const li = e.target.closest('[role=option]'); if (li) { choose(shown[[...list.children].indexOf(li)]); input.focus(); } });
    toggle.addEventListener('mousedown', e => e.preventDefault());
    toggle.addEventListener('click', e => { e.preventDefault(); if (isOpen()) hide(); else { input.focus(); show(''); } });
  });
}

// Side drawer dialog.
// Keyboard focus stays inside it and returns to where it was when it closes. Text typed into a form is protected:
// closing by accident (Esc, the X, a click outside) asks for a second try first, and leaving the page asks the browser
// to confirm. A successful save replaces the form with open() or close(), which clears the protection.
let dialogOpener = null, dialogDirty = false, discardArmedUntil = 0;
function open(html) {
  if ($('#overlay').hidden) dialogOpener = document.activeElement;
  dialogDirty = false; discardArmedUntil = 0;
  $('#dialog-content').innerHTML = html;
  $('#dialog-content h2')?.setAttribute('id', 'dialog-title');
  $('#overlay').hidden = false;
  setTimeout(() => $('.drawer input, .drawer select, .drawer button')?.focus(), 0);
}
function close() {
  $('#overlay').hidden = true; current = null; dialogDirty = false;
  if (dialogOpener && dialogOpener.isConnected && dialogOpener !== document.body) dialogOpener.focus();
  dialogOpener = null;
}
function requestClose() {
  if (dialogDirty && Date.now() > discardArmedUntil) {
    discardArmedUntil = Date.now() + 6000;
    return toast('You have text that is not saved. Close again within a few seconds to discard it.');
  }
  close();
}
$('.close').onclick = requestClose;
$('#overlay').onclick = e => { if (e.target.id === 'overlay') requestClose(); };
const markDialogDirty = e => { if (e.target.closest && e.target.closest('form') && !['checkbox', 'radio'].includes(e.target.type)) dialogDirty = true; };
$('#dialog-content').addEventListener('input', markDialogDirty);
window.addEventListener('beforeunload', e => { if (dialogDirty && !$('#overlay').hidden) e.preventDefault(); });
document.addEventListener('keydown', e => {
  if ($('#overlay').hidden) return;
  if (e.key === 'Escape') return requestClose();
  if (e.key !== 'Tab') return;
  const items = [...$('.drawer').querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], inside = $('.drawer').contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
});
