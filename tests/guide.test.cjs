// Guided next actions (WorkflowCore.nextStep): every suggestion comes from the workflow rules themselves. Following
// the suggested steps, taken by whoever they name, must drive a request from submission to closure without a single
// refused action, and nobody else is ever told a step is theirs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../public/workflow-core.js');

const sim = v => W.simulatedContext(v, { time: () => 'now' });
const VIEWS = { Requestor: sim('Requestor'), Admin: sim('Admin'), Developer: sim('Developer') };
const task = { title: 'Build', requirement: 'R', criteria: 'C', start: '2026-11-02', end: '2026-11-10', owner: 'Miguel Santos' };
// Real input for each suggested step (the form a person would fill in).
const INPUT = {
  review: { status: 'Under review' }, resume: { status: 'Under review' }, 'provide-info': { status: 'Under review' },
  'schedule-meeting': { meeting: '2026-11-01T10:00', location: 'Room 1' }, 'confirm-meeting': {},
  'record-agreement': { notes: 'Met.', requirements: 'Reports', criteria: 'Totals match' }, 'confirm-agreement': {}, 'confirm-agreement-worker': {},
  'create-project': { projectName: 'P', date: '2026-12-01', tasks: [task] }, start: { status: 'In progress' },
  'add-evidence': { links: [{ url: 'https://reports.example.com/1' }] }, 'worker-complete': { summary: 'Tested.' }, 'requestor-confirm': {},
  release: { status: 'Released' }, close: { status: 'Closed' }
};
// Follows the guidance until nothing is open (or the step named until). assignTo: who the Admin assigns. Returns the
// steps taken and who took them.
function follow(t, contexts, { assignTo = 'Miguel Santos', until = null } = {}) {
  const path = [];
  for (let i = 0; i < 40; i++) {
    const step = W.nextStep(t, Object.values(contexts));
    if (!step || step.key === until) return path;
    assert.ok(step.mine, `${step.key}: someone among the participants can take it`);
    const ctx = Object.values(contexts).find(c => c.view === step.mine);
    const input = step.key === 'assign' ? { dev: assignTo, priority: 'High' } : step.key === 'tasks' ? { index: t.tasks.findIndex(x => !x.done), done: true } : INPUT[step.key];
    W.ticketAction(t, step.action, input, ctx); // throws if guidance ever suggested a refused action
    path.push(`${step.key}:${step.mine}`);
    // Nobody outside the step's party is told it is theirs.
    for (const [view, c] of Object.entries(contexts)) {
      const own = W.nextStep(t, [c]);
      if (own && own.mine) assert.equal(own.mine, view);
    }
  }
  throw new Error('guidance did not reach an end');
}
const fresh = type => W.createTicket({ title: 'T', description: 'D', type, date: '2026-12-01', name: 'Rhea' }, 'JRC-9').ticket;

test('a Ticket follows review, assignment, work, evidence, both confirmations, and closure', () => {
  const t = fresh('Ticket');
  assert.deepEqual(follow(t, VIEWS), ['review:Admin', 'assign:Admin', 'start:Developer', 'add-evidence:Developer', 'worker-complete:Developer', 'requestor-confirm:Requestor', 'close:Admin']);
  assert.equal(t.status, 'Closed');
});

test('a Project follows the meeting, both agreement confirmations, timeline, tasks, evidence, handover, and closure', () => {
  const t = fresh('Project');
  assert.deepEqual(follow(t, VIEWS), ['review:Admin', 'assign:Admin', 'schedule-meeting:Developer', 'confirm-meeting:Requestor', 'record-agreement:Developer', 'confirm-agreement-worker:Developer', 'confirm-agreement:Requestor', 'create-project:Developer', 'start:Developer', 'tasks:Developer', 'add-evidence:Developer', 'worker-complete:Developer', 'requestor-confirm:Requestor', 'release:Developer', 'close:Admin']);
  assert.equal(t.status, 'Closed');
});

test('Admin self-assignment: the Admin is guided through the worker steps; the Requestor still confirms', () => {
  const t = fresh('Ticket');
  assert.deepEqual(follow(t, VIEWS, { assignTo: W.SIM_ADMIN }), ['review:Admin', 'assign:Admin', 'start:Admin', 'add-evidence:Admin', 'worker-complete:Admin', 'requestor-confirm:Requestor', 'close:Admin']);
});

