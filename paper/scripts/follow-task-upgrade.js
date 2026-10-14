// In-place paper upgrade, guarded by both process leases. No collector is started.
const async = require('async');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db/adapter').create();
const tasks = require('../server/service/follow-task-service').create(db);
let releaseWorker, releaseApi, before, seeded;
const queries = {
  account: 'SELECT id,cash::text,"initialCash"::text,realized::text,fees::text FROM paper_accounts ORDER BY id',
  orders: 'SELECT COUNT(*)::text count,COALESCE(SUM(gross),0)::text gross,COALESCE(SUM(fee),0)::text fee,COALESCE(SUM(quantity),0)::text quantity FROM paper_orders',
  statuses: 'SELECT status,COUNT(*)::text count FROM paper_orders GROUP BY status ORDER BY status',
  positions: 'SELECT COUNT(*)::text count,COALESCE(SUM(quantity),0)::text quantity,COALESCE(SUM(cost),0)::text cost,COALESCE(SUM(realized),0)::text realized FROM paper_positions',
  fills: 'SELECT COUNT(*)::text count,COALESCE(SUM(quantity),0)::text quantity,COALESCE(SUM(fee),0)::text fee FROM paper_fills',
  settlements: 'SELECT COUNT(*)::text count,COALESCE(SUM(revenue),0)::text revenue,COALESCE(SUM(profit),0)::text profit FROM paper_settlements',
  ledger: 'SELECT COUNT(*)::text count,COALESCE(SUM(delta),0)::text delta FROM paper_cash_ledger',
  daily: 'SELECT COUNT(*)::text count,COALESCE(SUM("netProfit"),0)::text profit FROM paper_daily_reports',
  sources: 'SELECT COUNT(*)::text count FROM paper_source_trades',
  outbox: 'SELECT status,COUNT(*)::text count FROM paper_outbox GROUP BY status ORDER BY status'
};
function snapshot(callback) {
  const result = {};
  async.eachSeries(Object.keys(queries), function (key, next) {
    db.query(queries[key], [], function (err, rows) { result[key] = rows; next(err); });
  }, function (err) { callback(err, result); });
}
async.waterfall([
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.lease(function () { process.exitCode = 1; }, function (err, release) { releaseWorker = release; next(err); }); },
  function (next) { db.apiLease(function () { process.exitCode = 1; }, function (err, release) { releaseApi = release; next(err); }); },
  function (next) { snapshot(next); },
  function (data, next) { before = data; db.migrate(function (err) { next(err); }); },
  function (next) { tasks.initialize(next); },
  function (result, next) { seeded = result; snapshot(next); },
  function (after, next) {
    try { assert.deepEqual(after, before, 'Existing money and record totals must remain unchanged'); }
    catch (err) { return next(err); }
    tasks.list(function (err, result) {
      if (err) return next(err);
      const report = { at: new Date().toISOString(), initialized: seeded, conserved: true, before, after,
        tasks: result.data.map(function (task) { return { name: task.name, wallet: task.wallet, state: task.state, fundingMode: task.fundingMode, allocation: task.allocation, fundedCapital: task.fundedCapital, cash: task.cash, copyPercent: task.copyPercent, maxOrderAmount: task.maxOrderAmount, realized: task.realized, fees: task.fees }; }) };
      fs.writeFile(path.join(__dirname, '../../reports/paper-follow-task-upgrade.json'), JSON.stringify(report, null, 2), next);
    });
  }
], function (err) {
  function close() { db.close(function (failure) { const error = err || failure; if (error) { console.error(error.message); process.exitCode = 1; } else console.log('Paper task upgrade complete; existing money/records preserved. No service started.'); }); }
  function workerRelease() { if (releaseWorker) releaseWorker(close); else close(); }
  if (releaseApi) releaseApi(workerRelease); else workerRelease();
});
