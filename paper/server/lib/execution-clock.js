const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

function create(options) {
  options = options || {};
  const processId = options.processId || process.pid, clockId = options.clockId || crypto.randomUUID();
  const wallNow = options.wallNow || Date.now, monotonicNow = options.monotonicNow || function () { return performance.now(); };
  function timing(receivedMonotonicMs) { return { processId, clockId, receivedMonotonicMs, discoveryMonotonicMs: monotonicNow() }; }
  function stamp(signal) {
    const anchor = signal && signal.timing, received = Date.parse(signal && signal.receivedAt);
    if (anchor && anchor.processId === processId && anchor.clockId === clockId && Number.isFinite(received) && Number.isFinite(anchor.receivedMonotonicMs)) {
      const elapsed = monotonicNow() - anchor.receivedMonotonicMs;
      if (Number.isFinite(elapsed) && elapsed >= 0) { const receivedToExecutionMs = Math.round(elapsed); return { clockBasis: 'worker-monotonic', executedAt: new Date(received + receivedToExecutionMs).toISOString(), receivedToExecutionMs }; }
    }
    return { clockBasis: 'worker-utc', executedAt: new Date(wallNow()).toISOString() };
  }
  return { timing, stamp };
}
module.exports = { create, ...create() };
