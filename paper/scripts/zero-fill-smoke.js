// Repair regression runs only in a disposable database.
const assert = require('node:assert/strict');
const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const testName = 'polymarket_zero_fill_test_' + Date.now();
process.env.POSTGRES_DATABASE = testName;
settings.POSTGRES_DATABASE = testName;
const db = require('../server/db/adapter').create();
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
const { D } = require('../server/service/accounting-service');
let created = false, baseline;
const paper = require('../server/service/paper-service').create(db, null);
process.once('uncaughtException', cleanup);
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('CREATE DATABASE "' + testName + '"', function (err) { created = !err; next(err); }); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.migrate(function (err) { next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { db.insert('Position', { id: 'wallet:real', wallet: 'wallet', token: 'real', condition: 'market', outcomeIndex: 0, quantity: '10.000000000000000003', cost: '5' }, function (err) { next(err); }); },
  function (next) { db.insert('Position', { id: 'wallet:empty', wallet: 'wallet', token: 'empty', condition: 'market', outcomeIndex: 0, quantity: '0.000000000000000001', cost: '0' }, function (err) { next(err); }); },
  function (next) { db.insert('Order', { id: 'real', sourceId: 'real-source', wallet: 'wallet', token: 'real', condition: 'market', side: 'BUY', status: 'FILLED', quantity: '10', gross: '5', fee: '0', details: { positionCycle: 1 } }, function (err) { next(err); }); },
  function (next) { db.insert('Fill', { id: 'real-fill', orderId: 'real', wallet: 'wallet', token: 'real', side: 'BUY', quantity: '10', price: '0.5', fee: '0' }, function (err) { next(err); }); },
  function (next) {
    async.eachSeries([{ id: 'ghost-real', token: 'real', quantity: '0.000000000000000003' }, { id: 'ghost-empty', token: 'empty', quantity: '0.000000000000000001' }], function (g, saved) {
      async.waterfall([
        function (step) { db.insert('Order', { ...g, sourceId: g.id, wallet: 'wallet', condition: 'market', side: 'BUY', status: 'PARTIAL', gross: '0', fee: '0', details: { positionCycle: 1, signal: { sourceAmount: '10' } } }, function (err) { step(err); }); },
        function (step) { db.insert('Fill', { id: 'fill:' + g.id, orderId: g.id, wallet: 'wallet', token: g.token, side: 'BUY', quantity: g.quantity, price: '0.1', fee: '0' }, function (err) { step(err); }); },
        function (step) { db.insert('Ledger', { id: 'trade:' + g.id, reference: g.id, kind: 'BUY', delta: '0', balance: '100000', details: {} }, function (err) { step(err); }); },
        function (step) { db.insert('Outbox', { id: g.id, kind: 'copy', status: 'done', payload: {} }, function (err) { step(err); }); }
      ], saved);
    }, next);
  },
  function (next) { db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { baseline = account; db.update('Ledger', 'trade:ghost-empty', { delta: '1' }, function (err) { next(err); }); },
  function (next) { require('../server/service/repair-service').create(db).zeroValueBuys(function (err) { assert.ok(err); assert.match(err.message, /Unexpected ledger/); next(); }); },
  function (next) { db.one('Order', { where: { id: 'ghost-real' } }, next); },
  function (order, next) { assert.equal(order.status, 'PARTIAL'); assert.equal(order.details.repair, undefined); db.find('Fill', { where: { orderId: 'ghost-real' } }, next); },
  function (fills, next) { assert.equal(fills.length, 1, 'Failure rolls back earlier ghost edits'); db.update('Ledger', 'trade:ghost-empty', { delta: '0' }, function (err) { next(err); }); },
  function (next) { db.insert('Cycle', { id: 'wallet:empty:1', wallet: 'wallet', token: 'empty', profit: '0', reason: 'SETTLEMENT' }, function (err) { next(err); }); },
  function (next) { require('../server/service/repair-service').create(db).zeroValueBuys(function (err) { assert.ok(err); assert.match(err.message, /cannot be safely repaired/); next(); }); },
  function (next) { db.query('DELETE FROM paper_closed_cycles WHERE id=$1', ['wallet:empty:1'], function (err) { next(err); }); },
  function (next) { db.insert('Order', { id: 'sold-guard', sourceId: 'sold-guard', wallet: 'wallet', token: 'real', condition: 'market', side: 'SELL', status: 'PARTIAL', quantity: '1', gross: '0.5', fee: '0', details: { positionCycle: 1 } }, function (err) { next(err); }); },
  function (next) { require('../server/service/repair-service').create(db).zeroValueBuys(function (err) { assert.ok(err, 'A sale in the affected cycle must block unsafe quantity subtraction'); assert.match(err.message, /cannot be safely repaired/); next(); }); },
  function (next) { db.query('DELETE FROM paper_orders WHERE id=$1', ['sold-guard'], function (err) { next(err); }); },
  function (next) { require('../server/service/repair-service').create(db).zeroValueBuys(next); },
  function (result, next) { assert.equal(result.repairedOrders, 2); assert.equal(result.removedFills, 2); assert.equal(result.removedLedgers, 2); db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { assert.deepEqual(account, baseline); db.one('Position', { where: { id: 'wallet:real' } }, next); },
  function (position, next) { assert.ok(D(position.quantity).eq(10)); assert.ok(D(position.cost).eq(5)); db.one('Position', { where: { id: 'wallet:empty' } }, next); },
  function (position, next) { assert.equal(position, null); db.one('Order', { where: { id: 'ghost-real' } }, next); },
  function (order, next) { assert.equal(order.status, 'SKIPPED'); assert.equal(order.reason, 'INSUFFICIENT_CASH'); assert.ok(D(order.quantity).isZero()); assert.equal(order.details.repair.originalQuantity, '0.000000000000000003'); assert.equal(order.details.signal.sourceAmount, '10'); db.find('Fill', { where: { orderId: 'real' } }, next); },
  function (fills, next) { assert.equal(fills.length, 1); assert.ok(D(fills[0].quantity).eq(10)); require('../server/service/repair-service').create(db).zeroValueBuys(next); },
  function (result, next) { assert.equal(result.repairedOrders, 0); db.query('SELECT COUNT(*)::int count FROM paper_cash_ledger', [], next); },
  function (rows, next) { assert.equal(rows[0].count, 1); db.one('Order', { where: { id: 'real' } }, next); },
  function (order, next) { assert.equal(order.status, 'FILLED'); next(); }
], cleanup);
function cleanup(err) {
  db.close(function (closeError) {
    function finish(cleanupError) { admin.end(function () { const failure = err || closeError || cleanupError; if (failure) { console.error(failure.stack); process.exitCode = 1; } else console.log('Zero-value repair passed: real holdings, account and real fills preserved; phantom effects removed; repeat is a no-op.'); }); }
    if (created && /^polymarket_zero_fill_test_\d+$/.test(testName)) admin.query('DROP DATABASE "' + testName + '"', finish);
    else finish();
  });
}
