const async = require('async');
const { D, str } = require('./accounting-service');

function create(db) {
  function increaseTo(value, callback) {
    let target;
    try { target = D(value); if (!target.isFinite() || target.lte(0)) throw new Error('Invalid capital amount'); }
    catch (err) { return callback(err); }
    db.transaction(function (tx, done) {
      let account, added;
      async.waterfall([
        function (next) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (rows, next) {
          account = rows[0];
          if (!account) return next(new Error('Paper account missing'));
          added = target.minus(account.initialCash);
          if (added.lt(0)) return next(new Error('increaseTo cannot reduce capital'));
          if (added.isZero()) return done(null, { added: '0', initialCash: str(account.initialCash), cash: str(account.cash) });
          account.cash = str(D(account.cash).plus(added));
          account.initialCash = str(target);
          tx.save('Account', account, function (err) { next(err); });
        },
        function (next) { tx.query('SELECT clock_timestamp() AS at', [], next); },
        function (rows, next) {
          tx.insert('Ledger', { id: 'capital-deposit:paper:' + str(target), reference: 'paper', kind: 'DEPOSIT', delta: str(added), balance: account.cash, details: { targetPrincipal: str(target), reason: '用户调整虚拟本金' }, createdAt: rows[0].at }, function (err) { next(err); });
        }
      ], function (err) { done(err, { added: added && str(added), initialCash: account && str(account.initialCash), cash: account && str(account.cash) }); });
    }, callback);
  }
  return { increaseTo };
}
module.exports = { create };
