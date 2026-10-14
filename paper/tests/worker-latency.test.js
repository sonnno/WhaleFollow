const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const wsPath = require.resolve('ws'), realWs = require('ws');
class Socket extends EventEmitter { constructor() { super(); Socket.last = this; this.readyState = 1; this.sent = []; this.terminated = 0; } send(value) { this.sent.push(value); } ping() {} terminate() { this.terminated++; this.readyState = 3; } }
Socket.OPEN = 1;
require.cache[wsPath].exports = Socket;
const create = require('../server/service/worker-service').create;
require.cache[wsPath].exports = realWs;
const wallet = '0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7';
function fixture(t) {
  const timers = [], polls = [], inventories = [], queries = [];
  t.mock.method(global, 'setInterval', function (fn, ms) { timers.push({ fn, ms }); return {}; });
  t.mock.method(global, 'clearInterval', function () {});
  t.mock.method(require('../server/service/daily-report-service'), 'create', function () { return { runDue: function (cb) { cb(); } }; });
  const db = { one: function (_, __, cb) { cb(null, { id: wallet }); }, save: function (_, row, cb) { cb(null, row); }, query: function (sql, params, cb) { queries.push(sql); cb(null, []); } };
  const redis = { rpop: function (_, cb) { cb(null, null); }, del: function (_, cb) { cb(); } };
  const leaders = { tracked: function (cb) { cb(null, [{ id: wallet }]); }, refresh: function (cb) { cb(); }, inventory: function (_, cb) { inventories.push(cb); } };
  let listener;
  const sources = { poll: function (_, cb) { polls.push(cb); }, onSignal: function (fn) { listener = fn; } };
  const markets = { start: function () {}, stop: function () {}, onResolved: function () {}, resolutions: function (cb) { cb(null, []); }, mark: function (cb) { cb(); }, schedules: function (cb) { cb(); }, health: {} };
  const paper = { initialize: function (cb) { cb(); } }, dashboard = { snapshot: function (cb) { cb(); } };
  const worker = create(db, redis, leaders, sources, markets, paper, dashboard);
  worker.start(function (err) { assert.ifError(err); });
  t.after(function () { worker.stop(function () {}); });
  return { socket: Socket.last, db, redis, paper, dashboard, leaders, sources, markets, worker, polls, inventories, queries, timers, notify: function (signal) { assert.equal(typeof listener, 'function', 'new source signals must wake dispatch'); listener('new-intent', signal); }, notice: function () { Socket.last.emit('message', JSON.stringify({ topic: 'activity', type: 'trades', payload: { proxyWallet: wallet, timestamp: Date.now() / 1000 } })); } };
}

test('a committed WS signal starts copy without Redis delivery and duplicate admissions stay single', function (t, done) {
  const f = fixture(t), copied = [], signal = { id: 'new-intent', wallet, token: 'token', side: 'BUY', origin: 'websocket', fundingMode: 'dedicated' };
  f.db.query = function (_, params, cb) { assert.equal(params[0], 'new-intent'); cb(null, [{ id: 'new-intent', attempts: 0, payload: signal }]); };
  f.paper.copy = function (payload, cb) { copied.push(payload); };
  f.notify(signal); f.notify(signal);
  setImmediate(function () { assert.equal(copied.length, 1); assert.equal(copied[0].dispatchMode, 'direct'); done(); });
});

test('direct WS admission preserves earlier pending copy and source-confirmation barriers', function (t, done) {
  const f = fixture(t), queries = [];
  f.db.query = function (sql, _, cb) { queries.push(sql); cb(null, []); };
  f.paper.copy = function () { assert.fail('earlier pending copy must block direct admission'); };
  f.notify({ id: 'new-intent', wallet, token: 'token', side: 'BUY', origin: 'websocket' });
  setImmediate(function () { assert.ok(queries.some(function(sql) { return sql.includes('j.id=$1') && sql.includes('source-confirmation'); })); done(); });
});

