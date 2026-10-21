const { test } = require('node:test');
const assert = require('node:assert/strict');
const TC = require('../public/ticket-core.js');

// In-memory stand-in for window.localStorage. Options simulate browser storage failures.
class FakeStorage {
  constructor(entries = {}, { failRead = false, failWrite = false, corruptWrite = false } = {}) {
    this.map = new Map(Object.entries(entries));
    Object.assign(this, { failRead, failWrite, corruptWrite });
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { if (this.failRead) throw new Error('SecurityError: storage blocked'); return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.failWrite) throw new Error('QuotaExceededError'); this.map.set(k, this.corruptWrite ? String(v).slice(1) : String(v)); }
  removeItem(k) { this.map.delete(k); }
  snapshot() { return Object.fromEntries(this.map); }
}

const KEY = 'jarc-helpdesk-v1';
const NOW = Date.UTC(2026, 9, 21, 6, 30);
const seed = () => ({ tickets: [{ id: 'JRC-1', name: 'Sample', tasks: [], history: [] }], changes: [], notices: [] });
const existing = () => ({
  tickets: [
    { id: 'JRC-1042', title: 'Sales reporting', name: 'Adriane Venzon', dev: 'Miguel Santos', status: 'In progress', project: 'PRJ-1', projectName: 'Sales automation',
      tasks: [{ title: 'Export', start: '2026-10-01', end: '2026-10-03', done: true, owner: 'Miguel Santos' }, { title: 'Undated draft', done: false }],
      history: [{ text: 'Request submitted.', time: 'Oct 16, 10:00 AM' }], futureField: { kept: true } },
    { id: 'JRC-1043', title: 'Other team request', name: 'Someone Else', dev: 'Elyza Cruz', status: 'Assigned', tasks: [], history: [] },
    { id: 'JRC-1044', title: 'Unassigned request', name: 'Adriane Venzon', dev: '', status: 'Submitted', tasks: [], history: [] }
  ],
  changes: [{ id: 'CR-201', ticket: 'JRC-1042', status: 'Submitted', history: [] }],
  notices: [{ text: 'JRC-1042 · Request submitted.', time: 'Oct 16, 10:00 AM' }]
});
const backupKeys = storage => Object.keys(storage.snapshot()).filter(k => k.startsWith(TC.BACKUP_PREFIX));

test('storage key and statuses keep the existing values', () => {
  assert.equal(TC.STORAGE_KEY, KEY);
  assert.equal(TC.statuses.length, 14);
  assert.deepEqual(TC.people, ['Miguel Santos', 'Elyza Cruz', 'Paolo Reyes']);
});

test('existing records load unchanged and save back in the same format', () => {
  const raw = JSON.stringify(existing());
  const storage = new FakeStorage({ [KEY]: raw });
  const session = TC.load(storage, seed, NOW);
  assert.equal(session.recovery, null);
  assert.equal(session.isNew, false);
  assert.deepEqual(session.state, existing());
  assert.equal(session.state.tickets[0].tasks[1].start, undefined, 'undated tasks are not given dates');
  assert.deepEqual(storage.snapshot(), { [KEY]: raw }, 'loading writes nothing');
  assert.deepEqual(TC.save(storage, session.state, session), { ok: true });
  assert.equal(storage.getItem(KEY), raw);
});

test('missing records start from sample data as a new demo', () => {
  const storage = new FakeStorage();
  const session = TC.load(storage, seed, NOW);
  assert.equal(session.isNew, true);
  assert.equal(session.recovery, null);
  assert.deepEqual(session.state, seed());
  assert.equal(storage.length, 0, 'loading alone does not write');
});

test('role filtering: admin sees all, developer sees assigned, requestor sees own', () => {
  const { tickets } = existing();
  const ids = role => TC.visibleTickets(tickets, role).map(t => t.id);
  assert.deepEqual(ids('Admin'), ['JRC-1042', 'JRC-1043', 'JRC-1044']);
  assert.deepEqual(ids('Developer'), ['JRC-1042']);
  assert.deepEqual(ids('Requestor'), ['JRC-1042', 'JRC-1044']);
});

test('progress rounds completed tasks and treats no tasks as zero', () => {
  assert.equal(TC.progress({ tasks: [] }), 0);
  assert.equal(TC.progress({}), 0);
  assert.equal(TC.progress({ tasks: [{ done: true }, { done: false }, { done: false }] }), 33);
  assert.equal(TC.progress({ tasks: [{ done: true }, { done: true }] }), 100);
});

