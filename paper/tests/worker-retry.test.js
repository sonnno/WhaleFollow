const test=require('node:test'),assert=require('node:assert/strict');
test('temporary copy failure releases delivery marker and schedules a bounded retry',function(_,done){
 const queue=[],markers=new Set(),job={id:'retry',kind:'copy',status:'pending',attempts:0,payload:{wallet:'w',token:'t',side:'BUY',fundingMode:'dedicated'}};
 const db={query:function(_,__,cb){cb(null,[job]);},one:function(_,__,cb){cb(null,job);},update:function(_,__,patch,cb){Object.assign(job,patch);cb();}};
 const redis={set:function(key,_,__,___,____,cb){if(markers.has(key))return cb(null,null);markers.add(key);cb(null,'OK');},lpush:function(_,id,cb){queue.push(id);cb();},rpop:function(_,cb){cb(null,queue.shift());},del:function(key,cb){markers.delete(key);if(cb)cb();}};
 const worker=require('../server/service/worker-service').create(db,redis,null,{onSignal:function(){}},{},{copy:function(_,cb){cb(null,{retry:true,order:{reason:'STALE_BOOK'}});}},{},{dailyReports:{}});
 worker.dispatch(function(e){assert.ifError(e);worker.consume(function(err){assert.ifError(err);setImmediate(function(){assert.equal(job.attempts,1);assert.equal(markers.size,0,'30 second delivery lease must be released');assert.ok(job.payload.retryAt>Date.now());assert.ok(job.payload.retryAt-Date.now()<=1500);done();});});});
});
