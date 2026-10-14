// Only a separate, disposable database may run these financial integration checks.
const assert = require('node:assert/strict');
const async = require('async');
const database = process.env.COPY_SQL_TEST_DATABASE;
if (database !== 'whalefollow_copy_test') throw new Error('COPY_SQL_TEST_DATABASE must name the isolated whalefollow_copy_test database');
if (!process.env.COPY_SQL_TEST_PORT) require('./runtime').load(process.env.RUNTIME_DIR || '/var/lib/whalefollow');
const config = require('../config');
if (process.env.COPY_SQL_TEST_PORT) Object.assign(config.db, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: Number(process.env.COPY_SQL_TEST_PORT), POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'copy-sql-test-only' });
config.paper.initialCash = '100';
const db = require('../server/db/adapter').create({ database });
const { D } = require('../server/service/accounting-service');
const wallet = 'copy-smoke-dedicated', shared = 'copy-smoke-shared';
const markets = { prepare: function (_, cb) { cb(null, { metadata: { rate: '0.1', exponent: 1 }, book: { bids: [{ price: '0.6', size: '10000' }], asks: [{ price: '0.5', size: '10000' }], observedAt: Date.now() } }); }, consume: function () {} };
let controls = require('../server/service/execution-control-service').create(db, {});
let paper = require('../server/service/paper-service').create(db, markets, { controls });
const signal = { wallet, token: 'token', condition: 'condition', side: 'BUY', active: true, outcomeIndex: 0, timestamp: 100,
  price: '0.5', size: '20', sourceAmount: '10', followGeneration: 1, config: { ...config.paper, copySizing: 'equal_amount' } };
