const test=require('node:test'),assert=require('node:assert/strict'),async=require('async');
const source=require('../server/service/source-service');
const wallet='0x'+'a'.repeat(40),hash='0x'+'b'.repeat(64),condition='0x'+'c'.repeat(64);
function packet(fields){return {proxyWallet:wallet,transactionHash:hash,asset:'123',conditionId:condition,side:'BUY',price:0.5,size:3,timestamp:Math.floor(Date.now()/1000),outcomeIndex:0,...fields};}
function fixture(){
 const tables={Source:new Map(),Outbox:new Map(),Setting:new Map()};
 const leader={id:wallet,joinedAt:new Date(0),active:true,inventory:{123:'100'},inventoryValid:true,raw:{followGeneration:1,inventoryTimestamp:0}};
 const tx={query:function(sql,args,cb){if(sql.startsWith('INSERT INTO paper_outbox')&&!tables.Outbox.has(args[0])){const kind=sql.includes("'source-confirmation'")?'source-confirmation':sql.includes("'source-reconcile'")?'source-reconcile':'market-enrich';tables.Outbox.set(args[0],{id:args[0],kind,payload:JSON.parse(args[1]),status:'pending',attempts:0,createdAt:new Date()});}if(sql.startsWith('UPDATE paper_outbox')&&tables.Outbox.has(args[0]))tables.Outbox.get(args[0]).status='done';cb(null,[]);},one:function(kind,q,cb){cb(null,kind==='Leader'?leader:tables[kind]&&tables[kind].get(q.where.id));},save:function(kind,row,cb){if(tables[kind])tables[kind].set(row.id,row);cb(null,row);},insert:function(kind,row,cb){assert.ok(!tables[kind].has(row.id),'primary-key uniqueness');tables[kind].set(row.id,row);cb(null,row);},update:function(kind,id,patch,cb){Object.assign(tables[kind].get(id),patch);cb();}};
 const db={...tx,transaction:function(work,cb){work(tx,cb);}},svc=source.create(db);
 return {svc,db,leader,tables,signals:function(){return [...tables.Outbox.values()].filter(x=>x.kind==='copy').map(x=>x.payload);}};
}
function ws(f,x,cb){assert.equal(typeof f.svc.ingestWebsocket,'function','WS BUY must ingest without an HTTP request');f.svc.ingestWebsocket(x,{generation:1,receivedAt:new Date().toISOString()},cb);}
function rest(x){return source.groupTrades([{proxy_wallet:wallet,transaction_hash:hash,token_id:'123',condition_id:condition,side:'BUY',price:0.5,size:3,timestamp:Math.floor(Date.now()/1000),outcome_index:0,...x}])[0];}
test('complete WS BUY is committed immediately and duplicate messages do not add funds',function(t,done){
 const f=fixture();t.mock.method(require('../server/lib/http-client'),'pages',()=>assert.fail('fast BUY must not fetch source REST'));
 async.eachSeries([packet(),packet()],(p,cb)=>ws(f,p,cb),function(e){assert.ifError(e);assert.equal(f.signals().length,1);assert.equal(f.signals()[0].sourceAmount,'1.5');assert.equal(f.signals()[0].origin,'websocket');done();});
});
test('same-price equal fills remain distinguishable through REST reconciliation',function(_,done){
 const f=fixture();async.waterfall([cb=>ws(f,packet(),cb),(_,cb)=>ws(f,packet(),cb),(_,cb)=>f.svc.ingest(rest({size:6}),cb)],function(e){assert.ifError(e);assert.deepEqual(f.signals().map(x=>x.size),['3','3']);assert.equal(f.tables.Source.values().next().value.processed['0.5'],'6');done();});
});
test('REST temporarily below WS quantity is held without a regressed quarantine',function(_,done){
 const f=fixture();async.waterfall([cb=>ws(f,packet({size:8}),cb),(_,cb)=>f.svc.ingest(rest({size:3}),cb),(_,cb)=>f.svc.ingest(rest({size:10}),cb)],function(e){assert.ifError(e);assert.deepEqual(f.signals().map(x=>x.size),['8','2']);assert.equal(f.tables.Setting.size,0);done();});
});
test('REST-first then WS replay creates no new copy intent',function(_,done){
 const f=fixture();async.waterfall([cb=>f.svc.ingest(rest({size:6}),cb),(_,cb)=>ws(f,packet(),cb)],function(e){assert.ifError(e);assert.equal(f.signals().length,1);done();});
});
test('missing required trade data requests fallback without creating a copy',function(_,done){
 const f=fixture();ws(f,packet({price:undefined}),function(e,r){assert.ifError(e);assert.equal(r.handled,false);assert.equal(f.signals().length,0);done();});
});

