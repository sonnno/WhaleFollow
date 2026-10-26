const async = require('async');
const crypto = require('node:crypto');
const { D, str } = require('./accounting-service');

// Lock first, then read context in a NEW statement. A snapshot taken before a
// competing transfer releases the account lock can contain old dedicated cash.
function read(tx, signal, callback) {
  let account;
  async.waterfall([
    function (next) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
    function (rows, next) {
      account = rows[0]; if (!account) return next(new Error('Paper account missing'));
      tx.query(`/* paper-copy-context */
        WITH retired AS (SELECT value FROM paper_settings WHERE id='task-deletion:'||$2),
        claimed AS (
          INSERT INTO paper_orders(id,"sourceId",wallet,token,condition,side,status,details)
          SELECT $1,$5,$2,$3,$4,$7,'WAITING','{}'::jsonb
          WHERE NOT EXISTS(SELECT 1 FROM retired WHERE (value->>'generation')::int >= $6)
          ON CONFLICT(id) DO UPDATE SET "updatedAt"=paper_orders."updatedAt"
          RETURNING *, (xmax=0) AS inserted
        )
        SELECT
          EXISTS(SELECT 1 FROM retired WHERE (value->>'generation')::int >= $6) AS "taskDeleted",
          (SELECT to_jsonb(c)||jsonb_build_object('quantity',c.quantity::text,'gross',c.gross::text,'fee',c.fee::text) FROM claimed c) AS claimed,
          (SELECT jsonb_build_object('delta',delta::text) FROM paper_cash_ledger WHERE id='trade:'||$1) AS "tradeLedger",
          (SELECT to_jsonb(p)||jsonb_build_object('quantity',p.quantity::text,'cost',p.cost::text,'realized',p.realized::text,'cycleRealized',p."cycleRealized"::text,'mark',p.mark::text) FROM paper_positions p WHERE id=$2||':'||$3) AS position,
          (SELECT jsonb_build_object('id',l.id,'name',l.name,'active',l.active,'joinedAt',l."joinedAt",'raw',jsonb_build_object('followGeneration',l.raw->'followGeneration')) FROM paper_leaders l WHERE id=$2) AS leader,
          (SELECT to_jsonb(t)||jsonb_build_object('cash',t.cash::text,'allocation',t.allocation::text,'fundedCapital',t."fundedCapital"::text,'realized',t.realized::text,'fees',t.fees::text,'copyPercent',t."copyPercent"::text,'maxOrderAmount',t."maxOrderAmount"::text) FROM paper_follow_tasks t WHERE id=$2) AS task,
          (SELECT value FROM paper_settings WHERE id='runtime') AS settings,
          (SELECT jsonb_build_object('status',j.status,'error',j.error) FROM paper_outbox j WHERE id=$1) AS job,
          (SELECT jsonb_build_object('raw',m.raw,'resolution',m.resolution) FROM paper_markets m WHERE id=$4) AS market,
          (SELECT COALESCE(SUM(gross+fee),0)::text FROM paper_orders WHERE "sourceId"=$5 AND side='BUY' AND status IN ('FILLED','PARTIAL')) AS spent,
          (SELECT COALESCE(SUM(quantity),0)::text FROM paper_orders WHERE "sourceId"=$5 AND side='SELL' AND status IN ('FILLED','PARTIAL')) AS "soldQuantity",
          (SELECT details->'saleBaseline' FROM paper_orders WHERE "sourceId"=$5 AND side='SELL' AND status IN ('FILLED','PARTIAL') AND details ? 'saleBaseline' ORDER BY "createdAt",id LIMIT 1) AS "saleBaseline",
          (SELECT COALESCE(SUM(cash),0)::text FROM paper_follow_tasks WHERE "fundingMode"='dedicated') AS "dedicatedCash",
          (SELECT COALESCE(SUM(cost),0)::text FROM paper_positions WHERE wallet=$2 AND quantity>0) AS "positionCost"`,
      [signal.id, signal.wallet, signal.token, signal.condition, signal.sourceId, Number(signal.followGeneration || 0), signal.side], next);
    }
  ], function (err, rows) {
    if (err) return callback(err);
    const context = rows[0];
    if (!context) return callback(new Error('Copy context missing'));
    const claimed = context.claimed;
    if (claimed && (claimed.wallet !== signal.wallet || claimed.token !== signal.token || claimed.side !== signal.side || claimed.sourceId !== signal.sourceId || claimed.condition !== signal.condition)) return callback(new Error('Order id belongs to a different trade'));
    callback(null, { ...context, account, sharedCash: str(D(account.cash).minus(context.dedicatedCash || 0)) });
  });
}

