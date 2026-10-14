class ManualTransfers1792300000000 {
  name = 'ManualTransfers1792300000000';
  up(runner) {
    return runner.query(`CREATE TABLE IF NOT EXISTS paper_follow_fund_transfers (
      id text PRIMARY KEY,wallet text NOT NULL,direction text NOT NULL,amount numeric(38,18) NOT NULL DEFAULT 0,
      "cashBefore" numeric(38,18) NOT NULL DEFAULT 0,"cashAfter" numeric(38,18) NOT NULL DEFAULT 0,
      "publicCashBefore" numeric(38,18) NOT NULL DEFAULT 0,"publicCashAfter" numeric(38,18) NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='paper_transfer_valid_values') THEN
        ALTER TABLE paper_follow_fund_transfers ADD CONSTRAINT paper_transfer_valid_values CHECK (
          direction IN ('in','out') AND amount>0 AND "cashBefore">=0 AND "cashAfter">=0 AND "publicCashBefore">=0 AND "publicCashAfter">=0
          AND "cashAfter"-"cashBefore"=CASE WHEN direction='in' THEN amount ELSE -amount END
          AND "publicCashAfter"-"publicCashBefore"=CASE WHEN direction='in' THEN -amount ELSE amount END);
      END IF; END $$;
      CREATE INDEX IF NOT EXISTS paper_transfer_wallet_time ON paper_follow_fund_transfers(wallet,"createdAt" DESC,id DESC);`);
  }
  down() { throw new Error('独立账户划转流水需要保留，不能自动删除。'); }
}
module.exports = ManualTransfers1792300000000;
