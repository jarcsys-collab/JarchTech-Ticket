// HTTP handler: the browser prototype's static files plus health and readiness checks.
// The UI still stores records in the browser; no ticket API exists yet.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function sendJson(req, res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

// /healthz: the process is up and answering. /readyz: it can serve traffic, which requires the database.
// Responses never include error details; those go to the server log, redacted.
function createHealth({ database, isShuttingDown, log }) {
  let lastReady = null;
  return async function health(req, res, pathname) {
    if (pathname === '/healthz') return sendJson(req, res, 200, { status: 'ok' });
    if (isShuttingDown()) return sendJson(req, res, 503, { status: 'not-ready', database: 'stopping' });
    if (!database || !database.configured) return sendJson(req, res, 503, { status: 'not-ready', database: 'not-configured' });
    const result = await database.ping();
    if (result.ok !== lastReady) {
      lastReady = result.ok;
      if (result.ok) log.log('Readiness: database reachable.');
      else log.error(`Readiness: database ${result.reason}.${result.error ? ' ' + result.error : ''}`);
    }
    return result.ok
      ? sendJson(req, res, 200, { status: 'ready', database: 'connected' })
      : sendJson(req, res, 503, { status: 'not-ready', database: result.reason });
  };
}

function createServer({ database = null, isShuttingDown = () => false, log = console } = {}) {
  const health = createHealth({ database, isShuttingDown, log });
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/healthz' || pathname === '/readyz') return health(req, res, pathname);
    let name;
    try { name = decodeURIComponent(pathname); }
    catch { res.writeHead(400); return res.end('Bad request'); }
    if (name === '/') name = '/index.html';
    const file = path.resolve(ROOT, '.' + name);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}

module.exports = { createServer };
