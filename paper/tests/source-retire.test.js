const test=require('node:test'),assert=require('node:assert/strict');
require('./helpers/source-store-mock')();
for(const readded of [false,true])test('an HTTP response from a deleted '+(readded?'and recreated ':'')+'task cannot restore source records or its checkpoint',function(t,done){
 let response,leader={id:'wallet',joinedAt:new Date(0),inventory:{},raw:{followGeneration:3},active:true};const writes=[];
 const tx={query:function(_,__,cb){cb(null,[]);},one:function(kind,_,cb){cb(null,kind==='Leader'?leader:null);},save:function(kind,row,cb){writes.push(kind);cb(null,row);},insert:function(kind,row,cb){writes.push(kind);cb(null,row);}};
 const db={...tx,transaction:function(work,cb){work(tx,cb);}};
 t.mock.method(require('../server/lib/http-client'),'pages',function(_,__,___,cb){response=cb;});
 require('../server/service/source-service').create(db).poll('wallet',function(err){assert.ifError(err);assert.deepEqual(writes,[]);done();});
 leader=readded?{id:'wallet',joinedAt:new Date(0),inventory:{},raw:{followGeneration:4},active:true}:null;
 response(null,[{proxy_wallet:'wallet',transaction_hash:'tx',token_id:'token',condition_id:'market',side:'BUY',size:10,price:0.5,timestamp:Math.floor(Date.now()/1000)}]);
});
test('a regressed response cannot invalidate a task recreated before quarantine finishes',function(t,done){
 let leader={id:'wallet',joinedAt:new Date(0),inventory:{},inventoryValid:true,raw:{followGeneration:3}},strayUpdates=0;const writes=[];
 const tx={query:function(sql,_,cb){cb(null,/SELECT id,processed/.test(sql)?[{id:'wallet:tx:token:BUY',processed:{'0.5':'10'}}]:[]);},one:function(kind,_,cb){cb(null,kind==='Leader'?leader:kind==='Source'?{processed:{'0.5':'10'}}:null);},save:function(kind,row,cb){writes.push(kind);cb(null,row);},insert:function(kind,row,cb){writes.push(kind);cb(null,row);}};
 const db={...tx,update:function(_,__,___,cb){strayUpdates++;cb();},transaction:function(work,cb){work(tx,function(err,result){if(err&&err.message.includes('regressed'))leader={...leader,raw:{followGeneration:4},inventoryValid:true};cb(err,result);});}};
 t.mock.method(require('../server/lib/http-client'),'pages',function(_,__,___,cb){cb(null,[{proxy_wallet:'wallet',transaction_hash:'tx',token_id:'token',condition_id:'market',side:'BUY',size:5,price:0.5,timestamp:Math.floor(Date.now()/1000)}]);});
 require('../server/service/source-service').create(db).poll('wallet',function(err){assert.ifError(err);assert.equal(strayUpdates,0);assert.deepEqual(writes,[]);assert.equal(leader.inventoryValid,true);done();});
});
test('an old SELL collector cannot validate or invalidate inventory of a recreated task',function(t,done){
 let leader={id:'wallet',joinedAt:new Date(0),inventory:{},inventoryValid:true,raw:{followGeneration:3,inventoryTimestamp:0}},activityCalls=0;const writes=[];
 const tx={query:function(sql,_,cb){if(/SELECT id,processed/.test(sql))leader={...leader,raw:{followGeneration:4,inventoryTimestamp:0}};cb(null,[]);},one:function(kind,_,cb){cb(null,kind==='Leader'?leader:null);},save:function(kind,row,cb){writes.push(kind);cb(null,row);},insert:function(kind,row,cb){writes.push(kind);cb(null,row);}};
 const db={...tx,transaction:function(work,cb){work(tx,cb);}};
 t.mock.method(require('../server/lib/http-client'),'pages',function(_,route,___,cb){if(route==='/v2/activity'){activityCalls++;return cb(null,[{type:'REDEEM',timestamp:10}]);}cb(null,[{proxy_wallet:'wallet',transaction_hash:'tx',token_id:'token',condition_id:'market',side:'SELL',size:5,price:0.5,timestamp:Math.floor(Date.now()/1000)}]);});
 require('../server/service/source-service').create(db).poll('wallet',function(err){assert.ifError(err);assert.equal(activityCalls,0);assert.deepEqual(writes,[]);assert.equal(leader.inventoryValid,true);done();});
});
