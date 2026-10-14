class DailyTaskReports1792400000000{
 name='DailyTaskReports1792400000000';
 up(runner){return runner.query(`ALTER TABLE paper_daily_reports ADD COLUMN IF NOT EXISTS "totalProfitEnd" numeric(38,18) NOT NULL DEFAULT 0;
 ALTER TABLE paper_daily_reports ADD COLUMN IF NOT EXISTS "breakdownVersion" integer NOT NULL DEFAULT 0;
 CREATE TABLE IF NOT EXISTS paper_daily_task_reports (
 id text PRIMARY KEY,day date NOT NULL,wallet text NOT NULL,"traderName" text NOT NULL,"taskCreatedAt" timestamptz NOT NULL,
 "buyCount" integer NOT NULL DEFAULT 0,"saleCount" integer NOT NULL DEFAULT 0,"settlementCount" integer NOT NULL DEFAULT 0,
 "buyAmount" numeric(38,18) NOT NULL DEFAULT 0,fees numeric(38,18) NOT NULL DEFAULT 0,
 "saleProfit" numeric(38,18) NOT NULL DEFAULT 0,"settlementProfit" numeric(38,18) NOT NULL DEFAULT 0,
 "netProfit" numeric(38,18) NOT NULL DEFAULT 0,"totalProfitEnd" numeric(38,18) NOT NULL DEFAULT 0,
 "leaderStatus" text NOT NULL DEFAULT 'pending',"leaderTradeProfit" numeric(38,18),"leaderIncome" numeric(38,18),
 "leaderNetProfit" numeric(38,18),"leaderTotalProfit" numeric(38,18),"leaderEvidence" jsonb NOT NULL DEFAULT '{}',
 "leaderError" text NOT NULL DEFAULT '',"leaderFetchedAt" timestamptz,"leaderRetryAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(day,wallet,"taskCreatedAt"));
 CREATE INDEX IF NOT EXISTS paper_daily_task_day_wallet ON paper_daily_task_reports(day DESC,wallet);`);}
 down(){throw new Error('日表为历史记录，不能自动删除');}
}
module.exports=DailyTaskReports1792400000000;
