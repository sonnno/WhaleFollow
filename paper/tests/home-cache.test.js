const test = require('node:test'), assert = require('node:assert/strict');

function harness() {
  let clock = 1000, pendingSummary, pendingHistory, saved;
  const timers = [];
  const cache = require('../server/service/home-cache-service').create({
    cashSummary: function (cb) { pendingSummary = cb; },
    homeHistory: function (cb) { pendingHistory = cb; }
  }, {
    get: function (_, cb) { cb(null, saved || null); },
    set: function (_, value, cb) { saved = value; cb(); }
  }, {
    now: function () { return clock; },
    setInterval: function (fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearInterval: function () {}
  });
  return { cache, timers, advance: function (ms) { clock += ms; },
    summary: function (err, value) { pendingSummary(err, value); },
    history: function (err, value) { pendingHistory(err, value); } };
}

test('homepage reads finish from memory while both database refreshes are stalled', function () {
  const h = harness(); h.cache.start(function (err) { assert.ifError(err); });
  h.summary(null, { cash: '350', totalProfit: '0', createdAt: '2026-10-18', runtime: { pauseBuys: false } });
  h.history(null, { accountCreatedAt: '2026-10-18', history: [{ settledProfit: '2' }], days: [], leaders: [] });
  h.cache.refreshSummary(); h.cache.refreshHistory();
  for (let i = 0; i < 100; i++) {
    h.cache.summary(function (err, value) { assert.ifError(err); assert.equal(value.cash, '350'); });
    h.cache.history(function (err, value) { assert.ifError(err); assert.equal(value.history[0].settledProfit, '2'); });
  }
  assert.deepEqual(h.timers.map(function (t) { return t.ms; }), [2000, 30000]);
});

test('failed background refresh retains last result and reports stale data instead of zeros', function () {
  const h = harness(); h.cache.start(function () {});
  h.summary(null, { cash: '12.34', createdAt: '2026-10-18', runtime: {} });
  h.advance(15000); h.cache.refreshSummary(); h.summary(new Error('statement timeout'));
  h.cache.summary(function (err, value) { assert.ifError(err); assert.equal(value.cash, '12.34'); assert.equal(value.stale, true); assert.equal(value.updatedAt, new Date(1000).toISOString()); });
});

test('a new account cannot display the previous account history', function () {
  const h = harness(); h.cache.start(function () {});
  h.summary(null, { cash: '350', createdAt: 'old', runtime: {} });
  h.history(null, { accountCreatedAt: 'old', history: [{ settledProfit: '500' }] });
  h.cache.refreshSummary(); h.summary(null, { cash: '350', createdAt: 'new', runtime: {} });
  h.cache.history(function (err) { assert.equal(err.status, 503); });
  // A refresh that started before reset must not repopulate the old history.
  h.cache.refreshHistory(); h.history(null, { accountCreatedAt: 'old', history: [{ settledProfit: '500' }] });
  h.cache.history(function (err) { assert.equal(err.status, 503); });
});

test('cold cache fails immediately and never queries on a browser read', function () {
  const h = harness(); h.cache.start(function () {});
  h.cache.summary(function (err) { assert.equal(err.status, 503); });
  h.cache.history(function (err) { assert.equal(err.status, 503); });
  h.cache.stop();
});

test('a committed pause wins over an older in-flight background refresh', function () {
  const h = harness(); h.cache.start(function () {});
  h.cache.setRuntime({ pauseBuys: true });
  h.summary(null, { cash: '350', createdAt: '2026-10-18', runtime: { pauseBuys: false } });
  h.cache.settings(function (err, value) { assert.ifError(err); assert.equal(value.runtime.pauseBuys, true); });
});

test('restart restores persisted results before PostgreSQL has completed any refresh', function () {
  let summaryCalled = false, historyCalled = false;
  const cache = require('../server/service/home-cache-service').create({
    cashSummary: function () { summaryCalled = true; }, homeHistory: function () { historyCalled = true; }
  }, { get: function (_, cb) { cb(null, JSON.stringify({ summary: { cash: '23', createdAt: 'a', updatedAt: new Date().toISOString() },
    history: { accountCreatedAt: 'a', history: [{ settledProfit: '2' }], updatedAt: new Date().toISOString() } })); } },
  { setInterval: function () { return 1; }, clearInterval: function () {} });
  cache.start(function (err) { assert.ifError(err); });
  cache.summary(function (err, value) { assert.ifError(err); assert.equal(value.cash, '23'); });
  cache.history(function (err, value) { assert.ifError(err); assert.equal(value.history[0].settledProfit, '2'); });
  assert.equal(summaryCalled, true); assert.equal(historyCalled, true); cache.stop();
});

test('displayed principal follows committed virtual deposits rather than the startup default',function(){const h=harness();h.cache.start(function(){});h.summary(null,{cash:'450',initialCash:'450',totalProfit:'-7',createdAt:'2026-10-19',runtime:{}});h.cache.settings(function(err,value){assert.ifError(err);assert.equal(value.config.initialCash,'450');});h.cache.setRuntime({pauseBuys:true});h.cache.settings(function(err,value){assert.ifError(err);assert.equal(value.config.initialCash,'450');});});
