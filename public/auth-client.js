/* Signed-in mode only: the server adds this script (and window.JARC_SESSION) when AUTH_MODE=entra.
   Shows who is signed in, the Workspace switch (My workspace or Beta simulation), Settings (email reminders),
   a Sign out button, and the Admin Users screen. The role shown comes from the server; role and access changes go
   through the admin API, which the server checks on every request. If an Admin changes your role while the page is
   open, the page reloads with the new role when you return to it. */
(function () {
  const me = window.JARC_SESSION;
  if (!me) return;
  const ROLES = ['Requestor', 'Developer', 'Admin'];
  const ERRORS = {
    'invalid-email': 'Enter a valid work email address.', 'invalid-role': 'Choose a role.', 'already-exists': 'That email address already has an account or invitation.',
    'cannot-change-self': 'You cannot change your own role or access.', 'last-developer': 'At least one active Developer must remain.', 'changed-meanwhile': 'This person was changed by someone else meanwhile. Review and try again.',
    'invitation-not-accepted': 'This person has not signed in yet, so their invitation is still pending.', 'developer-only': 'Only Developers can manage users and roles.',
    'cross-origin': 'The request was blocked because it did not come from JarcTech Ticket.'
  };

  const inspection = window.JARC_INSPECTION || null; // present only when the server enables INSPECTION_MODE
  const inspecting = Boolean(inspection && inspection.active);
  // The beta simulation is active when chosen in the Workspace switch (and local inspection is not active).
  const sharedBeta = Boolean(window.JARC_BETA) && !inspecting;
  const workspace = inspecting ? null : window.JARC_SERVER || null;

  const style = document.createElement('style');
  style.textContent = '.signed-in-as{font-size:11px;color:#6c7e80}.signout-form{margin:0}.users-table{min-width:0}.users-table td,.users-table th{font-size:11px}.users-table select{margin:0;padding:6px 8px;font-size:11px}.users-table .self{color:#8a9a9e}'
    + '.inspection-banner{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;background:#fff3d9;border:1px solid #f0d48a;color:#7a5a12;border-radius:10px;padding:10px 14px;margin:12px 0 0;font-size:12px}.inspection-banner strong{font-size:13px}.inspection-banner span{flex:1;min-width:220px}.inspection-banner .actions{margin:0}.preview-choices{display:grid;gap:10px;margin-top:18px}.preview-choices button{text-align:left}'
    + '.beta-banner{background:#e3f6f5;border-color:#9fd9d6;color:#0b5c60}.save[data-state=saving] i{background:#e0a526}.save[data-state=error]{color:#c0574d}.save[data-state=error] i{background:#d9685d}';
  document.head.appendChild(style);

  // Outside inspection the role comes from the signed-in account, so the demo role selector is hidden.
  // While inspecting, the same selector becomes the clearly labeled "Preview views" switch (local sample data only).
  const demoRole = document.querySelector('.demo-role-label');
  // In the shared beta workspace it becomes the "Simulation view" switch (shared test data; real roles unchanged).
  if (demoRole) {
    demoRole.hidden = !(inspecting || sharedBeta);
    if (inspecting) {
      demoRole.firstChild.textContent = 'Preview views';
      demoRole.querySelector('select').setAttribute('aria-label', 'Preview views (sample data)');
    } else if (sharedBeta) {
      demoRole.firstChild.textContent = 'Simulation view';
      demoRole.querySelector('select').setAttribute('aria-label', 'Simulation view (shared beta test data)');
    }
  }
  const bottom = document.querySelector('.sidebar-bottom');
  if (sharedBeta) {
    bottom.childNodes[1].textContent = ' Shared beta workspace';
    bottom.querySelector('small').textContent = 'Test data saved on the server';
  } else if (workspace) {
    bottom.childNodes[1].textContent = ' My workspace';
    bottom.querySelector('small').textContent = 'Saved on the server · access from your account';
    const save = document.querySelector('.save');
    if (save) save.lastChild.textContent = ' Saved';
  }
  const avatar = document.querySelector('.avatar');
  avatar.textContent = me.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  avatar.title = `${me.displayName} (${me.email})`;

  const right = document.querySelector('.header-right');
  const who = document.createElement('span');
  who.className = 'signed-in-as';
  who.textContent = `${me.displayName} · ${me.role}`;
  right.insertBefore(who, avatar);
  if (inspection && !inspecting) {
    const preview = document.createElement('button');
    preview.className = 'secondary';
    preview.id = 'preview-views';
    preview.textContent = 'Preview views';
    preview.onclick = openPreviewChoices;
    right.insertBefore(preview, who);
  }
  // My workspace and the beta simulation are separate: one per page load, switched here.
  if (workspace && me.beta) {
    const label = document.createElement('label');
    label.className = 'workspace-switch';
    label.innerHTML = `Workspace<select id="workspace-switch" aria-label="Workspace"><option value="mine" ${workspace.simulated ? '' : 'selected'}>My workspace</option><option value="beta" ${workspace.simulated ? 'selected' : ''}>Beta simulation</option></select>`;
    right.insertBefore(label, right.firstChild);
    label.querySelector('select').onchange = e => workspace.switchTo(e.target.value);
  }
  if (workspace) {
    const settings = document.createElement('button');
    settings.className = 'secondary';
    settings.id = 'settings';
    settings.textContent = 'Settings';
    settings.onclick = openSettings;
    right.insertBefore(settings, who);
  }
  if (inspecting) showInspectionBanner();
  if (sharedBeta) showBetaBanner();
  // Real user management is never part of inspection or the simulation's views: only real Developer accounts get it,
  // and the server refuses everyone else whatever the page shows.
  if (me.role === 'Developer' && !inspecting) {
    const usersButton = document.createElement('button');
    usersButton.className = 'secondary';
    usersButton.id = 'manage-users';
    usersButton.textContent = 'Users';
    usersButton.onclick = openUsers;
    right.insertBefore(usersButton, avatar);
  }
  const signOut = document.createElement('form');
  signOut.method = 'post';
  signOut.action = '/auth/logout';
  signOut.className = 'signout-form';
  signOut.innerHTML = '<button class="secondary" type="submit" id="sign-out">Sign out</button>';
  signOut.addEventListener('submit', () => { if (inspection) inspection.forget(); }); // sample data stays; the next sign-in starts normally
  right.appendChild(signOut);

  function openPreviewChoices() {
    open(`<div class="tagline">BETA INSPECTION</div><h2>Preview views</h2>
      <p>Try the Requestor, Admin, and Developer views on <strong>local sample data</strong> kept only in this browser, separate from your normal records${me.beta ? ' and from the shared beta workspace' : ''}. Your account and real role (${esc(me.role)}) do not change, and nothing is sent to the server. Admin and Developer actions are simulated on the sample data only.</p>
      <div class="preview-choices">${inspection.views.map(v => `<button class="secondary" data-preview="${v}">Preview as ${v}</button>`).join('')}</div>`);
    document.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => inspection.enter(b.dataset.preview));
  }

  function showBetaBanner() {
    const banner = document.createElement('div');
    banner.className = 'inspection-banner beta-banner';
    banner.id = 'beta-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `<strong>Beta simulation — test data</strong><span id="beta-detail"></span><div class="actions"><button class="secondary" id="reset-beta">Reset beta workspace</button></div>`;
    document.querySelector('main').insertBefore(banner, document.querySelector('main').firstChild);
    // The current view comes from the beta client (the selector only shows it once the shared records have loaded).
    const describe = v => `Shared test records saved on the server for everyone in the beta, separate from My workspace. You are simulating the ${v} view${v === 'Developer' ? ' (labelled as sample developer Miguel Santos): every Admin ability; managing real users stays on the Users screen for real Developer accounts' : v === 'Admin' ? ': manage and deliver every ticket, no user management' : ': your own and the sample requests'}. Your account and real role (${me.role}) do not change, and simulated views give no access to real tickets or accounts. Nothing here is emailed.`;
    $('#beta-detail').textContent = describe(window.JARC_BETA.view);
    $('#demo-role').addEventListener('change', e => { $('#beta-detail').textContent = describe(e.target.value); });
    $('#reset-beta').onclick = () => {
      open(`<div class="tagline">BETA SIMULATION</div><h2>Reset the shared beta workspace</h2>
        <p>This replaces <strong>every shared beta test record</strong> (tickets, projects, tasks, comments, activity, and scope changes) with the original sample records, for everyone in the beta. It cannot be undone.</p>
        <p>Accounts, sign-in sessions, browser-only records, and other databases are not affected.</p>
        <form id="beta-reset-form"><label>Type RESET to confirm *<input name="confirm" autocomplete="off" required></label><div class="actions"><button class="secondary danger">Reset shared beta workspace</button></div></form>`);
      $('#beta-reset-form').onsubmit = async e => {
        e.preventDefault();
        if (new FormData(e.target).get('confirm') !== 'RESET') return toast('Type RESET exactly to confirm.');
        if (await window.JARC_BETA.reset()) { close(); toast('The shared beta workspace was reset to the sample records.'); }
      };
    };
  }

  function showInspectionBanner() {
    const banner = document.createElement('div');
    banner.className = 'inspection-banner';
    banner.id = 'inspection-banner';
    banner.setAttribute('role', 'status');
    const describe = () => `Previewing the ${$('#demo-role').value} view with sample records stored only in this browser. Your account and real role (${me.role}) are unchanged, and nothing here is saved to the server.`;
    banner.innerHTML = `<strong>Inspection mode — sample data</strong><span id="inspection-detail"></span><div class="actions"><button class="secondary" id="reset-sample">Reset sample data</button><button class="primary" id="exit-inspection">Exit inspection</button></div>`;
    document.querySelector('main').insertBefore(banner, document.querySelector('main').firstChild);
    $('#inspection-detail').textContent = describe();
    $('#demo-role').addEventListener('change', e => { inspection.setView(e.target.value); $('#inspection-detail').textContent = describe(); });
    $('#exit-inspection').onclick = () => inspection.exit();
    $('#reset-sample').onclick = () => { if (confirm('Reset all inspection sample data in this browser? Your normal records are not affected.')) inspection.reset(); };
  }

  // Your own settings: email reminders are opt-in, and only sent when the server has email delivery enabled.
  async function openSettings() {
    open('<div class="tagline">SETTINGS</div><h2>Your settings</h2><p>Loading…</p>');
    let prefs;
    try { prefs = await api('GET', '/api/v1/me/preferences'); }
    catch (err) { return open(`<div class="tagline">SETTINGS</div><h2>Your settings</h2><div class="banner">${esc(message(err))}</div>`); }
    const on = prefs.emailDelivery === 'enabled';
    open(`<div class="tagline">SETTINGS</div><h2>Your settings</h2><p>Signed in as ${esc(me.displayName)} (${esc(me.email)}) · ${esc(me.role)}. Your role is set by an Admin.</p>
      <h3>Reminders</h3><p>Due-date reminders, overdue alerts, pending approvals, and escalations always appear in the app (the bell). Dates use ${esc((me.deadlines || {}).timezone || 'Asia/Manila')} time.</p>
      <form id="prefs-form"><label class="task"><input type="checkbox" name="emailReminders" ${prefs.emailReminders ? 'checked' : ''}>Also email me reminders and escalations (ticket number and reminder type only, with a sign-in link)</label>
      <p class="read-only">${on ? 'Email delivery is enabled for this workspace.' : 'Email delivery is not enabled for this workspace yet, so no emails are sent. Your choice is saved for when it is.'}</p>
      <div class="actions"><button class="primary">Save settings</button></div></form>`);
    $('#prefs-form').onsubmit = async e => {
      e.preventDefault();
      try { await api('PATCH', '/api/v1/me/preferences', { emailReminders: e.target.elements.emailReminders.checked }); toast('Settings saved'); close(); }
      catch (err) { toast(message(err)); }
    };
  }

  // A role or access change by an Admin applies on the server at once. When you come back to this page, reload it if
  // your role changed, so the screens match what the server now allows. A disabled account is signed out.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch('/api/v1/me', { credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/auth/signin'; return; }
      const data = await res.json();
      if (data.user && data.user.role !== me.role) { toast(`Your role is now ${data.user.role}. Reloading…`); setTimeout(() => location.reload(), 800); }
    } catch {}
  });

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/auth/signin'; throw new Error('sign-in-required'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'request-failed');
    return data;
  }
  const message = err => ERRORS[err.message] || 'The change could not be saved. Please try again.';

  async function openUsers() {
    open('<div class="tagline">DEVELOPER</div><h2>Users</h2><p>Loading…</p>');
    let users;
    try { users = (await api('GET', '/api/v1/users')).users; }
    catch (err) { return open(`<div class="tagline">DEVELOPER</div><h2>Users</h2><div class="banner">${esc(message(err))}</div>`); }
    const rows = users.map(u => {
      const self = u.email === me.email;
      const role = self ? esc(u.role) : `<select data-user="${esc(u.id)}" data-field="role" aria-label="Role for ${esc(u.email)}">${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
      // Someone who never signed in can only be invited or revoked; the server keeps them "invited" until they sign in.
      const enabledLabel = u.linked ? 'Active' : 'Invited (not signed in yet)';
      const disabledLabel = u.linked ? 'Disabled' : 'Invitation revoked';
      const access = self ? 'You'
        : `<select data-user="${esc(u.id)}" data-field="status" aria-label="Access for ${esc(u.email)}"><option value="active" ${u.status !== 'disabled' ? 'selected' : ''}>${enabledLabel}</option><option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>${disabledLabel}</option></select>`;
      return `<tr class="${self ? 'self' : ''}"><td><span class="ticket-name">${esc(u.displayName)}</span><span class="ticket-id">${esc(u.email)}</span></td><td>${role}</td><td>${access}</td></tr>`;
    }).join('');
    const policy = me.accessPolicy === 'tenant-members'
      ? 'Beta access: every member account of the company tenant can sign in and starts as a Requestor. Guests and other organizations are refused. Invite someone here to give them a different role from their first sign-in.'
      : 'Only invited people can use JarcTech Ticket. An invitation becomes active when that person first signs in with the same Microsoft work email.';
    open(`<div class="tagline">DEVELOPER</div><h2>Users</h2><p>${policy} Roles are set here, never by the sign-in itself. Disabled people cannot sign in under either policy.</p><p class="read-only">Requestor: own requests. Admin: all tickets, management, and delivery. Developer: everything an Admin can do, plus users and roles. At least one active Developer always remains.</p>`
      + `
      <div class="table-wrap"><table class="users-table"><thead><tr><th>Person</th><th>Role</th><th>Access</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3>Invite someone</h3><form id="invite-form"><div class="field-grid"><label class="full">Work email *<input name="email" type="email" required autocomplete="off"></label><label>Display name<input name="displayName" maxlength="120"></label><label>Role *<select name="role" required>${ROLES.map(r => `<option>${r}</option>`).join('')}</select></label></div><div class="actions"><button class="primary">Send invitation</button></div></form>`);
    document.querySelectorAll('[data-user]').forEach(select => select.onchange = async () => {
      try { await api('PATCH', `/api/v1/users/${select.dataset.user}`, { [select.dataset.field]: select.value }); toast('User updated'); }
      catch (err) { toast(message(err)); }
      openUsers();
    });
    $('#invite-form').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('POST', '/api/v1/users', f); toast(`Invitation saved for ${f.email}`); openUsers(); }
      catch (err) { toast(message(err)); }
    };
  }
})();
