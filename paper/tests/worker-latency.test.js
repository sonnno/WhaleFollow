const test = require('node:test'), assert = require('node:assert/strict'), EventEmitter = require('node:events');
const wsPath = require.resolve('ws'), realWs = require('ws');
class Socket extends EventEmitter { constructor() { super(); Socket.last = this; this.readyState = 1; this.sent = []; this.terminated = 0; } send(value) { this.sent.push(value); } terminate() { this.terminated++; this.readyState = 3; } }
Socket.OPEN = 1; require.cache[wsPath].exports = Socket;
const create = require('../server/service/worker-service').create; require.cache[wsPath].exports = realWs;
const wallet = '0x'+'a'.repeat(40);
function fixture(t, options) {
  const timers=[],queries=[],copied=[];
  t.mock.method(global,'setInterval',function(fn,ms){timers.push({fn,ms});return {};}); t.mock.method(global,'clearInterval',function(){});
  const db={query:function(sql,params,cb){queries.push(sql);cb(null,[]);},save:function(_,row,cb){cb(null,row);},one:function(){assert.fail('A fresh notification cannot read leader from DB');}};
  const markets={start:function(){},stop:function(){},onResolved:function(){},resolutions:function(cb){cb(null,[]);},mark:function(cb){cb();},schedules:function(cb){cb();},health:{}};
  const controls={get:function(){return {leader:{id:wallet,active:true,raw:{followGeneration:1}},task:{generation:1}};},invalidate:function(){},refresh:function(cb){cb();}};
  const paper={initialize:function(cb){cb();},copy:function(signal,cb){copied.push(signal);cb(null,{order:{details:{timings:{receivedToExecutionMs:0}}},fill:{}});}};
  const leaders={refresh:function(cb){cb();}},dashboard={snapshot:function(cb){cb();}};
  const worker=create(db,{},leaders,markets,paper,dashboard,{controls,dailyReports:{runDue:function(cb){cb();}},...options});
  worker.start(function(err){assert.ifError(err);}); t.after(function(){worker.stop(function(){});});
  const payload={proxyWallet:wallet,transactionHash:'0x'+'b'.repeat(64),asset:'123',conditionId:'0x'+'c'.repeat(64),side:'BUY',size:10,price:0.5,outcomeIndex:0,timestamp:Math.floor(Date.now()/1000)};
  function notice(){Socket.last.emit('message',JSON.stringify({topic:'activity',type:'trades',payload}));}
  return {worker,socket:Socket.last,timers,queries,copied,paper,controls,notice,payload};
}
test('fresh complete WS executes directly without source ingestion or database eligibility',function(t){
 const f=fixture(t),before=f.queries.length;f.notice();assert.equal(f.copied.length,1);assert.equal(f.queries.length,before);assert.equal(f.copied[0].sourceAmount,'5');assert.equal(f.copied[0].origin,'websocket');assert.ok(f.copied[0].timing);
});
test('messages are not held behind previous same-token persistence or an admission lookup',function(t){
 const f=fixture(t);f.paper.copy=function(signal){f.copied.push(signal);};f.notice();f.notice();assert.equal(f.copied.length,2);assert.equal(f.copied[0].id,f.copied[1].id,'same payload keeps the same record identity without a preexecution lookup');
});
test('startup retires previous copy jobs and does not register historical dispatch timers',function(t){
 const f=fixture(t);assert.ok(f.queries.some(function(sql){return sql.includes('ORDER_BACKFILL_REMOVED')&&sql.includes('paper_outbox');}));assert.equal(f.worker.dispatch,undefined);assert.equal(f.worker.consume,undefined);assert.equal(f.timers.some(function(x){return x.ms===50;}),false);assert.equal(f.copied.length,0);
});
test('a trader already present in the refreshed control snapshot needs no separate roster lookup',function(t){
 const f=fixture(t);f.notice();assert.equal(f.copied[0].wallet,wallet);
});
test('partial notifications do not generate historical catch-up work',function(t){
 const f=fixture(t),before=f.queries.length;f.socket.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:{proxyWallet:wallet}}));assert.equal(f.copied.length,0);assert.equal(f.queries.length,before);
});
test('a socket with no activity trades for one minute is disconnected for recovery', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  t.mock.method(console, 'error', function () {});
  const f = fixture(t); f.socket.emit('open');
  assert.equal(f.worker.health.activityConnected, true);
  now += 60001;
  f.socket.emit('message', 'pong');
  f.timers.filter(x => x.ms === 5000).at(-1).fn();
  assert.equal(f.socket.terminated, 1, 'PONG alone cannot prove the subscribed trade feed is alive');
  assert.equal(f.worker.health.activityConnected, false);
});

test('receiving activity trades keeps an active socket alive', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(t); f.socket.emit('open'); now += 50000; f.notice(); now += 20000;
  f.timers.filter(x => x.ms === 5000).at(-1).fn();
  assert.equal(f.socket.terminated, 0);
  assert.equal(f.worker.health.activityConnected, true);
});

test('reconnect attempts back off and reset when the trade feed recovers', function (t) {
  const reconnects = [];
  t.mock.method(global, 'setTimeout', function (fn, ms) { reconnects.push({ fn, ms }); return {}; });
  t.mock.method(global, 'clearTimeout', function () {});
  const f = fixture(t);
  f.socket.emit('close'); assert.equal(reconnects[0].ms, 3000);
  reconnects[0].fn(); Socket.last.emit('close'); assert.equal(reconnects[1].ms, 6000);
  reconnects[1].fn(); Socket.last.emit('message', JSON.stringify({ topic: 'activity', type: 'trades', payload: {} }));
  Socket.last.emit('close'); assert.equal(reconnects[2].ms, 3000);
});