test('waiting states name who acts next, and a returned correction leads back to the worker', () => {
  const t = fresh('Ticket');
  W.ticketAction(t, 'assign', { dev: 'Miguel Santos', priority: 'Low' }, VIEWS.Admin);
  const forRequestor = W.nextStep(t, [VIEWS.Requestor]);
  assert.deepEqual([forRequestor.key, forRequestor.party, forRequestor.mine], ['start', 'worker', null], 'the Requestor waits for the worker');
  W.ticketAction(t, 'status', { status: 'In progress' }, VIEWS.Developer);
  W.ticketAction(t, 'add-evidence', INPUT['add-evidence'], VIEWS.Developer);
  W.ticketAction(t, 'worker-complete', INPUT['worker-complete'], VIEWS.Developer);
  assert.deepEqual([W.nextStep(t, [VIEWS.Admin]).key, W.nextStep(t, [VIEWS.Admin]).mine], ['requestor-confirm', null], 'the Admin cannot close yet and is told it waits for the Requestor');
  W.ticketAction(t, 'reason', { status: 'In progress', reason: 'Wrong totals' }, VIEWS.Requestor);
  const back = W.nextStep(t, [VIEWS.Developer]);
  assert.deepEqual([back.key, back.mine], ['worker-complete', 'Developer'], 'evidence is kept; the worker completes again');
  assert.equal(W.nextStep(t, [VIEWS.Requestor]).mine, null);
  assert.equal(W.nextStep({ ...t, status: 'Waiting for information', dev: '' }, [VIEWS.Requestor]).key, 'provide-info');
  assert.equal(W.nextStep({ ...t, status: 'On hold' }, [VIEWS.Admin]).key, 'resume');
  for (const status of ['Closed', 'Rejected', 'Cancelled']) assert.equal(W.nextStep({ ...t, status }, Object.values(VIEWS)), null, status);
});

test('the Requestor and the worker may confirm the agreement in either order', () => {
  const t = fresh('Project');
  W.ticketAction(t, 'assign', { dev: 'Miguel Santos', priority: 'Low' }, VIEWS.Admin);
  W.ticketAction(t, 'schedule-meeting', INPUT['schedule-meeting'], VIEWS.Developer);
  W.ticketAction(t, 'confirm-meeting', {}, VIEWS.Requestor);
  W.ticketAction(t, 'record-agreement', INPUT['record-agreement'], VIEWS.Developer);
  assert.equal(W.nextStep(t, [VIEWS.Requestor]).key, 'confirm-agreement');
  assert.equal(W.nextStep(t, [VIEWS.Developer]).key, 'confirm-agreement-worker');
  assert.equal(W.nextStep(t, [VIEWS.Admin]).mine, null);
  W.ticketAction(t, 'confirm-agreement', {}, VIEWS.Requestor);
  assert.equal(W.nextStep(t, [VIEWS.Requestor]).mine, null, 'after confirming, the Requestor waits for the worker');
});

test('My workspace capacities: when the Requestor is the worker, only a different Admin is guided to confirm', () => {
  const acc = (view, uid) => ({ view, time: () => 'now', actorFor: () => ({ id: uid, name: uid }), isRequester: t => t.requester.id === uid, isWorker: t => ['Admin', 'Developer'].includes(view) && t.devId === uid, sameParty: t => t.devId === t.requester.id, assignee: id => ({ dev: id, devId: id }) });
  const t = { id: 'JRC-2001', type: 'Ticket', status: 'Awaiting acceptance', dev: 'dev1', devId: 'dev1', requester: { id: 'dev1', name: 'Dee' }, tasks: [], history: [], evidence: [{ kind: 'link', url: 'https://x.example/' }], completion: { round: 1, worker: { id: 'dev1' }, requestor: null, log: [] } };
  const self = W.nextStep(t, [acc('Developer', 'dev1'), acc('Requestor', 'dev1')]);
  assert.deepEqual([self.key, self.mine, self.independent], ['requestor-confirm', null, true], 'the worker is not guided to confirm their own work');
  const admin = W.nextStep(t, [acc('Admin', 'adm2')]);
  assert.deepEqual([admin.key, admin.mine, admin.independent], ['requestor-confirm', 'Admin', true]);
  W.ticketAction(t, 'requestor-confirm', {}, acc('Admin', 'adm2'));
  assert.equal(t.completion.requestor.id, 'adm2');
});

