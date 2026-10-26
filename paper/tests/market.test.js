const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const service = require('../server/service/market-service');

function fixture(options) {
  let socket, reads = 0, metadataReads = 0; const cacheWrites = [];
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 1; }
    send() {}
    terminate() { this.emit('close'); }
  }
  const db = { save: function (_, value, cb) { cb(null, value); }, query: function (_, __, cb) { cb(null, []); } };
  const redis = { get: function (_, cb) { cb(null, null); }, set: function (_, value) { cacheWrites.push(JSON.parse(value)); } };
  const http = { request: function (_, route, __, cb) {
    if (route === '/book') { reads++; return cb(null, { bids: [{ price: '0.4', size: '50' }], asks: [{ price: '0.5', size: '50' }], hash: 'snapshot' }); }
    if (route === '/markets') return cb(null, options && options.marketResponse || [{ conditionId: 'condition', active: true, closed: false, acceptingOrders: true }]);
    metadataReads++; cb(null, { t: [{ t: 'token' }, { t: 'other' }], fd: { r: 0, e: 1 }, mos: 1 });
  } };
  const markets = service.create(db, redis, { http, WebSocket: Socket });
  markets.start(); socket.emit('open');
  return { markets, socket, cacheWrites, reads: function () { return reads; }, metadataReads: function () { return metadataReads; } };
}
const signal = { condition: 'condition', token: 'token', outcomeIndex: 0 };

test('concurrent live metadata misses share one request and finish before optional SQL',function(_,done){
 let requests=0,respond;const events=[];
 const markets=service.create({query(sql,args,cb){events.push('sql');cb(null,[]);}}, {}, {http:{request(base,route,args,cb){requests++;respond=cb;}}});
 let callbacks=0;function ready(err){assert.ifError(err);assert.ok(markets.policyMarket(signal));events.push('ready');if(++callbacks===2){assert.equal(requests,1);assert.deepEqual(events,['ready','ready']);assert.equal(markets.health.policyWaits,2);assert.equal(markets.health.policyWaitSuccesses,2);setImmediate(()=>setImmediate(()=>{assert.ok(events.includes('sql'));markets.stop();done();}));}}
 markets.ensurePolicy(signal,ready);markets.ensurePolicy(signal,ready);
 setImmediate(()=>respond(null,[{conditionId:'condition',gameStartTime:'2026-10-27T00:00:00Z',sportsMarketType:'moneyline',active:true,closed:false,acceptingOrders:true}]));
});

test('live policy promotion overtakes queued background warmup and bypasses failed warmup cooldown',function(_,done){
 const requests=[],pending=new Map();const markets=service.create({query(sql,args,cb){cb(null,[]);}}, {}, {http:{request(base,route,args,cb){requests.push(args.condition_ids);pending.set(args.condition_ids,cb);}}});
 markets.warmPolicy({condition:'a'});markets.warmPolicy({condition:'b'});
 setImmediate(()=>{assert.deepEqual(requests,['a','b']);markets.warmPolicy({condition:'background'});markets.warmPolicy({condition:'live'});
 let retries=0;markets.ensurePolicy({condition:'live'},function ready(err){if(err){retries++;return markets.ensurePolicy({condition:'live'},ready);}assert.equal(retries,1);markets.stop();done();});
 pending.get('a')(null,[{conditionId:'a'}]);setImmediate(()=>{assert.equal(requests[2],'live');pending.get('live')(Error('temporary'));setImmediate(()=>{assert.equal(requests[3],'live');pending.get('live')(null,[{conditionId:'live'}]);});});});
});

test('sports policy reads memory only and warmup preserves explicit game start and state', function (_, done) {
  const f = fixture({ marketResponse: [{ conditionId: 'condition', gameStartTime: '2026-10-20T12:00:00Z', sportsMarketType: 'moneyline', active: true, closed: false, acceptingOrders: true, question: 'A vs. B', events: [{ slug: 'a-b', title: 'A vs. B' }] }] });
  assert.equal(f.markets.policyMarket(signal), null);
  f.markets.warmPolicy(signal, function (err) {
    assert.ifError(err); const row = f.markets.policyMarket(signal);
    assert.equal(row.gameStartTime, '2026-10-20T12:00:00Z'); assert.equal(row.sportsMarketType, 'moneyline');
    assert.equal(row.eventTitle, 'A vs. B'); assert.equal(row.closed, false); f.markets.stop(); done();
  });
});