function expect(fn, next) { try { fn(); next(); } catch (err) { next(err); } }
function trade(id, extra, callback) { controls.refresh(function(err) { if(err) return callback(err); paper.copy({ ...signal, id, sourceId: id, ...extra }, callback); }); }
function funds(callback) { db.query('SELECT a.cash::text AS cash,t.cash::text AS dedicated,a.realized::text AS realized,a.fees::text AS fees FROM paper_accounts a JOIN paper_follow_tasks t ON t.id=$1 WHERE a.id=$2', [wallet, 'paper'], callback); }
let beforeRollback;
async.series([
  function (next) { db.connect(next); },
  function (next) { db.query('SELECT current_database() AS name', [], function (err, rows) { if (err) return next(err); expect(function () { assert.equal(rows[0].name, database); }, next); }); },
  function (next) { db.migrate(next); },
  function (next) { db.query('SELECT count(*)::int AS n FROM paper_accounts', [], function (err, rows) { if (err) return next(err); expect(function () { assert.equal(rows[0].n, 0, 'Disposable DB must be empty'); }, next); }); },
  function (next) { paper.initialize(next); },
  function (next) { async.eachSeries([wallet, shared], function (id, saved) {
    db.insert('Leader', { id, name: 'Integration fixture', rank: 1, pnl: '0', active: true, joinedAt: new Date(0) }, function (err) {
      if (err) return saved(err);
      db.insert('FollowTask', { id, state: 'running', fundingMode: id === wallet ? 'dedicated' : 'shared', allocation: '100', cash: id === wallet ? '60' : '0', fundedCapital: id === wallet ? '60' : '0', copyPercent: '100', generation: 1, startedAt: new Date(0) }, saved);
    });
  }, next); },
  function (next) { controls.refresh(function (err) { if (err) return next(err); expect(function () { assert.equal(controls.get(wallet).task.copyPercent, '100.000000000000000000'); assert.equal(controls.get(wallet).leader.active, true); }, next); }); },
  function (next) { trade('first-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.status, 'FILLED'); assert.ok(D(result.order.fee).eq('0.5')); assert.ok(D(result.order.quantity).eq('20')); }, next); }); },
  function (next) { trade('first-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.duplicate, true); }, next); }); },
  function (next) { funds(function (err, rows) { if (err) return next(err); expect(function () { assert.ok(D(rows[0].cash).eq('89.5')); assert.ok(D(rows[0].dedicated).eq('49.5')); assert.ok(D(rows[0].fees).eq('0.5')); }, next); }); },
  function (next) { trade('sale-1', { sourceId: 'source-sale', side: 'SELL', price: '0.6', size: '10' }, function (err, result) { if (err) return next(err); expect(function () { assert.ok(D(result.order.quantity).eq('10')); assert.ok(D(result.order.details.realizedProfit).eq('0.51')); }, next); }); },
  function (next) { trade('sale-2', { sourceId: 'source-sale', side: 'SELL', price: '0.6', size: '5' }, function (err, result) { if (err) return next(err); expect(function () { assert.ok(D(result.order.quantity).eq('5')); }, next); }); },
  function (next) { funds(function (err, rows) { if (err) return next(err); expect(function () { assert.ok(D(rows[0].cash).eq('98.14')); assert.ok(D(rows[0].dedicated).eq('58.14')); assert.ok(D(rows[0].realized).eq('0.765')); }, next); }); },
  function (next) { trade('shared-partial', { wallet: shared, token: 'shared-token', sourceAmount: '100', size: '200' }, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.status, 'PARTIAL'); assert.ok(D(result.fill.cash).lte('40')); }, next); }); },
  function (next) { db.save('Setting', { id: 'runtime', value: { pauseBuys: true } }, next); },
  function (next) { trade('paused-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.reason, 'BUYS_PAUSED'); assert.equal(result.fill, null); }, next); }); },
  function (next) { trade('first-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.status, 'SKIPPED'); }, next); }); },
  function (next) { db.one('Order', { where: { id: 'first-buy' } }, function (err, row) { if (err) return next(err); expect(function () { assert.equal(row.status, 'FILLED', 'Failure cannot overwrite an existing executed result'); assert.ok(D(row.quantity).eq('20')); }, next); }); },
  function (next) { expect(function () { assert.equal(controls.get(wallet).settings.pauseBuys, true, 'Fresh transactional controls must override any old memory value'); }, next); },
  function (next) { db.save('Setting', { id: 'runtime', value: {} }, next); },
  function (next) { db.save('Setting', { id: 'task-deletion:' + wallet, value: { generation: 1 } }, next); },
  function (next) { trade('retired-buy', {}, function (err) { expect(function () { assert.match(err.message, /Task deleted/); assert.ok(err.executedOrder); }, next); }); },
  function (next) { db.one('Order', { where: { id: 'retired-buy' } }, function (err, row) { if (err) return next(err); expect(function () { assert.equal(row, null, 'Deleted task must not recreate order history'); }, next); }); },
  function (next) { db.query('DELETE FROM paper_settings WHERE id=$1', ['task-deletion:' + wallet], next); },
  function (next) { controls = require('../server/service/execution-control-service').create(db, {}); paper = require('../server/service/paper-service').create(db, markets, { controls }); controls.refresh(next); },
  function (next) { funds(function (err, rows) { if (err) return next(err); beforeRollback = rows[0]; next(); }); },
  function (next) { db.insert('Ledger', { id: 'trade:forced-rollback', reference: 'fixture', kind: 'TEST', delta: '0', balance: '0' }, next); },
  function (next) { trade('forced-rollback', {}, function (err) { expect(function () { assert.equal(err.code, '23505'); }, next); }); },
  function (next) { funds(function (err, rows) { if (err) return next(err); expect(function () { assert.deepEqual(rows[0], beforeRollback, 'A failure on a later ledger CTE must roll back all earlier writes'); }, next); }); },
  function (next) { db.one('Order', { where: { id: 'forced-rollback' } }, function (err, row) { if (err) return next(err); expect(function () { assert.equal(row, null, 'Order claim must roll back with the failed debit'); }, next); }); },
  function (next) { db.query(`SELECT o.id FROM paper_orders o JOIN paper_cash_ledger l ON l.id='trade:'||o.id WHERE o."createdAt"<>l."createdAt"`, [], function (err, rows) { if (err) return next(err); expect(function () { assert.equal(rows.length, 0, 'Order/ledger dates must share one DB timestamp'); }, next); }); }
], function (err) {
  db.close(function () { if (err) { console.error('Copy SQL integration failed:', err.message); process.exitCode = 1; } else console.log('Isolated immediate copy SQL verified: fees, dedicated/shared funds, partial buy, stable order id, direct SELL, pause, deletion, rollback, timestamps and post-fill source records'); });
});