test('direct reservation prevents delayed eligibility from racing Redis execution and uses persisted payload', function (t, done) {
  const f = fixture(t), reads = [], copied = [], signal = { id: 'new-intent', wallet, token: 'token', side: 'BUY', origin: 'websocket', fundingMode: 'dedicated' };
  const persisted = { id: 'new-intent', status: 'pending', attempts: 2, payload: { ...signal, refreshBook: true } };
  f.db.query = function (sql, params, cb) { assert.match(sql, /retryAt/); reads.push(cb); };
  f.redis.rpop = function (_, cb) { cb(null, 'new-intent'); };
  f.db.one = function (_, __, cb) { cb(null, persisted); };
  f.paper.copy = function (payload, cb) { copied.push(payload); };
  f.notify(signal); assert.equal(f.worker.health.inFlight, 1, 'direct admission is reserved before its eligibility callback');
  f.worker.consume(function (err) { assert.ifError(err); });
  assert.equal(reads.length, 1, 'Redis must skip the reserved intent before any eligibility read');
  setImmediate(function () {
    assert.equal(copied.length, 0, 'Redis cannot execute while direct eligibility owns the admission');
    reads[0](null, [persisted]);
    setImmediate(function () { assert.equal(copied.length, 1); assert.equal(copied[0].refreshBook, true, 'must use persisted payload instead of the notification snapshot'); done(); });
  });
});

test('failed direct eligibility releases the reservation for durable recovery', function (t, done) {
  t.mock.method(console, 'error', function () {});
  const f = fixture(t); let calls = 0;
  f.db.query = function (_, __, cb) { calls++; cb(calls === 1 ? new Error('temporary SQL failure') : null, []); };
  f.notify({ id: 'new-intent', wallet, token: 'token', side: 'BUY', origin: 'websocket' });
  assert.equal(f.worker.health.inFlight, 0);
  setImmediate(function () { assert.ok(calls >= 2, 'durable dispatch must be woken after failed direct admission'); done(); });
});

test('Redis skips an intent already owned by direct execution before taking a stale snapshot', function (t, done) {
  const f = fixture(t), signal = { id: 'new-intent', wallet, token: 'token', side: 'BUY', origin: 'websocket', fundingMode: 'dedicated' };
  const persisted = { id: 'new-intent', status: 'pending', attempts: 0, payload: signal }; let reads = 0, complete, copies = 0;
  f.db.query = function (sql, _, cb) { if (sql.includes('j.id=$1')) { reads++; return cb(null, [persisted]); } cb(null, []); };
  f.db.one = function (_, __, cb) { cb(null, persisted); };
  f.db.update = function (_, __, patch, cb) { Object.assign(persisted, patch); cb(); };
  f.redis.rpop = function (_, cb) { cb(null, 'new-intent'); }; f.redis.del = function (_, cb) { cb(); };
  f.paper.copy = function (_, cb) { copies++; complete = cb; };
  f.notify(signal);
  setImmediate(function () {
    f.worker.consume(function (err) { assert.ifError(err); });
    assert.equal(reads, 1, 'Redis must not start an eligibility snapshot for an already admitted direct intent');
    complete(null, { retry: true, order: { reason: 'STALE_BOOK' } });
    setImmediate(function () { assert.equal(copies, 1); assert.equal(persisted.attempts, 1); assert.equal(persisted.payload.refreshBook, true); done(); });
  });
});
test('slow inventory does not block discovering new trades', function (t) {
  const f = fixture(t);
  assert.equal(f.inventories.length, 1);
  assert.equal(f.polls.length, 1, 'trade polling must run while inventory HTTP request is pending');
});

test('a newly saved trader is polled and receives websocket wakeups without restarting', function (t, done) {
  const f = fixture(t), newcomer = '0x' + 'b'.repeat(40), seen = [], inventories = [];
  f.polls[0](); f.inventories[0]();
  f.leaders.tracked = function (cb) { cb(null, [{ id: newcomer, raw: { followGeneration: 1 } }]); };
  f.leaders.inventory = function (leader, cb) { inventories.push(leader.id); cb(); };
  f.sources.poll = function (id, cb) { seen.push(id); cb(); };
  f.db.one = function (_, where, cb) { cb(null, { id: where.where.id }); };
  f.timers.find(function (timer) { return timer.ms === 1000; }).fn();
  assert.deepEqual(seen, [newcomer], 'DB roster replaces the static configured wallet filter');
  f.socket.emit('message', JSON.stringify({ topic: 'activity', type: 'trades', payload: { proxyWallet: newcomer, timestamp: Date.now() / 1000 } }));
  assert.deepEqual(seen, [newcomer, newcomer], 'new wallet notifications must immediately wake collection');
  setImmediate(function () { assert.ok(inventories.includes(newcomer), 'new control generation obtains an inventory baseline'); done(); });
});
test('a notification arriving during a poll triggers a follow-up poll', function (t, done) {
  const f = fixture(t);
  f.inventories[0]();
  if (!f.polls.length) f.timers.find(x => x.ms === 1000).fn();
  f.notice(); f.notice();
  assert.equal(f.polls.length, 1);
  f.polls[0]();
  setImmediate(function () { assert.equal(f.polls.length, 2, 'busy notifications must be coalesced, not discarded'); done(); });
});
test('committed source signal wakes dispatch without waiting for the timer', function (t, done) {
  const f = fixture(t), before = f.queries.length;
  f.notify(); f.notify();
  setImmediate(function () { assert.equal(f.queries.length, before + 1); done(); });
});

