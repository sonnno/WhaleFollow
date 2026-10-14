const test=require('node:test'),assert=require('node:assert/strict');
const wallet='0x'+'a'.repeat(40),start=Date.parse('2026-10-11T16:00:00Z')/1000,end=start+86400;
function body(){return{data:{proxy_wallet:wallet,source_fidelity:'1d',points:[{timestamp:start,source_block:100,realized_pnl:20,wallet_income:5,settled_pnl:25,fees:-7},{timestamp:end,source_block:200,realized_pnl:17,wallet_income:8,settled_pnl:25,fees:-10}]}};}
test('official daily report separates realized trades/income, never subtracts fees twice',function(){
 const service=require('../server/service/leader-daily-pnl-service');const result=service.extract(body(),wallet,'2026-10-12');
 assert.equal(result.leaderTradeProfit,'-3');assert.equal(result.leaderIncome,'3');assert.equal(result.leaderNetProfit,'0');assert.equal(result.leaderTotalProfit,'25');assert.equal(result.leaderStatus,'sampled');assert.equal(result.leaderEvidence.sourceFidelity,'1d');assert.equal(result.leaderEvidence.start.timestamp,start);
});
test('missing boundary or null official profit is unavailable instead of invented zero',function(){
 const service=require('../server/service/leader-daily-pnl-service'),v=body();v.data.points[1].settled_pnl=null;
 assert.throws(()=>service.extract(v,wallet,'2026-10-12'),/不可用/);
 v.data.points[1].timestamp-=3600;assert.throws(()=>service.extract(v,wallet,'2026-10-12'),/边界/);
 assert.throws(()=>service.extract(body(),'0x'+'b'.repeat(40),'2026-10-12'),/钱包/);
});
test('official data uses maximum historical range and hourly grid',function(){
 const service=require('../server/service/leader-daily-pnl-service');let params;
 service.create({http:{request:function(base,route,query,cb){assert.equal(route,'/v2/user-pnl');params=query;cb(null,body());}}}).fetch(wallet,'2026-10-12',function(err,result){assert.ifError(err);assert.equal(params.interval,'max');assert.equal(params.fidelity,'1h');assert.equal(result.leaderNetProfit,'0');});
});
