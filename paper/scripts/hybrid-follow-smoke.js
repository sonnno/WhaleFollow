// Shared/dedicated capital and deferred refunds: disposable PostgreSQL only.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg');
const settings=require('../config/DBsettings'),name='polymarket_hybrid_test_'+Date.now();settings.POSTGRES_DATABASE=name;
const db=require('../server/db/adapter').create({database:name});require('../config').paper.initialCash='1000';const {D}=require('../server/service/accounting-service');
const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres'});let created=false;
const markets={prepare:function(_,cb){cb(null,{metadata:{rate:'0',exponent:1},book:{asks:[{price:'0.5',size:'10000'}],bids:[{price:'0.5',size:'10000'}],observedAt:Date.now()}});},consume:function(){}};
const paper=require('../server/service/paper-service').create(db,markets),tasks=require('../server/service/follow-task-service').create(db);
const transfers=require('../server/service/follow-transfer-service').create(db);
const wallets=['a','b','c'].map(v=>'0x'+v.repeat(40)),[A,B,C]=wallets;
const base={token:'common-token',condition:'common-market',side:'BUY',price:'0.5',timestamp:Math.floor(Date.now()/1000)+5,title:'Same market',outcomeIndex:0,active:true,historical:false,followGeneration:1};
function copy(wallet,id,size,next,extra){paper.copy({...base,wallet,id,sourceId:id,size,...extra},next);}
process.once('uncaughtException',cleanup);
async.waterfall([
 function(next){admin.connect(function(e){next(e);});},function(next){admin.query('CREATE DATABASE "'+name+'"',function(e){created=!e;next(e);});},function(next){db.connect(function(e){next(e);});},function(next){db.migrate(function(e){next(e);});},function(next){paper.initialize(function(e){next(e);});},function(next){tasks.initialize(function(e){next(e);});},
 function(next){async.eachSeries(wallets,function(wallet,cb){tasks.save({wallet,name:wallet===A?'A':wallet===B?'B':'C',fundingMode:wallet===A?'dedicated':'shared',allocation:wallet===A?'500':'1000',copyPercent:'100',maxOrderAmount:null},function(e){if(e)return cb(e);tasks.control(wallet,{action:'start'},function(e){cb(e);});});},next);},
 function(next){transfers.transfer(A,{direction:'in',amount:'500',requestId:'hybrid-initial-reserve'},function(err){next(err);});},
 function(next){tasks.list(next);},function(list,next){assert.ok(D(list.wallet.unallocatedCash).eq(500));assert.ok(D(list.data.find(t=>t.wallet===A).cash).eq(500));copy(A,'a-full','1000',next);},
 function(res,next){assert.ok(D(res.order.gross).eq(500));tasks.save({wallet:A,name:'A',fundingMode:'dedicated',allocation:'200',copyPercent:'100',maxOrderAmount:null},next);},
 function(task,next){assert.ok(D(task.cash).isZero());assert.ok(D(task.fundedCapital).eq(500));assert.equal(task.pendingRelease,undefined);copy(B,'b-use-public','600',next);},
 function(res,next){assert.ok(D(res.order.gross).eq(300));copy(C,'c-public-remainder','600',next);},
 function(res,next){assert.ok(D(res.order.gross).eq(200));copy(A,'a-budget-blocked','20',next);},
 function(res,next){assert.equal(res.order.reason,'TASK_BUDGET_LIMIT');copy(A,'a-refund-sale','60',next,{side:'SELL',beforeInventory:'100'});},
 function(res,next){assert.ok(D(res.order.gross).eq(300));tasks.list(next);},
 function(list,next){const a=list.data.find(t=>t.wallet===A);assert.ok(D(a.cash).eq(300));assert.ok(D(a.fundedCapital).eq(500));assert.ok(D(a.positionCost).eq(200));assert.ok(D(list.wallet.unallocatedCash).isZero());transfers.transfer(A,{direction:'out',amount:'300',requestId:'hybrid-manual-return'},function(err){next(err);});},
 function(next){copy(A,'a-still-at-limit','20',next);},
 function(res,next){assert.equal(res.order.reason,'TASK_BUDGET_LIMIT');copy(A,'a-retain-small-sale','50',next,{side:'SELL',beforeInventory:'100'});},
 function(res,next){assert.ok(D(res.order.gross).eq(100));tasks.list(next);},
 function(list,next){const a=list.data.find(t=>t.wallet===A);assert.ok(D(a.cash).eq(100));assert.ok(D(list.wallet.unallocatedCash).eq(300));copy(A,'a-resume-within-limit','300',next);},
 function(res,next){assert.ok(D(res.order.gross).eq(100));copy(B,'b-public-independent','400',next);},
 function(res,next){assert.ok(D(res.order.gross).eq(200));tasks.save({wallet:A,name:'A',fundingMode:'dedicated',allocation:'100',copyPercent:'100',maxOrderAmount:null},function(err){next(err);});},
 function(next){paper.settle('common-market',{status:'resolved',payouts:[500000,500000]},function(e){next(e);});},
 function(next){tasks.list(next);},function(list,next){assert.ok(D(list.wallet.cash).eq(1000));assert.ok(D(list.wallet.unallocatedCash).eq(800));const a=list.data.find(t=>t.wallet===A);assert.ok(D(a.cash).eq(200));assert.ok(D(a.availableCash).eq(100));assert.ok(D(a.unusedCash).eq(100));assert.ok(D(list.wallet.totalProfit).isZero());tasks.save({wallet:A,name:'A',fundingMode:'shared',allocation:'200',copyPercent:'100',maxOrderAmount:null},function(err){assert.match(err.message,/手动转出/);next();});},
 function(next){transfers.transfer(A,{direction:'out',amount:'200',requestId:'hybrid-close-account'},function(err){next(err);});},
 function(next){tasks.save({wallet:A,name:'A',fundingMode:'shared',allocation:'200',copyPercent:'100',maxOrderAmount:null},next);},
 function(task,next){assert.ok(D(task.cash).isZero());assert.ok(D(task.fundedCapital).isZero());assert.equal(task.generation,2);paper.copy({...base,wallet:A,id:'old-mode-cached',sourceId:'old-mode-cached',condition:'new-market',token:'new-token',size:'20',followGeneration:1},next);},
 function(res,next){assert.equal(res.order.reason,'TASK_GENERATION_CHANGED');db.query('SELECT a.cash,a.realized,(SELECT SUM(delta)::text FROM paper_cash_ledger) ledger FROM paper_accounts a WHERE id=$1',['paper'],next);},
 function(rows,next){assert.ok(D(rows[0].cash).eq(rows[0].ledger));assert.ok(D(rows[0].cash).eq(1000));next();}
],cleanup);
function cleanup(err){db.close(function(closeErr){function finish(dropErr){admin.end(function(){const e=err||closeErr||dropErr;if(e){console.error(e.stack);process.exitCode=1;}else console.log('Hybrid engine passed: public B/C share500, A owns500, target changes never transfer, SELL/settlement keep own cash, manual withdrawals, exposure blocks/resumes, global ledger conservation, mode-change old BUY invalidated. Disposable DB removed.');});}if(created&&/^polymarket_hybrid_test_\d+$/.test(name))admin.query('DROP DATABASE "'+name+'"',finish);else finish();});}

