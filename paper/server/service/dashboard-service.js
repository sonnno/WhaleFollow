const async = require('async');
const crypto = require('node:crypto');
const { D, str } = require('./accounting-service');
const config = require('../../config').paper;
const { describe } = require('./market-view-service');
const tradeView=require('./trade-view-service');
const {orderHistorySql,settlementHistorySql}=require('./accounting-history-service');

function create(db) {
  function cashSummary(callback) {
    // One statement gives cash, orders and settlements the same committed snapshot.
    const sql = `WITH accounting_orders AS (${orderHistorySql}),accounting_settlements AS (${settlementHistorySql}),settled AS (
      SELECT s.*,COALESCE(NULLIF(p.title,''),s.condition) title,COALESCE(l.name,s.wallet) name,m.raw->'gamma' gamma
      FROM accounting_settlements s LEFT JOIN paper_positions p ON p.wallet=s.wallet AND p.token=s.token LEFT JOIN paper_leaders l ON l.id=s.wallet LEFT JOIN paper_markets m ON m.id=s.condition
    ), totals AS (
      SELECT COALESCE(SUM(profit) FILTER(WHERE profit>0),0) wins,COALESCE(-SUM(profit) FILTER(WHERE profit<0),0) losses,
        COALESCE(SUM(profit),0) profit,COALESCE(SUM(revenue),0) revenue,COALESCE(SUM(cost),0) cost,
        COUNT(*)::int count,COUNT(*) FILTER(WHERE profit>0)::int winning,COUNT(*) FILTER(WHERE profit<0)::int losing FROM settled
    ), bets AS (
      SELECT COALESCE(SUM(gross+fee),0) amount FROM accounting_orders WHERE side='BUY' AND status IN ('FILLED','PARTIAL')
    ), sales AS (
      SELECT COALESCE(SUM(delta),0) amount FROM paper_cash_ledger WHERE kind='SELL'
    ), pending AS (
      SELECT COALESCE(SUM(cost),0) cost,COUNT(DISTINCT condition)::int markets FROM paper_positions WHERE quantity>0
    ), pending_orders AS (
      SELECT COUNT(*)::int count FROM paper_orders o JOIN paper_positions p ON p.wallet=o.wallet AND p.token=o.token
      WHERE o.side='BUY' AND o.status IN ('FILLED','PARTIAL') AND p.quantity>0 AND COALESCE((o.details->>'positionCycle')::int,1)=p.cycle
    ) SELECT a.cash,a."initialCash",a."createdAt",a.fees,a.realized AS "totalProfit",CURRENT_TIMESTAMP AS "updatedAt",po.count AS "pendingBets",
      t.wins::text "settledWins",t.losses::text "settledLosses",t.profit::text "settledProfit",t.revenue::text "settlementRevenue",
      t.cost::text "settledCost",t.count "settledCount",t.winning "winningCount",t.losing "losingCount",
      b.amount::text wagered,s.amount::text "saleRevenue",(a.realized-t.profit)::text "saleProfit",p.cost::text "pendingCost",p.markets "pendingMarkets",
      COALESCE((SELECT jsonb_agg(row_to_json(h) ORDER BY h."createdAt") FROM (
        SELECT "createdAt",(SUM(profit) OVER(ORDER BY "createdAt"))::text "settledProfit" FROM (
          SELECT "createdAt",SUM(profit) profit FROM settled GROUP BY "createdAt"
        ) grouped ORDER BY "createdAt" DESC LIMIT 10000
      ) h),'[]'::jsonb) history,
      COALESCE((SELECT jsonb_agg(row_to_json(d) ORDER BY d.day DESC) FROM (
        SELECT to_char("createdAt" AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "day",
          COALESCE(SUM(profit) FILTER(WHERE profit>0),0)::text wins,COALESCE(-SUM(profit) FILTER(WHERE profit<0),0)::text losses,SUM(profit)::text profit
        FROM settled GROUP BY "day"
      ) d),'[]'::jsonb) days,
      COALESCE((SELECT jsonb_agg(row_to_json(l) ORDER BY l.profit::numeric DESC) FROM (
        SELECT wallet,name,COUNT(*)::int count,COALESCE(SUM(profit) FILTER(WHERE profit>0),0)::text wins,
          COALESCE(-SUM(profit) FILTER(WHERE profit<0),0)::text losses,SUM(profit)::text profit FROM settled GROUP BY wallet,name
      ) l WHERE l.wallet IS NOT NULL),'[]'::jsonb) leaders
      FROM paper_accounts a CROSS JOIN totals t CROSS JOIN bets b CROSS JOIN sales s CROSS JOIN pending p CROSS JOIN pending_orders po WHERE a.id='paper'`;
    db.query(sql, [], function (err, rows) {
      if (err) return callback(err);
      if (!rows[0]) return callback(new Error('Account not initialized'));
      const result = rows[0];
      result.mode = 'paper';
      result.currency = config.currency;
      result.history.unshift({ createdAt: result.createdAt, settledProfit: '0' });
      callback(null, result);
    });
  }
  function bets(filters, callback) {
    const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit || 20, 10) || 20));
    const offset = Math.max(0, Number.parseInt(filters.offset || 0, 10) || 0);
    const asOf = filters.asOf || null;
    const visibility = filters.snapshot || null;
    if (asOf && Number.isNaN(new Date(asOf).getTime())) return callback(new Error('Invalid bet page timestamp'));
    if (visibility && !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(visibility)) return callback(new Error('Invalid bet page snapshot'));
    // Orders are immutable. Freeze transaction visibility as well as time, excluding late commits from old pages.
    const sql = `WITH cutoff AS (SELECT COALESCE($1::timestamptz,CURRENT_TIMESTAMP) at,COALESCE($4::pg_snapshot,pg_current_snapshot()) visibility), selected AS MATERIALIZED (
      SELECT o.id,o."createdAt" FROM paper_orders o
      WHERE o.side='BUY' AND o.status IN ('FILLED','PARTIAL') AND o."createdAt"<=(SELECT at FROM cutoff)
        AND pg_visible_in_snapshot(o.xmin::text::xid8,(SELECT visibility FROM cutoff))
    ), page AS (
      SELECT o.* FROM (SELECT id,"createdAt" FROM selected ORDER BY "createdAt" DESC,id DESC LIMIT $2 OFFSET $3) b
      JOIN paper_orders o ON o.id=b.id
    ), enriched AS (
      SELECT o.id,o.wallet,o.token,o.condition,o."createdAt",o.quantity,(o.gross+o.fee)::text amount,
        o.gross::text gross,o.fee::text fee,o.details->'signal'->>'price' "sourcePrice",
        o.details->'signal'->>'timestamp' "sourceTimestamp",COALESCE(o.details->>'sourceAmount',o.details->'signal'->>'sourceAmount') "sourceAmount",
        (o.gross/NULLIF(o.quantity,0))::text "buyPrice",COALESCE(l.name,o.wallet) "traderName",
        COALESCE(NULLIF(o.details->'signal'->>'title',''),NULLIF(p.title,''),o.condition) title,
        COALESCE(m.raw->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o',o.details->'quote'->'metadata'->'raw'->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o') outcome,
        m.raw->'gamma' gamma,m.resolution->>'expected_settlement_time' "expectedSettlementAt",m.raw->'gamma'->>'endDate' "marketEndAt",s."createdAt" "settledAt",
        CASE WHEN s.id IS NOT NULL THEN 'settled'
          WHEN c.reason='SELL' OR p.cycle<>COALESCE((o.details->>'positionCycle')::int,1) OR p.quantity=0 THEN 'sold'
          ELSE 'pending' END status
      FROM page o LEFT JOIN paper_leaders l ON l.id=o.wallet LEFT JOIN paper_positions p ON p.wallet=o.wallet AND p.token=o.token
      LEFT JOIN paper_markets m ON m.id=o.condition
      LEFT JOIN paper_settlements s ON s.id=o.wallet||':'||o.token||':'||COALESCE(o.details->>'positionCycle','1')
      LEFT JOIN paper_closed_cycles c ON c.id=o.wallet||':'||o.token||':'||COALESCE(o.details->>'positionCycle','1')
    ) SELECT (SELECT visibility::text FROM cutoff) snapshot,(SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM cutoff) "asOf",(SELECT COUNT(*)::int FROM selected) total,
      COALESCE((SELECT jsonb_agg(row_to_json(b) ORDER BY b."createdAt" DESC,b.id DESC) FROM enriched b),'[]'::jsonb) data`;
    db.query(sql, [asOf, limit, offset, visibility], function (err, rows) {
      if (err) return callback(err);
      rows[0].data.forEach(function (row) { Object.assign(row, describe(row.gamma));delete row.gamma;tradeView.enrich(row); });
      callback(null, { ...rows[0], limit, offset });
    });
  }
  function overview(callback) {
    let account, positions;
    async.waterfall([
      function (next) { db.one('Account', { where: { id: 'paper' } }, next); },
      function (row, next) { account = row; if (!account) return next(new Error('Account not initialized')); db.query('SELECT * FROM paper_positions WHERE quantity>0 ORDER BY "createdAt" DESC', [], next); },
      function (rows, next) {
        positions = rows;
        db.query('SELECT COUNT(*)::int AS closed,COUNT(*) FILTER(WHERE profit>0)::int AS wins,COUNT(*) FILTER(WHERE profit=0)::int AS even FROM paper_closed_cycles', [], next);
      },
      function (cycles, next) {
        let value = D(0), cost = D(0), stale = false;
        const leaders = {};
        positions.forEach(function (p) {
          const mark = p.mark === null ? D(p.cost).div(p.quantity) : D(p.mark);
          const holding = D(p.quantity).mul(mark);
          value = value.plus(holding); cost = cost.plus(p.cost);
          if (!p.markedAt || Date.now() - new Date(p.markedAt).getTime() > config.bookMaxAgeMs) stale = true;
          const prior = leaders[p.wallet] || { value: '0', cost: '0', unrealized: '0' };
          leaders[p.wallet] = { value: str(D(prior.value).plus(holding)), cost: str(D(prior.cost).plus(p.cost)), unrealized: str(D(prior.unrealized).plus(holding).minus(p.cost)) };
        });
        const equity = D(account.cash).plus(value);
        next(null, { mode: 'paper', cash: account.cash, frozen: '0', initialCash: account.initialCash, realized: account.realized, fees: account.fees, positionCost: str(cost), positionValue: str(value), unrealized: str(value.minus(cost)), equity: str(equity), profit: str(equity.minus(account.initialCash)), returnPercent: str(equity.minus(account.initialCash).div(account.initialCash).mul(100)), stale, openPositions: positions.length, cycles: cycles[0], leaders });
      }
    ], callback);
  }
  function snapshot(callback) {
    // Account and position snapshot must observe one committed accounting state.
    db.transaction(function (tx, done) {
      tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) {
        if (err) return done(err);
        create(tx).overview(function (error, value) {
          if (error) return done(error);
          tx.insert('Snapshot', { id: crypto.randomUUID(), cash: value.cash, equity: value.equity, realized: value.realized, unrealized: value.unrealized, fees: value.fees, stale: value.stale, leaders: value.leaders }, done);
        });
      });
    }, callback);
  }
  const tables = { leaders: 'paper_leaders', copies: 'paper_orders', positions: 'paper_positions', settlements: 'paper_settlements', ledger: 'paper_cash_ledger', snapshots: 'paper_equity_snapshots', cycles: 'paper_closed_cycles', sources: 'paper_source_trades' };
  function list(kind, filters, callback) {
    if (!tables[kind]) return callback(new Error('Invalid collection'));
    const clauses = [], values = [];
    ['wallet', 'condition', 'status'].forEach(function (field) {
      if (!filters[field] || !(['copies', 'sources'].includes(kind) || field !== 'status' && ['positions', 'settlements', 'cycles'].includes(kind))) return;
      values.push(String(filters[field])); clauses.push('"' + field + '"=$' + values.length);
    });
    if (kind === 'positions' && filters.open === 'true') clauses.push('quantity>0');
    if (filters.from || filters.to) {
      for (const key of ['from', 'to']) {
        if (!filters[key]) continue;
        const date = new Date(filters[key]);
        if (Number.isNaN(date.getTime())) return callback(new Error('Invalid date filter'));
        values.push(date); clauses.push('"createdAt"' + (key === 'from' ? '>=' : '<=') + '$' + values.length);
      }
    }
    const limit = Math.min(500, Math.max(1, Number.parseInt(filters.limit || 100, 10) || 100));
    const offset = Math.max(0, Number.parseInt(filters.offset || 0, 10) || 0);
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const order = kind === 'leaders' ? 'active DESC,rank ASC' : '"createdAt" DESC,id ASC';
    let source = tables[kind];
    if (kind === 'copies') source = `(SELECT o.*,COALESCE(NULLIF(l.name,''),'人员名称暂未取得') "traderName",m.raw->'gamma' gamma,COALESCE(m.raw->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o',o.details->'quote'->'metadata'->'raw'->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o') outcome FROM paper_orders o LEFT JOIN paper_leaders l ON l.id=o.wallet LEFT JOIN paper_markets m ON m.id=o.condition) orders`;
    if (kind === 'positions') source = '(SELECT p.*,COALESCE(NULLIF(l.name,\'\'),\'人员名称暂未取得\') "traderName",m.raw->\'gamma\' gamma,m.raw->\'t\'->p."outcomeIndex"->>\'o\' outcome FROM paper_positions p LEFT JOIN paper_leaders l ON l.id=p.wallet LEFT JOIN paper_markets m ON m.id=p.condition) holdings';
    if (kind === 'settlements') source = '(SELECT s.*,COALESCE(NULLIF(l.name,\'\'),\'人员名称暂未取得\') "traderName",m.raw->\'gamma\' gamma,COALESCE(NULLIF(p.title,\'\'),\'市场名称暂未取得\') title,m.raw->\'t\'->p."outcomeIndex"->>\'o\' outcome FROM paper_settlements s LEFT JOIN paper_leaders l ON l.id=s.wallet LEFT JOIN paper_positions p ON p.wallet=s.wallet AND p.token=s.token LEFT JOIN paper_markets m ON m.id=s.condition) results';
    db.query('SELECT *,COUNT(*) OVER()::int AS "totalRows" FROM ' + source + where + ' ORDER BY ' + order + ' LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2), [...values, limit, offset], function (err, rows) {
      if (err) return callback(err);
      if (['copies', 'positions', 'settlements'].includes(kind)) rows.forEach(function (row) { Object.assign(row, describe(row.gamma)); delete row.gamma; });
      if(kind==='copies')rows.forEach(tradeView.enrich);
      callback(null, { data: rows, limit, offset, total: rows.length ? rows[0].totalRows : 0 });
    });
  }
  function detail(id, callback) {
    let order, fills, position, summary;
    async.waterfall([
      function (next) { db.one('Order', { where: { id } }, next); },
      function (row, next) { order = row; if (!order) return next(new Error('Order not found')); db.find('Fill', { where: { orderId: id }, order: { createdAt: 'ASC' } }, next); },
      function (rows, next) { fills = rows; db.one('Position', { where: { id: order.wallet + ':' + order.token } }, next); },
      function (row, next) {
        position = row;
        db.query(`SELECT COALESCE(NULLIF(l.name,''),'人员名称暂未取得') "traderName",
          COALESCE(NULLIF(o.details->'signal'->>'title',''),NULLIF(p.title,''),'市场名称暂未取得') title,
          COALESCE(m.raw->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o',o.details->'quote'->'metadata'->'raw'->'t'->(o.details->'signal'->>'outcomeIndex')::int->>'o','方向暂未取得') outcome,
          m.raw->'gamma' gamma,m.resolution->>'expected_settlement_time' "expectedSettlementAt",m.raw->'gamma'->>'endDate' "marketEndAt",c.reason "cycleReason"
          FROM paper_orders o LEFT JOIN paper_leaders l ON l.id=o.wallet LEFT JOIN paper_markets m ON m.id=o.condition
          LEFT JOIN paper_positions p ON p.wallet=o.wallet AND p.token=o.token
          LEFT JOIN paper_closed_cycles c ON c.id=o.wallet||':'||o.token||':'||COALESCE(o.details->>'positionCycle','1') WHERE o.id=$1`, [id], next);
      },
      function (rows, next) { summary = rows[0]; db.query('SELECT quantity,payout,revenue,cost,profit,"createdAt" FROM paper_settlements WHERE id=$1', [order.wallet + ':' + order.token + ':' + (order.details.positionCycle || 1)], next); },
      function (settlements, next) {
        const executed = ['FILLED', 'PARTIAL'].includes(order.status);
        const sameCycle = position && position.cycle === Number(order.details.positionCycle || 1);
        const lifecycle = order.status === 'WAITING' ? 'waiting' : !executed ? 'skipped' : order.side === 'SELL' ? 'sold' : settlements.length ? 'settled' : summary.cycleReason === 'SELL' || !sameCycle || D(position.quantity).isZero() ? 'sold' : 'pending';
        const signal = order.details.signal || {};
        const view = { ...summary, side: order.side, executionStatus: order.status, status: lifecycle, reason: order.reason,
          amount: str(order.side === 'BUY' ? D(order.gross).plus(order.fee) : D(order.gross).minus(order.fee)), fee: order.fee,
          quantity: order.quantity, averagePrice: D(order.quantity).gt(0) ? str(D(order.gross).div(order.quantity)) : null,
          sourceAmount: order.details.sourceAmount || str(signal.sourceAmount === undefined ? D(signal.size).mul(signal.price) : signal.sourceAmount), gross: order.gross,
          sourcePrice: signal.price || null, sourceTime: signal.timestamp ? new Date(Number(signal.timestamp) * 1000).toISOString() : null, createdAt: order.createdAt };
        delete view.cycleReason;
        Object.assign(view, describe(view.gamma)); delete view.gamma;
        next(null, { summary: view, fills: fills.map(function (fill) { return { price: fill.price, quantity: fill.quantity, fee: fill.fee }; }),
          holding: executed && sameCycle && D(position.quantity).gt(0) ? { quantity: position.quantity, cost: position.cost } : null,
          settlements: executed && order.side === 'BUY' ? settlements : [] });
      }
    ], callback);
  }
  function analytics(callback) {
    let snapshots;
    async.waterfall([
      function (next) { db.query('SELECT * FROM paper_equity_snapshots ORDER BY "createdAt" DESC LIMIT 10000', [], next); },
      function (rows, next) { snapshots = rows.reverse(); db.query('SELECT wallet,SUM(realized)::text AS realized,SUM(cost)::text AS cost,SUM(quantity*COALESCE(mark,CASE WHEN quantity>0 THEN cost/quantity ELSE 0 END)-cost)::text AS unrealized FROM paper_positions GROUP BY wallet ORDER BY SUM(realized) DESC', [], next); },
      function (leaders, next) {
        let peak = D(0), drawdown = D(0);
        const daily = {};
        snapshots.forEach(function (point) {
          if (D(point.equity).gt(peak)) peak = D(point.equity);
          const dd = peak.gt(0) ? peak.minus(point.equity).div(peak).mul(100) : D(0);
          if (dd.gt(drawdown)) drawdown = dd;
          const day = new Date(new Date(point.createdAt).getTime() + 8 * 3600000).toISOString().slice(0, 10);
          daily[day] = point;
        });
        let previous = null;
        const days = Object.entries(daily).map(function ([day, point]) { const value = { day, equity: point.equity, pnl: previous ? str(D(point.equity).minus(previous.equity)) : null, realizedChange: previous ? str(D(point.realized).minus(previous.realized)) : null }; previous = point; return value; });
        db.query('SELECT condition,SUM(realized)::text AS realized,SUM(cost)::text AS cost FROM paper_positions GROUP BY condition ORDER BY SUM(realized) DESC', [], function (err, markets) { next(err, { snapshots, leaders, markets, days, maxDrawdownPercent: str(drawdown), limitedToLastSnapshots: 10000 }); });
      }
    ], callback);
  }
  return { overview, cashSummary, bets, snapshot, list, detail, analytics };
}
module.exports = { create };

