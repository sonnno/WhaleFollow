const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const service = require('../server/service/market-service');

function fixture(options) {
  let socket, reads = 0;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 1; }
    send() {}
    terminate() { this.emit('close'); }
  }
  const db = { save: function (_, value, cb) { cb(null, value); }, query: function (_, __, cb) { cb(null, []); } };
  const redis = { get: function (_, cb) { cb(null, null); }, set: function () {} };
  const http = { request: function (_, route, __, cb) {
    if (route === '/book') { reads++; return cb(null, { bids: [{ price: '0.4', size: '50' }], asks: [{ price: '0.5', size: '50' }], hash: 'snapshot' }); }
    if (route === '/markets') return cb(null, options && options.marketResponse || [{ conditionId: 'condition', active: true, closed: false, acceptingOrders: true }]);
    cb(null, { t: [{ t: 'token' }, { t: 'other' }], fd: { r: 0, e: 1 }, mos: 1 });
  } };
  const markets = service.create(db, redis, { http, WebSocket: Socket });
  markets.start(); socket.emit('open');
  return { markets, socket, reads: function () { return reads; } };
}
const signal = { condition: 'condition', token: 'token', outcomeIndex: 0 };

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
