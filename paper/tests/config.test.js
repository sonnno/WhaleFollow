const test = require('node:test');
const assert = require('node:assert/strict');

test('live mode cannot start even when credentials are present', function () {
  const config = require('../config');
  assert.throws(function () { config.validate({ ...config.paper, mode: 'live' }); }, /paper/);
});

test('paper configuration uses the supplied local database defaults', function () {
  const settings = require('../config/DBsettings');
  assert.equal(settings.POSTGRES_HOST, 'localhost');
  assert.equal(settings.POSTGRES_PORT, 5432);
  assert.equal(settings.POSTGRES_USER, 'root');
  assert.equal(settings.REDIS_PORT, 6379);
});

test('effective configuration exposes no rejected strategy limits', function () {
  const config = require('../config').paper;
  ['slippage', 'marketCostLimit', 'signalTtlSeconds', 'latencyMs', 'buyBudget'].forEach(function (key) { assert.equal(config[key], undefined); });
  assert.ok(['equal_amount', 'fixed_ratio'].includes(config.copySizing));
  assert.ok(Number(config.initialCash) > 0);
});

test('fixed ratio configuration rejects zero, negative and missing proportions', function () {
  const config = require('../config');
  ['0', '-1', undefined, 'NaN'].forEach(function (copyRatio) {
    assert.throws(function () { config.validate({ ...config.paper, copySizing: 'fixed_ratio', copyRatio }); }, /copyRatio/);
  });
  assert.throws(function () { config.validate({ ...config.paper, copySizing: 'unsupported' }); }, /copySizing/);
});

test('fixed leader selection rejects malformed wallet configuration', function () {
  const config = require('../config');
  assert.throws(function () { config.validate({ ...config.paper, followWallets: 'all' }); }, /followWallets/);
  assert.throws(function () { config.validate({ ...config.paper, followWallets: ['bad-wallet'] }); }, /followWallets/);
});
