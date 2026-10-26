class ShortSports1792489000000 {
  name = 'ShortSports1792489000000';
  up(runner) {
    return runner.query(`ALTER TABLE paper_follow_tasks ADD COLUMN IF NOT EXISTS "realisticExecution" boolean NOT NULL DEFAULT false;
      ALTER TABLE paper_follow_tasks ADD COLUMN IF NOT EXISTS "shortSportsHours" integer DEFAULT NULL CHECK("shortSportsHours" IS NULL OR "shortSportsHours" BETWEEN 1 AND 720);
      ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS "openedAt" timestamptz;
      CREATE TABLE IF NOT EXISTS paper_copy_skip_stats(id text PRIMARY KEY,wallet text NOT NULL,"taskCreatedAt" timestamptz NOT NULL,reason text NOT NULL,
        count bigint NOT NULL CHECK(count>=0),"lastAt" timestamptz NOT NULL,sample jsonb NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS paper_copy_skip_wallet ON paper_copy_skip_stats(wallet,"taskCreatedAt");`);
  }
  down() { throw new Error('Simulation policy and skip history must be retained'); }
}
module.exports = ShortSports1792489000000;
