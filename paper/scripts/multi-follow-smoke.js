// Financial simulation regression: disposable database only, no external requests.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg');
const settings=require('../config/DBsettings');const name='polymarket_multi_test_'+Date.now();settings.POSTGRES_DATABASE=name;
const db=require('../server/db/adapter').create({database:name});const cfg=require('../config').paper;cfg.initialCash='1000';
const {D}=require('../server/service/accounting-service');const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres'});
let created=false,delay=false,releaseQuote,firstA,firstB;
const markets={prepare:function(_,cb){const value={metadata:{rate:'0.1',exponent:1},book:{asks:[{price:'0.5',size:'10000'}],bids:[{price:'0.6',size:'10000'}],observedAt:Date.now()}};if(delay){releaseQuote=function(){cb(null,value);};return;}cb(null,value);},consume:function(){}};
const paper=require('../server/service/paper-service').create(db,markets);
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);const base={token:'same-token',condition:'same-market',side:'BUY',price:'0.5',timestamp:Math.floor(Date.now()/1000),title:'Same asset',outcomeIndex:0,active:true,historical:false,followGeneration:1};
process.once('uncaughtException',cleanup);
async.waterfall([
 function(next){admin.connect(function(e){next(e);});},
 function(next){admin.query('CREATE DATABASE "'+name+'"',function(e){created=!e;next(e);});},
 function(next){db.connect(function(e){next(e);});},function(next){db.migrate(function(e){next(e);});},function(next){paper.initialize(function(e){next(e);});},
 function(next){async.eachSeries([A,B],function(wallet,cb){db.insert('Leader',{id:wallet,name:wallet===A?'A':'B',rank:1,pnl:'0',active:true,joinedAt:new Date(0),raw:{followGeneration:1}},function(e){if(e)return cb(e);db.insert('FollowTask',{id:wallet,state:'running',fundingMode:'dedicated',fundedCapital:'500',allocation:'500',cash:'500',copyPercent:wallet===A?'50':'100',maxOrderAmount:wallet===A?null:'20',generation:1,startedAt:new Date(0)},function(e){cb(e);});});},next);},
 function(next){paper.copy({...base,wallet:A,id:'a-buy',sourceId:'a-source',size:'200'},next);},
 function(result,next){assert.equal(result.order.status,'FILLED');assert.ok(D(result.order.gross).eq(50));db.one('FollowTask',{where:{id:A}},next);},
 function(row,next){assert.ok(D(row.cash).eq('447.5'),'BUY must debit only its own reserved cash');firstA=row.cash;paper.copy({...base,wallet:B,id:'b-buy',sourceId:'b-source',size:'300'},next);},
 function(result,next){assert.ok(D(result.order.gross).plus(result.order.fee).lte(20));assert.ok(D(result.order.gross).plus(result.order.fee).gt('19.999999'));db.one('FollowTask',{where:{id:B}},next);},
 function(row,next){firstB=row.cash;assert.ok(D(row.cash).gte(480));paper.copy({...base,wallet:B,id:'b-increment',sourceId:'b-source',size:'100'},next);},
 function(result,next){assert.equal(result.order.reason,'ORDER_AMOUNT_LIMIT');assert.equal(result.order.status,'SKIPPED');paper.copy({...base,wallet:A,id:'a-sell',sourceId:'a-sell',side:'SELL',size:'10',beforeInventory:'20'},next);},
 function(result,next){assert.equal(result.order.status,'FILLED');assert.ok(D(result.order.quantity).eq(50));db.one('FollowTask',{where:{id:A}},next);},
 function(row,next){assert.ok(D(row.cash).eq('476.3'));assert.ok(D(row.realized).eq('2.55'));db.one('FollowTask',{where:{id:B}},next);},
 function(row,next){assert.equal(row.cash,firstB,'Selling A cannot alter B cash');db.one('Position',{where:{id:B+':same-token'}},next);},
 function(row,next){assert.ok(D(row.quantity).gt(38));delay=true;paper.copy({...base,wallet:A,id:'late-buy',sourceId:'late-buy',size:'20'},function(e,result){if(e)return next(e);assert.equal(result.order.reason,'TASK_PAUSED');delay=false;next();});db.update('FollowTask',A,{state:'paused',generation:2},function(e){if(e)return next(e);releaseQuote();});},
 function(next){paper.settle('same-market',{status:'resolved',payouts:[1000000,0]},function(e){next(e);});},
 function(next){db.query('SELECT a.cash,a.realized,(SELECT SUM(cash)::text FROM paper_follow_tasks) own_cash,(SELECT SUM(realized)::text FROM paper_follow_tasks) own_profit FROM paper_accounts a WHERE id=$1',['paper'],next);},
 function(rows,next){assert.ok(D(rows[0].cash).eq(rows[0].own_cash));assert.ok(D(rows[0].realized).eq(rows[0].own_profit));next();}
],cleanup);
function cleanup(err){db.close(function(closeErr){function finish(dropErr){admin.end(function(){const e=err||closeErr||dropErr;if(e){console.error(e.stack);process.exitCode=1;}else console.log('Multi-person engine passed: ratio, reserved funds, same-asset isolation, per-source fee-inclusive cap, sale/settlement credit, delayed BUY cancellation. Disposable DB removed.');});}if(created&&/^polymarket_multi_test_\d+$/.test(name))admin.query('DROP DATABASE "'+name+'"',finish);else finish();});}
