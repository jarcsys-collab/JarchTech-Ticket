// In-memory rate limits for one running instance (the app runs as a single Railway service). A restart clears them,
// and more than one instance would each count separately; the limits exist to stop runaway clients and casual abuse,
// not to be an exact quota. Exceeding one answers 429 with Retry-After and changes nothing.
const RULES = {
  signin: { max: 60, windowMs: 60000 },   // per client address: /auth/login and /auth/callback
  read: { max: 1200, windowMs: 60000 },   // per account
  write: { max: 180, windowMs: 60000 },   // per account
  upload: { max: 60, windowMs: 600000 },  // per account; files are at most 10 MB each
  emailflow: { max: 60, windowMs: 60000 } // per client address, wrong secrets included: the flow needs about 12 a run
};
const MESSAGES = {
  signin: 'Too many sign-in attempts from this address. Wait a minute and try again.',
  read: 'Too many requests. Wait a moment and try again.',
  write: 'Too many changes in a short time. Wait a moment and try again; your entry is still here.',
  upload: 'Too many uploads in a short time. Wait a few minutes and try again.',
  emailflow: 'Too many requests.'
};

function createLimits({ enabled = true, now = Date.now, rules = RULES } = {}) {
  const hits = new Map();
  let lastPrune = 0;
  function prune(at) {
    if (at - lastPrune < 60000) return;
    lastPrune = at;
    for (const [key, w] of hits) if (w.until <= at) hits.delete(key);
  }
  // Returns null when allowed, or { retryAfter, message } when the limit is exceeded. Fixed windows per rule and key.
  function take(rule, key) {
    if (!enabled) return null;
    const at = now();
    prune(at);
    const { max, windowMs } = rules[rule];
    const id = `${rule}:${key}`;
    let w = hits.get(id);
    if (!w || w.until <= at) { w = { count: 0, until: at + windowMs }; hits.set(id, w); }
    w.count++;
    return w.count > max ? { retryAfter: Math.max(1, Math.ceil((w.until - at) / 1000)), message: MESSAGES[rule] } : null;
  }
  return { take };
}

// The client address for per-address limits: Railway's edge sets X-Real-IP and replaces any value the client sent.
// Locally there is no proxy, so the socket address is used.
const clientAddress = (req, { trustProxy = false } = {}) => (trustProxy && String(req.headers['x-real-ip'] || '').slice(0, 64)) || req.socket.remoteAddress || 'unknown';

module.exports = { RULES, clientAddress, createLimits };
