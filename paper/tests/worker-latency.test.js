const test = require('node:test'), assert = require('node:assert/strict'), EventEmitter = require('node:events');
const wsPath = require.resolve('ws'), realWs = require('ws');
class Socket extends EventEmitter { constructor() { super(); Socket.last = this; this.readyState = 1; this.sent = []; this.terminated = 0; } send(value,cb) { this.sent.push(value);if(cb)cb(); } terminate() { this.terminated++; this.readyState = 3; } }
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
  return {worker,socket:Socket.last,timers,queries,copied,paper,controls,markets,notice,payload};
}
test('fresh complete WS executes directly without source ingestion or database eligibility',function(t){
 const f=fixture(t),before=f.queries.length;f.notice();assert.equal(f.copied.length,1);assert.equal(f.queries.length,before);assert.equal(f.copied[0].sourceAmount,'5');assert.equal(f.copied[0].origin,'websocket');assert.ok(f.copied[0].timing);assert.equal(f.worker.health.activityCopyFilled,1);
});
test('source-position tracker observes deduplicated trades including inactive BUYs before copy',function(t){
 const seen=[],events=[];const tracker={refresh:cb=>cb(),observe:(signal)=>{seen.push(signal.side);events.push('observe');return{mode:'leader_fraction',fraction:'0.3'};},invalidate:()=>{},stop:()=>{},health:{version:1}};
 const f=fixture(t,{sourcePositions:tracker});const copy=f.paper.copy;f.paper.copy=(s,cb)=>{events.push('copy');copy(s,cb);};
 f.notice();f.notice();assert.deepEqual(seen,['BUY']);assert.deepEqual(events,['observe','copy']);
 const get=f.controls.get;f.controls.get=()=>({...get(),leader:{id:wallet,active:false}});f.payload.size=11;f.notice();assert.deepEqual(seen,['BUY','BUY']);assert.equal(f.copied.length,1);
 f.payload.side='SELL';f.notice();assert.deepEqual(seen,['BUY','BUY','SELL']);assert.equal(f.copied.at(-1).saleSizing.fraction,'0.3');
});
test('source-position reads are background only, with gaps invalidating confidence',function(t){
 let refreshes=0,invalidations=0,stops=0,now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(console,'error',()=>{});
 const tracker={refresh:cb=>{refreshes++;cb();},observe:()=>null,invalidate:()=>{invalidations++;},stop:()=>{stops++;},health:{version:1}};
 const f=fixture(t,{sourcePositions:tracker});const initial=refreshes;f.notice();assert.equal(refreshes,initial);f.socket.emit('open');now+=11000;f.timers.filter(x=>x.ms===5000).at(-1).fn();assert.ok(invalidations>0);
 f.worker.stop(()=>{});assert.equal(stops,1);
});
test('missing execution snapshots invalidate source holdings before returning',function(t){
 const reasons=[],tracker={refresh:cb=>cb(),observe:()=>assert.fail('cannot observe without task identity'),invalidate:r=>reasons.push(r),stop:()=>{},health:{version:1}};
 const f=fixture(t,{sourcePositions:tracker});f.controls.peek=()=>null;f.notice();assert.deepEqual(reasons,['SOURCE_CONTROL_UNAVAILABLE']);assert.equal(f.copied.length,0);
});
test('executed SELL receipt is reported as filled even if bookkeeping fails',function(t){
 const logs=[];t.mock.method(console,'error',(...x)=>logs.push(x.join(' ')));
 const sizing={mode:'leader_fraction',quantity:'2'},tracker={refresh:cb=>cb(),observe:()=>sizing,invalidate:()=>{},stop:()=>{},health:{}};
 const journal={count:()=>0,append:()=>{}};const f=fixture(t,{sourcePositions:tracker,receiptJournal:journal});
 f.paper.copy=(s,cb)=>cb(Object.assign(Error('ledger unavailable'),{executedOrder:{order:{id:s.id,details:{saleSizing:sizing}},fill:{quantity:'2'}}}));
 f.payload.side='SELL';f.notice();assert.equal(f.worker.health.lastSaleCopy.filledQuantity,'2');assert.equal(logs.some(x=>x.includes('sale-copy-skipped')),false);
});
test('messages are not held behind previous same-token persistence or an admission lookup',function(t){
 const f=fixture(t);f.paper.copy=function(signal){f.copied.push(signal);};f.notice();f.notice();assert.equal(f.copied.length,1);f.payload.size=11;f.notice();assert.equal(f.copied.length,2);assert.notEqual(f.copied[0].id,f.copied[1].id);
});