test('event identity is cached and returned before optional metadata persistence', function (_, done) {
  const events = [];
  const markets = service.create({ query: function (sql, args, cb) { events.push('write'); cb(null, []); } }, {}, { http: { request: function (_, route, params, cb) {
    events.push('request'); assert.equal(params.condition_ids, 'c'); cb(null, [{conditionId: 'c', events: [{slug: 'game-a'}]}]);
  } } });
  markets.identifyEvent({condition: 'c'}, function (err, event) {
    assert.ifError(err); assert.equal(event, 'game-a'); assert.deepEqual(events, ['request']);
    markets.identifyEvent({condition: 'c'}, function (error, cached) {
      assert.ifError(error); assert.equal(cached, 'game-a'); assert.deepEqual(events, ['request']);
      setImmediate(function () { setImmediate(function () { assert.deepEqual(events, ['request', 'write']); done(); }); });
    });
  });
});

test('bursty depth changes stay immediately tradable without serializing a full Redis book per change', function (t, done) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err); const writesBefore = f.cacheWrites.length;
    for (let i = 1; i <= 500; i++) f.socket.emit('message', JSON.stringify({ event_type: 'price_change', price_changes: [{ asset_id: 'token', side: 'SELL', price: i % 2 ? '0.5000' : '0.5', size: String(i) }] }));
    const quote = f.markets.latestQuote(signal);
    assert.equal(quote.book.asks.length, 1); assert.equal(quote.book.asks[0].size, '500');
    assert.ok(f.cacheWrites.length - writesBefore <= 1, 'market bursts must not enqueue hundreds of complete cache copies');
    t.mock.timers.tick(1000);
    assert.equal(f.cacheWrites.at(-1).asks[0].size, '500', 'background cache must receive the latest state');
    done();
  });
});

test('indexed depth deletion and replacement preserve consumed liquidity and distinct prices', function (t, done) {
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    function update(price, size) { f.socket.emit('message', JSON.stringify({ event_type: 'price_change', price_changes: [{ asset_id: 'token', side: 'SELL', price, size }] })); }
    update('0.6', '8'); update('0.7', '9'); update('0.500', '0'); update('0.7000', '11');
    f.markets.consume('token', 'BUY', [{ price: '0.7', quantity: '3' }]);
    update('0.60', '0'); update('0.5', '4');
    const levels = f.markets.latestQuote(signal).book.asks;
    assert.deepEqual(levels.map(function (row) { return [Number(row.price), row.size]; }).sort(), [[0.5, '4'], [0.7, '8']]);
    done();
  });
});

test('authoritative resolutions fence only the resolved market before accounting reload', function (_, done) {
  const markets = service.create({ query: function (sql, __, cb) { cb(null, sql.startsWith('SELECT') ? [{ condition: 'closed' }, { condition: 'open' }] : []); } }, {}, { http: { request: function (_, __, ___, cb) { cb(null, [{ condition_id: 'closed', status: 'resolved' }, { condition_id: 'open', status: 'pending' }, { condition_id: 'unrequested', status: 'resolved' }]); } } });
  markets.resolutions(function (err, rows) {
    assert.ifError(err); assert.equal(markets.isExecutable({ condition: 'closed', token: 'closed-token' }), false);
    assert.equal(markets.isExecutable({ condition: 'open', token: 'open-token' }), true);
    assert.equal(markets.isExecutable({ condition: 'unrequested', token: 'other-token' }), true);
    assert.equal(rows.length, 2); done();
  });
});

test('a depth retry refreshes only the book when fee parameters are cached', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err); now += 10000;
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'empty-live', asks: [], bids: [] }));
    const reads = f.reads(), params = f.metadataReads();
    f.markets.prepare({ ...signal, refreshBook: true }, function (error, quote) {
      assert.ifError(error); assert.equal(f.reads(), reads + 1); assert.equal(f.metadataReads(), params, 'failure retry must not wait for a redundant fee query');
      assert.equal(quote.book.asks[0].size, '50'); assert.equal(quote.book.refreshSnapshot.asks.executableLevels, 1); done();
    });
  });
});

