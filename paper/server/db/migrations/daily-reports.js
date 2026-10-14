class DailyReports1790812800000 {
  name = 'DailyReports1790812800000';
  up(runner) {
    const money = ['buyAmount', 'fees', 'saleProfit', 'settlementProfit', 'netProfit', 'cashEnd', 'positionCostEnd'].map(function (key) { return '"' + key + '" numeric(38,18) NOT NULL DEFAULT 0'; });
    return runner.query(`CREATE TABLE paper_daily_reports (
      id text PRIMARY KEY,day date NOT NULL UNIQUE,timezone text NOT NULL DEFAULT 'Asia/Shanghai',currency text NOT NULL DEFAULT 'USDT',
      "periodStart" timestamptz NOT NULL,"periodEnd" timestamptz NOT NULL,
      "buyCount" integer NOT NULL DEFAULT 0,"saleCount" integer NOT NULL DEFAULT 0,"settlementCount" integer NOT NULL DEFAULT 0,
      ${money.join(',')},"createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  down(runner) { return runner.query('DROP TABLE paper_daily_reports'); }
}
module.exports = DailyReports1790812800000;