test('startup retires previous copy jobs and does not register historical dispatch timers',function(t){
 const f=fixture(t);assert.ok(f.queries.some(function(sql){return sql.includes('ORDER_BACKFILL_REMOVED')&&sql.includes('paper_outbox');}));assert.equal(f.worker.dispatch,undefined);assert.equal(f.worker.consume,undefined);assert.equal(f.timers.some(function(x){return x.ms===50;}),false);assert.equal(f.copied.length,0);
});
test('a trader already present in the refreshed control snapshot needs no separate roster lookup',function(t){
 const f=fixture(t);f.notice();assert.equal(f.copied[0].wallet,wallet);
});

test('an empty settlement poll does not invalidate otherwise usable trading balances', function (t) {
  const f = fixture(t); let invalidations = 0;
  f.controls.invalidate = function () { invalidations++; };
  f.timers.find(function (timer) { return timer.ms === require('../config').paper.settlementSeconds * 1000; }).fn();
  assert.equal(invalidations, 0, 'no account changed when no resolved market was settled');
});

test('settlement of a fenced market refreshes balances without discarding unrelated new trades', function (t) {
  const f = fixture(t); let invalidations = 0, refreshes = 0;
  f.controls.invalidate = function () { invalidations++; };
  f.controls.refresh = function (cb) { refreshes++; cb(); };
  f.markets.resolutions = function (cb) { cb(null, [{ status: 'resolved', condition_id: 'closed-market' }]); };
  f.paper.settle = function (_, __, cb) { cb(); };
  f.timers.find(function (timer) { return timer.ms === require('../config').paper.settlementSeconds * 1000; }).fn();
  assert.equal(invalidations, 0); assert.equal(refreshes, 1); f.notice(); assert.equal(f.copied.length, 1);
});
test('partial notifications do not generate historical catch-up work',function(t){
 const f=fixture(t),before=f.queries.length;f.socket.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:{proxyWallet:wallet}}));assert.equal(f.copied.length,0);assert.equal(f.queries.length,before);
});
test('a silent old socket stays available until its replacement proves delivery', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  t.mock.method(console, 'error', function () {});
  const f = fixture(t); f.socket.emit('open');
  assert.equal(f.worker.health.activityConnected, true);
  now += 60001;
  f.socket.emit('message', 'pong');
  f.timers.filter(x => x.ms === 5000).at(-1).fn();
  assert.equal(f.socket.terminated, 0, 'do not drop the old stream before a replacement delivers');
  assert.equal(f.worker.health.activityConnected, false);
  const replacement=Socket.last;replacement.emit('open');replacement.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:f.payload}));
  assert.equal(f.socket.terminated,1);assert.equal(f.worker.health.activityConnected,true);
});

test('receiving activity trades keeps an active socket alive', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(t); f.socket.emit('open'); now += 50000; f.notice(); now += 20000;
  f.timers.filter(x => x.ms === 5000).at(-1).fn();
  assert.equal(f.socket.terminated, 0);
  assert.equal(f.worker.health.activityConnected, true);
});

