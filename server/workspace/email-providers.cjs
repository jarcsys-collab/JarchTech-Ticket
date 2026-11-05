// Email providers. Each takes one rendered message and says what happened, in the same words, so the queue in email.cjs
// (claims, backoff, stale checks, status) does not depend on who delivers it.
//   send({ eventId, key, to, subject, text, html, replyTo }) resolves to:
//     outcome   'sent'    the provider has it
//               'retry'   try again later
//               'failed'  stop; an Admin can retry
//     error     short code for the status screen: never a message from the provider, an address, or a URL
//     stop      the next message would fail the same way, so end this run
//     uncertain the message may have gone out anyway (timeout, server error)
//     refused   the provider certainly did not take it
//     inDoubt   the flow's own ledger cannot say whether it went
//     waitUntil do not try again before this time
//     id        the provider's id, when it gives one
const { createHash } = require('node:crypto');

const ERROR_NAME = /^[a-z0-9_-]{1,60}$/;
const USER_AGENT = 'JarcTech-Ticket';
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 30000;
// A flow must answer within 120 seconds (Power Automate's limit for HTTP-triggered flows), so this outlasts it.
const FLOW_TIMEOUT_MS = 130000;
const TOKEN_TIMEOUT_MS = 20000, TOKEN_MARGIN_MS = 5 * 60000;
const FLOW_AUDIENCE = 'https://service.flow.microsoft.com/';

const signal = ms => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
async function jsonOf(res) { try { return typeof res.json === 'function' ? await res.json() : {}; } catch { return {}; } }
const safeName = v => (ERROR_NAME.test(String(v ?? '')) ? String(v) : '');
const nextUtcDay = at => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, 0, 1));
const later = (res, at) => {
  const seconds = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(at.getTime() + Math.min(seconds, 3600) * 1000) : null;
};
const unknown = error => ({ outcome: 'retry', error, uncertain: true });

function createResend({ config, fetch, now }) {
  return {
    name: 'resend',
    sentLabel: 'Accepted by Resend',
    async send(m) {
      let res;
      try {
        res = await fetch(RESEND_URL, {
          method: 'POST', signal: signal(RESEND_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'Idempotency-Key': m.key },
          body: JSON.stringify({ from: config.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}) })
        });
      } catch { return unknown('network'); }
      const body = await jsonOf(res), { status } = res, name = safeName(body.name);
      if (status >= 200 && status < 300) return { outcome: 'sent', id: typeof body.id === 'string' ? body.id.slice(0, 100) : '' };
      const error = `HTTP ${status}${name ? ` ${name}` : ''}`;
      if (name === 'daily_quota_exceeded') return { outcome: 'retry', error, refused: true, stop: true, keepAttempts: true, waitUntil: nextUtcDay(now()) };
      const retryable = status >= 500 || (status === 429 && name !== 'monthly_quota_exceeded') || (status === 409 && name !== 'invalid_idempotent_request');
      return { outcome: retryable ? 'retry' : 'failed', error, refused: status >= 400 && status < 500, uncertain: status >= 500, stop: [401, 403, 429].includes(status) };
    }
  };
}

// Calls one Power Automate flow, which sends through the Office 365 Outlook connector. See docs/POWER-AUTOMATE-FLOW.md.
// The app signs in as its own service principal, and the flow's trigger allows only that one (no secret in the address).
// What the flow can send is limited in the flow itself: a fixed mailbox, company recipients only.
function createPowerAutomate({ config, fetch, now }) {
  let token = null; // { value, until }: held in memory only

  async function accessToken() {
    if (token && token.until > now().getTime()) return token.value;
    const res = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', signal: signal(TOKEN_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: `${FLOW_AUDIENCE}/.default` }).toString()
    });
    const body = await jsonOf(res);
    if (res.status !== 200 || typeof body.access_token !== 'string') { const e = new Error('token'); e.code = safeName(body.error) || `HTTP ${res.status}`; throw e; }
    token = { value: body.access_token, until: now().getTime() + Math.max(0, (Number(body.expires_in) || 0) * 1000 - TOKEN_MARGIN_MS) };
    return token.value;
  }

  async function call(payload) {
    const bearer = await accessToken(); // before the flow, so a failure here means nothing was sent
    return fetch(config.flowUrl, {
      method: 'POST', signal: signal(FLOW_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(payload)
    });
  }

  return {
    name: 'power-automate',
    sentLabel: 'Sent by Outlook',
    async send(m) {
      let res;
      try { res = await call({ schema: 1, eventId: createHash('sha256').update(m.key).digest('hex'), to: m.to, subject: m.subject, html: m.html || `<pre>${String(m.text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`, replyTo: m.replyTo || '' }); }
      catch (err) {
        if (err.message === 'token') return { outcome: 'retry', error: `token ${err.code}`, refused: true, stop: true };
        return unknown('network'); // it may have reached the flow; its ledger makes the retry safe
      }
      const body = await jsonOf(res), { status } = res, flow = safeName(body.outcome), code = safeName(body.code);
      if (status === 200 && (flow === 'sent' || flow === 'already-sent')) return { outcome: 'sent', id: flow };
      // Accepted but not answered: the flow ran or will run, and nothing says that Outlook sent it.
      if (status === 202) return { ...unknown('flow accepted, no result'), stop: true };
      if (flow === 'rejected') return { outcome: 'failed', error: `rejected ${code}`.trim(), refused: true };
      if (flow === 'in-doubt') return { ...unknown('in doubt'), inDoubt: true };
      if (flow === 'outlook-failed') {
        // The flow has cleared its ledger entry for this message, except for a timeout, which it reports as in-doubt.
        const error = `Outlook ${code}`.trim();
        const connection = ['401', '403', '404'].includes(code); // an expired connection, or no access to the mailbox
        const throttled = code === '429';
        return { outcome: connection ? 'failed' : 'retry', error, refused: true, stop: connection || throttled, waitUntil: later(res, now()) };
      }
      const error = `HTTP ${status}`;
      if (status === 429) return { outcome: 'retry', error, refused: true, stop: true, waitUntil: later(res, now()) };
      if (status === 401 || status === 403) return { outcome: 'failed', error, refused: true, stop: true };
      if (status >= 500 || status === 408) return unknown(error);
      return { outcome: 'failed', error, refused: true };
    },
    // Reaches the flow without sending anything: it answers before its first mail action. Proves the sign-in, the
    // trigger's allowed caller, and the flow being on. It cannot prove the Outlook connection is still valid.
    async check() {
      let res;
      try { res = await call({ schema: 1, check: true, eventId: 'check', to: '', subject: '', html: '', replyTo: '' }); }
      catch (err) { return { ok: false, step: err.message === 'token' ? 'sign-in' : 'network', code: err.code || '' }; }
      const body = await jsonOf(res);
      return res.status === 200 && body.outcome === 'check' ? { ok: true } : { ok: false, step: 'flow', code: `HTTP ${res.status}` };
    }
  };
}

function createProvider({ config, fetch, now }) {
  if (config.provider === 'power-automate') return createPowerAutomate({ config, fetch, now });
  return createResend({ config, fetch, now });
}

module.exports = { FLOW_AUDIENCE, RESEND_URL, createProvider };
