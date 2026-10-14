const async = require('async');
const { D, str } = require('./accounting-service');
const { orderHistorySql, settlementHistorySql } = require('./accounting-history-service');
const timezone = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function localParts(now) { const result = {}; formatter.formatToParts(new Date(now)).forEach(function (p) { result[p.type] = p.value; }); return result; }
function calendarDay(now) { const p = localParts(now); return p.year + '-' + p.month + '-' + p.day; }
function eligibleDay(now) {
  const day = new Date(calendarDay(now) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - (Number(localParts(now).hour) >= 10 ? 1 : 2));
  return day.toISOString().slice(0, 10);
}
function validDay(day) { return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(new Date(day + 'T00:00:00Z').getTime()) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day; }

function create(db, dependencies) {
  const currency = dependencies && dependencies.currency || 'USDT';
  const taskReports=require('./daily-task-report-service');
  const enrichment=taskReports.create(db,{upstream:dependencies&&dependencies.upstream});
  function readNow(connection, callback) {
    if (dependencies && dependencies.clock) return dependencies.clock(callback);
    connection.query('SELECT clock_timestamp() AS at', [], function (err, rows) { callback(err, rows && rows[0].at); });
  }
  function writeDay(day, callback) {
    if (!validDay(day)) return callback(new Error('Invalid report day'));
    db.transaction(function (tx, done) {
      let account,existingReport;
      async.waterfall([
        function (next) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (rows, next) { account = rows[0]; if (!account) return next(new Error('Account not initialized')); readNow(tx, next); },
        function (now, next) {
          if (day < calendarDay(account.createdAt) || day > eligibleDay(now)) return next(new Error('Report day is outside completed reporting period'));
          tx.one('DailyReport', { where: { id: day } }, next);
        },
        function (existing, next) {
          if (existing && existing.breakdownVersion>=1) return done(null, { duplicate: true, report: existing });
          existingReport=existing;
          tx.query(`WITH accounting_orders AS (${orderHistorySql}),accounting_settlements AS (${settlementHistorySql}),bounds AS (
            SELECT $1::date::timestamp AT TIME ZONE $2 AS start,($1::date+1)::timestamp AT TIME ZONE $2 AS finish
          ), buys AS (
            SELECT COUNT(*)::int count,COALESCE(SUM(gross+fee),0) amount FROM accounting_orders,bounds
            WHERE side='BUY' AND status IN ('FILLED','PARTIAL') AND "createdAt">=start AND "createdAt"<finish
          ), sales AS (
            SELECT COUNT(*)::int count,COALESCE(SUM((details->>'realizedProfit')::numeric),0) profit FROM accounting_orders,bounds
            WHERE side='SELL' AND status IN ('FILLED','PARTIAL') AND "createdAt">=start AND "createdAt"<finish
          ), settled AS (
            SELECT COUNT(*)::int count,COALESCE(SUM(profit),0) profit FROM accounting_settlements,bounds WHERE "createdAt">=start AND "createdAt"<finish
          ) SELECT start AS "periodStart",finish AS "periodEnd",b.count "buyCount",b.amount::text "buyAmount",
            s.count "saleCount",s.profit::text "saleProfit",r.count "settlementCount",r.profit::text "settlementProfit",(s.profit+r.profit)::text "netProfit",
            (SELECT COALESCE(SUM(fee),0)::text FROM accounting_orders WHERE status IN ('FILLED','PARTIAL') AND "createdAt">=start AND "createdAt"<finish) fees,
            (SELECT COALESCE(SUM(delta),0)::text FROM paper_cash_ledger WHERE "createdAt"<finish) "cashEnd",
            ((SELECT COALESCE(SUM(gross+fee),0) FROM accounting_orders WHERE side='BUY' AND status IN ('FILLED','PARTIAL') AND "createdAt"<finish)
             -(SELECT COALESCE(SUM((details->>'releasedCost')::numeric),0) FROM accounting_orders WHERE side='SELL' AND status IN ('FILLED','PARTIAL') AND "createdAt"<finish)
             -(SELECT COALESCE(SUM(cost),0) FROM accounting_settlements WHERE "createdAt"<finish))::text "positionCostEnd",
            (SELECT COUNT(*)::int FROM accounting_orders WHERE side='SELL' AND status IN ('FILLED','PARTIAL') AND "createdAt"<finish
             AND (details->>'realizedProfit' IS NULL OR details->>'releasedCost' IS NULL)) "missingSaleAccounting",
            ((SELECT COALESCE(SUM((details->>'realizedProfit')::numeric),0) FROM accounting_orders WHERE side='SELL' AND status IN ('FILLED','PARTIAL') AND "createdAt"<finish)
             +(SELECT COALESCE(SUM(profit),0) FROM accounting_settlements WHERE "createdAt"<finish))::text "totalProfitEnd"
            FROM bounds CROSS JOIN buys b CROSS JOIN sales s CROSS JOIN settled r`, [day, timezone], next);
        },
        function (rows, next) {
          const report = rows[0];
          if (report.missingSaleAccounting) return next(new Error('Missing realized SELL accounting; daily report was not written'));
          delete report.missingSaleAccounting;
          // All amounts are realized ledger values; never use mark-to-market snapshots here.
          ['buyAmount', 'fees', 'saleProfit', 'settlementProfit', 'netProfit', 'cashEnd', 'positionCostEnd','totalProfitEnd'].forEach(function (key) { report[key] = str(report[key]); });
          if (D(report.positionCostEnd).lt('-0.000000000001')) return next(new Error('Daily position cost does not balance'));
          const value={...existingReport,id:day,day,timezone,currency,...report,breakdownVersion:1};
          tx.save('DailyReport',value,function(err){if(err)return next(err);taskReports.write(tx,day,function(error){next(error,{duplicate:false,report:value});});});
        }
      ], done);
    }, callback);
  }
  function runDue(callback) {
    let first, last, written = 0;
    async.waterfall([
      function (next) { db.one('Account', { where: { id: 'paper' } }, next); },
      function (account, next) { if (!account) return next(new Error('Account not initialized')); first = calendarDay(account.createdAt); readNow(db, next); },
      function (now, next) {
        last = eligibleDay(now);
        db.query(`SELECT ($1::date+n)::text AS day FROM generate_series(0,$2::date-$1::date) n
          WHERE NOT EXISTS (SELECT 1 FROM paper_daily_reports WHERE id=($1::date+n)::text AND "breakdownVersion">=1) ORDER BY n`, [first, last], next);
      },
      function (days, next) { async.eachSeries(days, function (row, saved) { writeDay(row.day, function (err, result) { if (!err && !result.duplicate) written++; saved(err); }); }, next); },
      function(next){enrichment.enrichDue(function(err,result){next(err);});}
    ], function (err) { callback(err, { checked: err ? 0 : 1, written, eligibleThrough: last, timezone, closeTime: '10:00' }); });
  }
  function list(filters, callback) {
    readList('paper_daily_reports',filters,false,callback);
  }
  function listTasks(filters,callback){readList('paper_daily_task_reports',filters,true,callback);}
  function readList(table,filters,task,callback){
    const params=[],clauses=[];let limit,offset;
    try{
      ['from','to'].forEach(function(key){if(filters[key]&&!validDay(filters[key]))throw Object.assign(new Error('请输入有效日期'),{status:400});});
      if(filters.from&&filters.to&&filters.from>filters.to)throw Object.assign(new Error('开始日期不能晚于结束日期'),{status:400});
      if(filters.wallet&&!/^0x[a-fA-F0-9]{40}$/.test(filters.wallet))throw Object.assign(new Error('请选择有效跟单人'),{status:400});
      limit=Math.min(100,Math.max(1,Number.parseInt(filters.limit||20,10)||20));offset=Math.max(0,Number.parseInt(filters.offset||0,10)||0);
      ['from','to'].forEach(function(key){if(filters[key]){params.push(filters[key]);clauses.push('day'+(key==='from'?'>=':'<=')+'$'+params.length+'::date');}});
      if(task&&filters.wallet){params.push(filters.wallet.toLowerCase());clauses.push('wallet=$'+params.length);}
    }catch(err){return callback(err);}
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'',order=task?'day DESC,"traderName",id':'day DESC';
    params.push(limit,offset);
    db.query(`WITH selected AS (SELECT * FROM ${table}${where}) SELECT (SELECT COUNT(*)::int FROM selected) total,
      COALESCE((SELECT jsonb_agg(row_to_json(r)) FROM (SELECT * FROM selected ORDER BY ${order} LIMIT $${params.length-1} OFFSET $${params.length}) r),'[]'::jsonb) data`,params,function(err,rows){callback(err,rows&&{...rows[0],limit,offset,timezone,closeTime:'10:00'});});
  }
  function traders(callback){db.query(`SELECT DISTINCT ON (wallet) wallet,"traderName" name FROM (
    SELECT wallet,"traderName",day::timestamp at FROM paper_daily_task_reports UNION ALL SELECT id,name,clock_timestamp() FROM paper_leaders
    ) names ORDER BY wallet,at DESC`,[],function(err,rows){callback(err,{data:rows});});}
  return { writeDay, runDue, list,listTasks,traders,enrichDue:enrichment.enrichDue };
}
module.exports = { create, eligibleDay, calendarDay };

