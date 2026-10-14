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
const controls = require('../server/service/execution-control-service').create(db, {});
const paper = require('../server/service/paper-service').create(db, markets, { controls });
const signal = { wallet, token: 'token', condition: 'condition', side: 'BUY', active: true, outcomeIndex: 0, timestamp: 100,
  price: '0.5', size: '20', sourceAmount: '10', followGeneration: 1, config: { ...config.paper, copySizing: 'equal_amount' } };
function expect(fn, next) { try { fn(); next(); } catch (err) { next(err); } }
function trade(id, extra, callback) { paper.copy({ ...signal, id, sourceId: id, ...extra }, callback); }
function funds(callback) { db.query('SELECT a.cash::text AS cash,t.cash::text AS dedicated,a.realized::text AS realized,a.fees::text AS fees FROM paper_accounts a JOIN paper_follow_tasks t ON t.id=$1 WHERE a.id=$2', [wallet, 'paper'], callback); }
let beforeRollback;
const sourceReads = { one: 0, context: 0 }, sourceSignals = [];
const sourceDb = { ...db, transaction: function (work, callback) { db.transaction(function (tx, done) {
  work({ ...tx, one: function (kind, query, next) { sourceReads.one++; tx.one(kind, query, next); }, query: function (sql, params, next) { if (sql.includes('source-context')) sourceReads.context++; tx.query(sql, params, next); } }, done);
}, callback); } };
const source = require('../server/service/source-service').create(sourceDb);
source.onSignal(function (_, value) { sourceSignals.push(value); });
const sourceWallet = '0x' + 'a'.repeat(40), transactionHash = '0x' + 'b'.repeat(64), conditionId = '0x' + 'c'.repeat(64);
const packet = { proxyWallet: sourceWallet, transactionHash, asset: '123', conditionId, side: 'BUY', price: '0.5', size: '3', timestamp: 100, outcomeIndex: 0 };
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
  function (next) { trade('first-buy', { sourceId: 'different-source' }, function (err) { expect(function () { assert.match(err.message, /different trade/); }, next); }); },
  function (next) { trade('sale-1', { sourceId: 'source-sale', side: 'SELL', price: '0.6', size: '50', cumulativeSize: '50', beforeInventory: '100' }, function (err, result) { if (err) return next(err); expect(function () { assert.ok(D(result.order.quantity).eq('10')); assert.ok(D(result.order.details.realizedProfit).eq('0.51')); }, next); }); },
  function (next) { trade('sale-2', { sourceId: 'source-sale', side: 'SELL', price: '0.6', size: '25', cumulativeSize: '75', beforeInventory: '50' }, function (err, result) { if (err) return next(err); expect(function () { assert.ok(D(result.order.quantity).eq('5')); }, next); }); },
  function (next) { funds(function (err, rows) { if (err) return next(err); expect(function () { assert.ok(D(rows[0].cash).eq('98.14')); assert.ok(D(rows[0].dedicated).eq('58.14')); assert.ok(D(rows[0].realized).eq('0.765')); }, next); }); },
  function (next) { trade('shared-partial', { wallet: shared, token: 'shared-token', sourceAmount: '100', size: '200' }, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.status, 'PARTIAL'); assert.ok(D(result.fill.cash).lte('40')); }, next); }); },
  function (next) { db.save('Setting', { id: 'runtime', value: { pauseBuys: true } }, next); },
  function (next) { trade('paused-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.order.reason, 'BUYS_PAUSED'); assert.equal(result.fill, null); }, next); }); },
  function (next) { expect(function () { assert.equal(controls.get(wallet).settings.pauseBuys, true, 'Fresh transactional controls must override any old memory value'); }, next); },
  function (next) { db.save('Setting', { id: 'runtime', value: {} }, next); },
  function (next) { funds(function (err, rows) { if (err) return next(err); beforeRollback = rows[0]; next(); }); },
  function (next) { db.insert('Ledger', { id: 'trade:forced-rollback', reference: 'fixture', kind: 'TEST', delta: '0', balance: '0' }, next); },
  function (next) { trade('forced-rollback', {}, function (err) { expect(function () { assert.equal(err.code, '23505'); }, next); }); },
  function (next) { funds(function (err, rows) { if (err) return next(err); expect(function () { assert.deepEqual(rows[0], beforeRollback, 'A failure on a later ledger CTE must roll back all earlier writes'); }, next); }); },
  function (next) { db.one('Order', { where: { id: 'forced-rollback' } }, function (err, row) { if (err) return next(err); expect(function () { assert.equal(row, null, 'Order claim must roll back with the failed debit'); }, next); }); },
  function (next) { db.save('Setting', { id: 'task-deletion:' + wallet, value: { generation: 1 } }, next); },
  function (next) { trade('retired-buy', {}, function (err, result) { if (err) return next(err); expect(function () { assert.equal(result.taskDeleted, true); }, next); }); },
  function (next) { db.one('Order', { where: { id: 'retired-buy' } }, function (err, row) { if (err) return next(err); expect(function () { assert.equal(row, null, 'Deleted task must not recreate order history'); }, next); }); },
  function (next) { db.query(`SELECT o.id FROM paper_orders o JOIN paper_cash_ledger l ON l.id='trade:'||o.id WHERE o."createdAt"<>l."createdAt"`, [], function (err, rows) { if (err) return next(err); expect(function () { assert.equal(rows.length, 0, 'Order/ledger dates must share one DB timestamp'); }, next); }); }
  ,function (next) { db.insert('Leader', { id: sourceWallet, name: 'Source fixture', rank: 3, pnl: '0', active: true, joinedAt: new Date(0), inventory: { 123: '100' }, inventoryValid: true, raw: { followGeneration: 1, inventoryTimestamp: 0 } }, next); }
  ,function (next) { source.ingestWebsocket(packet, { generation: 1, receivedAt: new Date().toISOString() }, next); }
  ,function (next) { source.ingestWebsocket(packet, { generation: 1, receivedAt: new Date().toISOString() }, next); }
  ,function (next) { source.ingest(require('../server/service/source-service').groupTrades([{ proxy_wallet: sourceWallet, transaction_hash: transactionHash, token_id: '123', condition_id: conditionId, side: 'BUY', price: '0.5', size: '6', timestamp: 100, outcome_index: 0 }])[0], next); }
  ,function (next) { expect(function () { assert.deepEqual(sourceSignals.map(function (s) { return s.sourceAmount; }), ['1.5', '1.5']); assert.equal(sourceReads.one, 0, 'Source ingestion must not repeat per-field reads'); assert.equal(sourceReads.context, 3); }, next); }
  ,function (next) { db.one('Leader', { where: { id: sourceWallet } }, function (err, leader) { if (err) return next(err); expect(function () { assert.equal(leader.inventory['123'], '106'); assert.equal(leader.raw.followGeneration, 1); }, next); }); }
], function (err) {
  db.close(function () { if (err) { console.error('Copy SQL integration failed:', err.message); process.exitCode = 1; } else console.log('Isolated copy/source SQL verified: fees, funds, partial buy, duplicate id, SELL continuation, pause, deletion, rollback, timestamps, WS/REST source deltas and source read count'); });
});
