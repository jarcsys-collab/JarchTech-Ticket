// Providers the app calls itself. One message in, what happened out, so the queue in email.cjs does not depend on who delivers.
// (Power Automate is not here: there the flow collects messages from the app. See email.cjs and docs/POWER-AUTOMATE-FLOW.md.)
//   send({ key, to, subject, text, html, replyTo }) resolves to:
//     outcome   'sent' the provider has it; 'retry' try again later; 'failed' stop, an Admin can retry
//     error     short code for the status screen: never a message from the provider, an address, or a URL
//     stop      the next message would fail the same way, so end this run
//     uncertain the message may have gone out anyway (timeout, server error)
//     refused   the provider certainly did not take it
//     waitUntil do not try again before this time
//     id        the provider's id, when it gives one
const ERROR_NAME = /^[a-z0-9_-]{1,60}$/;
const USER_AGENT = 'JarcTech-Ticket';
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 30000;

const signal = ms => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
async function jsonOf(res) { try { return typeof res.json === 'function' ? await res.json() : {}; } catch { return {}; } }
const safeName = v => (ERROR_NAME.test(String(v ?? '')) ? String(v) : '');
const nextUtcDay = at => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, 0, 1));

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
      } catch { return { outcome: 'retry', error: 'network', uncertain: true }; }
      const body = await jsonOf(res), { status } = res, name = safeName(body.name);
      if (status >= 200 && status < 300) return { outcome: 'sent', id: typeof body.id === 'string' ? body.id.slice(0, 100) : '' };
      const error = `HTTP ${status}${name ? ` ${name}` : ''}`;
      if (name === 'daily_quota_exceeded') return { outcome: 'retry', error, refused: true, stop: true, keepAttempts: true, waitUntil: nextUtcDay(now()) };
      const retryable = status >= 500 || (status === 429 && name !== 'monthly_quota_exceeded') || (status === 409 && name !== 'invalid_idempotent_request');
      return { outcome: retryable ? 'retry' : 'failed', error, refused: status >= 400 && status < 500, uncertain: status >= 500, stop: [401, 403, 429].includes(status) };
    }
  };
}

const createProvider = ({ config, fetch, now }) => createResend({ config, fetch, now });

module.exports = { RESEND_URL, createProvider };
