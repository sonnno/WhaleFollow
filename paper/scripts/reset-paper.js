// Explicit maintenance command: clears this paper system only; never starts services.
const async = require('async');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../config/DBsettings');
const db = require('../server/db/adapter').create();
const redis = require('../server/lib/redis')();
const { definitions } = require('../server/db/entities');
const { D, str } = require('../server/service/accounting-service');
let releaseWorker, releaseApi, before, redisRemoved = 0;
const amount = process.argv[2];
const tables = Object.values(definitions).map(function (definition) { return definition.table; }).filter(function (table) { return table !== 'paper_settings'; });
function clearRedis(callback) {
  function page(cursor) {
    redis.scan(cursor, 'MATCH', 'paper:*', 'COUNT', 500, function (err, result) {
      if (err) return callback(err);
      function advance() { if (result[0] === '0') return callback(); page(result[0]); }
      if (!result[1].length) return advance();
      redis.del(result[1], function (error, count) { if (error) return callback(error); redisRemoved += count; advance(); });
    });
  }
  page('0');
}
async.waterfall([
  function (next) {
    try { if (!D(amount).isFinite() || !D(amount).gt(0)) throw new Error('Positive reset capital required'); }
    catch (err) { return next(err); }
    if (settings.POSTGRES_DATABASE !== 'polymarket_copy' || tables.some(function (table) { return !/^paper_[a-z_]+$/.test(table); })) return next(new Error('Reset restricted to the paper-owned database and tables'));
    db.connect(function (err) { next(err); });
  },
  function (next) {
    db.query("SELECT id FROM paper_system_identity WHERE id='paper'", [], function (err, rows) { if (err) return next(err); if (!rows.length) return next(new Error('Paper identity missing')); next(); });
  },
  function (next) {
    // Dropping only paper-owned process lease connections invokes their shutdown handlers.
    db.query(`SELECT pg_terminate_backend(a.pid) stopped FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.granted AND l.objid IN(178002,178004)
      AND a.datname=current_database() AND a.pid<>pg_backend_pid()`, [], function (err) { next(err); });
  },
  function (next) { db.lease(function () { process.exitCode = 1; }, function (err, release) { releaseWorker = release; next(err); }); },
  function (next) { db.apiLease(function () { process.exitCode = 1; }, function (err, release) { releaseApi = release; next(err); }); },
  function (next) { redis.connect(function (err) { next(err); }); },
  function (next) {
    db.transaction(function (tx, done) {
      async.waterfall([
        function (step) { tx.query('LOCK TABLE ' + tables.concat('paper_settings').join(',') + ' IN ACCESS EXCLUSIVE MODE', [], function (err) { step(err); }); },
        function (step) { tx.query('SELECT cash::text,"initialCash"::text,realized::text,fees::text,(SELECT COUNT(*) FROM paper_orders)::text orders,(SELECT COUNT(*) FROM paper_follow_tasks)::text tasks FROM paper_accounts WHERE id=$1', ['paper'], step); },
        function (rows, step) { before = rows[0]; tx.query('TRUNCATE TABLE ' + tables.join(','), [], function (err) { step(err); }); },
        function (step) { tx.query("DELETE FROM paper_settings WHERE id NOT LIKE 'session:%'", [], function (err) { step(err); }); },
        function (step) { tx.query('INSERT INTO paper_accounts(id,cash,"initialCash",realized,fees) VALUES($1,$2,$2,0,0)', ['paper', str(amount)], function (err) { step(err); }); },
        function (step) { tx.query('INSERT INTO paper_cash_ledger(id,reference,kind,delta,balance,details) VALUES($1,$2,$3,$4,$4,$5)', ['initial-deposit', 'paper', 'DEPOSIT', str(amount), { reset: true }], function (err) { step(err); }); },
        function (step) { tx.save('Setting', { id: 'follow-tasks-initialized', value: { version: 1, count: 0, resetAt: new Date().toISOString() } }, function (err) { step(err); }); }
      ], done);
    }, function (err) { next(err); });
  },
  function (next) { clearRedis(next); },
  function (next) {
    const filename = path.join(__dirname, '../config/local.json');
    const value = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
    value.initialCash = str(amount);
    fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', next);
  },
  function (next) {
    const counts = tables.map(function (table) { return "SELECT '" + table + "' AS name,COUNT(*)::int AS count FROM " + table; }).join(' UNION ALL ');
    db.query(counts, [], next);
  },
  function (rows, next) {
    try { rows.forEach(function (row) { assert.equal(row.count, ['paper_accounts', 'paper_cash_ledger'].includes(row.name) ? 1 : 0, row.name); }); }
    catch (err) { return next(err); }
    db.query('SELECT cash::text,"initialCash"::text,realized::text,fees::text,(SELECT SUM(delta)::text FROM paper_cash_ledger) ledger FROM paper_accounts WHERE id=$1', ['paper'], function (err, accounts) { next(err, { rows, account: accounts && accounts[0] }); });
  },
  function (result, next) {
    try { assert.ok(D(result.account.cash).eq(amount)); assert.ok(D(result.account.initialCash).eq(amount)); assert.ok(D(result.account.ledger).eq(amount)); assert.ok(D(result.account.realized).isZero()); assert.ok(D(result.account.fees).isZero()); }
    catch (err) { return next(err); }
    fs.writeFile(path.join(__dirname, '../../reports/paper-reset-2026-10-13.json'), JSON.stringify({ at: new Date().toISOString(), before, after: result, redisRemoved }, null, 2), next);
  }
], function (err) {
  redis.disconnect();
  function close() { db.close(function (error) { if (err || error) { console.error((err || error).message); process.exitCode = 1; } else console.log('Paper reset verified: capital/cash ' + amount + ', PnL/fees zero, all trading/task records empty, paper Redis cleared. Services stopped.'); }); }
  function workerRelease() { if (releaseWorker) releaseWorker(close); else close(); }
  if (releaseApi) releaseApi(workerRelease); else workerRelease();
});
