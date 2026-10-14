const test = require('node:test'), assert = require('node:assert/strict');

test('worker receipt anchor plus monotonic elapsed ignores a changing wallclock', function () {
  const clock = require('../server/lib/execution-clock').create({ processId: 7, clockId: 'boot-one', wallNow: function () { return Date.parse('2026-10-14T06:41:30Z'); }, monotonicNow: function () { return 1674; } });
  const result = clock.stamp({ receivedAt: '2026-10-14T06:41:11.600Z', timing: { processId: 7, clockId: 'boot-one', receivedMonotonicMs: 1000 } });
  assert.equal(result.executedAt, '2026-10-14T06:41:12.274Z');
  assert.equal(result.receivedToExecutionMs, 674);
  assert.equal(result.clockBasis, 'worker-monotonic');
});

test('a restarted worker never uses a previous process monotonic anchor', function () {
  const clock = require('../server/lib/execution-clock').create({ processId: 7, clockId: 'boot-two', wallNow: function () { return Date.parse('2026-10-14T07:00:00Z'); }, monotonicNow: function () { return 1674; } });
  const result = clock.stamp({ receivedAt: '2026-10-14T06:41:11.600Z', timing: { processId: 7, clockId: 'boot-one', receivedMonotonicMs: 1000 } });
  assert.equal(result.executedAt, '2026-10-14T07:00:00.000Z');
  assert.equal(result.receivedToExecutionMs, undefined);
  assert.equal(result.clockBasis, 'worker-utc');
});

test('copy timing uses recorded worker time rather than skewed database bookkeeping time', function () {
  const row = { status: 'FILLED', quantity: '1', gross: '0.48', createdAt: '2026-10-14T06:41:08.300Z', details: { signal: { timestamp: 1791960068, receivedAt: '2026-10-14T06:41:11.600Z' }, timings: { executedAt: '2026-10-14T06:41:12.274Z', clockBasis: 'worker-monotonic', receivedToExecutionMs: 674 } } };
  require('../server/service/trade-view-service').enrich(row);
  assert.equal(row.copyTime, '2026-10-14T06:41:12.274Z');
  assert.equal(row.executionDelayMs, 4274);
  assert.equal(row.receivedToExecutionMs, 674);
});

test('legacy WS execution time is reconstructed without rewriting historical financial records', function () {
  const row = { status: 'pending', quantity: '1', gross: '0.48', sourceTimestamp: 1791960068, receivedAt: '2026-10-14T06:41:11.600Z', executionTimings: { receivedToExecutionMs: 674 }, createdAt: '2026-10-14T06:41:11.599Z' };
  require('../server/service/trade-view-service').enrich(row);
  assert.equal(row.copyTime, '2026-10-14T06:41:12.274Z');
  assert.equal(row.copyClock, 'reconstructed-worker');
  assert.equal(row.createdAt, '2026-10-14T06:41:11.599Z');
  assert.equal(row.executionDelayMs, 4274);
});

test('history without receipt duration and waiting orders do not claim calibrated delay', function () {
  const enrich = require('../server/service/trade-view-service').enrich;
  const row = { status: 'FILLED', quantity: '1', gross: '0.48', sourceTimestamp: 1791960068, createdAt: '2026-10-14T06:41:11.599Z' };
  enrich(row);
  assert.equal(row.copyClock, 'legacy-database');
  assert.equal(row.executionDelayMs, null);
  const waiting = { ...row, status: 'WAITING' }; enrich(waiting);
  assert.equal(waiting.copyTime, null);
  assert.equal(waiting.executionDelayMs, null);
  assert.equal(waiting.receivedToExecutionMs, null);
});
