const test=require('node:test'),assert=require('node:assert/strict');
test('overview daily profits read closed report rows rather than continuously grouping settlements',function(_,done){
 const db={readSnapshot:function(work,callback){work({query:function(sql,params,cb){
  if(sql.includes('FROM paper_accounts'))return cb(null,[{createdAt:new Date()}]);
  if(sql.includes('paper_settlements'))return cb(null,[]);
  assert.match(sql,/FROM paper_daily_reports/);
  assert.match(sql,/"netProfit"::text\s+(?:AS\s+)?profit/i);
  assert.match(sql,/"breakdownVersion">=1/);
  cb(null,[{day:'2026-10-14',profit:'25.1023'}]);
 }},callback);}};
 require('../server/service/dashboard-service').create(db).homeHistory(function(err,result){assert.ifError(err);assert.deepEqual(result.days,[{day:'2026-10-14',profit:'25.1023'}]);done();});
});
