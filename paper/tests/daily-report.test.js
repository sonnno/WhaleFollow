const test = require('node:test');
const assert = require('node:assert/strict');

test('daily close uses Shanghai 10am and reports only the prior complete day', function () {
  const { eligibleDay, calendarDay } = require('../server/service/daily-report-service');
  assert.equal(eligibleDay(new Date('2026-10-01T01:59:59.999Z')), '2026-09-29');
  assert.equal(eligibleDay(new Date('2026-10-01T02:00:00Z')), '2026-09-30');
  assert.equal(eligibleDay(new Date('2026-10-01T15:59:59Z')), '2026-09-30');
  assert.equal(calendarDay(new Date('2026-09-30T16:00:00Z')), '2026-10-01');
});

test('daily close handles year and leap-month boundaries', function () {
  const { eligibleDay } = require('../server/service/daily-report-service');
  assert.equal(eligibleDay(new Date('2027-01-01T02:00:00Z')), '2026-12-31');
  assert.equal(eligibleDay(new Date('2028-03-01T02:00:00Z')), '2028-02-29');
});
