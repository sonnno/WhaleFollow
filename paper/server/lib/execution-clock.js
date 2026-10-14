const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const async = require('async');

function create(options) {
  options = options || {};
  const processId = options.processId || process.pid, clockId = options.clockId || crypto.randomUUID();
  const wallNow = options.wallNow || Date.now, monotonicNow = options.monotonicNow || function () { return performance.now(); };
  let calibration;
  function utcAt(mono) { return calibration ? calibration.utc + mono - calibration.mono : wallNow(); }
  function receipt() { const receivedMonotonicMs = monotonicNow(); return { receivedAt: new Date(utcAt(receivedMonotonicMs)).toISOString(), receivedMonotonicMs }; }
  function status() { const mono = monotonicNow(); return { synchronized: !!calibration, offsetMs: calibration ? Math.round(utcAt(mono) - wallNow()) : null, uncertaintyMs: calibration ? calibration.uncertaintyMs : null, syncedAt: calibration ? calibration.syncedAt : null }; }
  function synchronize(transport, base, callback) {
    const samples = [];
    async.timesSeries(3, function (_, next) {
      const began = monotonicNow();
      transport.request(base, '/time', {}, function (err, value) {
        const ended = monotonicNow(), seconds = Number(value);
        if (err) return next(err);
        if (!['number','string'].includes(typeof value) || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(seconds * 1000) || !Number.isFinite(new Date(seconds * 1000).getTime())) return next(new Error('Invalid official server time'));
        samples.push({ utc: seconds * 1000 + 500, mono: (began + ended) / 2, rtt: ended - began }); next();
      });
    }, function (err) {
      if (err) return callback(err);
      const best = samples.sort(function (a,b) { return a.rtt-b.rtt; })[0];
      calibration = { ...best, uncertaintyMs: Math.ceil(500 + best.rtt / 2), syncedAt: new Date(best.utc).toISOString() };
      callback(null, status());
    });
  }
  function timing(receivedMonotonicMs) { return { processId, clockId, receivedMonotonicMs, discoveryMonotonicMs: monotonicNow() }; }
  function stamp(signal) {
    const anchor = signal && signal.timing, received = Date.parse(signal && signal.receivedAt);
    if (anchor && anchor.processId === processId && anchor.clockId === clockId && Number.isFinite(received) && Number.isFinite(anchor.receivedMonotonicMs)) {
      const mono = monotonicNow(), elapsed = mono - anchor.receivedMonotonicMs;
      if (Number.isFinite(elapsed) && elapsed >= 0) { const receivedToExecutionMs = Math.round(elapsed); return { clockBasis: 'worker-monotonic', executedAt: new Date(calibration ? utcAt(mono) : received + receivedToExecutionMs).toISOString(), receivedToExecutionMs, serverClockSynced: !!calibration }; }
    }
    return { clockBasis: 'worker-utc', executedAt: new Date(utcAt(monotonicNow())).toISOString(), serverClockSynced: !!calibration };
  }
  return { timing, stamp, receipt, synchronize, status };
}
module.exports = { create, ...create() };