test('ten seconds of global feed silence starts overlap instead of waiting a minute',function(t){
 let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(console,'error',()=>{});
 const f=fixture(t);f.socket.emit('open');now+=11000;
 f.timers.filter(x=>x.ms===5000).at(-1).fn();
 const replacement=Socket.last;assert.notEqual(replacement,f.socket);assert.equal(f.socket.terminated,0);
 assert.equal(f.worker.health.activityGaps.length,1);assert.equal(f.worker.health.activityGaps[0].silenceMs,11000);
 replacement.emit('open');replacement.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:f.payload}));
 assert.equal(f.socket.terminated,1);assert.equal(f.copied.length,1);assert.equal(f.worker.health.activityHandovers,1);
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

test('failed persistence recovers bookkeeping before following only new notifications', function (t) {
  const records = [], flushed = [], completed = []; let fail = true;
  t.mock.method(console, 'error', function () {});
  const journal = { count: () => records.length, append: receipt => records.push(receipt), flush: function (record, recorded, cb) {
    if (fail) return cb(Error('database unavailable'));
    const value = records[0]; record(value, function (err) { if (err) return cb(err); recorded(value); records.shift(); cb(); });
  } };
  const recoverySteps = [];
  const f = fixture(t, { receiptJournal: journal, matchRatios: {start:function(cb){recoverySteps.push('restore-ratios');cb();}} }); let copies = 0;
  f.controls.complete = id => completed.push(id); f.controls.resume = cb => {recoverySteps.push('resume');cb();};
  f.paper.copy = function (signal, cb) { copies++; cb(Object.assign(Error('database unavailable'), { executedOrder: { order: { id: signal.id }, fill: { cash: '1' } } })); };
  f.paper.recordExecuted = function (record, cb) { flushed.push(record); cb(); };
  f.notice(); assert.equal(f.worker.health.executionHalted, true); f.notice(); assert.equal(copies, 1);
  f.worker.recordReceipts(function (err) { assert.ok(err); }); assert.equal(records.length, 1);
  fail = false; f.worker.recordReceipts(function (err) { assert.ifError(err); });
  assert.equal(f.worker.health.executionHalted, false); assert.equal(records.length, 0); assert.equal(flushed.length, 1); assert.equal(completed.length, 1); assert.equal(copies, 1, 'recording must never call copy');
  assert.deepEqual(recoverySteps,['restore-ratios','resume'],'legacy receipts have no ratio metadata; reconstruct from recorded history before resuming');
  f.payload.size=11; f.notice(); assert.equal(copies, 2, 'only a distinct new fill executes again');
});

test('orders_matched races trades and keeps full publication telemetry',function(t){
 const f=fixture(t),timestamp=Date.now()-100;f.socket.emit('message',JSON.stringify({topic:'activity',type:'orders_matched',timestamp,payload:f.payload}));f.notice();assert.equal(f.copied.length,1);assert.equal(f.copied[0].feed.type,'orders_matched');assert.equal(f.copied[0].feed.publishedAtMs,timestamp);assert.ok(Number.isFinite(f.copied[0].feed.rawReceivedAtMs));assert.ok(Number.isFinite(f.copied[0].feed.transitMs));
});

test('admission uses peek and missing snapshots are counted',function(t){
 const f=fixture(t);f.controls.peek=function(){return null;};f.controls.get=function(){assert.fail('deep snapshot on admission');};f.notice();assert.equal(f.copied.length,0);assert.equal(f.worker.health.activitySkips.snapshotUnavailable,1);
});

test('persistently delayed delivery overlaps until replacement delivers a valid subscribed activity',function(t){
 const f=fixture(t),old=f.socket;old.emit('open');
 for(let i=0;i<3;i++)old.emit('message',JSON.stringify({topic:'activity',type:'orders_matched',timestamp:Date.now()-6000,payload:f.payload}));
 const next=Socket.last;assert.notEqual(next,old);assert.equal(old.terminated,0);assert.equal(f.copied.length,1);
 next.emit('open');assert.equal(old.terminated,0);assert.equal(JSON.parse(next.sent[0]).subscriptions.length,2);next.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:{}}));assert.equal(old.terminated,0);
 next.emit('message',JSON.stringify({topic:'activity',type:'trades',timestamp:Date.now(),payload:f.payload}));assert.equal(f.copied.length,1);assert.equal(old.terminated,1);assert.equal(f.worker.health.activityHandovers,1);
});

