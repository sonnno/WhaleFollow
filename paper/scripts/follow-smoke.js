// All writes use a disposable database, never the running paper account.
const assert = require('node:assert/strict');
const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const testName = 'polymarket_follow_test_' + Date.now();
process.env.POSTGRES_DATABASE = testName;
settings.POSTGRES_DATABASE = testName;
const db = require('../server/db/adapter').create();
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
const config = require('../config').paper;
config.copySizing = 'equal_amount'; // Deterministic fixture independent of local follow ratio.
const { D } = require('../server/service/accounting-service');
let fault, created = false;
const markets = {
  prepare: function (signal, callback) {
    if (fault === 'network') return callback(new Error('Client network socket disconnected before secure TLS connection was established'));
    callback(null, { metadata: { rate: '0', exponent: 1, minSize: '1' }, book: { asks: fault === 'empty' ? [] : [{ price: '0.8', size: '1000' }], bids: [{ price: '0.2', size: '1000' }], observedAt: Date.now() - (fault === 'stale' ? 10000 : 0) } });
  }, consume: function () {}
};
const paper = require('../server/service/paper-service').create(db, markets);
const dashboard = require('../server/service/dashboard-service').create(db);
const queue = [], deliveryKeys = new Set();
const redis = {
  set: function (key, value, ex, seconds, nx, cb) { const added = !deliveryKeys.has(key); deliveryKeys.add(key); cb(null, added ? 'OK' : null); },
  lpush: function (_, id, cb) { queue.unshift(id); cb(null, queue.length); },
  rpop: function (_, cb) { cb(null, queue.pop() || null); },
  del: function (key, cb) { deliveryKeys.delete(key); cb(); }
};
const worker = require('../server/service/worker-service').create(db, redis, null, { onSignal: function () {} }, markets, paper, { snapshot: function (cb) { cb(); } });
const wallet = '0x' + 'b'.repeat(40), now = Math.floor(Date.now() / 1000);
const base = { sourceId: 'source', wallet, token: 'token', condition: 'condition', side: 'BUY', size: '20', price: '0.5', timestamp: now - 120, title: 'Follow regression', outcomeIndex: 0, active: true, historical: false, config: { ...config, buyBudget: '999', slippage: '0.01', signalTtlSeconds: 60, marketCostLimit: '500' } };
process.once('uncaughtException', cleanup);
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('CREATE DATABASE "' + testName + '"', function (err) { created = !err; next(err); }); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.migrate(function (err) { next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { db.insert('Leader', { id: wallet, name: 'Follow test', rank: 1, pnl: '0', active: true, joinedAt: new Date((now - 3600) * 1000), inventory: {}, inventoryValid: true, raw: {} }, function (err) { next(err); }); },
  function (next) { db.insert('Position', { id: 'other-wallet:other', wallet: 'other-wallet', token: 'other', condition: 'condition', quantity: '1000', cost: '800', outcomeIndex: 1 }, function (err) { next(err); }); },
  function (next) { paper.copy({ ...base, id: 'old-and-high-price' }, next); },
  function (result, next) { assert.equal(result.order.status, 'FILLED'); assert.ok(D(result.order.gross).eq(10)); assert.ok(D(result.order.quantity).eq('12.5')); fault = 'stale'; paper.copy({ ...base, id: 'stale' }, next); },
  function (result, next) { assert.equal(result.retry, true); assert.equal(result.order.status, 'WAITING'); dashboard.detail('stale', next); },
  function (detail, next) { assert.equal(detail.summary.status, 'waiting'); assert.equal(detail.fills.length, 0); assert.equal(detail.holding, null); assert.equal(detail.settlements.length, 0); fault = null; paper.copy({ ...base, id: 'stale' }, next); },
  function (result, next) { assert.equal(result.order.status, 'FILLED'); paper.copy({ ...base, id: 'stale' }, next); },
  function (result, next) { assert.equal(result.duplicate, true); fault = 'network'; paper.copy({ ...base, id: 'network' }, next); },
  function (result, next) { assert.equal(result.retry, true); assert.equal(result.order.status, 'WAITING'); fault = null; paper.copy({ ...base, id: 'network' }, next); },
  function (result, next) { assert.equal(result.order.status, 'FILLED'); fault = 'empty'; paper.copy({ ...base, id: 'empty' }, next); },
  function (result, next) { assert.equal(result.retry, true); assert.equal(result.order.status, 'WAITING'); fault = null; paper.copy({ ...base, id: 'empty' }, next); },
  function (result, next) { assert.equal(result.order.status, 'FILLED'); db.query('SELECT cash FROM paper_accounts WHERE id=$1', ['paper'], next); },
  function (rows, next) { assert.ok(D(rows[0].cash).eq(D(config.initialCash).minus(40))); db.query('SELECT COUNT(*)::int count FROM paper_cash_ledger WHERE kind=$1', ['BUY'], next); },
  function (rows, next) { assert.equal(rows[0].count, 4); db.update('Account', 'paper', { cash: '5' }, function (err) { next(err); }); },
  function (next) { paper.copy({ ...base, id: 'cash-wait' }, next); },
  function (result, next) { assert.equal(result.order.status, 'PARTIAL'); assert.ok(D(result.order.gross).eq(5)); assert.ok(D(result.order.details.remaining).eq(5)); db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { assert.ok(D(account.cash).isZero()); paper.copy({ ...base, id: 'zero-cash' }, next); },
  function (result, next) { assert.equal(result.retry, false); assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.order.reason, 'INSUFFICIENT_CASH'); db.update('Account', 'paper', { cash: '0.000000000000000001' }, function (err) { next(err); }); },
  function (next) { paper.copy({ ...base, id: 'cash-dust' }, next); },
  function (result, next) { assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.order.reason, 'INSUFFICIENT_CASH'); assert.equal(result.fill, null); assert.equal(result.retry, false); paper.copy({ ...base, id: 'cash-dust' }, next); },
  function (result, next) { assert.equal(result.duplicate, true); db.query('SELECT a.cash,(SELECT COUNT(*)::int FROM paper_fills WHERE "orderId"=$1) fills,(SELECT COUNT(*)::int FROM paper_cash_ledger WHERE reference=$1) ledger FROM paper_accounts a WHERE a.id=$2', ['cash-dust', 'paper'], next); },
  function (rows, next) { assert.ok(D(rows[0].cash).eq('0.000000000000000001')); assert.equal(rows[0].fills, 0); assert.equal(rows[0].ledger, 0); db.update('Account', 'paper', { cash: '20' }, function (err) { next(err); }); },
  function (next) { paper.copy({ ...base, id: 'cash-wait' }, next); },
  function (result, next) { assert.equal(result.duplicate, true); db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { assert.ok(D(account.cash).eq(20)); db.query('SELECT COUNT(*)::int count FROM paper_orders WHERE status=$1', ['WAITING'], next); },
  function (rows, next) { assert.equal(rows[0].count, 0); fault = 'network';
    async.eachSeries(['sequence-buy', 'sequence-sell'], function (id, cb) {
      const sell = id === 'sequence-sell';
      db.insert('Outbox', { id, kind: 'copy', payload: { ...base, id, sourceId: id, token: 'sequence-token', condition: 'sequence-condition', size: sell ? '100' : base.size, side: sell ? 'SELL' : 'BUY', timestamp: now - (sell ? 119 : 120), beforeInventory: '100' }, createdAt: new Date((now - (sell ? 119 : 120)) * 1000) }, cb);
    }, next);
  },
  function (next) { worker.dispatch(next); },
  function (next) { assert.deepEqual(queue, ['sequence-buy'], 'Only the earliest pending signal for the same wallet/token may be dispatched'); worker.consume(next); },
  function (next) { waitAttempt('sequence-buy', 1, next); },
  function (job, next) { assert.equal(job.status, 'pending'); queue.unshift('sequence-sell'); worker.consume(next); },
  function (next) { db.one('Outbox', { where: { id: 'sequence-sell' } }, next); },
  function (job, next) { assert.equal(job.attempts, 0, 'An already queued later SELL must also remain blocked'); fault = null; deliveryKeys.clear(); db.one('Outbox',{where:{id:'sequence-buy'}},function(err,buy){if(err)return next(err);setTimeout(function(){worker.dispatch(next);},Math.max(0,Number(buy.payload.retryAt||0)-Date.now())+10);}); },
  function (next) { worker.consume(next); },
  function (next) { waitAttempt('sequence-buy', 2, next); },
  function (job, next) { assert.equal(job.status, 'done'); worker.dispatch(next); },
  function (next) { worker.consume(next); },
  function (next) { waitAttempt('sequence-sell', 1, next); },
  function (job, next) { assert.equal(job.status, 'done'); db.one('Position', { where: { id: wallet + ':sequence-token' } }, next); },
  function (position, next) { assert.ok(D(position.quantity).isZero(), 'BUY retry followed by source SELL must leave no follower exposure'); db.update('Account', 'paper', { cash: '5' }, function (err) { next(err); }); },
  function (next) {
    async.eachSeries(['cash-sequence-buy', 'cash-sequence-sell'], function (id, cb) {
      const sell = id === 'cash-sequence-sell';
      db.insert('Outbox', { id, kind: 'copy', payload: { ...base, id, sourceId: id, side: sell ? 'SELL' : 'BUY', size: '200', beforeInventory: '200' }, createdAt: new Date((now + (sell ? 1 : 0)) * 1000) }, cb);
    }, next);
  },
  function (next) { worker.dispatch(next); },
  function (next) { worker.consume(next); },
  function (next) { waitAttempt('cash-sequence-buy', 1, next); },
  function (job, next) { assert.equal(job.status, 'done'); db.one('Order', { where: { id: 'cash-sequence-buy' } }, next); },
  function (order, next) { assert.equal(order.status, 'PARTIAL'); assert.ok(D(order.gross).eq(5)); worker.dispatch(next); },
  function (next) { worker.consume(next); },
  function (next) { waitAttempt('cash-sequence-sell', 1, next); },
  function (job, next) { assert.equal(job.status, 'done'); db.one('Position', { where: { id: wallet + ':token' } }, next); },
  function (position, next) { assert.ok(D(position.quantity).isZero(), 'Cash-short BUY must not prevent a later full SELL of existing holdings'); db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { assert.ok(D(account.cash).gt(0)); next(); }
], cleanup);
function waitAttempt(id, attempts, callback, count) {
  db.one('Outbox', { where: { id } }, function (err, job) {
    if (err || job.attempts >= attempts) return callback(err, job);
    if ((count || 0) > 80) return callback(new Error('Worker attempt did not complete: ' + id));
    setTimeout(function () { waitAttempt(id, attempts, callback, (count || 0) + 1); }, 25);
  });
}
function cleanup(err) {
  db.close(function (closeError) {
    function finish(cleanupError) { admin.end(function () { const failure = err || closeError || cleanupError; if (failure) { console.error(failure.stack); process.exitCode = 1; } else console.log('Follow regression passed: no price/age/market cap; waiting retries; idempotent ledger. Disposable database removed.'); }); }
    if (created && /^polymarket_follow_test_\d+$/.test(testName)) admin.query('DROP DATABASE "' + testName + '"', finish);
    else finish();
  });
}
