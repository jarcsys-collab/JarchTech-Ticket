// Due-date rules shared by the browser and the reminder scheduler (public/deadline-core.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/deadline-core.js');
const WorkflowCore = require('../public/workflow-core.js');

const at = iso => new Date(iso);
const ticket = (extra = {}) => ({ id: 'JRC-1', status: 'In progress', project: 'PRJ-1', date: '2026-11-10', dueDate: '2026-11-10', dev: 'Miguel Santos', tasks: [], statusSince: '2026-11-01T00:00:00Z', ...extra });

test('today is the calendar date in Asia/Manila (UTC+8), not the server clock date', () => {
  assert.equal(D.today(at('2026-11-09T15:59:00Z')), '2026-11-09');
  assert.equal(D.today(at('2026-11-09T16:00:00Z')), '2026-11-10', 'midnight in Manila');
  assert.equal(D.today(at('2026-11-09T16:00:00Z'), 'UTC'), '2026-11-09');
  assert.equal(D.days('2026-11-08', '2026-11-10'), 2);
  assert.equal(D.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(D.formatDate('2026-11-10'), '10 Nov 2026');
});

test('requested and agreed dates are distinct; older records fall back without inventing dates', () => {
  const made = WorkflowCore.createTicket({ title: 'T', description: 'D', date: '2026-12-01' }, 'JRC-9').ticket;
  assert.equal(D.requestedDate(made), '2026-12-01'); assert.equal(D.dueDate(made), '', 'no agreed date before a project');
  made.status = 'Assigned';
  WorkflowCore.ticketAction(made, 'create-project', { projectName: 'P', requirements: 'R', criteria: 'C', date: '2026-12-20', tasks: [{ title: 'A', requirement: 'R', criteria: 'C', start: '2026-12-01', end: '2026-12-05', owner: 'Miguel Santos' }] }, { view: 'Developer', isAssignee: () => true });
  assert.equal(made.requestedDate, '2026-12-01'); assert.equal(made.dueDate, '2026-12-20'); assert.equal(made.date, '2026-12-20');
  assert.equal(D.dueDate({ project: 'PRJ-2', date: '2026-10-01' }), '2026-10-01', 'an existing project keeps its confirmed target');
  assert.equal(D.requestedDate({ project: 'PRJ-2', date: '2026-10-01' }), '', 'not guessed for older projects');
});

test('due soon, overdue, and escalation stages, with each stage named by its deadline', () => {
  const r = (t, iso) => D.reminders(t, [], { now: at(iso) }).map(x => `${x.type}>${x.to}@${x.stage}`);
  assert.deepEqual(r(ticket(), '2026-11-07T02:00:00Z'), [], 'three days out');
  assert.deepEqual(r(ticket(), '2026-11-08T02:00:00Z'), ['due-soon>developer@2026-11-10']);
  assert.deepEqual(r(ticket(), '2026-11-11T02:00:00Z'), ['overdue>developer@2026-11-10']);
  assert.deepEqual(r(ticket(), '2026-11-12T02:00:00Z'), ['overdue>developer@2026-11-10', 'escalate-overdue>admin@2026-11-10']);
  assert.deepEqual(r(ticket({ dueDate: '2026-11-20', date: '2026-11-20' }), '2026-11-12T02:00:00Z'), [], 'a later deadline replaces the old stages');
  for (const status of ['On hold', 'Awaiting acceptance', 'Released', 'Closed', 'Cancelled', 'Rejected']) {
    assert.ok(!r(ticket({ status }), '2026-11-20T02:00:00Z').some(x => x.startsWith('overdue') || x.startsWith('due-soon')), status);
  }
  const labelled = D.label(ticket(), '2026-11-12');
  assert.deepEqual(labelled, { state: 'overdue', text: 'Overdue 2 days' });
});

test('waiting decisions: acceptance escalates; review, information, meeting, and scope changes remind once per state', () => {
  const r = (t, iso, changes = []) => D.reminders(t, changes, { now: at(iso) }).map(x => `${x.type}>${x.to}`);
  const accept = ticket({ status: 'Awaiting acceptance' });
  assert.deepEqual(r(accept, '2026-11-02T00:00:00Z'), []);
  assert.deepEqual(r(accept, '2026-11-03T00:00:00Z'), ['acceptance>requestor']);
  assert.deepEqual(r(accept, '2026-11-06T00:00:00Z'), ['acceptance>requestor', 'escalate-acceptance>admin']);
  assert.deepEqual(r(ticket({ status: 'Submitted', project: null, dueDate: '' }), '2026-11-04T00:00:00Z'), ['review>admin']);
  assert.deepEqual(r(ticket({ status: 'Waiting for information', project: null, dueDate: '' }), '2026-11-04T00:00:00Z'), ['information>requestor']);
  assert.deepEqual(r(ticket({ status: 'Meeting scheduled', project: null, dueDate: '', meeting: '2026-11-05T10:00', meetingConfirmed: false }), '2026-11-04T00:00:00Z'), ['meeting>requestor']);
  const change = { id: 'CR-1', status: 'Awaiting approval', requestorAgreed: true, statusSince: '2026-11-01T00:00:00Z' };
  assert.deepEqual(r(ticket({ status: 'Released' }), '2026-11-04T00:00:00Z', [change]), ['change-approval>admin']);
  const a = D.reminders(accept, [], { now: at('2026-11-03T00:00:00Z') })[0], b = D.reminders({ ...accept, statusSince: '2026-11-05T00:00:00Z' }, [], { now: at('2026-11-08T00:00:00Z') })[0];
  assert.notEqual(a.stage, b.stage, 'returning to acceptance later is a new stage');
});
