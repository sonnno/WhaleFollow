// End-to-end accounting tests use a separate disposable database, never the paper ledger.
const assert = require('node:assert/strict');
const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const testName = 'polymarket_copy_test_' + Date.now();
process.env.POSTGRES_DATABASE = testName;
settings.POSTGRES_DATABASE = testName;
const db = require('../server/db/adapter').create();
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
const config = require('../config').paper;
config.copySizing = 'equal_amount'; // Keep this accounting fixture independent of the configured follow ratio.
const { D } = require('../server/service/accounting-service');
const markets = { prepare: function (signal, callback) { callback(null, { metadata: { rate: '0', exponent: 1, minSize: '1' }, book: { asks: [{ price: '0.5', size: '1000' }], bids: [{ price: '0.6', size: '1000' }], observedAt: Date.now(), version: 'smoke' } }); }, consume: function () {} };
const paper = require('../server/service/paper-service').create(db, markets);
const capital = require('../server/service/capital-service').create(db);
const startingCash = D(config.initialCash).plus(10000);
const sources = require('../server/service/source-service').create(db);
const dashboard = require('../server/service/dashboard-service').create(db);
const metadata = require('../server/service/market-service').create(db, { get: function (_, cb) { cb(null, null); }, set: function () {} }, { http: { request: function (_, route, __, cb) {
  if (route === '/markets') return cb(null, [{ conditionId: 'condition', active: true, closed: false, acceptingOrders: true, endDate: '2026-10-10T12:00:00Z', slug: 'smoke-market', events: [{ slug: 'smoke-event' }], tags: [{ slug: 'soccer', label: 'Soccer' }], sportsMarketType: 'moneyline' }]);
  if (route === '/v2/resolutions') return cb(null, { data: [{ condition_id: 'condition', status: 'proposed', expected_settlement_time: '2026-10-10T14:00:00Z' }] });
  if (route === '/book') return cb(null, { bids: [{ price: '0.4', size: '100' }], asks: [{ price: '0.5', size: '100' }] });
  cb(null, { t: [{ o: 'Yes', t: 'token' }, { o: 'No', t: 'other' }], fd: { r: 0, e: 1 }, mos: 1 });
} } });
assert.equal(typeof dashboard.cashSummary, 'function', 'Cash statistics service must expose cashSummary');
assert.equal(typeof dashboard.bets, 'function', 'Overview must expose a paginated list of actual bets');
const wallet = '0x' + 'a'.repeat(40);
const now = Math.floor(Date.now() / 1000);
const buy = { id: 'buy', sourceId: 'source-buy', wallet, token: 'token', condition: 'condition', side: 'BUY', size: '20', price: '0.5', timestamp: now, title: 'Smoke market', outcomeIndex: 0, active: true, historical: false, config };
const sale = { ...buy, id: 'sell', sourceId: 'source-sell', side: 'SELL', price: '0.6', size: '5', beforeInventory: '10' };
let created = false, betAnchor;
process.once('uncaughtException', cleanup);
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('CREATE DATABASE "' + testName + '"', function (err) { created = !err; next(err); }); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.migrate(function (err) { next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { capital.increaseTo(startingCash, next); },
  function (result, next) { assert.ok(D(result.added).eq(10000)); capital.increaseTo(startingCash, next); },
  function (result, next) { assert.equal(result.added, '0'); db.query('SELECT a.cash,a."initialCash",a.realized,(SELECT SUM(delta)::text FROM paper_cash_ledger) ledger_cash FROM paper_accounts a WHERE id=$1', ['paper'], next); },
  function (rows, next) { assert.ok(D(rows[0].cash).eq(startingCash)); assert.ok(D(rows[0].cash).eq(rows[0].ledger_cash)); assert.ok(D(rows[0].initialCash).eq(startingCash)); assert.ok(D(rows[0].realized).isZero()); next(); },
  function (next) { db.insert('Leader', { id: wallet, name: 'Test', rank: 1, pnl: '0', active: true, joinedAt: new Date((now - 20) * 1000), inventory: {}, inventoryValid: true, raw: { inventoryTimestamp: now - 10 } }, function (err) { next(err); }); },
  function (next) { db.insert('Market', { id: 'condition', raw: { t: [{ o: 'Yes', t: 'token' }, { o: 'No', t: 'other' }], gamma: { endDate: '2026-10-10T12:00:00Z' } }, resolution: {} }, function (err) { next(err); }); },
  function (next) { paper.copy(buy, next); },
  function (result, next) { assert.ok(D(result.order.quantity).eq(20)); metadata.prepare(buy, next); },
  function (_, next) { metadata.resolutions(next); },
  function (_, next) { dashboard.bets({ limit: 1, offset: 0 }, next); },
  function (page, next) { assert.equal(page.total, 1); assert.equal(page.data[0].traderName, 'Test'); assert.ok(D(page.data[0].amount).eq(10)); assert.equal(page.data[0].outcome, 'Yes'); assert.equal(page.data[0].status, 'pending'); assert.equal(page.data[0].marketEndAt, '2026-10-10T12:00:00Z'); assert.equal(page.data[0].expectedSettlementAt, '2026-10-10T14:00:00Z'); dashboard.cashSummary(next); },
  function (summary, next) { assert.equal(summary.pendingBets, 1); assert.ok(D(summary.totalProfit).isZero()); dashboard.detail('buy', next); },
  function (detail, next) { assert.equal(detail.summary.traderName, 'Test'); assert.equal(detail.summary.outcome, 'Yes'); assert.equal(detail.summary.marketEndAt, '2026-10-10T12:00:00Z'); assert.equal(detail.summary.category, '足球'); assert.equal(detail.summary.marketType, '胜负'); assert.equal(detail.summary.officialUrl, 'https://polymarket.com/event/smoke-event/smoke-market'); paper.copy(buy, next); },
  function (result, next) { assert.equal(result.duplicate, true); paper.copy(sale, next); },
  function (result, next) { assert.ok(D(result.order.quantity).eq(10)); dashboard.detail('sell', next); },
  function (detail, next) { assert.equal(detail.summary.status, 'sold'); assert.ok(D(detail.summary.amount).eq(6)); assert.equal(detail.settlements.length, 0); paper.settle('condition', { status: 'proposed', payouts: [1000000, 0] }, next); },
  function (result, next) { assert.equal(result.pending, true); paper.settle('condition', { status: 'resolved', payouts: [1000000, 0], condition_id: 'condition' }, next); },
  function (_, next) { paper.settle('condition', { status: 'resolved', payouts: [1000000, 0], condition_id: 'condition' }, next); },
  function (_, next) { paper.copy({ ...buy, id: 'after-settlement' }, next); },
  function (result, next) { assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.order.reason, 'MARKET_ALREADY_RESOLVED'); dashboard.detail('after-settlement', next); },
  function (detail, next) { assert.equal(detail.summary.status, 'skipped'); assert.equal(detail.settlements.length, 0); assert.equal(detail.order, undefined); dashboard.overview(next); },
  function (result, next) { assert.ok(D(result.cash).eq(startingCash.plus(6))); assert.ok(D(result.realized).eq(6)); assert.equal(result.openPositions, 0); db.query('SELECT COUNT(*)::int AS count FROM paper_settlements', [], next); },
  function (rows, next) { assert.equal(rows[0].count, 1); dashboard.cashSummary(next); },
  function (summary, next) {
    assert.ok(D(summary.settledWins).eq(5)); assert.ok(D(summary.settledLosses).eq(0));
    assert.ok(D(summary.settledProfit).eq(5)); assert.ok(D(summary.saleProfit).eq(1));
    assert.ok(D(summary.wagered).eq(10)); assert.ok(D(summary.settlementRevenue).eq(10)); assert.ok(D(summary.saleRevenue).eq(6));
    assert.ok(D(summary.initialCash).minus(summary.wagered).plus(summary.settlementRevenue).plus(summary.saleRevenue).eq(summary.cash));
    require('../server/service/market-statistics-service').create(db).list({},next);
  },
  function(page,next){assert.equal(page.data[0].category,'足球');assert.equal(page.data[0].marketType,'胜负');assert.equal(page.data[0].officialUrl,'https://polymarket.com/event/smoke-event/smoke-market');paper.copy({...buy,id:'loss-buy',token:'loss-token',condition:'loss-condition'},next);},
  function (_, next) { dashboard.bets({ limit: 1 }, next); },
  function (page, next) { assert.equal(page.total, 2); assert.equal(page.data[0].id, 'loss-buy'); dashboard.bets({ limit: 1, offset: 1, asOf: page.asOf }, next); },
  function (page, next) { assert.equal(page.data[0].id, 'buy'); assert.equal(page.data[0].status, 'settled'); dashboard.bets({ limit: 1, offset: 99 }, next); },
  function (page, next) { assert.equal(page.total, 2); assert.equal(page.data.length, 0); paper.settle('loss-condition', { status: 'resolved', payouts: [0, 1000000] }, next); },
  function (_, next) { dashboard.cashSummary(next); },
  function (summary, next) {
    assert.ok(D(summary.settledWins).eq(5)); assert.ok(D(summary.settledLosses).eq(10)); assert.ok(D(summary.settledProfit).eq(-5));
    assert.ok(D(summary.wagered).eq(20)); assert.ok(D(summary.cash).eq(startingCash.minus(4)));
    assert.equal(summary.settledCount, 2); assert.ok(D(summary.pendingCost).isZero());
    assert.equal(summary.pendingBets, 0); assert.ok(D(summary.totalProfit).eq(-4));
    assert.ok(D(summary.initialCash).minus(summary.wagered).plus(summary.settlementRevenue).plus(summary.saleRevenue).eq(summary.cash));
    // Start a bet transaction before page one, then commit it after page one's visibility snapshot.
    db.transaction(function (tx, done) {
      tx.query("INSERT INTO paper_orders SELECT (jsonb_populate_record(NULL::paper_orders,to_jsonb(o)||jsonb_build_object('id','late-commit','createdAt',CURRENT_TIMESTAMP))).* FROM paper_orders o WHERE id='loss-buy'", [], function (err) {
        if (err) return done(err);
        dashboard.bets({ limit: 1 }, done);
      });
    }, next);
  },
  function (page, next) { assert.equal(page.total, 2); betAnchor = page; dashboard.bets({ limit: 1, offset: 1, asOf: page.asOf, snapshot: page.snapshot }, next); },
  function (page, next) { assert.equal(page.total, 2); assert.equal(page.data[0].id, 'buy'); dashboard.bets({}, next); },
  function (page, next) { assert.equal(page.total, betAnchor.total + 1); db.save('Leader', { id: wallet, name: 'Test', rank: 1, pnl: '0', active: true, joinedAt: new Date((now - 20) * 1000), inventory: {}, inventoryValid: true, raw: { inventoryTimestamp: now - 10 } }, next); },
  function (_, next) { const raw = { proxy_wallet: wallet, transaction_hash: 'buy-new', token_id: 'new-token', condition_id: 'new-condition', side: 'BUY', price: 0.5, size: 10, timestamp: now, outcome_index: 0 }; sources.ingest(require('../server/service/source-service').groupTrades([raw])[0], next); },
  function (_, next) { db.one('Leader', { where: { id: wallet } }, next); },
  function (leader, next) { assert.equal(leader.inventory['new-token'], '10'); const raw = { proxy_wallet: wallet, transaction_hash: 'sell-new', token_id: 'new-token', condition_id: 'new-condition', side: 'SELL', price: 0.5, size: 5, timestamp: now + 1, outcome_index: 0 }; const group = require('../server/service/source-service').groupTrades([raw])[0]; group.validatedInventoryBaseline = (now - 10) + ':'; sources.ingest(group, next); },
  function (_, next) { db.query('SELECT payload FROM paper_outbox WHERE payload->>\'side\'=$1', ['SELL'], next); },
  function (rows, next) { assert.equal(rows[0].payload.beforeInventory, '10'); db.save('Setting', { id: 'quarantine:' + wallet + ':buy-new:new-token:BUY', value: { reason: 'source regression' } }, next); },
  function (_, next) { const raw = { proxy_wallet: wallet, transaction_hash: 'buy-new', token_id: 'new-token', condition_id: 'new-condition', side: 'BUY', price: 0.5, size: 20, timestamp: now, outcome_index: 0 }; sources.ingest(require('../server/service/source-service').groupTrades([raw])[0], next); },
  function (result, next) { assert.equal(result.quarantined, true); db.one('Source', { where: { id: wallet + ':buy-new:new-token:BUY' } }, next); },
  function (row, next) { assert.equal(row.processed['0.5'], '10'); dashboard.snapshot(next); }
], cleanup);
function cleanup(err) {
  db.close(function (closeError) {
    function finish(cleanupError) { admin.end(function () { const failure = err || closeError || cleanupError; if (failure) { console.error(failure.stack); process.exitCode = 1; } else console.log('Database integration passed: duplicate copy, proportional sell, final settlement, PnL conservation, new-token inventory, snapshots. Disposable database removed.'); }); }
    if (created && /^polymarket_copy_test_\d+$/.test(testName)) admin.query('DROP DATABASE "' + testName + '"', finish);
    else finish();
  });
}
