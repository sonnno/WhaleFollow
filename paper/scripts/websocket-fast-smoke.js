// Financial integration checks in a disposable database only; no public HTTP or WS.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg');
const settings=require('../config/DBsettings');
const testName='polymarket_ws_test_'+Date.now();
process.env.POSTGRES_DATABASE=testName;settings.POSTGRES_DATABASE=testName;
const config=require('../config').paper;config.initialCash='1000';
const db=require('../server/db/adapter').create();
const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres'});
const {D}=require('../server/service/accounting-service');
const wallet='0x'+'a'.repeat(40),hash='0x'+'b'.repeat(64),condition='0x'+'c'.repeat(64),now=Math.floor(Date.now()/1000),generation=5;
const markets={prepare:function(_,cb){cb(null,{metadata:{rate:'0.1',exponent:1,minSize:'1'},book:{asks:[{price:'0.5',size:'100000'}],bids:[{price:'0.5',size:'100000'}],observedAt:Date.now()}});},consume:function(){}};
const paper=require('../server/service/paper-service').create(db,markets),sourceModule=require('../server/service/source-service'),sources=sourceModule.create(db);
const queue=[],keys=new Set();
const redis={set:function(k,_,__,___,____,cb){if(keys.has(k))return cb(null,null);keys.add(k);cb(null,'OK');},lpush:function(_,id,cb){queue.unshift(id);cb();},rpop:function(_,cb){cb(null,queue.pop()||null);},del:function(k,cb){keys.delete(k);if(cb)cb();}};
const worker=require('../server/service/worker-service').create(db,redis,null,sources,markets,paper,{});
const packet={proxyWallet:wallet,transactionHash:hash,asset:'123',conditionId:condition,side:'BUY',price:0.5,size:3,timestamp:now,outcomeIndex:0};
const context={generation,receivedAt:new Date().toISOString(),receivedMonotonicMs:performance.now()};
let created=false;
function rest(fields){return sourceModule.groupTrades([{proxy_wallet:wallet,transaction_hash:hash,token_id:'123',condition_id:condition,side:'BUY',price:0.5,size:3,timestamp:now,outcome_index:0,...fields}])[0];}
function drain(callback,attempt){
 worker.dispatch(function(err){if(err)return callback(err);worker.consume(function(error){if(error)return callback(error);setTimeout(function(){db.query("SELECT COUNT(*)::int n FROM paper_outbox WHERE kind='copy' AND status='pending'",[],function(e,r){if(e)return callback(e);if(!r[0].n)return callback();if((attempt||0)>100)return callback(Error('Trading queue did not drain'));drain(callback,(attempt||0)+1);});},10);});});
}
function state(callback){db.query(`SELECT a.cash,a.fees,t.cash AS dedicated,(SELECT COUNT(*)::int FROM paper_orders WHERE status IN ('FILLED','PARTIAL')) orders,(SELECT COUNT(*)::int FROM paper_cash_ledger WHERE kind='BUY') ledgers,(SELECT quantity FROM paper_positions WHERE id=$1) quantity FROM paper_accounts a JOIN paper_follow_tasks t ON t.id=$2 WHERE a.id='paper'`,[wallet+':123',wallet],callback);}
async.waterfall([
 cb=>admin.connect(e=>cb(e)),
 cb=>admin.query('CREATE DATABASE "'+testName+'"',e=>{created=!e;cb(e);}),
 cb=>db.connect(e=>cb(e)),cb=>db.migrate(e=>cb(e)),cb=>paper.initialize(e=>cb(e)),
 cb=>db.insert('Leader',{id:wallet,name:'WS integration',rank:1,pnl:'0',active:true,joinedAt:new Date((now-3600)*1000),inventory:{123:'100'},inventoryValid:true,raw:{followGeneration:generation,followFundingMode:'dedicated',inventoryTimestamp:now-3600,inventoryRevision:'fixture'}},e=>cb(e)),
 cb=>db.insert('FollowTask',{id:wallet,state:'running',generation,fundingMode:'dedicated',allocation:'200',fundedCapital:'200',cash:'200',copyPercent:'100',maxOrderAmount:null,startedAt:new Date((now-3600)*1000)},e=>cb(e)),
 cb=>async.timesLimit(12,6,(_,next)=>sources.ingestWebsocket(packet,context,e=>next(e)),e=>cb(e)),
 cb=>drain(cb),cb=>state(cb),
 (rows,cb)=>{const x=rows[0];assert.equal(x.orders,1);assert.equal(x.ledgers,1);assert.ok(D(x.cash).eq('998.425'));assert.ok(D(x.dedicated).eq('198.425'));assert.ok(D(x.quantity).eq(3));sources.ingest(rest({size:1}),e=>cb(e));},
 cb=>state(cb),
 (rows,cb)=>{assert.equal(rows[0].orders,1);sources.ingest(rest({size:6}),e=>cb(e));},
 cb=>drain(cb),cb=>state(cb),
 (rows,cb)=>{const x=rows[0];assert.equal(x.orders,2);assert.equal(x.ledgers,2);assert.ok(D(x.cash).eq('996.85'));assert.ok(D(x.dedicated).eq('196.85'));assert.ok(D(x.quantity).eq(6));assert.ok(D(x.fees).eq('.15'));db.query("SELECT payload FROM paper_outbox WHERE kind='copy'",[],cb);},
 (rows,cb)=>async.eachLimit(rows,2,(row,next)=>paper.copy(row.payload,(e,r)=>{if(!e)assert.equal(r.duplicate,true);next(e);}),cb),
 cb=>state(cb),(rows,cb)=>{assert.ok(D(rows[0].cash).eq('996.85'));cb();},
 cb=>sources.ingestWebsocket({...packet,side:'SELL',size:3,transactionHash:'0x'+'d'.repeat(64),timestamp:now+1},context,e=>cb(e)),
 cb=>sources.ingestWebsocket({...packet,size:1,transactionHash:'0x'+'e'.repeat(64),timestamp:now+2},context,e=>cb(e)),
 cb=>worker.dispatch(cb),
 cb=>{assert.equal(queue.length,0,'unconfirmed SELL blocks later same-asset BUY, not enrichment');const group=rest({side:'SELL',size:3,transaction_hash:'0x'+'d'.repeat(64),timestamp:now+1});group.validatedInventoryBaseline=(now-3600)+':fixture';sources.ingest(group,e=>cb(e));},
 cb=>drain(cb),
 cb=>db.query("SELECT side,status FROM paper_orders WHERE wallet=$1 ORDER BY \"createdAt\",id",[wallet],cb),
 (rows,cb)=>{assert.deepEqual(rows.map(x=>x.side),['BUY','BUY','SELL','BUY']);assert.ok(rows.every(x=>x.status==='FILLED'));db.query("SELECT count(*)::int n FROM paper_outbox WHERE kind='market-enrich' AND attempts>0",[],cb);},
 (rows,cb)=>{assert.equal(rows[0].n,0,'trade consumer never executes display jobs');cb();}
],cleanup);
function cleanup(err){db.close(function(closeError){function finish(dropError){admin.end(function(){const failure=err||closeError||dropError;if(failure){console.error(failure.stack);process.exitCode=1;}else console.log('WS fast-path PG integration passed: concurrent replay, REST deltas, fees, dedicated cash, idempotent ledger, SELL order barrier. Disposable database removed.');});}if(created&&/^polymarket_ws_test_\d+$/.test(testName))admin.query('DROP DATABASE "'+testName+'"',finish);else finish();});}
