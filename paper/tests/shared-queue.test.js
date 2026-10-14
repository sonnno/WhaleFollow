const test=require('node:test'),assert=require('node:assert/strict');
test('shared buys run sequentially while a dedicated person can proceed independently',function(_,done){
 const create=require('../server/service/worker-service').create;const jobs=new Map(['s1','s2','d1'].map(function(id){return[id,{id,status:'pending',attempts:0,payload:{id,token:id,wallet:id,side:'BUY',fundingMode:id==='d1'?'dedicated':'shared'}}];}));const queue=['s1','s2','d1'],calls=[],callbacks={};
 const db={one:function(_,options,cb){cb(null,jobs.get(options.where.id));},query:function(sql,params,cb){const job=jobs.get(params[0]);cb(null,job?[job]:[]);},update:function(_,id,fields,cb){Object.assign(jobs.get(id),fields);cb();}};
 const redis={rpop:function(_,cb){cb(null,queue.shift());},del:function(_,cb){if(cb)cb();},set:function(_,__,___,____,_____,cb){cb(null,null);}};
 const worker=create(db,redis,null,{onSignal:function(){}},{stop:function(){}},{copy:function(signal,cb){calls.push(signal.id);callbacks[signal.id]=cb;}},{snapshot:function(cb){cb();}});
 worker.consume(function(){worker.consume(function(){worker.consume(function(){setImmediate(function(){try{assert.ok(calls.includes('s1'));assert.ok(calls.includes('d1'));assert.equal(calls.includes('s2'),false,'Second shared buy must wait');callbacks.s1(null,{retry:false});setImmediate(function(){try{assert.ok(calls.includes('s2'));callbacks.s2(null,{retry:false});callbacks.d1(null,{retry:false});worker.stop(done);}catch(e){done(e);}});}catch(e){worker.stop(function(){done(e);});}});});});});
});
