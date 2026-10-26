const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function check(row) {
  const process = { argv: ['node', 'check', 'worker'], env: {} };
  const Client = function () { this.on = function () {}; this.connect = cb => cb(); this.query = function (sql, args, cb) { cb(null, { rows: row ? [{ ...row, value: sql.includes('value') ? row.value : undefined }] : [] }); }; this.end = cb => cb(); };
  vm.runInNewContext(fs.readFileSync(require.resolve('../deploy/healthcheck'), 'utf8'), { process, Date, require: name => name === 'pg' ? { Client } : name === './runtime' ? { load() {} } : {} });
  return process.exitCode || 0;
}
test('fresh worker heartbeat cannot mask a halted executor', function () { assert.equal(check({ updatedAt: new Date(), value: { executionHalted: true } }), 1); });
test('healthy active executor passes and old heartbeat fails', function () { assert.equal(check({ updatedAt: new Date(), value: {} }), 0); assert.equal(check({ updatedAt: new Date(Date.now() - 200000), value: {} }), 1); });
