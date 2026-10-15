const i18n = require('./helpers/i18n.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const esbuild = require('esbuild');
const mod = { exports: {} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(require('node:path').join(__dirname, '../web/src/OrderDetail.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module: mod, exports: mod.exports, require: function (name) { return name === './i18n' ? i18n : {}; }, Intl, Date });

test('UI formats the difference of recorded source and copy execution times', function () {
  const row = { executionDelayMs: 4274, receivedToExecutionMs: 674, copyClock: 'reconstructed-worker' };
  assert.equal(mod.exports.comparisonDelay(row), '4.274 秒');
});
test('UI never recalculates a historical delay from database and source timestamps', function () {
  const row = { copyClock: 'legacy-database', sourceTime: '2026-10-14T06:41:08Z', copyTime: '2026-10-14T06:41:11.599Z' };
  assert.equal(mod.exports.comparisonDelay(row), '暫無資料');
  assert.equal(mod.exports.comparisonDelay({ executionDelayMs: null, copyClock: 'worker-utc' }), '暫無資料');
});
