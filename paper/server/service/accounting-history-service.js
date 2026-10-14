// Deleted task details are gone; anonymous wallet-level cash facts keep totals correct.
const orderHistorySql = `SELECT side,gross,fee,details,"createdAt",status FROM paper_orders
  UNION ALL SELECT kind,(details->>'gross')::numeric,(details->>'fee')::numeric,details,"createdAt",'FILLED'::text
  FROM paper_cash_ledger WHERE kind IN ('BUY','SELL') AND details->>'recordsDeleted'='true'`;
const settlementHistorySql = `SELECT wallet,token,condition,profit,revenue,cost,"createdAt" FROM paper_settlements
  UNION ALL SELECT NULL::text,NULL::text,NULL::text,(details->>'profit')::numeric,delta,(details->>'cost')::numeric,"createdAt"
  FROM paper_cash_ledger WHERE kind='SETTLEMENT' AND details->>'recordsDeleted'='true'`;
module.exports = { orderHistorySql, settlementHistorySql };

