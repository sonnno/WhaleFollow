const test=require('node:test'),assert=require('node:assert/strict');
test('overview daily profits read closed report rows rather than continuously grouping settlements',function(_,done){
 const db={query:function(sql,params,cb){
  const section=sql.slice(sql.indexOf('row_to_json(d)'));
  assert.match(section,/FROM paper_daily_reports/);
  assert.match(section,/"netProfit"::text\s+(?:AS\s+)?profit/i);
  assert.doesNotMatch(section.slice(0,section.indexOf("'[]'::jsonb) days")),/FROM settled/);
  cb(null,[{history:[],days:[{day:'2026-10-14',profit:'25.1023'}],createdAt:'2026-10-14T00:00:00Z'}]);
 }};
 require('../server/service/dashboard-service').create(db).cashSummary(function(err,result){assert.ifError(err);assert.deepEqual(result.days,[{day:'2026-10-14',profit:'25.1023'}]);done();});
});
