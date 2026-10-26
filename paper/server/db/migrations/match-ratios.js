class MatchRatios1792800000000 {
  name = 'MatchRatios1792800000000';
  up(runner) {
    return runner.query(`CREATE TABLE IF NOT EXISTS paper_match_ratios (
      id text PRIMARY KEY,wallet text NOT NULL,"taskCreatedAt" timestamptz NOT NULL,"eventKey" text NOT NULL,
      "copyPercent" numeric(38,18) NOT NULL CHECK ("copyPercent">0),"firstOrderId" text NOT NULL,"lockedAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS paper_match_ratios_wallet ON paper_match_ratios(wallet);`);
  }
  down() { throw new Error('比赛已锁定比例，不可自动删除记录'); }
}
module.exports = MatchRatios1792800000000;
