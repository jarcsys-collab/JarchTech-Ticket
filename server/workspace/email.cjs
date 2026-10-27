// Optional email for My workspace reminders and escalations (EMAIL_DELIVERY=resend). Off by default.
// - Only accounts that are active and turned "Email me reminders" on receive email; the setting is checked again
//   just before sending. Beta simulation reminders are never emailed.
// - Messages carry the ticket number, the kind of reminder, and a sign-in link: no summaries, descriptions,
//   comments, or names.
// - Each message is queued once per notification and recipient (email_outbox, unique key) and sent by the reminder
//   scheduler with retries and backoff; a failed provider call never affects in-app notifications.
const { ObjectId } = require('mongodb');
const { ADMINS } = require('./notifications.cjs');

const RESEND_URL = 'https://api.resend.com/emails';
const BATCH = 20, MAX_ATTEMPTS = 5;

function createEmail({ config, db, fetch = globalThis.fetch, now = () => new Date(), log = console }) {
  const outbox = db.collection('email_outbox'), users = db.collection('users');
  const enabled = Boolean(config && config.enabled);

  async function recipients(inbox) {
    if (inbox === ADMINS) return users.find({ role: 'Admin', status: 'active', emailReminders: true }).toArray();
    const m = /^user:([0-9a-f]{24})$/.exec(inbox);
    if (!m) return [];
    return users.find({ _id: new ObjectId(m[1]), status: 'active', emailReminders: true }).toArray();
  }
  const message = doc => ({
    subject: `JarcTech Ticket reminder for ${doc.record}`,
    text: `${doc.title} (${doc.record}).\n\nSign in to JarcTech Ticket to see the details:\n${config.appUrl}/\n\nYou receive this because email reminders are on in your JarcTech Ticket settings. You can turn them off there at any time.`
  });

  async function enqueue(docs) {
    if (!enabled) return 0;
    const at = now();
    let queued = 0;
    for (const doc of docs) {
      for (const user of await recipients(doc.inbox)) {
        try {
          await outbox.insertOne({ key: `${doc.key}:${user._id}`, userId: user._id, to: user.email, ...message(doc), status: 'pending', attempts: 0, nextAttemptAt: at, createdAt: at });
          queued++;
        } catch (err) { if (err.code !== 11000) throw err; }
      }
    }
    return queued;
  }

  async function send(item) {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.key.slice(0, 256) },
      body: JSON.stringify({ from: config.from, to: [item.to], subject: item.subject, text: item.text })
    });
    return res.status;
  }

  // Sends due messages. Permanent refusals (4xx other than 429) are not retried; others back off up to MAX_ATTEMPTS.
  async function process() {
    if (!enabled) return { sent: 0 };
    let sent = 0;
    for (const item of await outbox.find({ status: 'pending', nextAttemptAt: { $lte: now() } }).sort({ nextAttemptAt: 1 }).limit(BATCH).toArray()) {
      const user = await users.findOne({ _id: item.userId, status: 'active', emailReminders: true });
      if (!user) { await outbox.updateOne({ _id: item._id }, { $set: { status: 'skipped' } }); continue; }
      let status = 0;
      try { status = await send({ ...item, to: user.email }); } catch { status = 0; }
      const attempts = item.attempts + 1;
      if (status >= 200 && status < 300) { await outbox.updateOne({ _id: item._id }, { $set: { status: 'sent', attempts, sentAt: now() } }); sent++; continue; }
      const permanent = status >= 400 && status < 500 && status !== 429;
      const done = permanent || attempts >= MAX_ATTEMPTS;
      await outbox.updateOne({ _id: item._id }, { $set: { status: done ? 'failed' : 'pending', attempts, lastError: status ? `HTTP ${status}` : 'network', nextAttemptAt: new Date(now().getTime() + Math.min(2 ** attempts * 5 * 60000, 6 * 3600000)) } });
      if (done) log.error(`Email: a reminder could not be delivered (${status ? `HTTP ${status}` : 'network error'}).`);
    }
    return { sent };
  }

  return { enabled, provider: config ? config.provider : 'disabled', enqueue, process };
}

module.exports = { RESEND_URL, createEmail };