test('a forced identical snapshot records official depth without refilling locally consumed liquidity', function (t, done) {
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err); f.markets.consume('token', 'BUY', [{ price: '0.5', quantity: '50' }]);
    f.markets.prepare({ ...signal, refreshBook: true }, function (error, quote) {
      assert.ifError(error); assert.equal(quote.book.asks[0].size, '0'); assert.equal(quote.book.refreshSnapshot.asks.quantity, 50); done();
    });
  });
});

test('healthy full-book WS snapshot executes after two seconds without any new REST request', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture();
  t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'live', asks: [{ price: '0.6', size: '20' }], bids: [{ price: '0.5', size: '20' }] }));
    now += 10000;
    const reads = f.reads();
    f.markets.prepare({ ...signal }, function (error, quote) {
      assert.ifError(error); assert.equal(f.reads(), reads, 'healthy WS snapshot must bypass arbitrary age refresh');
      assert.equal(quote.book.asks[0].price, '0.6'); assert.equal(quote.quoteSource, 'websocket-cache');
      f.markets.stop(); done();
    });
  });
});

test('a disconnected market stream cannot execute an old WS snapshot', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture();
  t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'live', asks: [{ price: '0.6', size: '20' }], bids: [] }));
    now += 10000; const reads = f.reads(); f.markets.stop();
    f.markets.prepare({ ...signal }, function (error, quote) {
      assert.ifError(error); assert.ok(f.reads() > reads); assert.equal(quote.book.asks[0].price, '0.5'); done();
    });
  });
});

test('an open socket without traffic or PONG is not a live quote source', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'live', asks: [{ price: '0.6', size: '20' }], bids: [] }));
    now += 120000; const reads = f.reads();
    f.markets.prepare({ ...signal }, function (error, quote) { assert.ifError(error); assert.ok(f.reads() > reads, 'silent half-open stream must refresh'); assert.equal(quote.book.asks[0].price, '0.5'); done(); });
  });
});

test('PONG keeps a quiet unchanged full-book snapshot live without REST', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'live', asks: [{ price: '0.6', size: '20' }], bids: [] }));
    now += 120000; f.socket.emit('message', 'PONG'); const reads = f.reads();
    f.markets.prepare({ ...signal }, function (error, quote) { assert.ifError(error); assert.equal(f.reads(), reads); assert.equal(quote.quoteSource, 'websocket-cache'); done(); });
  });
});

test('execution joins an in-flight warm preparation without duplicate book or metadata HTTP', function (_, done) {
  const requests = [], callbacks = {};
  const markets = service.create({ query: function (_, __, cb) { cb(null, []); } }, { get: function (_, cb) { cb(null, null); }, set: function () {} }, { http: { request: function (_, route, __, cb) { requests.push(route); callbacks[route] = cb; } } });
  assert.equal(typeof markets.warm, 'function');
  markets.warm({ ...signal });
  markets.prepare({ ...signal }, function (err, quote) { assert.ifError(err); assert.equal(quote.outcomeIndex, 0); assert.equal(quote.book.asks[0].size, '7', 'warm lookup must not replay depth consumed by an earlier order'); assert.equal(requests.filter(function (route) { return route === '/book'; }).length, 1); assert.equal(requests.filter(function (route) { return route === '/clob-markets/condition'; }).length, 1); done(); });
  callbacks['/book'](null, { asks: [{ price: '0.5', size: '10' }], bids: [], hash: 'warm-snapshot' });
  markets.consume('token','BUY',[{price:'0.5',quantity:'3'}]);
  callbacks['/clob-markets/condition'](null, { ao: true, t: [{ t: 'token' }, { t: 'other' }], fd: { r: 0, e: 1 } });
});

test('background refresh observes closure before the next cached execution', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const options = {}, f = fixture(options); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err); now += 31000;
    options.marketResponse = [{ conditionId: 'condition', closed: true }];
    f.markets.refreshParameters(function (error) {
      assert.match(error.message, /closed/); assert.equal(f.markets.isExecutable(signal), false); done();
    });
  });
});

