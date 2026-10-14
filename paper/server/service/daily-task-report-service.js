const async=require('async');
const {str}=require('./accounting-service');
const timezone='Asia/Shanghai';
function write(tx,day,callback){
 const sql=`WITH bounds AS (SELECT $1::date::timestamp AT TIME ZONE $2 start,($1::date+1)::timestamp AT TIME ZONE $2 finish),
 roster AS (SELECT t.id wallet,COALESCE(NULLIF(l.name,''),t.id) "traderName",t."createdAt" "taskCreatedAt" FROM paper_follow_tasks t LEFT JOIN paper_leaders l ON l.id=t.id
 UNION ALL SELECT l.id,COALESCE(NULLIF(l.name,''),l.id),l."joinedAt" FROM paper_leaders l WHERE NOT EXISTS(SELECT 1 FROM paper_follow_tasks t WHERE t.id=l.id)),
 orders AS (SELECT wallet,COUNT(*) FILTER(WHERE side='BUY' AND "createdAt">=start)::int "buyCount",
 COUNT(*) FILTER(WHERE side='SELL' AND "createdAt">=start)::int "saleCount",
 COALESCE(SUM(gross+fee) FILTER(WHERE side='BUY' AND "createdAt">=start),0) "buyAmount",
 COALESCE(SUM(fee) FILTER(WHERE "createdAt">=start),0) fees,
 COALESCE(SUM((details->>'realizedProfit')::numeric) FILTER(WHERE side='SELL' AND "createdAt">=start),0) "saleProfit",
 COALESCE(SUM((details->>'realizedProfit')::numeric) FILTER(WHERE side='SELL'),0) total
 FROM paper_orders,bounds WHERE status IN ('FILLED','PARTIAL') AND "createdAt"<finish GROUP BY wallet),
 settlements AS (SELECT wallet,COUNT(*) FILTER(WHERE "createdAt">=start)::int "settlementCount",
 COALESCE(SUM(profit) FILTER(WHERE "createdAt">=start),0) "settlementProfit",COALESCE(SUM(profit),0) total
 FROM paper_settlements,bounds WHERE "createdAt"<finish GROUP BY wallet)
 SELECT $1::text||':'||r.wallet||':'||md5(r."taskCreatedAt"::text) id,$1::text AS day,r.wallet,r."traderName",r."taskCreatedAt",
 COALESCE(o."buyCount",0) "buyCount",COALESCE(o."saleCount",0) "saleCount",COALESCE(s."settlementCount",0) "settlementCount",
 COALESCE(o."buyAmount",0)::text "buyAmount",COALESCE(o.fees,0)::text fees,COALESCE(o."saleProfit",0)::text "saleProfit",
 COALESCE(s."settlementProfit",0)::text "settlementProfit",(COALESCE(o."saleProfit",0)+COALESCE(s."settlementProfit",0))::text "netProfit",
 (COALESCE(o.total,0)+COALESCE(s.total,0))::text "totalProfitEnd"
 FROM roster r CROSS JOIN bounds LEFT JOIN orders o ON o.wallet=r.wallet LEFT JOIN settlements s ON s.wallet=r.wallet
 WHERE r."taskCreatedAt"<finish OR o.wallet IS NOT NULL OR s.wallet IS NOT NULL`;
 async.waterfall([
  function(next){tx.query(sql,[day,timezone],next);},
  function(rows,next){async.eachSeries(rows,function(row,saved){['buyAmount','fees','saleProfit','settlementProfit','netProfit','totalProfitEnd'].forEach(function(key){row[key]=str(row[key]);});tx.query('SELECT id FROM paper_daily_task_reports WHERE id=$1',[row.id],function(err,existing){if(err)return saved(err);if(existing.length)return saved();tx.insert('DailyTaskReport',row,function(error){saved(error);});});},next);}
 ],callback);
}
function create(db,options){
 options=options||{};const upstream=options.upstream||require('./leader-daily-pnl-service').create();
 function enrichDue(callback){
  let completed=0,failed=0;
  async.waterfall([
   function(next){db.query(`SELECT id,day::text AS day,wallet FROM paper_daily_task_reports WHERE "leaderStatus"='pending' AND "leaderRetryAt"<=clock_timestamp() ORDER BY day DESC,wallet LIMIT 5`,[],next);},
   function(rows,next){async.eachSeries(rows,function(row,saved){upstream.fetch(row.wallet,row.day,function(err,result){
    if(err){failed++;const delay=/边界|不可用|钱包/.test(err.message)?21600:300;return db.query(`UPDATE paper_daily_task_reports SET "leaderError"=$2,"leaderRetryAt"=clock_timestamp()+$3*INTERVAL '1 second',"updatedAt"=clock_timestamp() WHERE id=$1 AND "leaderStatus"='pending'`,[row.id,String(err.message).slice(0,500),delay],function(error){saved(error);});}
    db.query(`UPDATE paper_daily_task_reports SET "leaderStatus"=$2,"leaderTradeProfit"=$3,"leaderIncome"=$4,"leaderNetProfit"=$5,"leaderTotalProfit"=$6,"leaderEvidence"=$7,"leaderFetchedAt"=$8,"leaderError"='',"updatedAt"=clock_timestamp() WHERE id=$1 AND "leaderStatus"='pending'`,[row.id,result.leaderStatus,result.leaderTradeProfit,result.leaderIncome,result.leaderNetProfit,result.leaderTotalProfit,result.leaderEvidence,result.leaderFetchedAt],function(error,updated){if(!error)completed++;saved(error);});
   });},next);}
  ],function(err){callback(err,{completed,failed});});
 }
 return{enrichDue};
}
module.exports={write,create};
