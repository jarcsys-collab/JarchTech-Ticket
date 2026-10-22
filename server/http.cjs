// Small HTTP helpers shared by the server routes: cookies, JSON bodies, responses, and origin checks.

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const MAX_JSON_BYTES = 16 * 1024;

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
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) { reject(new HttpError(413, 'body-too-large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
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

module.exports = { HttpError, cookie, parseCookies, readJson, redirect, sameOrigin, sendHtml, sendJson, SECURITY_HEADERS };
