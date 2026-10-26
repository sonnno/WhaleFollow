class BackgroundIndexes1792700000000 {
  name = 'BackgroundIndexes1792700000000';
  transaction = false;
  up(runner) {
    return runner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS paper_positions_token_open ON paper_positions(token) WHERE quantity>0');
  }
  down(runner) { return runner.query('DROP INDEX CONCURRENTLY IF EXISTS paper_positions_token_open'); }
}
module.exports = BackgroundIndexes1792700000000;
