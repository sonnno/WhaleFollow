// Every write targets one newly created, verified disposable database.
const assert = require('node:assert/strict');
const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const name = 'polymarket_tasks_test_' + Date.now() + process.pid;
if (!/^polymarket_tasks_test_\d+$/.test(name) || name === settings.POSTGRES_DATABASE) throw new Error('Unsafe disposable database name');
const db = require('../server/db/adapter').create({ database: name });
const tasks = require('../server/service/follow-task-service').create(db);
const transfers = require('../server/service/follow-transfer-service').create(db);
const { D } = require('../server/service/accounting-service');
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40), c = '0x' + 'c'.repeat(40);
let created = false, verified = false, winner, baseline;
function input(wallet, allocation, fundingMode) { return { wallet, name: 'Disposable task ' + wallet[2], allocation, fundingMode, copyPercent: '100', maxOrderAmount: '' }; }
function insert(entity, row, callback) { db.insert(entity, row, function (err) { callback(err); }); }
function numeric(actual, expected) { assert.ok(D(actual).eq(expected), String(actual) + ' != ' + expected); }
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('CREATE DATABASE "' + name + '"', function (err) { created = !err; next(err); }); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.query('SELECT current_database() name', [], next); },
  function (rows, next) { assert.equal(rows[0].name, name); verified = true; db.migrate(function (err) { next(err); }); },
  function (next) { insert('Account', { id: 'paper', initialCash: '1000', cash: '1000', realized: '0', fees: '0' }, next); },
  function (next) { tasks.initialize(next); },
  function (result, next) { assert.equal(result.count, 0); tasks.initialize(next); },
  function (result, next) { assert.equal(result.initialized, false); tasks.list(next); },
  function (result, next) { assert.equal(result.data.length, 0); numeric(result.wallet.unallocatedCash, 1000); assert.equal(result.defaults.copyPercent, '100');
    async.parallel([a, b].map(function (wallet) { return function (saved) { tasks.save(input(wallet, '600', 'dedicated'), function (err, row) { saved(null, { err, row }); }); }; }), next);
  },
  function (results, next) { assert.equal(results.filter(function (r) { return !r.err; }).length, 2); async.parallel([a,b].map(function(wallet){return function(cb){transfers.transfer(wallet,{direction:'in',amount:'600',requestId:'smoke-in-'+wallet},function(err,row){cb(null,{err,row,wallet});});};}),next); },
  function (results, next) { assert.equal(results.filter(function(r){return !r.err;}).length,1); assert.match(results.find(function(r){return r.err;}).err.message,/400/); winner=results.find(function(r){return !r.err;}).wallet; transfers.transfer(winner,{direction:'out',amount:'100',requestId:'smoke-return-100'},function(err){if(err)return next(err);db.query('SELECT cash FROM paper_accounts WHERE id=$1',['paper'],next);}); },
  function (rows, next) { numeric(rows[0].cash, 1000); tasks.save(input(winner, '500'), next); },
  function (row, next) { numeric(row.cash, 500); numeric(row.fundedCapital, 500); async.eachSeries([winner === a ? b : a, c], function (wallet, saved) { tasks.save(input(wallet, '1000', 'shared'), function (err, shared) { if (err) return saved(err); assert.equal(shared.fundingMode, 'shared'); numeric(shared.cash, 0); numeric(shared.fundedCapital, 0); numeric(shared.availableCash, 500); saved(); }); }, next); },
  function (next) { tasks.list(next); },
  function (result, next) { numeric(result.wallet.allocatedCapital, 500); numeric(result.wallet.unallocatedCash, 500); assert.equal(result.data.length, 3);const funded=result.data.find(function(r){return r.wallet===winner;});numeric(funded.accountFunds,500);numeric(funded.recordedTransferredIn,600);numeric(funded.recordedTransferredOut,100); const shared = result.data.filter(function (row) { return row.fundingMode === 'shared'; }); shared.forEach(function (row) {assert.equal(row.accountFunds,null); numeric(row.availableCash, 500); numeric(row.allocation, 1000); }); tasks.save(input(winner, '600'), next); },
  function (row, next) { numeric(row.fundedCapital, 500); transfers.transfer(winner,{direction:'in',amount:'100',requestId:'smoke-add-100'},function(err){if(err)return next(err);db.update('Account', 'paper', { cash: '500', realized: '-30', fees: '2' }, function (err) { next(err); });}); },
  function (next) { db.update('FollowTask', winner, { cash: '100', realized: '-30', fees: '2' }, function (err) { next(err); }); },
  function (next) { insert('Position', { id: winner + ':token', wallet: winner, fundingMode: 'dedicated', token: 'token', condition: 'condition', quantity: '1000', cost: '470', realized: '-30', outcomeIndex: 0 }, next); },
  function (next) { insert('Order', { id: 'filled', sourceId: 'source-filled', wallet: winner, token: 'token', condition: 'condition', side: 'BUY', status: 'FILLED', gross: '468', quantity: '1000', fee: '2', details: { completed: true } }, next); },
  function (next) { insert('Order', { id: 'waiting-buy', sourceId: 'source-buy', wallet: winner, token: 'token', condition: 'condition', side: 'BUY', status: 'WAITING', details: { kept: true } }, next); },
  function (next) { insert('Order', { id: 'waiting-sell', sourceId: 'source-sell', wallet: winner, token: 'token', condition: 'condition', side: 'SELL', status: 'WAITING', details: { kept: true } }, next); },
  function (next) { async.eachSeries(['BUY', 'SELL'], function (side, saved) { insert('Outbox', { id: 'pending-' + side, kind: 'copy', payload: { wallet: winner, side }, status: 'pending' }, saved); }, next); },
  function (next) { db.query(`SELECT (SELECT row_to_json(p) FROM paper_positions p WHERE p.id=$1) position,(SELECT row_to_json(o) FROM paper_orders o WHERE o.id='filled') filled,(SELECT row_to_json(a) FROM paper_accounts a WHERE a.id='paper') account`, [winner + ':token'], next); },
  function (rows, next) { baseline = rows[0]; tasks.save(input(winner, '200'), next); },
  function (row, next) { numeric(row.cash, 100); numeric(row.fundedCapital, 600); assert.equal(row.pendingRelease,undefined); numeric(row.availableCash,0);tasks.list(function(err,result){if(err)return next(err);const funded=result.data.find(function(r){return r.wallet===winner;});numeric(funded.accountFunds,570);numeric(funded.recordedTransferredIn,700);numeric(funded.recordedTransferredOut,100);tasks.save(input(winner,'300'),next);}); },
  function (row, next) { numeric(row.cash, 100); numeric(row.fundedCapital, 600); assert.equal(row.pendingRelease,undefined); numeric(row.realized, -30); numeric(row.fees, 2); tasks.save(input(c, '600', 'dedicated'),function(err){if(err)return next(err);transfers.transfer(c,{direction:'in',amount:'600',requestId:'smoke-too-much'},function(err){assert.ok(err);assert.match(err.message,/公共.*400/);next();});}); },
  function (next) { tasks.save(input(winner, '600'), next); },
  function (row, next) { numeric(row.cash, 100); async.eachSeries(['start', 'pause', 'stop'], function (action, controlled) { tasks.control(winner, { action }, function (err, task) { if (err) return controlled(err); assert.equal(task.state, { start: 'running', pause: 'paused', stop: 'stopped' }[action]); assert.equal(task.generation, { start: 1, pause: 2, stop: 3 }[action]); controlled(); }); }, next); },
  function (next) { tasks.save(input(winner, '600', 'shared'), function (err) { assert.ok(err); assert.match(err.message, /未结算持仓.*切换/); next(); }); },
  function (next) { db.query(`SELECT (SELECT row_to_json(p) FROM paper_positions p WHERE p.id=$1) position,(SELECT row_to_json(o) FROM paper_orders o WHERE o.id='filled') filled,(SELECT row_to_json(a) FROM paper_accounts a WHERE a.id='paper') account`, [winner + ':token'], next); },
  function (rows, next) { assert.deepEqual(rows[0], baseline, 'Task funding/control must preserve account and executed records'); db.query(`SELECT id,status,reason,details FROM paper_orders ORDER BY id`, [], next); },
  function (rows, next) { const buy = rows.find(function (r) { return r.id === 'waiting-buy'; }); assert.equal(buy.status, 'SKIPPED'); assert.equal(buy.reason, 'TASK_CONTROL_CANCELLED'); assert.deepEqual(buy.details, { kept: true, completed: true }); assert.equal(rows.find(function (r) { return r.id === 'waiting-sell'; }).status, 'WAITING'); db.query('SELECT id,status,error FROM paper_outbox ORDER BY id', [], next); },
  function (rows, next) { assert.equal(rows.find(function (r) { return r.id === 'pending-BUY'; }).error, 'TASK_CONTROL_CANCELLED'); assert.equal(rows.find(function (r) { return r.id === 'pending-SELL'; }).status, 'pending'); db.one('Leader', { where: { id: winner } }, next); },
  function (leader, next) { assert.equal(leader.raw.followGeneration, 3); assert.equal(leader.active, false); assert.equal(leader.inventoryValid, false); tasks.list(next); },
  function (result, next) { numeric(result.wallet.initialCash, 1000); numeric(result.wallet.cash, 500); numeric(result.wallet.allocatedCapital, 600); numeric(result.wallet.unallocatedCash, 400); numeric(result.wallet.totalProfit, -30); assert.equal(result.data.length, 3); const t = result.data.find(function (row) { return row.wallet === winner; }); assert.equal(t.pendingBets, 1); assert.equal(t.buyCount, 1); numeric(t.positionCost, 470); numeric(t.totalProfit, -30); assert.equal(t.state, 'stopped');
    // Reset only this verified scratch database to exercise actual legacy grouping SQL.
    if (!verified) return next(new Error('Unverified disposable target'));
    db.query('TRUNCATE paper_follow_tasks,paper_settings,paper_positions,paper_orders,paper_leaders,paper_outbox', [], function (err) { next(err); });
  },
  function (next) { db.update('Account', 'paper', { cash: '550', realized: '-50', fees: '7' }, function (err) { next(err); }); },
  function (next) { async.eachSeries([a, b], function (wallet, saved) { insert('Leader', { id: wallet, name: 'Legacy ' + wallet[2], rank: 0, pnl: '0', active: wallet === b, joinedAt: new Date('2026-01-01T00:00:00Z'), inventory: {}, raw: {} }, saved); }, next); },
  function (next) { insert('Position', { id: a + ':open', wallet: a, token: 'open', condition: 'condition', quantity: '600', cost: '300', realized: '0', outcomeIndex: 0 }, next); },
  function (next) { insert('Position', { id: a + ':closed', wallet: a, token: 'closed', condition: 'condition', quantity: '0', cost: '0', realized: '-100', outcomeIndex: 0 }, next); },
  function (next) { insert('Position', { id: b + ':open', wallet: b, token: 'open', condition: 'condition', quantity: '200', cost: '100', realized: '50', outcomeIndex: 0 }, next); },
  function (next) { async.eachSeries([a, b], function (wallet, saved) { insert('Order', { id: wallet + ':legacy-fees', sourceId: 'legacy-fees', wallet, token: 'open', condition: 'condition', side: 'BUY', status: 'FILLED', gross: '100', quantity: '200', fee: wallet === a ? '5' : '2' }, saved); }, next); },
  function (next) { tasks.initialize(next); },
  function (result, next) { assert.equal(result.count, 2); tasks.list(next); },
  function (result, next) { const first = result.data.find(function (row) { return row.wallet === a; }), second = result.data.find(function (row) { return row.wallet === b; }); numeric(first.allocation, 1000); numeric(first.cash, 0); numeric(first.realized, -100); numeric(first.fees, 5); numeric(second.allocation, 1000); numeric(second.cash, 0); numeric(second.realized, 50); numeric(second.fees, 2); numeric(result.wallet.unallocatedCash, 550); numeric(result.wallet.allocatedCapital, 0); assert.equal(first.fundingMode, 'shared'); assert.equal(first.pendingBets, 1, 'Closed realized positions must not inflate pending bets'); assert.equal(second.state, 'running'); tasks.initialize(next); },
  function (result, next) { assert.equal(result.initialized, false); next(); }
], cleanup);

let cleaning = false;
process.once('uncaughtException', cleanup);
function cleanup(error) {
  if (cleaning) { console.error('Secondary smoke error:', error.message); process.exitCode = 1; return; }
  cleaning = true;
  db.close(function (closeError) {
    function finish(cleanupError) { admin.end(function () { const failure = error || closeError || cleanupError; if (failure) { console.error(failure.stack); process.exitCode = 1; } else console.log('Follow task PostgreSQL smoke passed: shared pool and optional dedicated reserves, concurrent funding, manual transfers and independent target changes, generation/cancellation, record preservation, legacy shared balances. Disposable database removed.'); }); }
    if (created && /^polymarket_tasks_test_\d+$/.test(name) && name !== settings.POSTGRES_DATABASE) {
      if (!verified && !error) return finish(new Error('Disposable database was not verified'));
      admin.query('DROP DATABASE "' + name + '"', finish);
    } else finish();
  });
}


