// All financial writes and deletes target a newly created disposable database.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg');
const settings=require('../config/DBsettings'),name='polymarket_delete_test_'+Date.now();
const db=require('../server/db/adapter').create({database:name});require('../config').paper.initialCash='1000';const {D}=require('../server/service/accounting-service');
const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres'});let created=false,before,report,other,generation,taskVersion;
const markets={prepare:function(_,cb){cb(null,{metadata:{rate:'0.1',exponent:1},book:{asks:[{price:'0.5',size:'10000'}],bids:[{price:'0.6',size:'10000'}],observedAt:Date.now()}});},consume:function(){}};
const paper=require('../server/service/paper-service').create(db,markets),tasks=require('../server/service/follow-task-service').create(db),dashboard=require('../server/service/dashboard-service').create(db);
const transfers=require('../server/service/follow-transfer-service').create(db),deletion=require('../server/service/task-deletion-service').create(db,{cleanup:function(_,__,cb){cb();}});
const daily=require('../server/service/daily-report-service').create(db,{clock:function(cb){cb(null,new Date('2026-10-12T02:00:00Z'));}});
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40),base={token:'shared-token',condition:'shared-market',side:'BUY',price:'0.5',timestamp:Math.floor(Date.now()/1000)+5,outcomeIndex:0,active:true,historical:false,followGeneration:1,size:'200',title:'Same market'};
function failGuard(next){deletion.remove(A,{confirm:true,generation:1},function(err){assert.equal(err.status,409);assert.match(err.message,/暂停/);next();});}
function normalized(row){const result={...row};delete result.createdAt;delete result.updatedAt;return result;}
async.waterfall([
 function(next){admin.connect(function(e){next(e);});},function(next){admin.query('CREATE DATABASE "'+name+'"',function(e){created=!e;next(e);});},function(next){db.connect(function(e){next(e);});},function(next){db.migrate(function(e){next(e);});},function(next){paper.initialize(function(e){next(e);});},function(next){tasks.initialize(function(e){next(e);});},
 function(next){async.eachSeries([A,B],function(wallet,cb){tasks.save({wallet,name:wallet===A?'A':'B',fundingMode:'shared',allocation:'1000',copyPercent:'100',maxOrderAmount:null},function(e){if(e)return cb(e);tasks.control(wallet,{action:'start'},function(e){cb(e);});});},next);},
 failGuard,
 function(next){paper.copy({...base,wallet:A,id:'a-buy',sourceId:'a-source'},next);},function(_,next){paper.copy({...base,wallet:B,id:'b-buy',sourceId:'b-source'},next);},
 function(_,next){tasks.control(A,{action:'pause'},function(e,t){generation=t.generation;next(e);});},
 function(next){deletion.remove(A,{confirm:true,generation},function(e){assert.equal(e.status,409);assert.match(e.message,/未结算/);next();});},
 function(next){paper.copy({...base,wallet:A,id:'a-sell',sourceId:'a-sell',side:'SELL',size:'50',beforeInventory:'100',followGeneration:generation},next);},
 function(_,next){paper.settle('shared-market',{status:'resolved',payouts:[1000000,0]},function(e){next(e);});},
 function(next){async.eachSeries(['paper_orders','paper_cash_ledger','paper_settlements'],function(table,cb){db.query('UPDATE '+table+' SET "createdAt"=$1',[new Date('2026-10-11T04:00:00Z')],function(e){cb(e);});},next);},
 function(next){db.update('Account','paper',{createdAt:new Date('2026-10-11T00:00:00Z')},function(e){next(e);});},
 function(next){db.save('Checkpoint',{id:'trades:'+A,timestamp:'100'},function(e){next(e);});},
 function(next){db.save('Setting',{id:'quarantine:'+A+':old',value:{source:{wallet:A}}},function(e){next(e);});},
 function(next){db.save('Snapshot',{id:'test-snapshot',cash:'1000',equity:'1000',leaders:{[A]:{cost:'100'},[B]:{cost:'100'}}},function(e){next(e);});},
 function(next){db.save('Outbox',{id:'a-pending',kind:'copy',payload:{wallet:A,side:'SELL'},status:'pending'},function(e){next(e);});},
 function(next){dashboard.cashSummary(next);},function(result,next){before=result;daily.writeDay('2026-10-11',next);},function(result,next){report=normalized(result.report);db.query('SELECT row_to_json(p) value FROM paper_positions p WHERE wallet=$1 ORDER BY id',[B],next);},
 function(rows,next){other=rows;deletion.remove(A,{confirm:true,generation},next);},
 function(result,next){assert.equal(result.deleted,true);dashboard.cashSummary(next);},
 function(after,next){for(const key of ['cash','initialCash','totalProfit','fees','wagered','saleRevenue','saleProfit','settlementRevenue','settledProfit','settledWins','settledLosses','settledCount','settledCost','pendingCost'])assert.ok(D(after[key]).eq(before[key]),key+' changed');assert.equal(after.leaders.some(row=>row.wallet===A),false);db.query('SELECT row_to_json(p) value FROM paper_positions p WHERE wallet=$1 ORDER BY id',[B],next);},
 function(rows,next){assert.deepEqual(rows,other);db.query("DELETE FROM paper_daily_reports WHERE id='2026-10-11'",[],function(e){next(e);});},
 function(next){daily.writeDay('2026-10-11',next);},function(result,next){assert.deepEqual(normalized(result.report),report,'Historical day must regenerate identically after removing task details');
 const tables=['paper_orders','paper_fills','paper_positions','paper_settlements','paper_closed_cycles','paper_follow_fund_transfers','paper_source_trades'];async.eachSeries(tables,function(table,cb){db.query('SELECT COUNT(*)::int count FROM '+table+' WHERE wallet=$1',[A],function(e,rows){if(e)return cb(e);assert.equal(rows[0].count,0,table);cb();});},next);},
 function(next){db.query('SELECT COUNT(*)::int count FROM paper_cash_ledger WHERE id LIKE $1 OR reference LIKE $1 OR details::text LIKE $1',['%'+A+'%'],next);},
 function(rows,next){assert.equal(rows[0].count,0);paper.copy({...base,wallet:A,id:'late-buy',sourceId:'late-buy'},next);},
 function(result,next){assert.equal(result.taskDeleted,true);paper.copy({...base,wallet:A,id:'late-sell',sourceId:'late-sell',side:'SELL'},next);},
 function(result,next){assert.equal(result.taskDeleted,true);tasks.save({wallet:A,name:'Recreated A',fundingMode:'dedicated',allocation:'500',copyPercent:'100',maxOrderAmount:null},next);},
 function(task,next){assert.equal(task.generation,generation+1);taskVersion=task.taskVersion;assert.ok(D(task.cash).isZero());transfers.transfer(A,{direction:'in',amount:'20',requestId:'delete-test-transfer',taskVersion},function(e){next(e);});},
 function(next){tasks.control(A,{action:'stop'},function(e,t){generation=t.generation;next(e);});},
 function(next){deletion.remove(A,{confirm:true,generation},function(e){assert.match(e.message,/全部转出/);next();});},
 function(next){transfers.transfer(A,{direction:'out',amount:'20',requestId:'delete-test-transfer-out',taskVersion},function(e){next(e);});},
 function(next){deletion.remove(A,{confirm:true,generation},function(e){next(e);});},
 function(next){tasks.save({wallet:A,name:'A again',fundingMode:'dedicated',allocation:'500',copyPercent:'100',maxOrderAmount:null},function(e){next(e);});},
 function(next){transfers.transfer(A,{direction:'in',amount:'20',requestId:'delete-test-transfer'},function(e){assert.match(e.message,/已删除/);next();});},
 function(next){db.query('SELECT a.cash::text,(SELECT SUM(delta)::text FROM paper_cash_ledger) ledger,(SELECT COUNT(*)::int FROM paper_markets WHERE id=$1) market FROM paper_accounts a WHERE id=$2',['shared-market','paper'],next);},
 function(rows,next){assert.ok(D(rows[0].cash).eq(rows[0].ledger));assert.equal(rows[0].market,1,'Other person still uses the shared market');next();}
],cleanup);
let cleaning=false;process.once('uncaughtException',cleanup);
function cleanup(err){if(cleaning)return;cleaning=true;db.close(function(closeErr){function finish(dropErr){admin.end(function(){const e=err||closeErr||dropErr;if(e){console.error(e.stack);process.exitCode=1;}else console.log('Task deletion passed: paused/completed/empty-cash guards, details removed, global cash/PnL/day preserved, B/shared-market isolated, old BUY/SELL blocked, recreation and retired-transfer protection. Disposable DB removed.');});}if(created&&/^polymarket_delete_test_\d+$/.test(name))admin.query('DROP DATABASE "'+name+'"',finish);else finish();});}
