const async = require('async');
const { D, str } = require('./accounting-service');

function create(db) {
  function zeroValueBuys(callback) {
    db.transaction(function (tx, done) {
      let orders, before;
      const groups = new Map();
      const counts = { repairedOrders: 0, removedFills: 0, removedLedgers: 0, removedPositions: 0 };
      const balanceSql = `SELECT cash,"initialCash",realized,fees,
        (SELECT COALESCE(SUM(delta),0)::text FROM paper_cash_ledger) ledger_cash,
        (SELECT COALESCE(SUM(cost),0)::text FROM paper_positions) position_cost
        FROM paper_accounts WHERE id='paper'`;
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (rows, next) { if (!rows.length) return next(new Error('Paper account missing')); tx.query(balanceSql, [], next); },
        function (rows, next) { before = rows[0]; tx.query("SELECT * FROM paper_orders WHERE side='BUY' AND status IN ('FILLED','PARTIAL') AND gross=0 AND fee=0 FOR UPDATE", [], next); },
        function (rows, next) {
          orders = rows;
          orders.forEach(function (o) {
            const cycle = Number(o.details.positionCycle || 1), id = o.wallet + ':' + o.token;
            const key = id + ':' + cycle;
            const group = groups.get(key) || { id, wallet: o.wallet, token: o.token, cycle, quantity: D(0) };
            group.quantity = group.quantity.plus(o.quantity);
            groups.set(key, group);
          });
          async.eachSeries(Array.from(groups.values()), function (g, saved) {
            tx.query(`SELECT p.*,(SELECT COUNT(*)::int FROM paper_settlements WHERE id=$2) settled,
              (SELECT COUNT(*)::int FROM paper_closed_cycles WHERE id=$2) closed,
              (SELECT COUNT(*)::int FROM paper_orders o WHERE o.wallet=p.wallet AND o.token=p.token AND o.side='SELL'
                AND o.status IN ('FILLED','PARTIAL') AND COALESCE((o.details->>'positionCycle')::int,1)=$3) sold
              FROM paper_positions p WHERE p.id=$1 FOR UPDATE`, [g.id, g.id + ':' + g.cycle, g.cycle], function (err, values) {
              if (err) return saved(err);
              const p = values[0];
              if (!p || p.cycle !== g.cycle || p.settled || p.closed || p.sold || g.quantity.lt(0) || D(p.quantity).lt(g.quantity)) return saved(new Error('Zero-value order cycle cannot be safely repaired: ' + g.id));
              g.position = p;
              saved();
            });
          }, next);
        },
        function (next) {
          async.eachSeries(orders, function (o, saved) {
            let parts;
            async.waterfall([
              function (step) { tx.query('SELECT * FROM paper_fills WHERE "orderId"=$1 FOR UPDATE', [o.id], step); },
              function (rows, step) {
                parts = rows;
                const quantity = parts.reduce(function (sum, f) { return sum.plus(f.quantity); }, D(0));
                if (!quantity.eq(o.quantity) || parts.some(function (f) { return f.side !== 'BUY' || f.wallet !== o.wallet || f.token !== o.token || !D(f.fee).eq(0) || D(f.quantity).lte(0) || !D(str(D(f.price).mul(f.quantity))).eq(0); })) return step(new Error('Unexpected nonzero fill in zero-value order'));
                tx.query('SELECT * FROM paper_cash_ledger WHERE reference=$1 FOR UPDATE', [o.id], step);
              },
              function (rows, step) {
                if (rows.length !== 1 || rows[0].kind !== 'BUY' || !D(rows[0].delta).eq(0)) return step(new Error('Unexpected ledger in zero-value order'));
                o.details = { ...o.details, repair: { reason: 'ZERO_VALUE_FILL', at: new Date().toISOString(), originalStatus: o.status, originalQuantity: o.quantity, originalFills: parts.map(function (f) { return { quantity: f.quantity, price: f.price, fee: f.fee }; }) } };
                o.status = 'SKIPPED'; o.reason = 'INSUFFICIENT_CASH'; o.quantity = '0';
                tx.save('Order', o, function (err) { step(err); });
              },
              function (step) { tx.query('WITH removed AS (DELETE FROM paper_fills WHERE "orderId"=$1 RETURNING id) SELECT COUNT(*)::int count FROM removed', [o.id], step); },
              function (rows, step) { counts.removedFills += rows[0].count; tx.query('WITH removed AS (DELETE FROM paper_cash_ledger WHERE reference=$1 RETURNING id) SELECT COUNT(*)::int count FROM removed', [o.id], step); },
              function (rows, step) { counts.removedLedgers += rows[0].count; counts.repairedOrders++; step(); }
            ], saved);
          }, next);
        },
        function (next) {
          async.eachSeries(Array.from(groups.values()), function (g, saved) {
            const p = g.position;
            p.quantity = str(D(p.quantity).minus(g.quantity));
            delete p.settled; delete p.closed; delete p.sold;
            tx.save('Position', p, function (err) {
              if (err) return saved(err);
              tx.query(`WITH removed AS (DELETE FROM paper_positions p WHERE p.id=$1 AND quantity=0 AND cost=0 AND realized=0 AND "cycleRealized"=0
                AND NOT EXISTS (SELECT 1 FROM paper_orders o WHERE o.wallet=p.wallet AND o.token=p.token AND o.status IN ('FILLED','PARTIAL'))
                AND NOT EXISTS (SELECT 1 FROM paper_settlements s WHERE s.wallet=p.wallet AND s.token=p.token)
                AND NOT EXISTS (SELECT 1 FROM paper_closed_cycles c WHERE c.wallet=p.wallet AND c.token=p.token) RETURNING id) SELECT COUNT(*)::int count FROM removed`, [p.id], function (error, rows) { if (!error) counts.removedPositions += rows[0].count; saved(error); });
            });
          }, next);
        },
        function (next) { tx.query(balanceSql, [], next); },
        function (rows, next) {
          const after = rows[0];
          if (Object.keys(before).some(function (key) { return !D(before[key]).eq(after[key]); })) return next(new Error('Repair changed money or cost balances; rolled back'));
          if (!D(after.cash).eq(after.ledger_cash)) return next(new Error('Account cash does not match ledger; rolled back'));
          next(null, { ...counts, balances: after });
        }
      ], done);
    }, callback);
  }
  return { zeroValueBuys };
}
module.exports = { create };
