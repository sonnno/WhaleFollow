// All mutations are confined to this newly created disposable database.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg');
const s=require('../config/DBsettings'),name='polymarket_onboarding_test_'+Date.now()+process.pid;
if(!/^polymarket_onboarding_test_\d+$/.test(name)||name===s.POSTGRES_DATABASE)throw Error('Unsafe test database');
const db=require('../server/db/adapter').create({database:name}),setup=require('../server/service/task-onboarding-service').create(db),tasks=require('../server/service/follow-task-service').create(db),transfers=require('../server/service/follow-transfer-service').create(db),deletion=require('../server/service/task-deletion-service').create(db);
const admin=new Client({host:s.POSTGRES_HOST,port:s.POSTGRES_PORT,user:s.POSTGRES_USER,password:s.POSTGRES_PASSWORD,database:'postgres'});
let created=false,closing=false,winner,retiredVersion;
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40),C='0x'+'c'.repeat(40);
function input(wallet,extra){return{wallet,name:'Disposable '+wallet[2],fundingMode:'dedicated',allocation:'350',copyPercent:'0.08484',maxOrderAmount:null,initialTransferAmount:'200',requestId:'setup-'+wallet,taskVersion:'initial',start:true,...extra};}
function finish(error){if(closing)return;closing=true;db.close(function(closeError){if(created)admin.query('DROP DATABASE "'+name+'"',function(dropError){admin.end(function(){if(error||closeError||dropError){console.error((error||closeError||dropError).stack);process.exitCode=1;}else console.log('Onboarding PG passed: atomic create/fund/start, failed journal rollback, competing budget isolation, duplicate create/start do not modify running task, idempotent retry without restart, save-only, deletion retirement. Disposable database removed.');});});else admin.end();});}
process.once('uncaughtException',finish);
async.waterfall([
 function(next){admin.connect(function(err){next(err);});},
 function(next){admin.query('CREATE DATABASE "'+name+'"',function(err){created=!err;next(err);});},
 function(next){db.connect(function(err){next(err);});},
 function(next){db.query('SELECT current_database() name',[],next);},
 function(rows,next){assert.equal(rows[0].name,name);db.migrate(function(err){next(err);});},
 function(next){db.insert('Account',{id:'paper',initialCash:'350',cash:'350',realized:'0',fees:'0'},function(err){next(err);});},
 function(next){tasks.initialize(function(err){next(err);});},
 function(next){db.query(`CREATE FUNCTION fail_initial_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test journal failure'; END $$; CREATE TRIGGER fail_initial_journal BEFORE INSERT ON paper_follow_fund_transfers FOR EACH ROW EXECUTE FUNCTION fail_initial_journal()`,[],function(err){next(err);});},
 function(next){setup.setup(input(C),function(err){assert.match(err.message,/test journal failure/);tasks.list(next);});},
 function(list,next){assert.equal(list.data.length,0);assert.equal(Number(list.wallet.cash),350);db.query('DROP TRIGGER fail_initial_journal ON paper_follow_fund_transfers; DROP FUNCTION fail_initial_journal()',[],function(err){next(err);});},
 function(next){async.parallel([A,B].map(function(wallet){return function(cb){setup.setup(input(wallet),function(err,row){cb(null,{err,row,wallet});});};}),next);},
 function(results,next){const ok=results.filter(r=>!r.err);assert.equal(ok.length,1);winner=ok[0].wallet;assert.equal(Number(ok[0].row.cash),200);assert.equal(ok[0].row.state,'running');assert.equal(results.find(r=>r.err).err.status,409);tasks.list(next);},
 function(list,next){assert.equal(list.data.length,1);assert.equal(Number(list.wallet.unallocatedCash),150);assert.equal(Number(list.wallet.cash),350);db.one('FollowTask',{where:{id:winner}},function(err,before){if(err)return next(err);tasks.control(winner,{action:'start'},function(err){assert.equal(err.status,409);tasks.save({...input(winner),operation:'create',copyPercent:'99'},function(err){assert.equal(err.status,409);db.one('FollowTask',{where:{id:winner}},function(err,after){if(err)return next(err);assert.deepEqual(after,before);tasks.control(winner,{action:'pause'},function(err){next(err);});});});});});},
 function(next){setup.setup(input(winner),next);},
 function(row,next){assert.equal(row.duplicate,true);db.one('FollowTask',{where:{id:winner}},next);},
 function(task,next){assert.equal(task.state,'paused');assert.equal(Number(task.cash),200);setup.setup(input(C,{initialTransferAmount:'50',start:false}),next);},
 function(row,next){assert.equal(row.state,'paused');assert.equal(Number(row.cash),50);tasks.list(next);},
 function(list,next){assert.equal(Number(list.wallet.unallocatedCash),100);assert.equal(Number(list.wallet.cash),350);transfers.transfer(winner,{direction:'out',amount:'200',requestId:'test-withdraw-winner',taskVersion:'initial'},function(err){next(err);});},
 function(next){tasks.control(winner,{action:'stop'},next);},
 function(row,next){retiredVersion=String(row.generation);deletion.remove(winner,{confirm:true,generation:row.generation},next);},
 function(row,next){assert.equal(row.deleted,true);db.query('SELECT COUNT(*)::int count FROM paper_settings WHERE id LIKE $1',['task-onboarding:'+winner+':%'],next);},
 function(rows,next){assert.equal(rows[0].count,0);setup.setup(input(winner),function(err){assert.equal(err.status,409);setup.setup(input(winner,{requestId:'recreate-winner',initialTransferAmount:'10',taskVersion:retiredVersion}),next);});},
 function(row,next){assert.equal(row.state,'running');assert.equal(Number(row.cash),10);assert.notEqual(row.taskVersion,'initial');tasks.list(next);},
 function(list,next){assert.equal(Number(list.wallet.cash),350);assert.equal(Number(list.wallet.unallocatedCash),290);assert.equal(list.data.length,2);db.query('SELECT count(*)::int count FROM paper_follow_fund_transfers WHERE wallet=$1',[winner],next);},
 function(rows,next){assert.equal(rows[0].count,1);next();}
],finish);
