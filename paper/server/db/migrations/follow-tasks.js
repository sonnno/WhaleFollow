class FollowTasks1792200000000 {
  name = 'FollowTasks1792200000000';
  up(runner) {
    return runner.query(`CREATE TABLE IF NOT EXISTS paper_follow_tasks (
      id text PRIMARY KEY,state text NOT NULL DEFAULT 'paused',allocation numeric(38,18) NOT NULL DEFAULT 0,
      cash numeric(38,18) NOT NULL DEFAULT 0,realized numeric(38,18) NOT NULL DEFAULT 0,fees numeric(38,18) NOT NULL DEFAULT 0,
      "copyPercent" numeric(38,18) NOT NULL DEFAULT 100,"maxOrderAmount" numeric(38,18) DEFAULT NULL,
      generation integer NOT NULL DEFAULT 0,"startedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
      ALTER TABLE paper_follow_tasks ADD COLUMN IF NOT EXISTS "fundingMode" text NOT NULL DEFAULT 'shared';
      ALTER TABLE paper_follow_tasks ADD COLUMN IF NOT EXISTS "fundedCapital" numeric(38,18) NOT NULL DEFAULT 0;
      ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS "fundingMode" text NOT NULL DEFAULT 'shared';
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='paper_task_valid_values') THEN
        ALTER TABLE paper_follow_tasks ADD CONSTRAINT paper_task_valid_values CHECK (
          state IN ('running','paused','stopped') AND allocation>=0 AND cash>=0 AND fees>=0 AND "copyPercent">0
          AND ("maxOrderAmount" IS NULL OR "maxOrderAmount">0) AND generation>=0
          AND "fundingMode" IN ('shared','dedicated') AND "fundedCapital">=0);
      END IF; END $$;
      CREATE INDEX IF NOT EXISTS paper_task_state ON paper_follow_tasks(state);`);
  }
  down() { throw new Error('跟单子账户持有资金与历史，不能自动删除；请先核对并归还资金。'); }
}
module.exports = FollowTasks1792200000000;
