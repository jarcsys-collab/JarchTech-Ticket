// Email for My workspace, through a configured provider (EMAIL_DELIVERY; email-providers.cjs). Off by default. The beta
// simulation never reaches this.
// - Saving an action never depends on email: messages are queued after the save, and a queue or provider failure is logged
//   and changes nothing else. In-app notifications are separate and always stored.
// - Recipients come only from accounts and assignments on the server, one recipient per message, so no list is ever exposed.
// - Action emails are on unless the person turns them off; reminder emails stay opt-in. Both are checked again before sending.
// - Nothing is queued while delivery is off, so turning it on later never sends a backlog. Older queued messages expire.
// - Sending claims one message at a time by moving its next attempt into the future, in one atomic write. If the process
//   stops mid-send the claim runs out and the retry reuses the message's stable key, so it cannot arrive twice.
// - Just before sending, the message's reason is rechecked against the live record: account, preference, access, and whether
//   the step is still open. Otherwise it is suppressed with a reason.
// - Status words: pending = queued, sent = taken by the provider (not proof of inbox delivery), failed, skipped = suppressed.
//   Addresses and message content are never logged. email_outbox stays within its existing validator.
const { ObjectId } = require('mongodb');
const DeadlineCore = require('../../public/deadline-core.js');
const { requestPath } = require('../auth/return-path.cjs');
const { HttpError } = require('../http.cjs');
const { ADMINS } = require('./notifications.cjs');
const { LABELS, renderEmail } = require('./email-templates.cjs');
const { planTicketEmails, staleReason } = require('./email-events.cjs');
const { RESEND_URL, createProvider } = require('./email-providers.cjs');

const BATCH = 20, MAX_ATTEMPTS = 5, STATUS_LIMIT = 50;
const CLAIM_MS = 10 * 60000, MAX_AGE_MS = 48 * 3600000, SOON_MS = 500, PACE_MS = 120;
const ID = /^[0-9a-f]{24}$/, ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const STATES = { pending: 'queued', sent: 'sent', failed: 'failed', skipped: 'suppressed' };

