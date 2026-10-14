const async = require('async');
const db = require('../server/db/adapter').create();
const capital = require('../server/service/capital-service').create(db);
const { D } = require('../server/service/accounting-service');
const target = process.argv[2];
if (!target) { console.error('Usage: node scripts/set-capital.js <total virtual principal>'); process.exitCode = 1; }
else async.waterfall([
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { capital.increaseTo(target, next); },
  function (result, next) {
    db.query(`SELECT a.cash,a."initialCash",a.realized,a.fees,
      (SELECT COALESCE(SUM(delta),0)::text FROM paper_cash_ledger) ledger_cash,
      (SELECT COALESCE(SUM(cost),0)::text FROM paper_positions WHERE quantity>0) position_cost
      FROM paper_accounts a WHERE id=$1`, ['paper'], function (err, rows) {
      if (err) return next(err);
      const account = rows[0];
      if (!D(account.cash).eq(account.ledger_cash)) return next(new Error('Cash does not match ledger'));
      if (D(account.initialCash).plus(account.realized).minus(D(account.cash).plus(account.position_cost)).abs().gt('0.000000000001')) return next(new Error('Capital and position cost accounting do not balance'));
      next(null, { ...result, account });
    });
  }
], function (err, result) { if (err) { console.error(err.message); process.exitCode = 1; } else console.log(JSON.stringify(result)); db.close(function () {}); });
