const test=require('node:test'),assert=require('node:assert/strict');
test('display enrichment is independently queued and saves only after task identity check',function(_,done){
 const module=require('../server/service/market-enrichment-service');let response,saved=0;
 const job={id:'meta',kind:'market-enrich',status:'pending',attempts:0,payload:{wallet:'w',condition:'c',followGeneration:1}};
 const leader={raw:{followGeneration:1}};
 const tx={query:function(_,__,cb){cb(null,[]);},one:function(kind,_,cb){cb(null,kind==='Leader'?leader:kind==='Outbox'?job:null);},update:function(_,__,patch,cb){Object.assign(job,patch);cb();}};
 const db={query:function(_,__,cb){cb(null,[job]);},transaction:function(work,cb){work(tx,cb);}};
 const service=module.create(db,{saveSchedule:function(row,cb){saved++;cb();}},{http:{request:function(_,__,___,cb){response=cb;}}});
 service.run(function(e){assert.ifError(e);assert.equal(saved,1);assert.equal(job.status,'done');done();});
 assert.equal(saved,0,'no display write before HTTP completion');response(null,[{conditionId:'c',endDate:'2026-11-01T00:00:00Z'}]);
});
test('deleted task cannot be restored by a late enrichment HTTP response',function(_,done){
 const module=require('../server/service/market-enrichment-service');let response,saved=0;
 const job={id:'meta',kind:'market-enrich',status:'pending',attempts:0,payload:{wallet:'w',condition:'c',followGeneration:1}};
 const tx={query:function(_,__,cb){cb(null,[]);},one:function(_,__,cb){cb(null,null);}};
 const db={query:function(_,__,cb){cb(null,[job]);},transaction:function(work,cb){work(tx,cb);}};
 const service=module.create(db,{saveSchedule:function(){saved++;}},{http:{request:function(_,__,___,cb){response=cb;}}});
 service.run(function(e){assert.ifError(e);assert.equal(saved,0);done();});response(null,[{conditionId:'c'}]);
});