test('an Admin who is both Requestor and worker is guided through each step themselves, never to another reviewer', () => {
  const uid = 'adm1';
  const acc = view => ({ view, time: () => 'now', actorFor: () => ({ id: uid, name: 'Ana' }), isRequester: t => t.requester.id === uid, isWorker: t => view === 'Admin' && t.devId === uid, sameParty: () => false, selfService: t => t.devId === uid && t.requester.id === uid, owners: ['Ana'], assignee: () => ({ dev: 'Ana', devId: uid }) });
  const contexts = [acc('Admin'), acc('Requestor')];
  const inputs = { start: { status: 'In progress' }, 'add-evidence': { links: [{ url: 'https://x.example/' }] }, 'worker-complete': { summary: 'Done' }, 'requestor-confirm': {}, close: { status: 'Closed' } };
  const t = { id: 'JRC-2100', type: 'Ticket', status: 'Assigned', priority: 'Low', dev: 'Ana', devId: uid, requester: { id: uid, name: 'Ana' }, tasks: [], history: [], evidence: [], completion: { round: 1, worker: null, requestor: null, log: [] } };
  const path = [];
  for (let s = W.nextStep(t, contexts); s; s = W.nextStep(t, contexts)) {
    assert.ok(s.mine, `${s.key} is theirs`);
    assert.equal(s.self, true); assert.equal(s.independent, false);
    assert.doesNotMatch(`${s.title} ${s.explain}`, /another|different|other Admin|independent/i, s.key);
    path.push(`${s.key}:${s.mine}`);
    W.ticketAction(t, s.action, inputs[s.key], s.mine === 'Admin' ? contexts[0] : contexts[1]);
  }
  assert.deepEqual(path, ['start:Admin', 'add-evidence:Admin', 'worker-complete:Admin', 'requestor-confirm:Requestor', 'close:Admin']);
  assert.equal(t.status, 'Closed');
  // Someone else sees whose turn it was, with no request for a second review.
  const open = { ...t, status: 'Awaiting acceptance', completion: { round: 1, worker: { id: uid }, requestor: null, log: [] } };
  const other = W.nextStep(open, [{ ...acc('Admin'), actorFor: () => ({ id: 'adm2', name: 'Bo' }), isWorker: () => false, isRequester: () => false, selfService: () => false }]);
  assert.deepEqual([other.key, other.mine, other.independent, other.self], ['requestor-confirm', null, false, false]);
});

test('scope changes are guided through review, assessment, agreement, approval, and delivery', () => {
  const t = fresh('Project');
  follow(t, VIEWS, { until: 'tasks' }); // a Project in development
  const c = W.createChange(t, { title: 'Export', reason: 'Needed', criteria: 'Works' }, 'CR-1', VIEWS.Requestor).change;
  const inputs = { 'change-send': { status: 'Assessment' }, 'change-assess': { impact: 'Small', effort: '1 day', date: '2026-12-05' }, 'change-agree': {}, 'change-approve': {}, 'change-start': { status: 'In progress' }, 'change-test': { results: 'Tested.' }, 'change-accept': { status: 'Accepted' }, 'change-release': { status: 'Released' }, 'change-close': { status: 'Closed' } };
  const path = [];
  for (let s = W.nextChangeStep(c, t, Object.values(VIEWS)); s; s = W.nextChangeStep(c, t, Object.values(VIEWS))) {
    const r = W.changeAction(c, t, s.action, inputs[s.key], VIEWS[s.mine]);
    if (r.ticketEffect) r.ticketEffect(t);
    path.push(`${s.key}:${s.mine}`);
  }
  assert.deepEqual(path, ['change-send:Admin', 'change-assess:Developer', 'change-agree:Requestor', 'change-approve:Admin', 'change-start:Developer', 'change-test:Developer', 'change-accept:Requestor', 'change-release:Developer', 'change-close:Admin']);
});

test('guidance never changes the record it inspects', () => {
  const t = fresh('Project');
  const before = JSON.stringify(t);
  for (const v of Object.values(VIEWS)) W.nextStep(t, [v]);
  assert.equal(JSON.stringify(t), before);
});