test('sub-precision WS amounts fall back instead of crashing the worker callback',function(_,done){
 const f=fixture();ws(f,packet({size:1e-30}),function(e,r){assert.ifError(e);assert.equal(r.handled,false);done();});
});
test('old captured generation cannot create a fast intent in a recreated task',function(_,done){
 const f=fixture();f.leader.raw.followGeneration=2;ws(f,packet(),function(e){assert.ifError(e);assert.equal(f.signals().length,0);done();});
});
test('paused-at-discovery flag survives the fast path',function(_,done){
 const f=fixture();f.tables.Setting.set('runtime',{id:'runtime',value:{pauseBuys:true}});ws(f,packet(),function(e){assert.ifError(e);assert.equal(f.signals()[0].pausedAtDiscovery,true);done();});
});
test('WS BUY does not use a quantity lower bound to change authoritative leader inventory',function(_,done){
 const f=fixture();ws(f,packet(),function(e){assert.ifError(e);assert.equal(f.leader.inventory['123'],'100');f.svc.ingest(rest({size:6}),function(err){assert.ifError(err);assert.equal(f.leader.inventory['123'],'106');done();});});
});
test('WS SELL creates a source-confirmation barrier, never an unverified copy',function(_,done){
 const f=fixture();ws(f,packet({side:'SELL'}),function(e,r){assert.ifError(e);assert.equal(r.handled,true);assert.equal(r.needsRest,true);assert.equal(f.signals().length,0);assert.equal([...f.tables.Outbox.values()].filter(x=>x.kind==='source-confirmation'&&x.status==='pending').length,1);done();});
});

test('partial REST SELL cannot release a barrier before the known WS size is confirmed',function(_,done){
 const f=fixture();async.waterfall([cb=>ws(f,packet({side:'SELL',size:8}),cb),(_,cb)=>f.svc.ingest(rest({side:'SELL',size:3}),cb)],function(e){assert.ifError(e);assert.equal(f.signals().length,0);const stored=[...f.tables.Source.values()][0];assert.equal(stored.raw.wsPending,true);assert.equal([...f.tables.Outbox.values()].find(x=>x.kind==='source-confirmation').status,'pending');done();});
});

test('duplicate WS and zero-delta REST do not invalidate a newer inventory baseline',function(_,done){
 const f=fixture();async.waterfall([cb=>f.svc.ingest(rest(),cb),(_,cb)=>{f.leader.raw.inventoryTimestamp=Math.floor(Date.now()/1000)+1;f.leader.raw.lastTradeObservedAt=123;f.leader.inventoryValid=true;ws(f,packet(),cb);},(_,cb)=>f.svc.ingest(rest(),cb)],function(e){assert.ifError(e);assert.equal(f.leader.inventoryValid,true);assert.equal(f.leader.raw.lastTradeObservedAt,123);done();});
});

test('durable source reconciliation catches another equal-price fill beyond normal overlap',function(t,done){
 const f=fixture(),timestamp=Math.floor(Date.now()/1000);
 const original=f.db.query;f.db.query=function(sql,args,cb){if(sql.includes("kind='source-reconcile'"))return cb(null,[...f.tables.Outbox.values()].filter(x=>x.kind==='source-reconcile'&&x.status==='pending'));original(sql,args,cb);};
 t.mock.method(require('../server/lib/http-client'),'pages',function(_,__,params,cb){assert.equal(params.start,timestamp);assert.equal(params.end,timestamp);cb(null,[{proxy_wallet:wallet,transaction_hash:hash,token_id:'123',condition_id:condition,side:'BUY',price:0.5,size:6,timestamp,outcome_index:0}]);});
 async.waterfall([cb=>ws(f,packet({timestamp}),cb),(_,cb)=>f.svc.ingest(rest({timestamp,size:3}),cb),(_,cb)=>{assert.equal(typeof f.svc.reconcile,'function');t.mock.method(Date,'now',()=>timestamp*1000+1000000);f.svc.reconcile(cb);}],function(e){assert.ifError(e);assert.deepEqual(f.signals().map(x=>x.size),['3','3']);done();});
});
