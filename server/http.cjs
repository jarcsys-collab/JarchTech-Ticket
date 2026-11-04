// Small HTTP helpers shared by the server routes: cookies, JSON bodies, responses, and origin checks.

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
// Large enough for a full agreement or project plan in any language (fields are capped by WorkflowCore).
const MAX_JSON_BYTES = 128 * 1024;

// Headers on every response. Downloads and the app page replace the Content-Security-Policy with a stricter or
// page-specific one.
function baseHeaders({ secure = false } = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': contentSecurityPolicy({}),
    ...(secure ? { 'Strict-Transport-Security': 'max-age=15552000' } : {})
  };
}
// Scripts come only from this app (plus, on the app page, the one inline script carrying the session, by nonce).
// Inline style attributes are used for progress bars and the Gantt chart. formOrigins: where sign-out may continue to.
function contentSecurityPolicy({ nonce, formOrigins = [] }) {
  return [
    "default-src 'self'", `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", `form-action 'self'${formOrigins.map(o => ' ' + o).join('')}`
  ].join('; ');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) { try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

// HttpOnly and SameSite=Lax always; Secure on https. Path=/ and no Domain so __Host- names are valid.
function cookie(name, value, { secure, maxAge }) {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '', `Max-Age=${maxAge}`].filter(Boolean).join('; ');
}

function sendJson(req, res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

function sendHtml(req, res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...SECURITY_HEADERS, ...headers });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function redirect(res, location, status = 302, headers = {}) {
  res.writeHead(status, { Location: location, ...SECURITY_HEADERS, ...headers });
  res.end();
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

// Reads a JSON request body. Rejects other content types, oversized bodies, and malformed JSON.
function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return Promise.reject(new HttpError(415, 'json-required'));
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', chunk => {
      if (!chunks) return;
      size += chunk.length;
      // The refusal is answered with Connection: close (the caller checks req.complete), so the person sees why.
      if (size > MAX_JSON_BYTES) { chunks = null; req.pause(); reject(new HttpError(413, 'body-too-large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(new HttpError(400, 'invalid-json')); }
    });
    req.on('error', () => reject(new HttpError(400, 'invalid-body')));
  });
}

// State-changing requests must come from the app itself. Browsers send Origin on POST, PATCH, and DELETE.
function sameOrigin(req, baseUrl) {
  return req.headers.origin === baseUrl;
}

module.exports = { HttpError, baseHeaders, contentSecurityPolicy, cookie, parseCookies, readJson, redirect, sameOrigin, sendHtml, sendJson, SECURITY_HEADERS };
