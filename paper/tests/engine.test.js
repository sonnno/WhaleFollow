const test = require('node:test');
const assert = require('node:assert/strict');
const config = { ...require('../config').paper, copySizing: 'equal_amount' };

test('fixed ratio follows source notional at the current price and charges fees separately', function () {
  const engine = require('../server/service/simulation-service');
  const signal = { side: 'BUY', sourceAmount: '10000', price: '0.5', size: '20000' };
  const fill = engine.execute(signal, { asks: [{ price: '0.8', size: '1000' }] }, { rate: '0.1', exponent: 1 }, { ...config, copySizing: 'fixed_ratio', copyRatio: '0.000606', availableCash: '1000' });
  assert.equal(fill.gross, '6.06');
  assert.equal(fill.quantity, '7.575');
  assert.equal(fill.fee, '0.1212');
  assert.equal(fill.cash, '6.1812');
  assert.equal(signal.sourceAmount, '10000');
});

test('fixed ratio does not scale the sale quantity twice', function () {
  const engine = require('../server/service/simulation-service');
  const target = engine.saleQuantity('20', '25', '100');
  const fill = engine.execute({ side: 'SELL', price: '0.5', size: '25' }, { bids: [{ price: '0.6', size: '100' }] }, { rate: '0', exponent: 1 }, { ...config, copySizing: 'fixed_ratio', copyRatio: '0.000606' }, target);
  assert.equal(fill.quantity, '5');
  assert.equal(fill.cash, '3');
});

test('equal-amount buys walk depth and charge fees separately from source notional', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', price: '0.5', size: '20' }, { asks: [{ price: '0.5', size: '10' }, { price: '0.505', size: '20' }], bids: [] }, { rate: '0.1', exponent: 1, minSize: '1' }, config);
  assert.equal(fill.fills.length, 2);
  assert.ok(require('../server/service/accounting-service').D(fill.gross).minus(10).abs().lte('0.000000000000000001'));
  assert.ok(Number(fill.cash) > 10);
  assert.ok(Number(fill.fee) > 0);
});

test('unknown fees and empty depth cannot fabricate a fill', function () {
  const engine = require('../server/service/simulation-service');
  assert.throws(function () { engine.execute({ side: 'BUY', price: '0.5' }, { asks: [] }, null, config); }, /fee/i);
  assert.equal(engine.execute({ side: 'BUY', price: '0.5', size: '20' }, { asks: [] }, { rate: '0', exponent: 1, minSize: '1' }, config).quantity, '0');
});

test('follow buys use current prices even beyond the old one percent limit', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', price: '0.5', size: '20' }, { asks: [{ price: '0.8', size: '100' }] }, { rate: '0', exponent: 1, minSize: '1' }, { ...config, slippage: '0.01' });
  assert.equal(fill.gross, '10');
  assert.equal(fill.quantity, '12.5');
});

test('virtual allocations do not inherit the real exchange minimum order size', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', price: '0.5', size: '20' }, { asks: [{ price: '0.5', size: '1000' }] }, { rate: '0', exponent: 1, minSize: '100' }, config);
  assert.equal(fill.gross, '10');
  assert.equal(fill.quantity, '20');
});

test('sale quantity is bounded by follower inventory and leader fraction', function () {
  const engine = require('../server/service/simulation-service');
  assert.equal(engine.saleQuantity('40', '25', '100'), '10');
  assert.equal(engine.saleQuantity('40', '200', '100'), '40');
  assert.throws(function () { engine.saleQuantity('40', '10', '0'); }, /inventory/i);
});

test('equal source amount stays equal when the follower price changes and fees are extra', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '200', price: '0.5', sourceAmount: '100' }, { asks: [{ price: '0.8', size: '1000' }] }, { rate: '0.1', exponent: 1 }, { ...config, buyBudget: '10', availableCash: '1000' });
  assert.equal(fill.gross, '100');
  assert.equal(fill.quantity, '125');
  assert.equal(fill.fee, '2');
  assert.equal(fill.cash, '102');
});

test('cash availability covers both the equal gross target and simulated fees', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '200', price: '0.5', sourceAmount: '100' }, { asks: [{ price: '0.8', size: '1000' }] }, { rate: '0.1', exponent: 1 }, { ...config, availableCash: '100' });
  assert.ok(Number(fill.cash) <= 100);
  assert.ok(Number(fill.gross) < 100);
  assert.equal(fill.partial, true);
});

test('cash dust cannot fabricate a zero-value partial fill', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '20', price: '0.5' }, { asks: [{ price: '0.8', size: '1000' }] }, { rate: '0', exponent: 1 }, { ...config, availableCash: '0.000000000000000001' });
  assert.equal(fill.quantity, '0');
  assert.equal(fill.gross, '0');
  assert.equal(fill.cash, '0');
  assert.deepEqual(fill.fills, []);
  assert.equal(fill.reason, 'INSUFFICIENT_CASH');
});

test('depth whose value cannot be recorded is ignored without free shares', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '20', price: '0.5' }, { asks: [{ price: '0.3', size: '0.000000000000000001' }, { price: '0.5', size: '20' }] }, { rate: '0', exponent: 1 }, config);
  assert.equal(fill.quantity, '20');
  assert.equal(fill.gross, '10');
  assert.equal(fill.fills.length, 1);
});

test('a positive amount at the existing database precision can still be bought', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '20', price: '0.5' }, { asks: [{ price: '0.5', size: '1000' }] }, { rate: '0', exponent: 1 }, { ...config, availableCash: '0.000000000000000001' });
  assert.equal(fill.quantity, '0.000000000000000002');
  assert.equal(fill.gross, '0.000000000000000001');
  assert.equal(fill.cash, '0.000000000000000001');
});

test('an unrecordable depth quantity does not block later executable depth', function () {
  const engine = require('../server/service/simulation-service');
  const fill = engine.execute({ side: 'BUY', size: '20', price: '0.5' }, { asks: [{ price: '0.3', size: '0.0000000000000000001' }, { price: '0.5', size: '20' }] }, { rate: '0', exponent: 1 }, config);
  assert.equal(fill.gross, '10');
  assert.equal(fill.quantity, '20');
  assert.equal(fill.fills.length, 1);
});
