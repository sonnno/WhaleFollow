const test = require('node:test'), assert = require('node:assert/strict');
const policy = require('../server/service/paper-execution-policy');
const engine = require('../server/service/simulation-service');
const now = Date.parse('2026-10-20T10:00:00Z');
const game = extra => ({ gameStartTime: new Date(now + 3600000).toISOString(), sportsMarketType: 'moneyline', question: 'A vs. B', active: true, acceptingOrders: true, closed: false, ...extra });
const task = { shortSportsHours: 72, realisticExecution: true };
const signal = { side: 'BUY', price: '0.5', sourceAmount: '1.239', size: '2.478' };
const book = { asks: [{ price: '0.5', size: '100' }], bids: [{ price: '0.4', size: '100' }] };
const metadata = { rate: '0', exponent: 1, tick: '0.01', minSize: '1' };
const config = { realisticExecution: true, copySizing: 'equal_amount', availableCash: '100' };

test('single sports games use the actual game start, including games underway', () => {
  assert.equal(policy.eligibility(signal, task, game({}), now), '');
  assert.equal(policy.eligibility(signal, task, game({ gameStartTime: new Date(now - 3600000).toISOString() }), now), '');
  assert.equal(policy.eligibility(signal, task, game({ gameStartTime: new Date(now + 72 * 3600000).toISOString() }), now), '');
  assert.equal(policy.eligibility(signal, task, game({ gameStartTime: new Date(now + 72 * 3600000 + 1).toISOString() }), now), 'SPORTS_TOO_FAR');
});
test('endDate alone, missing identity, stale schedule and championship markets never qualify', () => {
  assert.equal(policy.eligibility(signal, task, null, now), 'SPORTS_METADATA_MISSING');
  assert.equal(policy.eligibility(signal, task, game({ gameStartTime: null, endDate: new Date(now).toISOString() }), now), 'SPORTS_TIME_UNKNOWN');
  assert.equal(policy.eligibility(signal, task, game({ sportsMarketType: null }), now), 'NOT_SINGLE_SPORTS_GAME');
  assert.equal(policy.eligibility(signal, task, game({ question: 'Will A win the championship?' }), now), 'NOT_SINGLE_SPORTS_GAME');
  assert.equal(policy.eligibility(signal, task, game({ closed: true }), now), 'SPORTS_MARKET_CLOSED');
});
test('SELL and disabled time filter bypass eligibility', () => {
  assert.equal(policy.eligibility({ side: 'SELL' }, task, null, now), '');
  assert.equal(policy.eligibility(signal, {}, null, now), '');
});
test('a championship game is still a single game, but a championship winner proposition is not', () => {
  assert.equal(policy.eligibility(signal, task, game({ question: 'NFC Championship: A vs. B' }), now), '');
  assert.equal(policy.eligibility(signal, task, game({ question: 'Will A win the championship?' }), now), 'NOT_SINGLE_SPORTS_GAME');
});
test('realistic BUY rounds dollars down; it never raises a sub-dollar order', () => {
  assert.equal(engine.buyAmount(signal, config).toString(), '1.23');
  assert.equal(engine.execute({ ...signal, sourceAmount: '0.999' }, book, metadata, config).reason, 'BELOW_MIN_BUY_AMOUNT');
  const fill = engine.execute(signal, book, metadata, config);
  assert.equal(fill.gross, '1.23'); assert.equal(fill.quantity, '2.46');
});
test('minimum shares uses submitted worst-price quantity, not the original trader price', () => {
  const high = { asks: [{ price: '0.8', size: '100' }] };
  assert.equal(engine.execute({ ...signal, sourceAmount: '1' }, high, { ...metadata, minSize: '5' }, config).reason, 'BELOW_MIN_ORDER_SHARES');
  assert.equal(engine.execute({ ...signal, sourceAmount: '4' }, high, { ...metadata, minSize: '5' }, config).gross, '4');
  const depth = { asks: [{ price: '0.2', size: '1' }, { price: '0.8', size: '100' }] };
  assert.equal(engine.execute({ ...signal, sourceAmount: '3' }, depth, { ...metadata, minSize: '5' }, config).reason, 'BELOW_MIN_ORDER_SHARES');
});
test('unknown constraints skip and never fabricate a trade; invalid tick prices skip', () => {
  assert.equal(engine.execute(signal, book, { rate: '0', exponent: 1 }, config).reason, 'ORDER_CONSTRAINTS_UNAVAILABLE');
  assert.equal(engine.execute(signal, { asks: [{ price: '0.505', size: '100' }] }, metadata, config).reason, 'INVALID_MARKET_TICK');
});
test('a valid FAK request can partially execute below the request minimum, without funds-driven resizing', () => {
  const fill = engine.execute({ ...signal, sourceAmount: '10' }, { asks: [{ price: '0.5', size: '1' }] }, { ...metadata, minSize: '5' }, config);
  assert.equal(fill.quantity, '1'); assert.equal(fill.gross, '0.5'); assert.equal(fill.partial, true);
  assert.equal(engine.execute(signal, book, metadata, { ...config, availableCash: '1' }).reason, 'INSUFFICIENT_CASH');
});
test('realistic SELL rounds input shares down and enforces minimum request shares', () => {
  const sell = { ...signal, side: 'SELL' };
  const fill = engine.execute(sell, book, metadata, config, '2.469');
  assert.equal(fill.quantity, '2.46');
  assert.equal(engine.execute(sell, book, metadata, config, '0.999').reason, 'BELOW_MIN_ORDER_SHARES');
});