test('complete activity trade directly ingests while source REST is stalled',function(t){
 const f=fixture(t),received=[];
 f.sources.ingestWebsocket=function(payload,context,cb){received.push({payload,context});cb(null,{handled:true});};
 f.socket.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:{proxyWallet:wallet,transactionHash:'0x'+'a'.repeat(64),asset:'123',conditionId:'0x'+'b'.repeat(64),side:'BUY',size:10,price:0.5,timestamp:Math.floor(Date.now()/1000)}}));
 assert.equal(received.length,1,'WS must bypass the pending poll');assert.equal(f.polls.length,1,'complete BUY does not initiate another REST poll');assert.ok(received[0].context.receivedAt);
});

test('verified WS trade warms the same quote before slow source ingestion', function (t) {
 const f=fixture(t),events=[];
 f.db.one=function(_,__,cb){cb(null,{id:wallet,active:true,raw:{followGeneration:1}});};
 const warmPayloads=[];
 f.markets.warm=function(signal){events.push('warm');warmPayloads.push(signal);};
 f.sources.ingestWebsocket=function(_,__,cb){events.push('ingest');};
 f.socket.emit('message',JSON.stringify({topic:'activity',type:'trades',payload:{proxyWallet:wallet,transactionHash:'0x'+'a'.repeat(64),asset:'123',conditionId:'0x'+'b'.repeat(64),side:'BUY',size:10,price:0.5,timestamp:Math.floor(Date.now()/1000)}}));
 assert.deepEqual(events,['warm','ingest']);assert.equal(warmPayloads[0].token,'123');
});

test('dispatch selects only trading jobs and keeps source-confirmation barriers in ordering',function(t,done){
 const f=fixture(t);f.worker.dispatch(function(e){assert.ifError(e);const sql=f.queries.at(-1);assert.match(sql,/j.kind\s*=\s*'copy'/);assert.match(sql,/source-confirmation/);done();});
});

test('portfolio snapshot cannot hold a completed copy execution slot', function (t, done) {
  const f = fixture(t);
  f.redis.rpop = function (_, cb) { cb(null, 'intent'); };
  f.redis.del = function (_, cb) { cb(); };
  f.db.one = function (_, __, cb) { cb(null, { id: 'intent', status: 'pending', attempts: 0, payload: { token: 'token' } }); };
  f.db.query = function (_, __, cb) { cb(null, [{ id: 'intent', attempts: 0, payload: { token: 'token' } }]); };
  f.db.update = function (_, __, ___, cb) { cb(); };
  f.paper.copy = function (_, cb) { cb(null, { fill: {} }); };
  f.dashboard.snapshot = function () {};
  f.worker.consume(function (err) { assert.ifError(err); });
  setImmediate(function () { assert.equal(f.worker.health.inFlight, 0, 'completed fills must release execution capacity independently of reporting'); done(); });
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

test('backoff ticks do not flood stderr while the actual network error is still logged', function (t) {
  const messages = []; t.mock.method(console, 'error', function (value) { messages.push(value); });
  const f = fixture(t);
  f.polls[0](Object.assign(new Error('Polymarket backoff active'), { code: 'POLYMARKET_BACKOFF', retryAfterMs: 5000 }));
  assert.equal(messages.length, 0);
  f.notice(); f.polls[1](new Error('TLS connection interrupted'));
  assert.equal(messages.length, 1); assert.match(messages[0], /TLS connection interrupted/);
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
