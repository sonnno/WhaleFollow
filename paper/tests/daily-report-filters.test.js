const test=require('node:test'),assert=require('node:assert/strict'),service=require('../server/service/daily-report-service');
test('daily filters validate real dates and wallets and bind filters without interpolation',function(){
 const calls=[],db={query:function(sql,params,cb){calls.push({sql,params});cb(null,[{total:0,data:[]}]);}},daily=service.create(db);
 daily.list({from:'2026-02-30'},function(err){assert.ok(err);});
 daily.list({from:'2026-10-12',to:'2026-10-01'},function(err){assert.ok(err);});
 daily.listTasks({wallet:'bad'},function(err){assert.ok(err);});
 const wallet='0x'+'a'.repeat(40);daily.listTasks({wallet,from:'2026-10-01',to:'2026-10-12',limit:20,offset:20},function(err,result){assert.ifError(err);assert.equal(result.offset,20);});
 assert.equal(calls.length,1);assert.ok(calls[0].params.includes(wallet));assert.ok(!calls[0].sql.includes(wallet));
});
