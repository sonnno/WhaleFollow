const test=require('node:test'),assert=require('node:assert/strict');
test('market statistics validates real dates, ordering, wallets and profit scope',function(){
 const service=require('../server/service/market-statistics-service').create({query:function(){throw Error('Invalid request reached SQL');}});
 for(const query of [{from:'2026-02-30'},{from:'2026-10-14',to:'2026-10-13'},{wallet:'bad'},{profit:'all winners'},{offset:-1},{limit:101}])service.list(query,function(err){assert.ok(err);assert.equal(err.status,400);});
});
test('market filters are parameterized, profit applies after aggregation, query is paginated',function(){
 const wallet='0x'+'a'.repeat(40),query={wallet,keyword:"abc' OR true --",category:'足球',profit:'negative',from:'2026-10-13',to:'2026-10-14',offset:20,limit:20};let captured;
 require('../server/service/market-statistics-service').create({query:function(sql,params,cb){captured={sql,params};cb(null,[{data:[],total:0,summary:{},categories:[]}]);}}).list(query,function(err,value){assert.ifError(err);assert.equal(value.offset,20);});
 assert.ok(captured.params.includes(wallet));assert.ok(captured.params.includes(query.keyword));assert.ok(captured.params.includes('足球'));assert.ok(!captured.sql.includes(query.keyword));assert.match(captured.sql,/LIMIT \$\d+ OFFSET \$\d+/);assert.match(captured.sql,/GROUP BY s\.condition/);assert.match(captured.sql,/profit<0/);
});