function commit(tx, account, task, position, order, fill, callback) {
  const delta = order.side === 'BUY' ? str(D(fill.cash).negated()) : fill.cash;
  const fills = fill.fills.map(function (part) { return { id: crypto.randomUUID(), ...part }; });
  const value = { account, task, position, order, fill, fills, delta, profit: order.details.realizedProfit || '0' };
  tx.query(`/* paper-copy-commit */
    WITH input AS (SELECT $1::jsonb AS v), stamp AS MATERIALIZED (SELECT clock_timestamp() AS at),
    account_change AS (
      UPDATE paper_accounts a SET cash=a.cash+(v->>'delta')::numeric,fees=a.fees+(v->'fill'->>'fee')::numeric,
        realized=a.realized+(v->>'profit')::numeric,"updatedAt"=stamp.at
      FROM input,stamp WHERE a.id='paper' AND a.cash+(v->>'delta')::numeric>=0 RETURNING a.cash
    ), task_change AS (
      UPDATE paper_follow_tasks t SET cash=t.cash+CASE WHEN t."fundingMode"='dedicated' THEN (v->>'delta')::numeric ELSE 0 END,
        fees=t.fees+(v->'fill'->>'fee')::numeric,realized=t.realized+(v->>'profit')::numeric,"updatedAt"=stamp.at
      FROM input,stamp,account_change WHERE t.id=v->'task'->>'id' RETURNING t.id
    ), position_change AS (
      INSERT INTO paper_positions(id,wallet,token,condition,title,"outcomeIndex",quantity,cost,realized,"cycleRealized",cycle,"fundingMode","openedAt","updatedAt")
      SELECT p->>'id',p->>'wallet',p->>'token',p->>'condition',COALESCE(p->>'title',''),(p->>'outcomeIndex')::int,
        (p->>'quantity')::numeric,(p->>'cost')::numeric,(p->>'realized')::numeric,(p->>'cycleRealized')::numeric,
        (p->>'cycle')::int,COALESCE(p->>'fundingMode','shared'),(p->>'openedAt')::timestamptz,stamp.at
      FROM input,stamp,account_change,LATERAL (SELECT v->'position' AS p) value WHERE true
      ON CONFLICT(id) DO UPDATE SET quantity=EXCLUDED.quantity,cost=EXCLUDED.cost,realized=EXCLUDED.realized,
        "cycleRealized"=EXCLUDED."cycleRealized",cycle=EXCLUDED.cycle,"outcomeIndex"=EXCLUDED."outcomeIndex",
        "fundingMode"=EXCLUDED."fundingMode",title=EXCLUDED.title,"openedAt"=EXCLUDED."openedAt","updatedAt"=EXCLUDED."updatedAt" RETURNING id
    ), order_change AS (
      UPDATE paper_orders o SET status=v->'order'->>'status',reason=COALESCE(v->'order'->>'reason',''),
        quantity=(v->'order'->>'quantity')::numeric,gross=(v->'order'->>'gross')::numeric,fee=(v->'order'->>'fee')::numeric,
        details=v->'order'->'details',"createdAt"=stamp.at,"updatedAt"=stamp.at
      FROM input,stamp,account_change WHERE o.id=v->'order'->>'id' RETURNING o."createdAt"
    ), fill_change AS (
      INSERT INTO paper_fills(id,"orderId",wallet,token,side,quantity,price,fee,"createdAt")
      SELECT f->>'id',v->'order'->>'id',v->'order'->>'wallet',v->'order'->>'token',v->'order'->>'side',
        (f->>'quantity')::numeric,(f->>'price')::numeric,(f->>'fee')::numeric,stamp.at
      FROM input,stamp,account_change,LATERAL jsonb_array_elements(v->'fills') f RETURNING id
    ), ledger_change AS (
      INSERT INTO paper_cash_ledger(id,reference,kind,delta,balance,details,"createdAt")
      SELECT 'trade:'||(v->'order'->>'id'),v->'order'->>'id',v->'order'->>'side',(v->>'delta')::numeric,account_change.cash,
        jsonb_build_object('gross',v->'fill'->>'gross','fee',v->'fill'->>'fee'),stamp.at
      FROM input,stamp,account_change RETURNING id
    ), cycle_change AS (
      INSERT INTO paper_closed_cycles(id,wallet,token,profit,reason,"createdAt")
      SELECT (v->'position'->>'id')||':'||(v->'position'->>'cycle'),v->'order'->>'wallet',v->'order'->>'token',
        (v->'position'->>'cycleRealized')::numeric,'SELL',stamp.at
      FROM input,stamp,account_change WHERE (v->'position'->>'quantity')::numeric=0 RETURNING id
    ) SELECT (SELECT count(*)::int FROM account_change) AS "accountCount",(SELECT count(*)::int FROM order_change) AS "orderCount",
      (SELECT count(*)::int FROM task_change) AS "taskCount",(SELECT count(*)::int FROM position_change) AS "positionCount",
      (SELECT count(*)::int FROM fill_change) AS "fillCount",(SELECT count(*)::int FROM ledger_change) AS "ledgerCount",
      (SELECT "createdAt" FROM order_change) AS at`, [JSON.stringify(value)], function (err, rows) {
    if (err) return callback(err);
    const result = rows[0];
    if (!result || result.accountCount !== 1 || result.orderCount !== 1 || result.positionCount !== 1 || result.ledgerCount !== 1 || result.fillCount !== fills.length || task && result.taskCount !== 1) return callback(new Error('Atomic copy persistence failed'));
    order.createdAt = result.at;
    callback(null, order);
  });
}
module.exports = { read, commit };
