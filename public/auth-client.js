/* Signed-in mode only: the server adds this script (and window.JARC_SESSION) when AUTH_MODE=entra.
   Shows who is signed in, a Sign out button, and the Admin Users screen. The role shown comes from the server;
   role and access changes go through the admin API, which the server checks on every request. */
(function () {
  const me = window.JARC_SESSION;
  if (!me) return;
  const ROLES = ['Requestor', 'Developer', 'Admin'];
  const ERRORS = {
    'invalid-email': 'Enter a valid work email address.', 'invalid-role': 'Choose a role.', 'already-exists': 'That email address already has an account or invitation.',
    'cannot-change-self': 'You cannot change your own role or access.', 'last-admin': 'At least one active Admin must remain.',
    'invitation-not-accepted': 'This person has not signed in yet, so their invitation is still pending.', 'admin-only': 'Only Admins can manage users.',
    'cross-origin': 'The request was blocked because it did not come from JarcTech Ticket.'
  };

  const style = document.createElement('style');
  style.textContent = '.signed-in-as{font-size:11px;color:#6c7e80}.signout-form{margin:0}.users-table{min-width:0}.users-table td,.users-table th{font-size:11px}.users-table select{margin:0;padding:6px 8px;font-size:11px}.users-table .self{color:#8a9a9e}';
  document.head.appendChild(style);

  // The demo role selector is for demo mode only; here the role comes from the signed-in account.
  const demoRole = document.querySelector('.demo-role-label');
  if (demoRole) demoRole.hidden = true;
  const avatar = document.querySelector('.avatar');
  avatar.textContent = me.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  avatar.title = `${me.displayName} (${me.email})`;

  const right = document.querySelector('.header-right');
  const who = document.createElement('span');
  who.className = 'signed-in-as';
  who.textContent = `${me.displayName} · ${me.role}`;
  right.insertBefore(who, avatar);
  if (me.role === 'Admin') {
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
  right.appendChild(signOut);

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/auth/signin'; throw new Error('sign-in-required'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'request-failed');
    return data;
  }
  const message = err => ERRORS[err.message] || 'The change could not be saved. Please try again.';

  async function openUsers() {
    open('<div class="tagline">ADMIN</div><h2>Users</h2><p>Loading…</p>');
    let users;
    try { users = (await api('GET', '/api/v1/users')).users; }
    catch (err) { return open(`<div class="tagline">ADMIN</div><h2>Users</h2><div class="banner">${esc(message(err))}</div>`); }
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
    open(`<div class="tagline">ADMIN</div><h2>Users</h2><p>Only invited people can use JarcTech Ticket. An invitation becomes active when that person first signs in with the same Microsoft work email. Roles are set here, never by the sign-in itself.</p>
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
