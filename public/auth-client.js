/* Signed-in mode only: the server adds this script (and window.JARC_SESSION) when AUTH_MODE=entra.
   Shows who is signed in, Settings (email reminders), a Sign out button, and the Users screen for Admins (the only
   role that manages users and roles). The role shown comes from the server; role and access changes go through the
   users API, which the server checks on every request. If an Admin changes your role while the page is open, the page
   reloads with the new role at the next check, unless you have unsaved text open.
   The Workspace switch, simulation, and preview below exist only in local and test configurations. */
(function () {
  const me = window.JARC_SESSION;
  if (!me) return;
  const ROLES = ['Requestor', 'Developer', 'Admin'];
  const ERRORS = {
    'invalid-email': 'Enter a valid work email address.', 'invalid-role': 'Choose a role.', 'already-exists': 'That email address already has an account or invitation.',
    'cannot-change-self': 'You cannot change your own role or access.', 'last-admin': 'At least one active Admin must remain.', 'changed-meanwhile': 'This person was changed by someone else meanwhile. Review and try again.',
    'invitation-not-accepted': 'This person has not signed in yet, so their invitation is still pending.', 'admin-only': 'Only Admins can manage users and roles.',
    'cross-origin': 'The request was blocked because it did not come from JarcTech Ticket.', 'email-disabled': 'Email delivery is not turned on.', 'in-doubt': 'This message may already have gone out, so retrying could send it twice.', 'not-retryable': 'This message is no longer waiting for a retry. Refresh to see its status.', 'test-too-soon': 'A test message was just queued. Wait a minute before asking for another.', 'not-test-recipient': 'Your account is not on the test recipient list, so no test message was sent.', 'email-preference-off': 'Email is turned off in your Settings, so no test message was sent.', 'rate-limited': 'Too many changes in a short time. Wait a moment and try again.'
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
  // Real user management is never part of inspection or the simulation's views: only real Admin accounts get it,
  // and the server refuses everyone else whatever the page shows.
  if (me.role === 'Admin' && !inspecting) {
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
    const describe = v => `Shared test records saved on the server for everyone in the beta, separate from My workspace. You are simulating the ${v} view${v === 'Developer' ? ', acting as sample developer Miguel Santos: only work assigned to him; plan, add evidence, and mark work done' : v === 'Admin' ? ', acting as test Admin Alex Admin: every record; review, assign (to a sample developer or yourself), approve, and close. Real user management is not available here' : ': your own and the sample requests; confirm meetings, agreements, and completion'}. Each view is a different test identity, so worker and Requestor confirmations stay independent. Your account and real role (${me.role}) do not change, and simulated views give no access to real tickets or accounts. Nothing here is emailed.`;
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

  // Your own settings. Email asking you to act is on unless you turn it off; reminder email is opt-in. Neither is sent
  // unless the server has email delivery enabled.
  async function openSettings() {
    open('<div class="tagline">SETTINGS</div><h2>Your settings</h2><p>Loading…</p>');
    let prefs;
    try { prefs = await api('GET', '/api/v1/me/preferences'); }
    catch (err) { return open(`<div class="tagline">SETTINGS</div><h2>Your settings</h2><div class="banner">${esc(message(err))}</div>`); }
    const on = prefs.emailDelivery !== 'disabled';
    open(`<div class="tagline">SETTINGS</div><h2>Your settings</h2><p>Signed in as ${esc(me.displayName)} (${esc(me.email)}) · ${esc(me.role)}. Your role is set by an Admin.</p>
      <h3>Reminders</h3><p>Due-date reminders, overdue alerts, pending approvals, and escalations always appear in the app (the bell). Dates use ${esc((me.deadlines || {}).timezone || 'Asia/Manila')} time.</p>
      <h3>Email</h3><form id="prefs-form"><label class="task"><input type="checkbox" name="emailActions" ${prefs.emailActions ? 'checked' : ''} ${on ? '' : 'disabled'}>Email me when a request needs my action or is closed (assignment, meetings, agreements, completed work, corrections, closure)</label>
      <label class="task"><input type="checkbox" name="emailReminders" ${prefs.emailReminders ? 'checked' : ''} ${on ? '' : 'disabled'}>Also email me reminders and escalations</label>
      <p class="read-only">${prefs.emailDelivery === 'enabled' ? 'Email delivery is on for this workspace. Emails link to the request; you act in the app, and replies do not become comments.' : prefs.emailDelivery === 'test-only' ? '<b>Being tested:</b> email only reaches a few test accounts for now. Your choices are saved for when it opens to everyone.' : '<b>Not available:</b> email delivery is not set up for this workspace, so no emails are sent. Notifications appear in the app only.'}</p>
      ${on ? '<div class="actions"><button class="primary">Save settings</button></div>' : ''}</form>`);
    $('#prefs-form').onsubmit = async e => {
      e.preventDefault();
      try { await api('PATCH', '/api/v1/me/preferences', { emailActions: e.target.elements.emailActions.checked, emailReminders: e.target.elements.emailReminders.checked }); toast('Settings saved'); close(); }
      catch (err) { toast(message(err)); }
    };
  }

  // A role or access change by an Admin applies on the server at once. This check brings the screens in line: when you
  // return to the page and once a minute while it is showing. A form with typed text is never discarded; the server
  // refuses anything no longer allowed, and the person sees why.
  const typing = () => { const o = document.querySelector('#overlay'); return Boolean(o && !o.hidden && typeof dialogDirty !== 'undefined' && dialogDirty); };
  async function checkAccount() {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch('/api/v1/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        if (typing()) return toast('Your session has ended. Copy any text you want to keep, then sign in again.');
        location.href = '/auth/signin';
        return;
      }
      const data = await res.json();
      if (data.user && data.user.role !== me.role) {
        if (typing()) return toast(`Your role is now ${data.user.role}. The page will update once you finish here.`);
        toast(`Your role is now ${data.user.role}. Reloading…`);
        setTimeout(() => location.reload(), 800);
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', checkAccount);
  setInterval(checkAccount, 60000);

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/auth/signin'; throw new Error('sign-in-required'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'request-failed');
    return data;
  }
  const message = err => ERRORS[err.message] || 'The change could not be saved. Please try again.';

  // What a role or access change means for the person, shown before it is applied.
  function changeImpact(u, field, value) {
    const open = u.openAssigned ? ` ${u.openAssigned} open request${u.openAssigned === 1 ? '' : 's'} assigned to them will need reassigning.` : '';
    if (field === 'status') return value === 'disabled' ? `They are signed out at once and cannot sign in.${open}` : 'They can sign in again with their previous role.';
    return { Admin: 'They will see every request, manage users and roles, assign work, and close requests.', Developer: 'They will see the work assigned to them and their own requests, and can deliver assigned work. They cannot assign work or manage users.', Requestor: `They will see only their own requests.${open}` }[value] || '';
  }
  const ACTIVITY = {
    'user.updated': e => {
      const c = e.changes || {}, p = e.previous || {};
      return [c.role ? `role ${p.role || '?'} → ${c.role}` : '', c.status ? `access ${p.status || '?'} → ${c.status}` : ''].filter(Boolean).join(', ');
    },
    'user.invited': e => `invited as ${e.role || 'a member'}`,
    'user.activated': () => 'first sign-in (invitation accepted)',
    'user.auto-admitted': () => 'first sign-in (new Requestor)',
    'admin.bootstrapped': () => 'made Admin by the owner setup command'
  };
  const timeOf = at => new Date(at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Email delivery for Admins: what is queued, accepted by the provider, failed, or suppressed, with a retry for failures.
  const EMAIL_REASONS = { 'account-unavailable': 'account disabled or unavailable', 'preference-off': 'turned off in their settings', 'not-test-recipient': 'not a test recipient', 'outside-company': 'address is outside the company', 'record-unavailable': 'request deleted', archived: 'request archived', 'no-access': 'no longer has access', 'no-longer-involved': 'no longer involved', 'no-longer-needed': 'step already done or changed', superseded: 'replaced by a newer message', expired: 'waited too long' };
  const EMAIL_STATE = { enabled: 'On for everyone involved.', 'test-only': 'On for the test recipients only.', disabled: 'Off. Notifications are in-app only, and nothing is queued.' };
  async function loadEmailDelivery() {
    const host = document.querySelector('#email-delivery-body');
    if (!host) return;
    let data;
    try { data = await api('GET', '/api/v1/work/email'); }
    catch (err) { host.innerHTML = `<p class="read-only">${esc(message(err))}</p>`; return; }
    const c = data.counts;
    const rows = data.items.map(i => `<tr><td>${esc(i.record || 'Test')}<span class="ticket-id">${esc(i.event)}</span></td><td>${esc(i.recipient)}</td><td>${esc(i.status === 'sent' ? data.sentLabel : i.status[0].toUpperCase() + i.status.slice(1))}${i.reason ? `<span class="ticket-id">${esc(EMAIL_REASONS[i.reason] || i.reason)}</span>` : ''}${i.error ? `<span class="ticket-id">${esc(i.error)}</span>` : ''}</td><td>${esc(timeOf(i.sentAt || i.at))}${i.canRetry ? ` <button class="secondary" data-email-retry="${esc(i.id)}"${i.inDoubt ? ' data-email-force="1"' : ''}>${i.inDoubt ? 'Send again (may duplicate)' : 'Retry'}</button>` : ''}</td></tr>`).join('');
    host.innerHTML = `<p><b>${esc(EMAIL_STATE[data.delivery] || '')}</b> Queued ${c.queued} · Sent ${c.sent} · Failed ${c.failed} · Suppressed ${c.suppressed}</p>
      ${data.provider === 'power-automate' ? `<p id="email-flow-seen"${data.lastCollectedAt && Date.now() - new Date(data.lastCollectedAt) < data.stalledAfterMinutes * 60000 ? '' : ' class="banner"'}>${data.lastCollectedAt ? `The flow last collected at ${esc(timeOf(data.lastCollectedAt))}.` : 'The flow has not collected anything yet.'} It should collect every 2 minutes. Messages wait here for 48 hours if it stops.</p>` : ''}
      <p class="read-only">"${esc(data.sentLabel)}" means the mail service took the message. It does not prove it reached the inbox. In-app notifications are not affected by any of this.</p>
      ${data.delivery === 'disabled' ? '' : '<div class="actions"><button class="secondary" id="email-test">Send a test email to myself</button><button class="secondary" id="email-refresh">Refresh</button></div>'}
      ${rows ? `<div class="table-wrap"><table class="users-table"><thead><tr><th>Request</th><th>To</th><th>Status</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="read-only">No email has been queued.</p>'}`;
    const again = host.querySelector('#email-refresh');
    if (again) again.onclick = loadEmailDelivery;
    const test = host.querySelector('#email-test');
    if (test) test.onclick = async () => { test.disabled = true; try { await api('POST', '/api/v1/work/email/test', {}); toast('Test email queued'); } catch (err) { toast(message(err)); } loadEmailDelivery(); };
    host.querySelectorAll('[data-email-retry]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api('POST', `/api/v1/work/email/${b.dataset.emailRetry}/retry`, b.dataset.emailForce ? { force: true } : {}); toast('Queued again'); } catch (err) { toast(message(err)); } loadEmailDelivery(); });
  }

  async function openUsers() {
    open('<div class="tagline">ADMIN</div><h2>Users</h2><p>Loading…</p>');
    let users, usage, activity = [];
    try {
      const data = await api('GET', '/api/v1/users');
      users = data.users; usage = data.usage;
      activity = (await api('GET', '/api/v1/users/activity').catch(() => ({ activity: [] }))).activity;
    } catch (err) {
      open(`<div class="tagline">ADMIN</div><h2>Users</h2><div class="banner">${esc(message(err))}</div><div class="actions"><button class="secondary" id="users-retry">Try again</button></div>`);
      document.querySelector('#users-retry').onclick = openUsers;
      return;
    }
    const rows = users.map(u => {
      const self = u.id === me.id;
      const role = self ? esc(u.role) : `<select data-user="${esc(u.id)}" data-field="role" aria-label="Role for ${esc(u.email)}">${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
      // Someone who never signed in can only be invited or revoked; the server keeps them "invited" until they sign in.
      const enabledLabel = u.linked ? 'Active' : 'Invited (not signed in yet)';
      const disabledLabel = u.linked ? 'Disabled' : 'Invitation revoked';
      const access = self ? 'You'
        : `<select data-user="${esc(u.id)}" data-field="status" aria-label="Access for ${esc(u.email)}"><option value="active" ${u.status !== 'disabled' ? 'selected' : ''}>${enabledLabel}</option><option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>${disabledLabel}</option></select>`;
      return `<tr class="${self ? 'self' : ''}"><td><span class="ticket-name">${esc(u.displayName)}</span><span class="ticket-id">${esc(u.email)}</span>${u.openAssigned ? `<span class="ticket-id">${u.openAssigned} open assigned</span>` : ''}</td><td>${role}</td><td>${access}</td></tr>`;
    }).join('');
    const policy = me.accessPolicy === 'tenant-members'
      ? '<b>A colleague must sign in once with their company Microsoft account before their account appears here.</b> They then start as a Requestor, and you can make them a Developer or an Admin below. Guests and other organizations are refused.'
      : 'Only invited people can use JarcTech Ticket. An invitation becomes active when that person first signs in with the same Microsoft work email.';
    const used = usage ? Math.round(usage.bytes / usage.quotaBytes * 100) : 0;
    const storage = usage ? `<p class="read-only${used >= 80 ? ' storage-warning' : ''}" id="attachment-usage">Attachment storage: ${esc(AttachmentRules.formatSize(usage.bytes))} of ${esc(AttachmentRules.formatSize(usage.quotaBytes))} (${usage.files} file${usage.files === 1 ? '' : 's'}).${used >= 80 ? ' Nearly full: new uploads will be refused at the limit.' : ''}</p>` : '';
    const log = activity.length ? `<details class="activity-feed" id="account-activity"><summary>Recent account changes</summary>${activity.map(e => `<div class="notice">${esc(e.subject || 'An account')}: ${esc((ACTIVITY[e.type] || (() => e.type))(e))}<small>${esc(timeOf(e.at))}${e.actor ? ` · by ${esc(e.actor)}` : ''}</small></div>`).join('')}</details>` : '';
    open(`<div class="tagline">ADMIN</div><h2>Users</h2><p>${policy} Roles are set here, never by the sign-in itself. Disabled people cannot sign in.</p><p class="read-only">Requestor: submits and tracks own requests and confirms completion. Developer: plans and delivers the work assigned to them, and sees their own requests. Admin: every request, users and roles, assignment (to a Developer or themselves), and final closure. At least one active Admin always remains, and nobody can change their own role or access. Changes apply at once and are recorded.</p>${storage}`
      + `
      <div class="table-wrap"><table class="users-table"><thead><tr><th>Person</th><th>Role</th><th>Access</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="user-confirm" class="banner" role="status" hidden></div>
      ${log}
      <details class="activity-feed" id="email-delivery"><summary>Email delivery</summary><div id="email-delivery-body"><p class="read-only">Loading…</p></div></details>
      <h3>Invite someone before their first sign-in (optional)</h3><p class="read-only">Use this only to give someone a role from their very first sign-in. No email is sent: let them know, and they sign in with this same work email.</p><form id="invite-form"><div class="field-grid"><label class="full">Work email *<input name="email" type="email" required autocomplete="off"></label><label>Display name<input name="displayName" maxlength="120"></label><label>Role *<select name="role" required>${ROLES.map(r => `<option>${r}</option>`).join('')}</select></label></div><div class="actions"><button class="primary">Save invitation</button></div></form>`);
    document.querySelector('#email-delivery').addEventListener('toggle', e => { if (e.target.open) loadEmailDelivery(); });
    // A role or access change takes effect at once, so it is confirmed first.
    document.querySelectorAll('[data-user]').forEach(select => select.onchange = () => {
      const u = users.find(x => x.id === select.dataset.user), field = select.dataset.field, value = select.value;
      const box = document.querySelector('#user-confirm');
      const label = field === 'role' ? `make ${esc(u.displayName)} ${value === 'Admin' ? 'an' : 'a'} ${esc(value)}` : value === 'disabled' ? `turn off access for ${esc(u.displayName)}` : `restore access for ${esc(u.displayName)}`;
      box.hidden = false;
      box.innerHTML = `<p><b>Confirm: ${label}?</b> ${esc(changeImpact(u, field, value))}</p><div class="actions"><button class="primary" id="user-confirm-yes">Confirm change</button><button class="secondary" id="user-confirm-no">Cancel</button></div>`;
      box.querySelector('#user-confirm-no').onclick = openUsers;
      box.querySelector('#user-confirm-yes').onclick = async () => {
        box.querySelector('#user-confirm-yes').disabled = true;
        try { await api('PATCH', `/api/v1/users/${select.dataset.user}`, { [field]: value }); toast('User updated'); }
        catch (err) { toast(message(err)); }
        openUsers();
      };
      box.scrollIntoView({ block: 'center' });
      box.querySelector('#user-confirm-yes').focus();
    });
    $('#invite-form').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('POST', '/api/v1/users', f); toast(`Invitation saved for ${f.email}`); openUsers(); }
      catch (err) { toast(message(err)); }
    };
  }
})();
