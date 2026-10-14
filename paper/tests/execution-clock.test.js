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

test('official server UTC calibration uses the fastest round trip and no HTTP on receipt or stamp', function (_, done) {
  let mono = 1000, calls = 0;
  const clock = require('../server/lib/execution-clock').create({ processId: 7, clockId: 'synced', wallNow: function () { return 1004000; }, monotonicNow: function () { return mono; } });
  const transport = { request: function (_, route, __, cb) { assert.equal(route, '/time'); calls++; mono += calls === 2 ? 100 : 400; cb(null, 1000); } };
  assert.equal(typeof clock.synchronize, 'function');
  clock.synchronize(transport, 'https://example.test', function (err) {
    assert.ifError(err); assert.equal(calls, 3);
    const received = clock.receipt();
    assert.equal(Date.parse(received.receivedAt), 1000950);
    mono += 200;
    const stamp = clock.stamp({ ...received, timing: clock.timing(received.receivedMonotonicMs) });
    assert.equal(stamp.receivedToExecutionMs, 200);
    assert.equal(Date.parse(stamp.executedAt), 1001150);
    assert.equal(calls, 3);
    assert.equal(clock.status().synchronized, true);
    assert.equal(clock.status().uncertaintyMs, 550);
    done();
  });
});

test('first successful calibration corrects execution UTC for receipts collected before synchronization', function (_, done) {
  let mono = 1000;
  const clock = require('../server/lib/execution-clock').create({ processId: 7, clockId: 'late-sync', wallNow: function () { return 1004000; }, monotonicNow: function () { return mono; } });
  const received = clock.receipt(), signal = { ...received, timing: clock.timing(received.receivedMonotonicMs) };
  clock.synchronize({ request: function (_, __, ___, cb) { mono += 100; cb(null, 1000); } }, 'https://example.test', function (err) {
    assert.ifError(err);
    const result = clock.stamp(signal);
    assert.equal(result.receivedToExecutionMs, 300);
    assert.equal(result.executedAt, clock.receipt().receivedAt);
    assert.equal(result.serverClockSynced, true);
    assert.notEqual(Date.parse(result.executedAt), Date.parse(received.receivedAt) + 300);
    done();
  });
});

test('failed server time refresh preserves the previous calibration', function (_, done) {
  let mono = 1000;
  const clock = require('../server/lib/execution-clock').create({ wallNow: function () { return 999999999; }, monotonicNow: function () { return mono; } });
  clock.synchronize({ request: function (_, __, ___, cb) { mono += 100; cb(null, 1000); } }, 'https://example.test', function (err) {
    assert.ifError(err); const before = clock.receipt().receivedAt;
    clock.synchronize({ request: function (_, __, ___, cb) { cb(new Error('network failure')); } }, 'https://example.test', function (error) { assert.ok(error); assert.equal(clock.receipt().receivedAt, before); assert.equal(clock.status().synchronized, true); done(); });
  });
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
