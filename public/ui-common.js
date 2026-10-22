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

// Side drawer dialog.
function open(html) {
  $('#dialog-content').innerHTML = html;
  $('#dialog-content h2')?.setAttribute('id', 'dialog-title');
  $('#overlay').hidden = false;
  setTimeout(() => $('.drawer input, .drawer select, .drawer button')?.focus(), 0);
}
function close() { $('#overlay').hidden = true; current = null; }
$('.close').onclick = close;
$('#overlay').onclick = e => { if (e.target.id === 'overlay') close(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
