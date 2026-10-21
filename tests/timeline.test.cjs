const { test } = require('node:test');
const assert = require('node:assert/strict');
const TL = require('../public/timeline-core.js');
const task = (start, end) => ({ title: 'Export report', requirement: 'Export filtered records', criteria: 'Export totals match the filtered view', start, end });
test('dates reject invalid calendar values and missing dates', () => {
  assert.equal(TL.day('2026-02-30'), null);
  assert.equal(TL.day(''), null);
  assert.notEqual(TL.day('2028-02-29'), null);
});
test('one-day and cross-month tasks retain inclusive duration', () => {
  const chart = TL.timeline([task('2026-10-31', '2026-11-02'), task('2026-11-03', '2026-11-03')]);
  assert.equal(chart.bars[0].days, 3);
  assert.equal(chart.bars[1].days, 1);
  chart.bars.forEach(b => { assert.ok(b.left >= 0); assert.ok(b.left + b.width <= 100); });
  assert.equal(chart.ticks.length, 6);
});
test('missing schedules remain unscheduled rather than inventing dates', () => {
  assert.equal(TL.timeline([{ title: 'Legacy task' }]), null);
  const chart = TL.timeline([task('2026-10-22', '2026-10-23'), { title: 'Legacy task' }]);
  assert.equal(chart.bars[1], null);
});
test('task validation rejects reversed dates and incomplete requirements', () => {
  assert.match(TL.validateTask(task('2026-11-02','2026-11-01')), /end date/);
  assert.match(TL.validateTask({ ...task('2026-11-01','2026-11-02'), requirement: '' }), /requirement/);
  assert.equal(TL.validateTask(task('2026-11-01','2026-11-02')), '');
});
