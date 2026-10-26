const test = require('node:test'), assert = require('node:assert/strict');

test('summary counts pending buys per current open cycle without scanning historical JSON payloads', function () {
  let query;
  const db = { readSnapshot: function (work) { work({ query: function (sql, params, cb) {
    if (sql.includes('FROM paper_accounts')) return cb(null, [{createdAt:new Date()}]);
    query = sql;
  } }, function () {}); } };
  require('../server/service/dashboard-service').create(db).cashSummary(function () {});
  assert.match(query, /LATERAL/i);
  assert.match(query, /o\.wallet=p\.wallet/); assert.match(query, /o\.token=p\.token/);
  assert.match(query, /COALESCE\(\(o\.details->>'positionCycle'\)::int,1\)=p\.cycle/);
  assert.match(query, /o\.side='BUY'/); assert.match(query, /'FILLED','PARTIAL'/); assert.match(query, /p\.quantity>0/);
  assert.doesNotMatch(query, /paper_settlements|paper_markets|paper_cash_ledger/);
});

test('pending count index is built online and preserves legacy cycle-one interpretation', function () {
  const Migration = require('../server/db/migrations/dashboard-indexes'), migration = new Migration(); let query;
  migration.up({ query: function (sql) { query = sql; } });
  assert.equal(migration.transaction, false, 'online index cannot run inside a transaction');
  assert.match(query, /CREATE INDEX CONCURRENTLY IF NOT EXISTS paper_orders_pending_cycle/);
  assert.match(query, /wallet,token,\(COALESCE\(\(details->>'positionCycle'\)::int,1\)\)/);
  assert.match(query, /WHERE side='BUY' AND status IN \('FILLED','PARTIAL'\)/);
  assert.doesNotMatch(query, /DELETE|UPDATE|ALTER TABLE|live_/i);
});
