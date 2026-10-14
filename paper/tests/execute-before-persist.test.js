const test = require('node:test'), assert = require('node:assert/strict');
const store = require('../server/service/paper-copy-store');
const { D, str } = require('../server/service/accounting-service');
function fixture(t) {
  const events = [], orders = [], account = { id: 'paper', cash: '100', fees: '0', realized: '0' };
  const task = { id: 'w', generation: 1, state: 'running', fundingMode: 'dedicated', cash: '60', allocation: '60', copyPercent: '10', maxOrderAmount: null, startedAt: new Date(0) };
  const leader = { id: 'w', active: true, joinedAt: new Date(0) };
  const control = { account, task, leader, settings: {}, sharedCash: '40', positionCost: '0', positions: {} };
  const controls = { observe: function () {}, get: function () { return structuredClone(control); }, reserve: function (_, fill) { events.push('reserve'); account.cash = str(D(account.cash).minus(fill.cash)); task.cash = str(D(task.cash).minus(fill.cash)); }, complete: function () {}, invalidate: function () {}, refresh: function (cb) { cb(); } };
  t.mock.method(store, 'read', function (_, signal, cb) { events.push('read'); cb(null, { account: { id: 'paper', cash: '100', fees: '0', realized: '0' }, task: { ...task, cash: '60' }, leader, settings: {}, sharedCash: '40', positionCost: '0', claimed: { ...signal, inserted: true }, position: null, market: null }); });
  t.mock.method(store, 'commit', function (_, __, ___, ____, order, fill, cb) { events.push('commit'); orders.push(order); cb(null, order); });
  const tx = { save: function (_, row, cb) { orders.push(row); cb(null, row); }, query: function (_, __, cb) { cb(null, []); } };
  const db = { query: function (_, args, cb) { orders.push({ id: args[0], details: JSON.parse(args[8]) }); cb(null, []); }, transaction: function (work, cb) { events.push('transaction'); work(tx, cb); }, save: function (_, row, cb) { orders.push(row); cb(null, row); } };
  const markets = { prepare: function (_, cb) { events.push('prepare'); cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.5', size: '100' }], bids: [{ price: '0.5', size: '100' }] } }); }, consume: function () { events.push('executed'); } };
  const signal = { id: 'o', sourceId: 's', wallet: 'w', token: 't', condition: 'c', side: 'BUY', outcomeIndex: 0, timestamp: 100, price: '0.5', size: '20', sourceAmount: '10', followGeneration: 1, active: true, config: {} };
  const warnings = { mark: function (signal, state, required, cb) { events.push('balance-warning'); cb(); }, event: function () { return []; }, write: function (_, __, cb) { events.push('balance-clear'); cb(); } };
  const paper = require('../server/service/paper-service').create(db, markets, { controls, warnings });
  return { events, orders, db, markets, controls, signal, paper, warnings };
}
test('fill and local balance reservation happen before the first database operation', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.equal(result.order.gross, '1');
    assert.ok(f.events.indexOf('executed') < f.events.indexOf('transaction'), f.events.join(','));
    assert.ok(f.events.indexOf('reserve') < f.events.indexOf('transaction'));
    done();
  });
});
test('three failed attempts end permanently, with no WAITING result', function (t, done) {
  const f = fixture(t); let attempts = 0;
  f.markets.prepare = function (_, cb) { attempts++; cb(new Error('No executable book')); };
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.equal(attempts, 3); assert.equal(result.retry, false);
    assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.order.details.attempts, 3);
    assert.equal(f.events.includes('read'), false); done();
  });
});
test('failure followed by success stops immediately, and success is executed once', function (t, done) {
  const f = fixture(t), prepare = f.markets.prepare; let attempts = 0;
  f.markets.prepare = function (signal, cb) { if (++attempts === 1) return cb(new Error('Temporary failure')); prepare(signal, cb); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.ok(result.fill); assert.equal(attempts, 2); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});
test('persistence failure never executes the successful purchase again', function (t, done) {
  const f = fixture(t);
  t.mock.method(store, 'commit', function (_, __, ___, ____, _____, ______, cb) { cb(new Error('Ledger failure')); });
  f.paper.copy(f.signal, function (err) { assert.match(err.message, /Ledger failure/); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});
test('pause is read in memory, without accessing trade database context', function (t, done) {
  const f = fixture(t); f.controls.get = function () { return { ...fixtureControl(), settings: { pauseBuys: true } }; };
  function fixtureControl() { return { leader: { active: true }, task: { state: 'running', generation: 1, startedAt: new Date(0) } }; }
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.reason, 'BUYS_PAUSED'); assert.equal(f.events.includes('read'), false); done(); });
});

