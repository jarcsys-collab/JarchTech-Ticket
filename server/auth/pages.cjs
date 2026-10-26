// Server-rendered sign-in, access-denied, signed-out, and error pages in the JARC teal style.
// None of them load the ticket app or any browser records.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page({ title, heading, message, action = '', note = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · JarcTech Ticket</title><link rel="stylesheet" href="/style.css">
<style>
/* Centered in the whole viewport. The card is a <main>, so the app layout rules for main (sidebar offset and side padding) are reset here. */
body.auth-page{min-height:100vh;min-height:100dvh;margin:0;display:grid;place-items:center;background:linear-gradient(155deg,#068e94,#007d85);padding:24px}
body.auth-page main.auth-card{margin:0;max-width:none;background:#fff;border-radius:17px;padding:38px 36px;width:min(460px,100%);box-shadow:0 20px 50px #0b3f4433}
@media(max-width:720px){body.auth-page{padding:16px}body.auth-page main.auth-card{padding:28px 22px}}
.auth-brand{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:750;color:#008d95;margin-bottom:26px}
.auth-brand .brandmark{background:#009fa7;color:#fff;width:42px;height:42px;font-size:24px;border-radius:13px}
.auth-brand small{display:block;font-size:11px;font-weight:400;color:#859297;margin-top:2px}
.auth-card h1{font-size:24px;letter-spacing:-.5px;margin:0 0 10px}
.auth-card .actions{margin-top:24px}
.auth-card .primary{display:inline-block;text-decoration:none}
.auth-note{font-size:11px;color:#8a9a9e;margin-top:18px}
</style></head>
<body class="auth-page"><main class="auth-card" role="main"><div class="auth-brand"><span class="brandmark">J</span><span>Jarc<small>JarcTech Ticket</small></span></div>
<h1>${esc(heading)}</h1><p>${esc(message)}</p>${action ? `<div class="actions">${action}</div>` : ''}${note ? `<p class="auth-note">${esc(note)}</p>` : ''}</main></body></html>`;
}

const signInButton = (label = 'Sign in with Microsoft') => `<a class="primary" href="/auth/login">${esc(label)}</a>`;

const DENIED = {
  'not-invited': 'Your Microsoft account signed in successfully, but it has not been given access to JarcTech Ticket. Ask a JarcTech Ticket administrator to invite you.',
  disabled: 'Your access to JarcTech Ticket has been turned off. Contact a JarcTech Ticket administrator if you need it restored.',
  guest: 'Guest accounts from other organizations cannot use JarcTech Ticket. Sign in with your company account.',
  'wrong-tenant': 'This account belongs to a different organization. Sign in with your company account.',
  'missing-identity': 'Microsoft did not return a stable account identifier and work email, so access cannot be checked.',
  'personal-account': 'Personal Microsoft accounts cannot use JarcTech Ticket. Sign in with your company account.',
  'account-conflict': 'Another JarcTech Ticket account already uses this work email with a different Microsoft account. Ask a JarcTech Ticket administrator to resolve it.'
};

const SIGN_IN_MESSAGE = {
  'invite-only': 'Use your company Microsoft account. Access is by invitation from a JarcTech Ticket administrator.',
  'tenant-members': 'Use your company Microsoft account. During the beta, all company member accounts can sign in; new users start as Requestors.'
};

const pages = {
  signIn: (accessPolicy = 'invite-only') => page({ title: 'Sign in', heading: 'Sign in to JarcTech Ticket', message: SIGN_IN_MESSAGE[accessPolicy] || SIGN_IN_MESSAGE['invite-only'], action: signInButton() }),
  denied: reason => page({ title: 'Access not granted', heading: 'Access not granted', message: DENIED[reason] || DENIED['not-invited'], action: signInButton('Sign in with a different account'), note: 'No ticket data was opened.' }),
  signedOut: () => page({ title: 'Signed out', heading: 'You have signed out', message: 'Your JarcTech Ticket session has ended.', action: signInButton('Sign in again') }),
  failed: message => page({ title: 'Sign-in failed', heading: 'Sign-in could not be completed', message, action: signInButton('Try again') }),
  notSetUp: () => page({ title: 'Sign-in not set up', heading: 'Sign-in is not set up yet', message: 'The JarcTech Ticket database has not been prepared for sign-in. An administrator needs to complete the one-time setup.' }),
  unavailable: () => page({ title: 'Sign-in unavailable', heading: 'Sign-in is temporarily unavailable', message: 'JarcTech Ticket could not reach Microsoft sign-in. Please try again in a few minutes.', action: signInButton('Try again') })
};

module.exports = { pages };