test('background suspension invalidates cached acceptance for both outcomes', function (t, done) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const options = {}, f = fixture(options); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err) {
    assert.ifError(err);
    f.markets.prepare({ ...signal, token: 'other' }, function (failure) {
      assert.ifError(failure);
      f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'live-token', asks: [{ price: '0.5', size: '20' }], bids: [] }));
      now += 31000; options.marketResponse = [{ conditionId: 'condition', active: true, closed: false, acceptingOrders: false }];
      f.markets.refreshParameters(function (error) {
        assert.match(error.message, /not accepting/);
        assert.equal(f.markets.latestQuote(signal, { book: { asks: [], bids: [], observedAt: now } }), null, 'invalid acceptance cannot fall back to an older prepared quote');
        f.markets.prepare({ ...signal }, function (blocked) { assert.ok(blocked, 'cached acceptance on the other outcome must not survive suspension'); done(); });
      });
    });
  });
});

test('latest local quote uses price changes and consumed depth instead of the prepared snapshot', function (t, done) {
  const f = fixture(); t.after(function () { f.markets.stop(); });
  f.markets.prepare({ ...signal }, function (err, prepared) {
    assert.ifError(err);
    f.socket.emit('message', JSON.stringify({ event_type: 'book', asset_id: 'token', hash: 'now', asks: [{ price: '0.6', size: '20' }], bids: [] }));
    f.markets.consume('token', 'BUY', [{ price: '0.6', quantity: '3' }]);
    const latest = f.markets.latestQuote(signal, prepared);
    assert.equal(latest.book.asks[0].price, '0.6'); assert.equal(latest.book.asks[0].size, '17'); assert.equal(prepared.book.asks[0].price, '0.5'); done();
  });
});

test('schedule refresh fetches each requested market and preserves its official deadline', function (_, done) {
  const saved = [];
  const db = { query: function (sql, values, cb) {
    if (sql.startsWith('SELECT DISTINCT')) return cb(null, [{ condition: 'one' }, { condition: 'two' }]);
    saved.push(JSON.parse(values[1])); cb(null, []);
  } };
  const http = { request: function (_, route, params, cb) {
    const query = new URL(route, 'https://example.test').searchParams;
    assert.deepEqual(query.getAll('condition_ids'), ['one', 'two']);
    cb(null, [{ conditionId: 'one', endDate: '2026-10-01T12:00:00Z', tags: [], events: [{ tags: [{ id: '1', slug: 'soccer', label: 'Soccer' }] }] }, { conditionId: 'two', endDate: null }]);
  } };
  const markets = service.create(db, {}, { http });
  assert.equal(typeof markets.schedules, 'function');
  markets.schedules(function (err) { assert.ifError(err); assert.equal(saved.length, 2); assert.equal(saved[0].gamma.endDate, '2026-10-01T12:00:00Z'); assert.equal(saved[0].gamma.tags[0].slug, 'soccer'); done(); });
});

test('reconnect incremental updates cannot revive an unverified full book', function (_, done) {
  const env = fixture();
  env.markets.prepare(signal, function (err) {
    assert.ifError(err);
    env.markets.consume('token', 'BUY', [{ price: '0.5', quantity: '10' }]);
    env.socket.emit('open');
    env.socket.emit('message', JSON.stringify({ event_type: 'price_change', price_changes: [{ asset_id: 'token', side: 'BUY', price: '0.4', size: '10' }] }));
    env.markets.prepare(signal, function (error, quote) {
      env.markets.stop(); assert.ifError(error); assert.equal(env.reads(), 2); assert.equal(quote.book.asks[0].size, '40'); done();
    });
  });
});

test('market resolved notification prevents execution before payout verification', function (_, done) {
  const env = fixture();
  env.socket.emit('message', JSON.stringify({ event_type: 'market_resolved', market: 'condition', assets_ids: ['token', 'other'] }));
  env.markets.prepare(signal, function (err) {
    env.markets.stop(); assert.ok(err); assert.match(err.message, /not executable/); done();
  });
});

test('official token mapping repairs a missing or incorrect source outcome', function (_, done) {
  const env = fixture();
  const unknown = { ...signal, outcomeIndex: 999 };
  env.markets.prepare(unknown, function (err, quote) {
    env.markets.stop(); assert.ifError(err); assert.equal(unknown.outcomeIndex, 0); assert.equal(quote.outcomeIndex, 0); done();
  });
});