test('a generation change cannot move an executed fill into another task generation', function (t, done) {
  const f = fixture(t); let reads = 0;
  t.mock.method(store, 'read', function (_, signal, cb) { reads++; cb(null, { claimed: { inserted: true }, account: { cash: '100' }, task: { id: 'w', generation: 2, fundingMode: 'dedicated' } }); });
  f.paper.copy(f.signal, function (err) { assert.match(err.message, /generation changed/); assert.equal(reads, 3); assert.equal(err.executedOrder.order.details.followTask.generation, 1); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});

test('the final memory book overrides a previously prepared snapshot', function (t, done) {
  const f = fixture(t);
  f.markets.latestQuote = function () { return { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.5', size: '1' }] } }; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.quantity, '1'); assert.equal(result.order.status, 'PARTIAL'); assert.equal(result.retry, false); done(); });
});

test('a settled position during SELL persistence reports an error instead of throwing from an asynchronous callback', function (t, done) {
  const f = fixture(t);
  f.controls.get = function () { return { leader: { active: true }, task: { id: 'w', generation: 1, fundingMode: 'dedicated', copyPercent: '100', state: 'running', startedAt: new Date(0) }, account: { cash: '100' }, settings: {}, positions: { t: { quantity: '10' } } }; };
  t.mock.method(store, 'read', function (_, signal, cb) { setImmediate(function () { cb(null, { claimed: { inserted: true }, account: { cash: '100' }, task: { id: 'w', generation: 1, fundingMode: 'dedicated' }, position: { quantity: '0', cost: '0', realized: '0', cycleRealized: '0' } }); }); });
  f.paper.copy({ ...f.signal, side: 'SELL', size: '5' }, function (err) { assert.match(err.message, /Invalid sale quantity/); assert.ok(err.executedOrder); done(); });
});

test('insufficient cash marks the wallet but never creates an order or a financial transaction', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0'; return state; };
  let marked = 0;
  f.warnings.mark = function (signal, state, required, cb) { marked++; assert.equal(state.task.id, 'w'); assert.ok(D(required).gt(0)); cb(); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.insufficientFunds, true); assert.equal(result.order, null); assert.equal(marked, 1); assert.equal(f.events.includes('transaction'), false); assert.equal(f.events.includes('executed'), false); done(); });
});

test('cash below the required amount does not produce a partial affordable order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.5'; return state; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.insufficientFunds, true); assert.equal(result.order, null); assert.equal(f.events.includes('executed'), false); done(); });
});

test('successful execution clears balance warnings in the same transaction as its accounting', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err) { assert.ifError(err); assert.ok(f.events.indexOf('balance-clear') > f.events.indexOf('commit')); done(); });
});

test('cash covering the gross but not the fee creates no order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '1'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0.1', exponent: 1 }, book: { asks: [{ price: '0.5', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.insufficientFunds, true); assert.equal(f.events.includes('transaction'), false); done(); });
});

test('an insufficient-cash precision failure still cannot generate an order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.000000000000000001'; state.task.maxOrderAmount = '0.000000000000000001'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.8', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.insufficientFunds, true); assert.equal(f.events.includes('transaction'), false); done(); });
});

test('a configured per-order cap is retained without a false shortage warning', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.5'; state.task.maxOrderAmount = '0.5'; return state; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.gross, '0.5'); assert.equal(f.events.includes('balance-warning'), false); done(); });
});

test('a tiny per-order cap cannot falsely mark a funded wallet as insufficient', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.maxOrderAmount = '0.000000000000000001'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.8', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'ORDER_AMOUNT_BELOW_PRECISION'); assert.equal(f.events.includes('balance-warning'), false); done(); });
});