function createEmail({ config, db, fetch = globalThis.fetch, now = () => new Date(), log = console, settings = DeadlineCore.DEFAULTS, canSee = async () => true, instant = false, pace = PACE_MS }) {
  const outbox = db.collection('email_outbox'), users = db.collection('users');
  const tickets = db.collection('tickets'), changes = db.collection('ticket_changes');
  const enabled = Boolean(config && config.enabled);
  const testList = new Set(((config && config.testRecipients) || []).map(a => a.toLowerCase()));
  const mode = !enabled ? 'disabled' : testList.size ? 'test-only' : 'enabled';
  const provider = enabled ? createProvider({ config, fetch, now }) : null;
  const allowedDomains = ((config && config.allowedDomains) || []).map(d => d.toLowerCase());
  const inCompany = address => !allowedDomains.length || allowedDomains.includes(String(address).split('@').pop().toLowerCase());
  const onTestList = user => !testList.size || testList.has(String(user.email).toLowerCase());
  const wantsMail = (user, event) => (event === 'reminder' ? user.emailReminders === true : user.emailActions !== false);
  const idOf = v => (ID.test(String(v)) ? new ObjectId(String(v)) : null);
  const userById = id => { const _id = idOf(id); return _id ? users.findOne({ _id }) : null; };
  const replyToFor = actor => (actor && ADDRESS.test(String(actor.email || '')) && inCompany(actor.email) ? actor.email : config.replyTo || null);
  const blocked = (user, event) => (user.status !== 'active' || !ADDRESS.test(String(user.email || '')) ? 'account-unavailable' : !inCompany(user.email) ? 'outside-company' : !wantsMail(user, event) ? 'preference-off' : !onTestList(user) ? 'not-test-recipient' : null);

  // ---- Queueing ----
  async function queue({ key, user, event, audience, record, ticket, change, data, render, replyTo, reviewer }) {
    const at = now(), reason = blocked(user, event);
    const message = renderEmail({ event, record, reviewer, timezone: settings.timezone, link: `${config.appUrl}${ticket ? requestPath(ticket, change) : '/'}`, ...render });
    const doc = { key, userId: user._id, to: '', ...message, event, audience, record, ticket, data, ...(replyTo ? { replyTo } : {}), status: reason ? 'skipped' : 'pending', ...(reason ? { reason } : {}), attempts: 0, nextAttemptAt: at, createdAt: at };
    try { await outbox.insertOne(doc); }
    catch (err) { if (err.code === 11000) return false; throw err; } // this event already queued it: a repeat, not a new message
    // A newer message of the same kind replaces one still waiting: nobody needs both meeting proposals.
    const kinds = [['meeting-proposed', 'meeting-changed'], ['assigned', 'reassigned']].find(group => group.includes(event)) || [event];
    if (!reason && ticket && event !== 'reminder') await outbox.updateMany({ status: 'pending', userId: user._id, ticket, event: { $in: kinds }, key: { $ne: key } }, { $set: { status: 'skipped', reason: 'superseded' } });
    return !reason;
  }

  // The Requestor side is normally the Requestor. With a disabled Requestor, or a Developer who is both Requestor and worker,
  // an Admin other than the worker confirms for them. An active Admin in both places confirms for themselves.
  async function reviewers(t) {
    const owner = t.requester ? await userById(t.requester.id) : null;
    const same = Boolean(t.devId && owner && String(owner._id) === t.devId);
    if (owner && owner.status === 'active' && (!same || owner.role === 'Admin')) return { people: [owner], asReviewer: false };
    const admins = await users.find({ role: 'Admin', status: 'active' }).toArray();
    return { people: admins.filter(u => String(u._id) !== t.devId), asReviewer: true };
  }
  async function audienceOf(audience, t) {
    const one = async id => { const u = id ? await userById(id) : null; return { people: u ? [u] : [], asReviewer: false }; };
    if (audience === 'requester') return one(t.requester && t.requester.id);
    if (audience === 'worker') return one(t.devId);
    if (audience === 'reviewer') return reviewers(t);
    return { people: await users.find({ role: 'Admin', status: 'active' }).toArray(), asReviewer: false };
  }

  // Called once after a ticket action is saved. Never throws: the action has already succeeded.
  async function ticketSaved({ before, after, action, input, actor }) {
    if (!enabled || !after || !after.id || (after.requester && after.requester.sample)) return 0;
    try {
      const seen = new Set([String(actor._id)]); // nobody is told about their own action, and one action is one email each
      let queued = 0;
      const delivery = DeadlineCore.dueDate(after);
      for (const { event, audience, data } of planTicketEmails(before, after, action, input)) {
        const { people, asReviewer } = await audienceOf(audience, after);
        for (const user of people) {
          const uid = String(user._id);
          if (seen.has(uid)) continue;
          seen.add(uid);
          const dated = ['assigned', 'reassigned'].includes(event) ? delivery || DeadlineCore.requestedDate(after) : ['completion-review', 'ready-to-close'].includes(event) ? delivery : '';
          const added = await queue({
            key: `${after.id}:${after.version}:email:${event}:${uid}`, user, event, audience, record: after.id, ticket: after.id, data,
            reviewer: asReviewer, replyTo: replyToFor(actor),
            render: { actorName: actor.displayName || actor.email, ticketTitle: after.title, meeting: data.meeting, location: data.meeting ? after.location : '', delivery: dated }
          });
          if (added) queued++;
        }
      }
      if (queued) soon();
      return queued;
    } catch (err) {
      log.error(`Email: messages for ${after.id} were not queued (${err.name}). The action itself was saved.`);
      return 0;
    }
  }

  // Reminders and escalations from the scheduler, for people who opted in. docs: new in-app reminder notifications.
  async function reminderRecipients(inbox) {
    const opted = { status: 'active', emailReminders: true };
    if (inbox === ADMINS) return users.find({ role: 'Admin', ...opted }).toArray();
    const m = /^user:([0-9a-f]{24})$/.exec(inbox);
    return m ? users.find({ _id: new ObjectId(m[1]), ...opted }).toArray() : [];
  }
  async function enqueue(docs) {
    if (!enabled) return 0;
    let queued = 0;
    for (const doc of docs) {
      const t = doc.ticket ? await tickets.findOne({ workspace: 'main', id: doc.ticket }) : null;
      const dated = doc.type && /due|overdue/.test(doc.type) && t ? DeadlineCore.dueDate(t) : '';
      for (const user of await reminderRecipients(doc.inbox)) {
        const added = await queue({
          key: `${doc.key}:${user._id}`, user, event: 'reminder', audience: 'reminder', record: doc.record, ticket: doc.ticket || doc.record,
          change: doc.kind === 'change' ? doc.record : null, data: { type: doc.type, stage: doc.stage, to: doc.to }, replyTo: config.replyTo || null,
          render: { title: doc.title, ticketTitle: t ? t.title : '', delivery: dated }
        });
        if (added) queued++;
      }
    }
    return queued;
  }

  // ---- Sending ----
  // The same message always goes with the same key, unless an Admin has started a new attempt.
  const sendNow = (item, user) => provider.send({ key: `${item.key.slice(0, 240)}${item.generation ? `#${item.generation}` : ''}`, to: user.email, subject: item.subject, text: item.text, html: item.html, replyTo: item.replyTo });
  const backoff = attempts => Math.min(2 ** attempts * 5 * 60000, 6 * 3600000);

  async function whyNot(item, user) {
    if (!user) return 'account-unavailable';
    const reason = blocked(user, item.event);
    if (reason) return reason;
    if (!item.ticket || item.event === 'test') return null;
    const t = await tickets.findOne({ workspace: 'main', id: item.ticket });
    if (!t || t.deleting) return 'record-unavailable';
    if (t.archived) return 'archived';
    const cs = item.event === 'reminder' ? await changes.find({ workspace: 'main', ticket: t.id }).toArray() : [];
    return staleReason(item, t, user, cs, { now: now(), settings }) || (await canSee(user, t) ? null : 'no-access');
  }

  // Sends what is due. Returns { sent }. Stops early on anything that would fail the same way for the next message.
  async function run() {
    let sent = 0;
    const at = now();
    await outbox.updateMany({ status: 'pending', createdAt: { $lt: new Date(at.getTime() - MAX_AGE_MS) } }, { $set: { status: 'skipped', reason: 'expired' } });
    for (const due of await outbox.find({ status: 'pending', nextAttemptAt: { $lte: at } }).sort({ nextAttemptAt: 1 }).limit(BATCH).toArray()) {
      const item = await outbox.findOneAndUpdate({ _id: due._id, status: 'pending', nextAttemptAt: { $lte: now() } }, { $set: { nextAttemptAt: new Date(now().getTime() + CLAIM_MS) } }, { returnDocument: 'after' });
      if (!item) continue; // another run took it
      const user = await users.findOne({ _id: item.userId });
      const reason = await whyNot(item, user);
      if (reason) { await outbox.updateOne({ _id: item._id }, { $set: { status: 'skipped', reason } }); continue; }
      let result;
      try { result = await sendNow(item, user); }
      catch { result = { outcome: 'retry', error: 'network', uncertain: true }; }
      const attempts = item.attempts + 1;
      if (result.outcome === 'sent') {
        await outbox.updateOne({ _id: item._id }, { $set: { status: 'sent', attempts, sentAt: now(), ...(result.id ? { providerId: result.id } : {}) }, $unset: { lastError: '', inDoubt: '' } });
        sent++;
        if (pace) await new Promise(r => setTimeout(r, pace));
        continue;
      }
      const done = result.outcome === 'failed' || attempts >= MAX_ATTEMPTS;
      await outbox.updateOne({ _id: item._id }, { $set: { status: done ? 'failed' : 'pending', attempts: result.keepAttempts ? item.attempts : attempts, lastError: result.error, refused: Boolean(result.refused), uncertain: Boolean(item.uncertain) || Boolean(result.uncertain), inDoubt: Boolean(result.inDoubt), nextAttemptAt: result.waitUntil || new Date(now().getTime() + backoff(attempts)) } });
      if (done) log.error(`Email: a message about ${item.record || 'a test'} could not be delivered (${result.error}).`);
      if (result.stop) break;
    }
    return { sent };
  }
  let running = null, timer = null;
  function process() {
    if (!enabled) return Promise.resolve({ sent: 0 });
    running ??= run().catch(err => { log.error(`Email: the send run failed (${err.name}). The next run will retry.`); return { sent: 0 }; }).finally(() => { running = null; });
    return running;
  }
  function soon() {
    if (!instant || timer) return;
    timer = setTimeout(() => { timer = null; process(); }, SOON_MS);
    timer.unref();
  }

  // ---- Admin status, retry, and a test message ----
  async function status(filter) {
    const query = filter && STATES[filter] ? { status: filter } : {};
    const grouped = await outbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    const counts = { queued: 0, sent: 0, failed: 0, suppressed: 0 };
    for (const g of grouped) if (STATES[g._id]) counts[STATES[g._id]] = g.n;
    const items = await outbox.find(query, { projection: { event: 1, record: 1, ticket: 1, userId: 1, status: 1, reason: 1, attempts: 1, lastError: 1, inDoubt: 1, createdAt: 1, sentAt: 1 } }).sort({ _id: -1 }).limit(STATUS_LIMIT).toArray();
    const people = new Map((await users.find({ _id: { $in: [...new Set(items.map(i => String(i.userId)))].map(x => new ObjectId(x)) } }, { projection: { displayName: 1, email: 1 } }).toArray()).map(u => [String(u._id), u.displayName || u.email]));
    return {
      delivery: mode, provider: provider ? provider.name : null, sentLabel: provider ? provider.sentLabel : 'Sent', counts,
      items: items.map(i => ({ id: String(i._id), record: i.record || '', ticket: i.ticket || '', event: LABELS[i.event] || 'Reminder or escalation', recipient: people.get(String(i.userId)) || 'A removed account', status: STATES[i.status] || i.status, reason: i.reason || '', attempts: i.attempts, error: i.lastError || '', at: i.createdAt, sentAt: i.sentAt || null, canRetry: enabled && i.status === 'failed', inDoubt: Boolean(i.inDoubt) }))
    };
  }
  // Only a failed message, once: the status change is atomic. The live record is rechecked when it is sent.
  async function retry(id, { force = false } = {}) {
    if (!enabled) throw new HttpError(409, 'email-disabled');
    const _id = idOf(id);
    if (!_id) throw new HttpError(404, 'not-found');
    const failed = await outbox.findOne({ _id, status: 'failed' });
    if (!failed) throw new HttpError(409, 'not-retryable');
    // A message in doubt may have gone out, so a new attempt needs the Admin to accept that it could arrive twice.
    if (failed.inDoubt && !force) throw new HttpError(409, 'in-doubt');
    const update = { $set: { status: 'pending', attempts: 0, nextAttemptAt: now(), createdAt: now(), refused: false, inDoubt: false, ...(failed.inDoubt ? { uncertain: false } : {}) }, ...(failed.inDoubt || (failed.refused && !failed.uncertain) ? { $inc: { generation: 1 } } : {}) };
    const claimed = await outbox.findOneAndUpdate({ _id, status: 'failed', attempts: failed.attempts }, update, { returnDocument: 'after' });
    if (!claimed) throw new HttpError(409, 'not-retryable');
    soon();
    return { id: String(_id), status: 'queued' };
  }
  // One message to the Admin who asks, at most once a minute. It touches no request, so a test needs no real record.
  async function sendTest(actor) {
    if (!enabled) throw new HttpError(409, 'email-disabled');
    const minute = Math.floor(now().getTime() / 60000);
    const added = await queue({ key: `test:${actor._id}:${minute}`, user: actor, event: 'test', audience: 'self', record: '', ticket: '', data: {}, replyTo: config.replyTo || null, render: { actorName: actor.displayName || actor.email } });
    if (!added) {
      const row = await outbox.findOne({ key: `test:${actor._id}:${minute}` });
      throw new HttpError(409, row && row.reason === 'not-test-recipient' ? 'not-test-recipient' : row && row.reason === 'preference-off' ? 'email-preference-off' : 'test-too-soon');
    }
    soon();
    return { status: 'queued' };
  }
  async function stop() {
    clearTimeout(timer); timer = null;
    if (running) await running;
  }

  // Reaches the provider without sending anything, where it can (Power Automate).
  const check = async () => (provider && provider.check ? provider.check() : { ok: false, step: 'unavailable', code: '' });

  return { enabled, mode, provider: config ? config.provider : 'disabled', check, enqueue, ticketSaved, process, status, retry, sendTest, stop };
}

module.exports = { RESEND_URL, createEmail };