test('missing market metadata remains a temporary lookup failure', function (_, done) {
  const env = fixture({ marketResponse: [] });
  env.markets.prepare({ ...signal }, function (err) {
    env.markets.stop(); assert.match(err.message, /temporarily unavailable/); done();
  });
});

test('suspended order acceptance is different from confirmed closure', function (_, done) {
  const env = fixture({ marketResponse: [{ conditionId: 'condition', active: true, closed: false, acceptingOrders: false }] });
  env.markets.prepare({ ...signal }, function (err) {
    env.markets.stop(); assert.match(err.message, /temporarily not accepting/); done();
  });
});

test('fresh accepting CLOB metadata starts book lookup concurrently and bypasses Gamma',function(_,done){
 const requests=[],callbacks={};const db={query:function(_,__,cb){cb(null,[]);}},redis={get:function(_,cb){cb(null,null);},set:function(){}};
 const markets=service.create(db,redis,{http:{request:function(_,route,__,cb){requests.push(route);callbacks[route]=cb;}}});
 markets.prepare({...signal},function(e,q){assert.ifError(e);assert.equal(q.outcomeIndex,0);assert.ok(!requests.includes('/markets'));done();});
 assert.ok(requests.includes('/book'),'book GET starts before metadata returns');
 callbacks['/book'](null,{bids:[],asks:[{price:'0.5',size:'10'}],hash:'parallel'});
 callbacks['/clob-markets/condition'](null,{ao:true,t:[{t:'token'},{t:'other'}],fd:{r:0,e:1},mos:1});
});

test('compact acceptingOrders false never simulates a fill without state verification',function(_,done){
 const markets=service.create({query:function(_,__,cb){cb(null,[]);}},{get:function(_,cb){cb(null,null);},set:function(){}},{http:{request:function(_,route,__,cb){if(route==='/book')return cb(null,{asks:[],bids:[]});if(route.startsWith('/clob-markets/'))return cb(null,{ao:false,t:[{t:'token'},{t:'other'}],fd:{r:0,e:1}});cb(null,[{conditionId:'condition',closed:true}]);}}});
 markets.prepare({...signal},function(e){assert.match(e.message,/closed|not accepting/);done();});
});

test('official event closure blocks every market, but settling one half does not close the match',function(_,done){const markets=service.create({query:function(sql,args,cb){cb(null,[]);}},{},{});markets.saveSchedule({conditionId:'half',closed:true,events:[{slug:'game-a',closed:false}]},function(err){assert.ifError(err);assert.equal(markets.isExecutable({condition:'winner',token:'t',eventKey:'game-a'}),true);markets.saveSchedule({conditionId:'winner',events:[{slug:'game-a',closed:true}]},function(error){assert.ifError(error);assert.equal(markets.isExecutable({condition:'total',token:'x',eventKey:'game-a-more-markets'}),false);assert.equal(markets.isExecutable({condition:'b',token:'y',eventKey:'game-b'}),true);done();});});});

test('closing an additional-markets event cannot prematurely close its parent match',function(_,done){const markets=service.create({query:function(sql,args,cb){cb(null,[]);}},{},{});markets.saveSchedule({conditionId:'extra',events:[{slug:'game-a-more-markets',closed:true}]},function(err){assert.ifError(err);assert.equal(markets.isExecutable({condition:'winner',token:'t',eventKey:'game-a'}),true);done();});});

test('saved child closure metadata cannot exclude its parent from a smart-pause freeze',function(_,done){let stored;const markets=service.create({query:function(sql,args,cb){stored=JSON.parse(args[1]).gamma;cb(null,[]);}},{},{});markets.saveSchedule({conditionId:'child',events:[{slug:'game-a-more-markets',closed:true}]},function(err){assert.ifError(err);assert.equal(stored.eventClosed,false);require('../server/service/smart-pause-service').freeze({query:function(sql,args,cb){cb(null,stored.eventClosed?[]:[{eventSlug:stored.eventSlug}]);}},'w',new Date(),function(error,value){assert.ifError(error);assert.deepEqual(value.events,['game-a']);done();});});});
