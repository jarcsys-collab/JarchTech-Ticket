// Microsoft Entra sign-in routes, server-side sessions, the signed-in API, and the gate in front of the app.
// Any sign-in problem ends on an error or access-denied page; there is no fallback to demo mode.
const { HttpError, cookie, parseCookies, readJson, redirect, sameOrigin, sendHtml, sendJson } = require('../http.cjs');
const { redact } = require('../redact.cjs');
const { createOidc } = require('./oidc.cjs');
const { pages } = require('./pages.cjs');
const { ABSOLUTE_MS, StoreError, createStore } = require('./store.cjs');
const { seal, unseal } = require('./tokens.cjs');

const FLOW_MS = 10 * 60 * 1000;
const FLOW_PURPOSE = 'jarctech-auth-flow';
const PUBLIC_ASSETS = new Set(['/style.css']); // used by the sign-in pages before anyone is signed in
const USER_PATH = /^\/api\/v1\/users\/([0-9a-f]{24})$/;

function createAuth(auth, { database, log = console, oidc: oidcOptions, now } = {}) {
  const store = createStore(database.db(), { now });
  const oidc = createOidc(auth, oidcOptions);
  const secure = auth.secureCookies;
  const SESSION = secure ? '__Host-jt_session' : 'jt_session';
  const FLOW = secure ? '__Host-jt_auth' : 'jt_auth';
  const clear = name => cookie(name, '', { secure, maxAge: 0 });
  const describe = err => redact(database.redact(`${err.name}: ${err.message}`), [auth.clientSecret, auth.sessionSecret]);
  const tokenOf = req => parseCookies(req)[SESSION];

  async function currentUser(req) {
    const found = await store.getSession(tokenOf(req));
    return found ? found.user : null;
  }

  async function login(req, res) {
    try {
      const { url, flow } = await oidc.begin();
      const value = seal({ ...flow, exp: Date.now() + FLOW_MS }, auth.sessionSecret, FLOW_PURPOSE);
      return redirect(res, url, 302, { 'Set-Cookie': cookie(FLOW, value, { secure, maxAge: FLOW_MS / 1000 }) });
    } catch (err) {
      log.error(`Sign-in unavailable: ${describe(err)}`);
      return sendHtml(req, res, 503, pages.unavailable());
    }
  }

  async function callback(req, res) {
    const clearFlow = { 'Set-Cookie': clear(FLOW) };
    const url = new URL(req.url, auth.baseUrl);
    const error = url.searchParams.get('error');
    if (error) {
      const code = error.replace(/[^a-z_]/gi, '').slice(0, 60);
      log.error(`Microsoft sign-in returned an error: ${code}`);
      return sendHtml(req, res, 400, pages.failed(`Microsoft sign-in did not complete (${code}). Please try again.`), clearFlow);
    }
    const flow = unseal(parseCookies(req)[FLOW], auth.sessionSecret, FLOW_PURPOSE);
    if (!flow || !(flow.exp > Date.now())) {
      return sendHtml(req, res, 400, pages.failed('The sign-in attempt expired or was started in another browser. Please try again.'), clearFlow);
    }
    let claims;
    try { claims = await oidc.finish(url, flow); }
    catch (err) {
      log.error(`Sign-in rejected: ${describe(err)}`);
      return sendHtml(req, res, 401, pages.failed('The sign-in response could not be verified. Please try again.'), clearFlow);
    }
    const result = await store.admit(claims, auth.tenantId);
    if (result.denied) {
      log.log(`Sign-in denied (${result.denied}).`);
      return sendHtml(req, res, 403, pages.denied(result.denied), clearFlow);
    }
    await store.deleteSession(tokenOf(req)); // never keep using a session from before this sign-in
    const token = await store.createSession(result.user._id);
    return redirect(res, '/', 302, { 'Set-Cookie': [clear(FLOW), cookie(SESSION, token, { secure, maxAge: ABSOLUTE_MS / 1000 })] });
  }

  async function logout(req, res) {
    if (!sameOrigin(req, auth.baseUrl)) return sendHtml(req, res, 403, pages.failed('Sign-out must be started from JarcTech Ticket.'));
    await store.deleteSession(tokenOf(req));
    return redirect(res, (await oidc.signOutUrl()) || '/auth/signed-out', 303, { 'Set-Cookie': clear(SESSION) });
  }

  async function api(req, res, pathname) {
    const user = await currentUser(req);
    if (!user) return sendJson(req, res, 401, { error: 'sign-in-required' });
    const write = !['GET', 'HEAD'].includes(req.method);
    if (write && !sameOrigin(req, auth.baseUrl)) return sendJson(req, res, 403, { error: 'cross-origin' });
    if (pathname === '/api/v1/me') {
      if (write) return sendJson(req, res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, HEAD' });
      return sendJson(req, res, 200, { mode: 'entra', user: store.publicUser(user) });
    }
    const userMatch = USER_PATH.exec(pathname);
    if (pathname !== '/api/v1/users' && !userMatch) return sendJson(req, res, 404, { error: 'not-found' });
    if (user.role !== 'Admin') return sendJson(req, res, 403, { error: 'admin-only' });
    if (pathname === '/api/v1/users' && !write) return sendJson(req, res, 200, { users: await store.listUsers() });
    if (pathname === '/api/v1/users' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 201, { user: await store.inviteUser({ email: body?.email, role: body?.role, displayName: body?.displayName }, user) });
    }
    if (userMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      const changes = {};
      for (const key of ['role', 'status']) if (body && key in body) changes[key] = body[key];
      return sendJson(req, res, 200, { user: await store.updateUser(userMatch[1], changes, user) });
    }
    return sendJson(req, res, 405, { error: 'method-not-allowed' });
  }

  // Handles /auth/* and /api/v1/*. Returns false for other paths.
  async function handle(req, res, pathname) {
    try {
      if (pathname === '/auth/login' && req.method === 'GET') { await login(req, res); return true; }
      if (pathname === '/auth/callback' && req.method === 'GET') { await callback(req, res); return true; }
      if (pathname === '/auth/logout' && req.method === 'POST') { await logout(req, res); return true; }
      if (pathname === '/auth/signin' && req.method === 'GET') {
        if (await currentUser(req)) redirect(res, '/'); else sendHtml(req, res, 200, pages.signIn());
        return true;
      }
      if (pathname === '/auth/signed-out' && req.method === 'GET') { sendHtml(req, res, 200, pages.signedOut()); return true; }
      if (pathname.startsWith('/auth/')) { sendHtml(req, res, 404, pages.failed('This sign-in address does not exist.')); return true; }
      if (pathname.startsWith('/api/')) { await api(req, res, pathname); return true; }
      return false;
    } catch (err) {
      if (err instanceof HttpError || err instanceof StoreError) { sendJson(req, res, err.status, { error: err.code }); return true; }
      log.error(`Request failed: ${describe(err)}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'server-error' });
      return true;
    }
  }

  // Every app file except the sign-in pages' stylesheet requires an active session.
  // Returns the signed-in user, or null after sending the sign-in redirect or a 401.
  async function gate(req, res, pathname) {
    if (PUBLIC_ASSETS.has(pathname)) return { public: true };
    const user = await currentUser(req);
    if (user) return { user };
    if (pathname === '/' || pathname.endsWith('.html')) redirect(res, '/auth/signin');
    else { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Sign in required'); }
    return null;
  }

  return { handle, gate, store, cookieName: SESSION };
}

// Adds the signed-in user's display details to index.html. Values are JSON with < escaped, so they cannot end the script.
function injectSession(html, user) {
  const data = JSON.stringify({ displayName: user.displayName || user.email, email: user.email, role: user.role }).replace(/</g, '\\u003c');
  return html
    .replace('<script src="timeline-core.js"></script>', `<script>window.JARC_SESSION=Object.freeze(${data});</script><script src="timeline-core.js"></script>`)
    .replace('</body>', '<script src="auth-client.js"></script></body>');
}

module.exports = { createAuth, injectSession };