test('source publication delay alone does not replace a healthy connection',function(t){
 const f=fixture(t),old=f.socket;for(let i=0;i<4;i++)old.emit('message',JSON.stringify({topic:'activity',type:'trades',timestamp:Date.now(),payload:{...f.payload,timestamp:Math.floor(Date.now()/1000)-100}}));assert.equal(Socket.last,old);assert.equal(f.worker.health.activityDelayedReconnects,undefined);
});

test('a failed replacement leaves the old subscription connected and cleans up sockets on stop',function(t){
 t.mock.method(console,'error',function(){});const f=fixture(t),old=f.socket;old.emit('open');for(let i=0;i<3;i++)old.emit('message',JSON.stringify({topic:'activity',type:'trades',timestamp:Date.now()-6000,payload:f.payload}));const next=Socket.last;next.emit('error',Error('handshake failed'));next.emit('close');assert.equal(f.worker.health.activityConnected,true);assert.equal(old.terminated,0);f.worker.stop(function(){});assert.equal(f.worker.health.activityConnected,false);assert.ok(old.terminated>0);
});

 test('failed replacement is cooled down while new fills execute immediately',function(t){
 let now=Date.now();const published=now-6000;t.mock.method(Date,'now',function(){return now;});const f=fixture(t),old=f.socket;
 function stale(){old.emit('message',JSON.stringify({topic:'activity',type:'trades',timestamp:published,payload:f.payload}));}
 stale();stale();stale();const next=Socket.last;next.emit('close');f.payload.size=12;stale();assert.equal(Socket.last,next);assert.equal(f.copied.length,2);now+=30001;stale();assert.notEqual(Socket.last,next);
 });
 test('primary close waits for pending replacement and subscription timeout recovers once',function(t){
 const pending=[];t.mock.method(global,'setTimeout',function(fn,ms){const x={fn,ms};pending.push(x);return x;});t.mock.method(global,'clearTimeout',function(){});
 const f=fixture(t),old=f.socket;old.emit('open');for(let i=0;i<3;i++)old.emit('message',JSON.stringify({topic:'activity',type:'trades',timestamp:Date.now()-6000,payload:f.payload}));const next=Socket.last;old.emit('close');assert.equal(pending.filter(x=>x.ms===3000).length,0);next.emit('open');const timeout=pending.find(x=>x.ms===15000);assert.ok(timeout);timeout.fn();next.emit('close');assert.equal(pending.filter(x=>x.ms===3000).length,1);
 });
 test('loop histogram is sampled and reset at health interval, not per global notification',function(t){
 let samples=0,resets=0;const loop={mean:1e6,max:3e6,percentile:function(){samples++;return 2e6;},enable:function(){},disable:function(){},reset:function(){resets++;}};
 const f=fixture(t,{eventLoopMonitor:loop}),before=samples;f.controls.peek=function(){return null;};f.notice();f.notice();assert.equal(samples,before);f.timers.filter(x=>x.ms===5000).at(-1).fn();assert.ok(resets>=2);assert.equal(f.worker.health.eventLoop.p99Ms,2);
 });

test('untracked global wallets bypass normalization while tracked missing snapshots retain diagnostics',function(t){
 const f=fixture(t);f.controls.tracks=function(){return false;};f.controls.peek=function(){assert.fail('untracked admission');};f.notice();assert.equal(f.worker.health.activitySkips.untrackedWallet,1);assert.equal(f.worker.health.activitySkips.snapshotUnavailable,undefined);
 f.controls.tracks=function(){return true;};f.controls.peek=function(){return null;};f.notice();assert.equal(f.worker.health.lastActivitySkip.reason,'snapshotUnavailable');assert.equal(f.worker.health.lastActivitySkip.tx,f.payload.transactionHash);assert.ok(f.worker.health.lastActivitySkip.feed);
});
