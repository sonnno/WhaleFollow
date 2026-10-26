class DashboardIndexes1792600000000 {
  name = 'DashboardIndexes1792600000000';
  transaction = false;
  up(runner) {
    return runner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS paper_orders_pending_cycle
      ON paper_orders(wallet,token,(COALESCE((details->>'positionCycle')::int,1)))
      WHERE side='BUY' AND status IN ('FILLED','PARTIAL')`);
  }
  down(runner) { return runner.query('DROP INDEX CONCURRENTLY IF EXISTS paper_orders_pending_cycle'); }
}
module.exports = DashboardIndexes1792600000000;
