// Optional live public-data latency check. Trades exist only in a disposable paper DB.
const fs=require('node:fs'),async=require('async'),{Client}=require('pg'),WS=require('ws');
const settings=require('../config/DBsettings'),testName='polymarket_ws_shadow_'+Date.now();
settings.POSTGRES_DATABASE=testName;process.env.POSTGRES_DATABASE=testName;
const cfg=require('../config').paper;cfg.initialCash='1000';
const db=require('../server/db/adapter').create();
const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres'});
const agent=require('../server/lib/network-agent');
const redis=require('../server/lib/redis')();
// Keep all queue/book writes in the temporary namespace, leaving paper:* untouched.
const prefix='audit:'+testName+':';
const scopedRedis={set:function(k){const args=[prefix+k,...Array.from(arguments).slice(1)];redis.set.apply(redis,args);},get:function(k,cb){redis.get(prefix+k,cb);},lpush:function(k,id,cb){redis.lpush(prefix+k,id,cb);},rpop:function(k,cb){redis.rpop(prefix+k,cb);},del:function(k,cb){redis.del(prefix+k,cb);}};
const sources=require('../server/service/source-service').create(db),markets=require('../server/service/market-service').create(db,scopedRedis),paper=require('../server/service/paper-service').create(db,markets);
const worker=require('../server/service/worker-service').create(db,scopedRedis,null,sources,markets,paper,{});
const wallet='0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7';
let created=false,socket,ping,consume,dispatch,observing=true,ingesting=0,received=0,closing=false;
async.waterfall([
 cb=>admin.connect(e=>cb(e)),cb=>admin.query('CREATE DATABASE "'+testName+'"',e=>{created=!e;cb(e);}),cb=>db.connect(e=>cb(e)),cb=>db.migrate(e=>cb(e)),cb=>paper.initialize(e=>cb(e)),cb=>redis.connect(e=>cb(e)),
 cb=>db.insert('Leader',{id:wallet,name:'Shadow latency test',rank:1,pnl:'0',active:true,joinedAt:new Date(Date.now()-5000),inventory:{},inventoryValid:false,raw:{followGeneration:1,followFundingMode:'shared'}},e=>cb(e)),
 cb=>db.insert('FollowTask',{id:wallet,state:'running',generation:1,fundingMode:'shared',allocation:'1000',copyPercent:'0.08',startedAt:new Date(Date.now()-5000)},e=>cb(e))
],function(err){if(err)return cleanup(err);markets.start();consume=setInterval(()=>worker.consume(()=>{}),50);dispatch=setInterval(()=>worker.dispatch(()=>{}),1000);
 socket=new WS(cfg.activityWsUrl,{agent,handshakeTimeout:8000});socket.on('open',()=>{socket.send(JSON.stringify({action:'subscribe',subscriptions:[{topic:'activity',type:'trades'}]}));ping=setInterval(()=>{if(socket.readyState===WS.OPEN)socket.send('ping');},5000);console.log('Public shadow observation started; production tables and Redis keys are untouched.');});
 socket.on('error',e=>console.log('Shadow activity error: '+e.message));
 socket.on('message',data=>{if(!observing||received>=4)return;let m;try{m=JSON.parse(String(data));}catch(_){return;}const x=m.payload||{};if(m.topic!=='activity'||m.type!=='trades'||String(x.proxyWallet).toLowerCase()!==wallet||x.side!=='BUY')return;received++;ingesting++;sources.ingestWebsocket(x,{generation:1,receivedAt:new Date().toISOString(),receivedMonotonicMs:performance.now()},function(e){ingesting--;if(e)console.log('Shadow ingest: '+e.message);});});
 setTimeout(function(){observing=false;clearInterval(ping);socket.terminate();setTimeout(function(){finishObservation();},5000);},60000);
});
function finishObservation(){if(ingesting||worker.health.inFlight)return setTimeout(finishObservation,100);clearInterval(consume);clearInterval(dispatch);worker.stop(function(){db.query(`SELECT status,reason,details->'signal'->>'title' AS title,details->'timings' AS timings FROM paper_orders ORDER BY "createdAt"`,[],function(e,rows){if(!e){fs.writeFileSync(require('node:path').join(__dirname,'../../reports/paper-websocket-shadow-result.json'),JSON.stringify({at:new Date().toISOString(),received,orders:rows},null,2));console.log(JSON.stringify({received,orders:rows}));}cleanup(e);});});}
function cleanup(err){if(closing)return;closing=true;observing=false;clearInterval(consume);clearInterval(dispatch);clearInterval(ping);if(socket)socket.terminate();markets.stop();db.close(function(closeError){function end(dropError){function finish(redisError){redis.disconnect();if(agent)agent.destroy();admin.end(function(){const failure=err||closeError||dropError||redisError;if(failure){console.error(failure.stack);process.exitCode=1;}else console.log('Disposable shadow DB and Redis namespace removed.');});}function scan(cursor){redis.scan(cursor,'MATCH',prefix+'*','COUNT',1000,function(scanError,result){if(scanError)return finish(scanError);const names=result[1];if(names.some(k=>!k.startsWith(prefix)))return finish(new Error('Unexpected Redis namespace'));function proceed(e){if(e)return finish(e);if(result[0]!=='0')return scan(result[0]);finish();}if(names.length)return redis.del(names,proceed);proceed();});}scan(0);}if(created&&/^polymarket_ws_shadow_\d+$/.test(testName))admin.query('DROP DATABASE "'+testName+'"',end);else end();});}
