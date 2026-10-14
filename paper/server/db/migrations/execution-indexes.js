class ExecutionIndexes1792500000000 {
  name = 'ExecutionIndexes1792500000000';
  up(runner) {
    return runner.query(`CREATE INDEX IF NOT EXISTS paper_orders_source_execution ON paper_orders("sourceId",side,status) INCLUDE(quantity,gross,fee);
      CREATE INDEX IF NOT EXISTS paper_positions_wallet_open ON paper_positions(wallet) INCLUDE(cost) WHERE quantity>0;
      CREATE INDEX IF NOT EXISTS paper_outbox_asset_pending ON paper_outbox((payload->>'wallet'),(payload->>'token'),"createdAt",id)
        WHERE status='pending' AND kind IN ('copy','source-confirmation');`);
  }
  down(runner) { return runner.query('DROP INDEX IF EXISTS paper_outbox_asset_pending; DROP INDEX IF EXISTS paper_positions_wallet_open; DROP INDEX IF EXISTS paper_orders_source_execution'); }
}
module.exports = ExecutionIndexes1792500000000;
