// HTTP handler: the browser prototype's static files, health and readiness checks, and (with AUTH_MODE=entra)
// Microsoft sign-in in front of the app and its ticket APIs (My workspace and the beta simulation).
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { injectSession } = require('./auth/index.cjs');
const { BETA_COLLECTIONS, CORE_COLLECTIONS, WORK_COLLECTIONS } = require('./schema.cjs');

const ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function sendJson(req, res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

// /healthz: the process is up and answering. /readyz: it can serve traffic, which requires the database and,
// with sign-in enabled, the collections created by `npm run db:setup` (checked read-only).
// Responses never include error details; those go to the server log, redacted.
// The database check is shared by concurrent requests and cached (5 s when ready, 1 s when not, so a fix shows up
// quickly), so the public endpoint causes at most one ping and schema check per interval however often it is called.
const READY_CACHE_MS = 5000;
const NOT_READY_CACHE_MS = 1000;

function createHealth({ database, requireSchema, isShuttingDown, log, now = Date.now }) {
  let lastState = null;
  let cached = null; // { at, result } of the last completed check
  let inFlight = null;
  const note = (state, message) => {
    if (state === lastState) return;
    lastState = state;
    if (state === 'ready') log.log(message); else log.error(message);
  };

  async function check() {
    const ping = await database.ping();
    if (!ping.ok) {
      note(ping.reason, `Readiness: database ${ping.reason}.${ping.error ? ' ' + ping.error : ''}`);
      return { ready: false, database: ping.reason };
    }
    if (requireSchema && requireSchema.length) {
      const missing = await database.missingSchema(requireSchema);
      if (missing.length) {
        note('schema-missing', `Readiness: required collections or indexes are missing (${missing.join(', ')}). Run npm run db:setup.`);
        return { ready: false, database: 'schema-missing' };
      }
    }
    note('ready', 'Readiness: database reachable.');
    return { ready: true, database: 'connected' };
  }

  function readiness() {
    if (cached && now() - cached.at < (cached.result.ready ? READY_CACHE_MS : NOT_READY_CACHE_MS)) return Promise.resolve(cached.result);
    inFlight ??= check()
      .catch(err => { log.error(`Readiness check failed: ${database.redact(`${err.name}: ${err.message}`)}`); return { ready: false, database: 'unreachable' }; })
      .then(result => { cached = { at: now(), result }; inFlight = null; return result; });
    return inFlight;
  }

  return async function health(req, res, pathname) {
    if (pathname === '/healthz') return sendJson(req, res, 200, { status: 'ok' });
    if (isShuttingDown()) return sendJson(req, res, 503, { status: 'not-ready', database: 'stopping' });
    if (!database || !database.configured) return sendJson(req, res, 503, { status: 'not-ready', database: 'not-configured' });
    const result = await readiness();
    return result.ready
      ? sendJson(req, res, 200, { status: 'ready', database: 'connected' })
      : sendJson(req, res, 503, { status: 'not-ready', database: result.database });
  };
}

async function serveStatic(req, res, pathname, user, page) {
  let name;
  try { name = decodeURIComponent(pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (name === '/') name = '/index.html';
  const file = path.resolve(ROOT, '.' + name);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (user && name === '/index.html') { bytes = injectSession(bytes.toString('utf8'), user, page); headers['X-Frame-Options'] = 'DENY'; }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

// `auth` is null in demo mode, which serves the prototype exactly as before.
// `now` is for tests of the readiness cache.
function createServer({ database = null, auth = null, isShuttingDown = () => false, log = console, now } = {}) {
  // Readiness requires the sign-in and My workspace collections with Entra sign-in, plus the beta ones when enabled.
  const requireSchema = auth ? [...CORE_COLLECTIONS, ...WORK_COLLECTIONS, ...(auth.beta ? BETA_COLLECTIONS : [])] : [];
  const health = createHealth({ database, requireSchema, isShuttingDown, log, now });
  return http.createServer(async (req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (auth && await auth.handle(req, res, pathname)) return;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    if (pathname === '/healthz' || pathname === '/readyz') return health(req, res, pathname);
    if (!auth) return serveStatic(req, res, pathname, null);
    try {
      const access = await auth.gate(req, res, pathname);
      if (access) return serveStatic(req, res, pathname, access.user || null, access.page);
    } catch (err) {
      log.error(`Request failed: ${database.redact(`${err.name}: ${err.message}`)}`);
      if (!res.headersSent) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('Service unavailable'); }
    }
  });
}

module.exports = { createServer };
