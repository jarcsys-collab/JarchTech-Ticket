// Due-date reminders and escalation, run on the server (never in a browser).
// - Every intervalMinutes, one running instance (holding a lease in scheduler_locks) scans the active records of each
//   workspace and works out which reminders are due now (public/deadline-core.js).
// - Each reminder is stored as an in-app notification whose key names the record, reminder type, deadline or state,
//   and inbox, so it is created once however often or on however many instances the scan runs. A changed deadline or
//   a new state is a new key; completed, cancelled, rejected, and paused work produces no reminders.
// - The scan reads current state only, so after a restart or a missed run the next run catches up.
// - If the instance holding the lease stops, the lease expires and another instance takes over.
// - My workspace reminders may also be emailed (email.cjs); beta simulation reminders only reach simulated inboxes.
const { randomUUID } = require('node:crypto');
const DeadlineCore = require('../../public/deadline-core.js');

const JOB = 'reminders';

function createReminders({ db, workspaces, settings = DeadlineCore.DEFAULTS, email = null, now = () => new Date(), log = console, instanceId = randomUUID() }) {
  const locks = db.collection('scheduler_locks');
  const intervalMs = (settings.intervalMinutes || 5) * 60000;
  const leaseMs = Math.max(2 * intervalMs, 120000);
  let timer = null, running = null, stopped = false;

  // True when this instance holds (or has just taken) the lease. A concurrent upsert loses with a duplicate key.
  async function lease() {
    const at = now();
    try {
      const doc = await locks.findOneAndUpdate(
        { _id: JOB, $or: [{ leaseUntil: { $lte: at } }, { owner: instanceId }] },
        { $set: { owner: instanceId, leaseUntil: new Date(at.getTime() + leaseMs) } },
        { upsert: true, returnDocument: 'after' }
      );
      return Boolean(doc && doc.owner === instanceId);
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  }

  async function runOnce() {
    if (!await lease()) return { ran: false, created: 0 };
    const at = now();
    let created = 0;
    for (const ws of workspaces) {
      const items = [];
      for (const { ticket, changes } of await ws.scan()) {
        for (const r of DeadlineCore.reminders(ticket, changes, { now: at, settings })) items.push({ ...r, ticket });
      }
      const docs = await ws.notify.remind(items, at);
      created += docs.length;
      if (docs.length && email && email.enabled && !ws.policy.simulated) await email.enqueue(docs);
    }
    if (email && email.enabled) await email.process();
    await locks.updateOne({ _id: JOB, owner: instanceId }, { $set: { lastRunAt: at } });
    return { ran: true, created };
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(async () => {
      running = runOnce().catch(err => log.error(`Reminders: run failed (${err.name}). The next run will retry.`));
      await running; running = null;
      schedule(intervalMs);
    }, delay);
    timer.unref();
  }

  return {
    runOnce,
    start(firstDelayMs = 15000) { stopped = false; schedule(firstDelayMs); },
    // Stops the timer, waits for a run in progress, and hands the lease back so another instance can start at once.
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
      await locks.updateOne({ _id: JOB, owner: instanceId }, { $set: { leaseUntil: now() } }).catch(() => {});
    },
    instanceId
  };
}

module.exports = { createReminders };