for (const [label, raw, reason] of [
  ['unparseable JSON', '{"tickets":[', 'unreadable'],
  ['JSON null', 'null', 'invalid'],
  ['missing notices', JSON.stringify({ tickets: [], changes: [] }), 'invalid'],
  ['ticket without history', JSON.stringify({ tickets: [{ id: 'JRC-1', tasks: [] }], changes: [], notices: [] }), 'invalid'],
  ['change without id', JSON.stringify({ tickets: [], changes: [{ history: [] }], notices: [] }), 'invalid']
]) {
  test(`invalid data (${label}) enters recovery, keeps the original, and backs up the exact value`, () => {
    const storage = new FakeStorage({ [KEY]: raw, unrelated: 'x' });
    const session = TC.load(storage, seed, NOW);
    assert.equal(session.recovery.reason, reason);
    assert.equal(session.isNew, false, 'demo dates are not applied during recovery');
    assert.deepEqual(session.state, { tickets: [], changes: [], notices: [] }, 'sample data is not loaded');
    assert.equal(storage.getItem(KEY), raw, 'original value untouched');
    assert.equal(storage.getItem('unrelated'), 'x');
    assert.equal(session.recovery.backupKey, TC.BACKUP_PREFIX + '2026-10-21T06-30-00-000Z');
    assert.equal(storage.getItem(session.recovery.backupKey), raw);
  });
}

test('reloading invalid data reuses an identical backup instead of adding copies', () => {
  const storage = new FakeStorage({ [KEY]: 'not json' });
  const first = TC.load(storage, seed, NOW);
  const second = TC.load(storage, seed, NOW + 60000);
  assert.equal(second.recovery.backupKey, first.recovery.backupKey);
  assert.equal(backupKeys(storage).length, 1);
});

test('a different invalid value gets a unique backup key without overwriting earlier backups', () => {
  const storage = new FakeStorage({ [KEY]: 'first bad value' });
  const first = TC.load(storage, seed, NOW);
  storage.map.set(KEY, 'second bad value');
  const second = TC.load(storage, seed, NOW);
  assert.notEqual(second.recovery.backupKey, first.recovery.backupKey);
  assert.equal(storage.getItem(first.recovery.backupKey), 'first bad value');
  assert.equal(storage.getItem(second.recovery.backupKey), 'second bad value');
});

test('failed backup still preserves the original and reports the failure', () => {
  const storage = new FakeStorage({ [KEY]: '{broken' }, { failWrite: true });
  const session = TC.load(storage, seed, NOW);
  assert.equal(session.recovery.backupKey, null);
  assert.match(session.recovery.backupError, /Quota/);
  assert.equal(session.recovery.raw, '{broken', 'raw value is available for download');
  assert.deepEqual(storage.snapshot(), { [KEY]: '{broken' });
});

test('a backup that does not read back identically is treated as failed', () => {
  const storage = new FakeStorage({ [KEY]: '{broken' }, { corruptWrite: true });
  const session = TC.load(storage, seed, NOW);
  assert.equal(session.recovery.backupKey, null);
  assert.match(session.recovery.backupError, /did not match/);
  assert.equal(storage.getItem(KEY), '{broken');
});

test('storage read failure enters recovery without writing anything', () => {
  const storage = new FakeStorage({ [KEY]: JSON.stringify(existing()) }, { failRead: true });
  const session = TC.load(storage, seed, NOW);
  assert.equal(session.recovery.reason, 'read-failed');
  assert.equal(session.recovery.raw, null);
  assert.match(session.recovery.error, /blocked/);
  assert.equal(storage.map.size, 1);
  assert.equal(TC.load(null, seed, NOW).recovery.reason, 'read-failed', 'missing storage object is handled');
});

test('saves are blocked during recovery and the stored value stays untouched', () => {
  const storage = new FakeStorage({ [KEY]: '{broken' });
  const session = TC.load(storage, seed, NOW);
  session.state.tickets.push({ id: 'JRC-9', tasks: [], history: [] });
  assert.deepEqual(TC.save(storage, session.state, session), { ok: false, reason: 'recovery' });
  assert.equal(storage.getItem(KEY), '{broken');
});

test('write failures are reported rather than thrown, keeping the last saved value', () => {
  const raw = JSON.stringify(existing());
  const storage = new FakeStorage({ [KEY]: raw });
  const session = TC.load(storage, seed, NOW);
  storage.failWrite = true;
  session.state.notices.unshift({ text: 'new', time: 'now' });
  const result = TC.save(storage, session.state, session);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-failed');
  assert.equal(storage.getItem(KEY), raw);
});

test('explicit reset removes only the main record and keeps backups', () => {
  const storage = new FakeStorage({ [KEY]: '{broken' });
  const session = TC.load(storage, seed, NOW);
  assert.deepEqual(TC.reset(storage), { ok: true });
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem(session.recovery.backupKey), '{broken');
  const fresh = TC.load(storage, seed, NOW);
  assert.equal(fresh.isNew, true, 'next load starts sample data like a fresh browser');
});
