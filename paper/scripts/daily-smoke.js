// All daily report tests use a disposable database.
const assert = require('node:assert/strict');
const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const testName = 'polymarket_daily_test_' + Date.now();
process.env.POSTGRES_DATABASE = testName;
settings.POSTGRES_DATABASE = testName;
const db = require('../server/db/adapter').create();
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
const { D } = require('../server/service/accounting-service');
const config = require('../config').paper;
config.copySizing = 'equal_amount'; // Deterministic fixture independent of local follow ratio.
const markets = { prepare: function (_, cb) { cb(null, { metadata: { rate: '0.1', exponent: 1 }, book: { asks: [{ price: '0.5', size: '1000' }], bids: [{ price: '0.6', size: '1000' }], observedAt: Date.now() } }); }, consume: function () {} };
const paper = require('../server/service/paper-service').create(db, markets);
const signal = { wallet: '0x'+'d'.repeat(40), token: 'token', condition: 'market', side: 'BUY', size: '20', price: '0.5', timestamp: Math.floor(Date.now() / 1000), title: 'Daily test', outcomeIndex: 0, active: true, historical: false, config };
const B='0x'+'e'.repeat(40);
let created = false, daily, sellDetails, now = new Date('2026-10-02T01:59:59Z');
process.once('uncaughtException', cleanup);
function stampOrder(id, at, cb) { async.waterfall([
  function (next) { db.query('UPDATE paper_orders SET "createdAt"=$2 WHERE id=$1', [id, at], function (err) { next(err); }); },
  function (next) { db.query('UPDATE paper_cash_ledger SET "createdAt"=$2 WHERE reference=$1', [id, at], function (err) { next(err); }); }
], cb); }
function settleAfterLock(callback) {
  let finished = false;
  function finish(err) { if (finished) return; finished = true; callback(err, null); }
  let releasedAt;
  db.transaction(function (tx, unlock) {
    tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) {
      if (err) return unlock(err);
      paper.settle('market', { status: 'resolved', payouts: [1000000, 0] }, function (error) {
        if (error) return finish(error);
        db.query('SELECT MIN("createdAt") >= $1::timestamptz after_lock FROM paper_settlements WHERE condition=$2', [releasedAt, 'market'], function (failure, rows) {
          if (failure) return finish(failure);
          assert.equal(rows[0].after_lock, true, 'Settlement date is after obtaining the lock, not its earlier transaction start');
          finish();
        });
      });
      setTimeout(function () { tx.query('SELECT clock_timestamp() at', [], function (error, rows) { if (!error) releasedAt = rows[0].at; unlock(error, null); }); }, 100);
    });
  }, function (err) { if (err) finish(err); });
}
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('CREATE DATABASE "' + testName + '"', function (err) { created = !err; next(err); }); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.migrate(function (err) { next(err); }); },
  function(next){db.query("SELECT COUNT(*)::int count FROM pg_constraint WHERE conrelid='paper_daily_task_reports'::regclass AND contype='u'",[],next);},
  function(rows,next){assert.equal(rows[0].count,1,'Fresh schema enforces per-day/per-task uniqueness');next();},
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { db.update('Account', 'paper', { createdAt: new Date('2026-09-30T16:00:00Z') }, function (err) { next(err); }); },
  function (next) { db.query('UPDATE paper_cash_ledger SET "createdAt"=$1 WHERE id=$2', ['2026-09-30T16:00:00Z', 'initial-deposit'], function (err) { next(err); }); },
  function (next) { db.insert('Leader', { id: signal.wallet, name: 'Daily test', rank: 1, pnl: '0', active: true, joinedAt: new Date('2026-09-29T00:00:00Z'), inventory: {}, inventoryValid: true, raw: {} }, function (err) { next(err); }); },
  function(next){db.insert('Leader',{id:B,name:'No-trade task',rank:2,pnl:'0',active:false,joinedAt:new Date('2026-10-01T00:00:00Z')},function(err){next(err);});},
  function(next){db.insert('FollowTask',{id:B,state:'paused',fundingMode:'dedicated',allocation:'200',createdAt:new Date('2026-10-01T00:00:00Z')},function(err){next(err);});},
  function (next) { paper.copy({ ...signal, id: 'buy', sourceId: 'buy' }, next); },
  function (_, next) { db.query('SELECT o."createdAt"=l."createdAt" same FROM paper_orders o JOIN paper_cash_ledger l ON l.reference=o.id WHERE o.id=$1', ['buy'], next); },
  function (rows, next) { assert.equal(rows[0].same, true, 'Execution and cash debit must use the same event timestamp across midnight'); stampOrder('buy', '2026-09-30T16:00:00Z', next); },
  function (next) { paper.copy({ ...signal, id: 'sell', sourceId: 'sell', side: 'SELL', size: '5', beforeInventory: '10' }, next); },
  function (result, next) { assert.ok(D(result.order.details.realizedProfit).eq('0.51'), 'SELL must record its fee-inclusive realized profit'); assert.ok(D(result.order.details.releasedCost).eq('5.25')); sellDetails = result.order.details; stampOrder('sell', '2026-10-01T15:59:59.999Z', next); },
  function (next) { settleAfterLock(next); },
  function (_, next) { db.query('UPDATE paper_settlements SET "createdAt"=$1', ['2026-10-01T16:00:00Z'], function (err) { next(err); }); },
  function (next) { db.query("UPDATE paper_cash_ledger SET \"createdAt\"=$1 WHERE kind='SETTLEMENT'", ['2026-10-01T16:00:00Z'], function (err) { next(err); }); },
  function (next) { paper.copy({ ...signal, id: 'open-buy', sourceId: 'open-buy', token: 'open', condition: 'open-market', size: '30' }, next); },
  function (_, next) { stampOrder('open-buy', '2026-10-02T00:00:00Z', next); },
  function (next) { db.update('Position', signal.wallet + ':open', { mark: '0.99' }, function (err) { next(err); }); },
  function (next) { daily = require('../server/service/daily-report-service').create(db, { clock: function (cb) { cb(null, now); },upstream:{fetch:function(wallet,day,cb){assert.equal(typeof day,'string','PostgreSQL date must be passed to official API as calendar text');assert.match(day,/^\d{4}-\d{2}-\d{2}$/);cb(null,{leaderStatus:'sampled',leaderTradeProfit:'10',leaderIncome:'2',leaderNetProfit:'12',leaderTotalProfit:'100',leaderEvidence:{sourceFidelity:'1d'},leaderFetchedAt:new Date()});}} }); daily.runDue(next); },
  function (result, next) { assert.equal(result.written, 0, '09:59 must not write yesterday yet'); assert.equal(result.checked, 1, 'A successful deadline check is healthy even before the first report is due'); daily.writeDay('2026-10-03', function (err) { assert.ok(err, 'Incomplete/future days cannot close'); next(); }); },
  function (next) { now = new Date('2026-10-03T02:00:00Z'); db.update('Order', 'sell', { details: { ...sellDetails, realizedProfit: null } }, function (err) { next(err); }); },
  function (next) { daily.runDue(function (err) { assert.ok(err); assert.match(err.message, /Missing realized SELL accounting/); next(); }); },
  function (next) { db.query('SELECT COUNT(*)::int count FROM paper_daily_reports', [], next); },
  function (rows, next) { assert.equal(rows[0].count, 0, 'Unknown SELL profit cannot be silently zeroed'); db.update('Order', 'sell', { details: sellDetails }, function (err) { next(err); }); },
  function (next) { async.parallel([daily.runDue, daily.runDue], function (err, results) { next(err, results && { written: results.reduce(function (sum, r) { return sum + r.written; }, 0) }); }); },
  function (result, next) { assert.equal(result.written, 2, 'Restart catches up both missing days'); daily.list({ limit: 1 }, next); },
  function (page, next) { assert.equal(page.total, 2); assert.equal(page.data[0].day, '2026-10-02'); const r = page.data[0]; assert.ok(D(r.netProfit).eq('4.75')); assert.ok(D(r.buyAmount).eq('15.75')); assert.ok(D(r.fees).eq('0.75')); assert.ok(D(r.cashEnd).eq(D(config.initialCash).minus('10.49'))); assert.ok(D(r.positionCostEnd).eq('15.75')); assert.equal(r.settlementCount, 1); daily.list({ limit: 1, offset: 1 }, next); },
  function (page, next) { const r = page.data[0]; assert.equal(r.day, '2026-10-01'); assert.ok(D(r.netProfit).eq('0.51')); assert.ok(D(r.buyAmount).eq('10.5')); assert.ok(D(r.fees).eq('0.74')); assert.ok(D(r.cashEnd).eq(D(config.initialCash).minus('4.74'))); assert.ok(D(r.positionCostEnd).eq('5.25')); assert.equal(r.buyCount, 1); assert.equal(r.saleCount, 1); assert.equal(r.settlementCount, 0); daily.runDue(next); },
  function (result, next) { assert.equal(result.written, 0, 'Repeat does not duplicate or rewrite reports'); daily.writeDay('2026-10-01', next); },
  function (result, next) { assert.equal(result.duplicate, true); daily.list({ offset: 99 }, next); },
  function (page, next) { assert.equal(page.total, 2); assert.equal(page.data.length, 0); db.one('Account', { where: { id: 'paper' } }, next); },
  function (account, next) { assert.ok(D(account.realized).eq('5.26')); db.query('SELECT SUM("netProfit")::text profit FROM paper_daily_reports', [], next); },
  function (rows, next) { assert.ok(D(rows[0].profit).eq('5.26')); daily.listTasks({wallet:signal.wallet},next); },
  function (page,next) { assert.equal(page.total,2);assert.ok(D(page.data[0].netProfit).eq('4.75'));assert.ok(D(page.data[0].totalProfitEnd).eq('5.26'));assert.ok(D(page.data[1].netProfit).eq('0.51'));assert.equal(page.data[0].leaderStatus,'sampled');assert.ok(D(page.data[0].leaderNetProfit).eq('12'));daily.list({from:'2026-10-02',to:'2026-10-02'},next); },
  function (page,next) { assert.equal(page.total,1);assert.ok(D(page.data[0].totalProfitEnd).eq('5.26'));daily.listTasks({wallet:B},next); },
  function(page,next){assert.equal(page.total,2);page.data.forEach(function(r){assert.ok(D(r.netProfit).isZero());assert.ok(D(r.totalProfitEnd).isZero());});
   require('../server/service/follow-transfer-service').create(db).transfer(B,{direction:'in',amount:'20',requestId:require('crypto').randomUUID(),taskVersion:'initial'},function(err){next(err);});},
  function(next){now=new Date('2026-10-04T02:00:00Z');daily.runDue(next);},
  function(result,next){assert.equal(result.written,1);daily.list({from:'2026-10-03',to:'2026-10-03'},next);},
  function(page,next){assert.ok(D(page.data[0].netProfit).isZero(),'Transfers and open inventory cannot create daily profit');assert.ok(D(page.data[0].totalProfitEnd).eq('5.26'));db.query('UPDATE paper_daily_reports SET "breakdownVersion"=0 WHERE day=$1',['2026-10-02'],function(err){next(err);});},
  function(next){db.query('DELETE FROM paper_daily_task_reports WHERE day=$1',['2026-10-02'],function(err){next(err);});},
  function(next){daily.runDue(next);},
  function(result,next){assert.equal(result.written,1,'Existing older report receives breakdown and cumulative balance');daily.listTasks({from:'2026-10-02',to:'2026-10-02'},next);},
  function(page,next){assert.equal(page.total,2);const row=page.data.find(function(r){return r.wallet===signal.wallet;});db.update('DailyTaskReport',row.id,{leaderStatus:'pending',leaderTradeProfit:null,leaderIncome:null,leaderNetProfit:null,leaderTotalProfit:null,leaderRetryAt:new Date(0)},function(err){next(err,row.id);});},
  function(id,next){const failure=require('../server/service/daily-report-service').create(db,{upstream:{fetch:function(w,day,cb){cb(new Error('Temporary upstream outage'));}}});failure.enrichDue(function(err,result){assert.ifError(err);assert.equal(result.failed,1);db.one('DailyTaskReport',{where:{id}},function(error,row){assert.ifError(error);assert.equal(row.leaderStatus,'pending');assert.equal(row.leaderNetProfit,null);assert.match(row.leaderError,/outage/);db.update('DailyTaskReport',id,{leaderRetryAt:new Date(0)},function(e){next(e,id);});});});},
  function(id,next){const race=require('../server/service/daily-report-service').create(db,{upstream:{fetch:function(w,day,cb){db.query('DELETE FROM paper_daily_task_reports WHERE id=$1',[id],function(err){cb(err,{leaderStatus:'sampled',leaderTradeProfit:'1',leaderIncome:'0',leaderNetProfit:'1',leaderTotalProfit:'1',leaderEvidence:{},leaderFetchedAt:new Date()});});}}});race.enrichDue(function(err){if(err)return next(err);db.one('DailyTaskReport',{where:{id}},function(error,row){assert.equal(row,null,'Deleted report must not be recreated by an in-flight official response');next(error);});});}
], cleanup);
function cleanup(err) {
  if (err && err.query) console.error('Failed test SQL:', err.query);
  db.close(function (closeError) {
    function finish(cleanupError) { admin.end(function () { const failure = err || closeError || cleanupError; if (failure) { console.error(failure.stack); process.exitCode = 1; } else console.log('Daily report integration passed: Shanghai cutoff, fee-inclusive BUY/SELL/settlement, midnight boundaries, no float PnL, catch-up and idempotency.'); }); }
    if (created && /^polymarket_daily_test_\d+$/.test(testName)) admin.query('DROP DATABASE "' + testName + '"', finish);
    else finish();
  });
}
