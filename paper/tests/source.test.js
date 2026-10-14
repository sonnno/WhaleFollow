const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/source-store-mock')();

test('multiple identical fills in a transaction are summed, not dropped', function () {
  const source = require('../server/service/source-service');
  const trade = { proxy_wallet: '0xABC', transaction_hash: 'tx', token_id: 'a', condition_id: 'c', side: 'BUY', price: 0.5, size: 3, timestamp: 100 };
  const groups = source.groupTrades([trade, trade, { ...trade, price: 0.51, size: 2 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quantities['0.5'], '6');
  assert.equal(groups[0].quantities['0.51'], '2');
});

test('delta respects already processed price buckets', function () {
  const source = require('../server/service/source-service');
  assert.deepEqual(source.delta({ '0.5': '8', '0.6': '2' }, { '0.5': '6' }), { '0.5': '2', '0.6': '2' });
  assert.throws(function () { source.delta({ '0.5': '4' }, { '0.5': '6' }); }, /regress/i);
});

test('first poll covers the entire period since the leader joined', function (t, done) {
  const source = require('../server/service/source-service'), starts = [];
  const joined = Math.floor(Date.now() / 1000) - 900;
  const db = { one: function (kind, __, cb) { cb(null, kind === 'Leader' ? { joinedAt: new Date(joined * 1000), raw: { inventoryTimestamp: joined } } : null); }, save: function (_, row, cb) { cb(null, row); } };
  db.transaction=function(work,cb){work({...db,query:function(_,__,next){next(null,[]);}},cb);};
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, route, params, cb) { starts.push(params.start); cb(null, []); });
  source.create(db).poll('wallet', function (err) {
    assert.ifError(err); assert.deepEqual(starts, [joined]); done();
  });
});

test('source increments copy their own notional once instead of a fixed allocation', function (_, done) {
  const source = require('../server/service/source-service'), async = require('async'), orders = [], stored = new Map();
  const leader = { id: 'wallet', joinedAt: new Date(0), inventory: {}, inventoryValid: true, raw: { inventoryTimestamp: 0 }, active: true };
  const tx = {
    query: function (_, __, cb) { cb(null, []); },
    one: function (kind, options, cb) { cb(null, kind === 'Leader' ? leader : kind === 'Source' ? stored.get(options.where.id) : null); },
    save: function (kind, row, cb) { if (kind === 'Source') stored.set(row.id, row); cb(null, row); },
    insert: function (_, row, cb) { orders.push(row); cb(null, row); }
  };
  const db = { transaction: function (work, cb) { work(tx, cb); } }, svc = source.create(db);
  const row = { proxy_wallet: 'wallet', transaction_hash: 'tx', token_id: 'token', condition_id: 'condition', side: 'BUY', price: 0.4, size: 100, timestamp: 100, outcome_index: 0 };
  async.eachSeries([[row], [{ ...row, size: 150 }], [{ ...row, size: 150 }], [{ ...row, size: 150 }, { ...row, price: 0.6, size: 20 }]], function (rows, cb) {
    svc.ingest(source.groupTrades(rows)[0], cb);
  }, function (err) {
    assert.ifError(err); assert.equal(orders.length, 3);
    assert.deepEqual(orders.map(o => o.payload.sourceAmount), ['40', '20', '12']);
    assert.ok(orders.every(o => o.payload.config.buyBudget === undefined)); done();
  });
});


test('BUY discovery does not wait for the activity endpoint', function (t, done) {
  const source = require('../server/service/source-service');
  const leader = { id: 'wallet', joinedAt: new Date(0), inventory: {}, inventoryValid: true, raw: { inventoryTimestamp: 0 }, active: true };
  const tx = { query: function (_, __, cb) { cb(null, []); }, one: function (kind, _, cb) { cb(null, kind === 'Leader' ? leader : null); }, save: function (_, row, cb) { cb(null, row); }, insert: function (_, row, cb) { cb(null, row); } };
  const db = { ...tx, transaction: function (work, cb) { work(tx, cb); } };
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, route, params, cb) {
    assert.equal(route, '/v2/trades', 'BUY must not depend on activity HTTP completion');
    cb(null, [{ proxy_wallet: 'wallet', transaction_hash: 'tx', token_id: 'a', condition_id: 'c', side: 'BUY', price: 0.5, size: 3, timestamp: Math.floor(Date.now() / 1000) }]);
  });
  source.create(db).poll('wallet', function (err) { assert.ifError(err); done(); });
});

test('new intent notification happens after commit and is absent on duplicate reads', function (_, done) {
  const source = require('../server/service/source-service'), stored = new Map(), notices = [];
  let committed = false;
  const leader = { id: 'wallet', joinedAt: new Date(0), inventory: {}, inventoryValid: true, raw: { inventoryTimestamp: 0 }, active: true };
  const tx = { query: function (_, __, cb) { cb(null, []); }, one: function (kind, options, cb) { cb(null, kind === 'Leader' ? leader : kind === 'Source' ? stored.get(options.where.id) : null); }, save: function (kind, row, cb) { if (kind === 'Source') stored.set(row.id, row); cb(null, row); }, insert: function (_, row, cb) { assert.equal(notices.length, 0); cb(null, row); } };
  const db = { transaction: function (work, cb) { work(tx, function (err, result) { committed = true; cb(err, result); }); } }, svc = source.create(db);
  assert.equal(typeof svc.onSignal, 'function');
  svc.onSignal(function (id) { assert.equal(committed, true); notices.push(id); });
  const group = source.groupTrades([{ proxy_wallet: 'wallet', transaction_hash: 'tx', token_id: 'a', condition_id: 'c', side: 'BUY', price: 0.5, size: 3, timestamp: 100 }])[0];
  svc.ingest(group, function (err) { assert.ifError(err); assert.equal(notices.length, 1); svc.ingest(group, function (error) { assert.ifError(error); assert.equal(notices.length, 1); done(); }); });
});


test('overlap trades already fully processed do not take per-trade account locks', function (t, done) {
  const source = require('../server/service/source-service');
  const leader = { joinedAt: new Date(0), raw: { inventoryTimestamp: 0 } };
  const trade = { proxy_wallet: 'wallet', transaction_hash: 'tx', token_id: 'a', condition_id: 'c', side: 'BUY', price: 0.5, size: 3, timestamp: 100 };
  const group = source.groupTrades([trade])[0]; let reads = 0;
  let checkpointLocks=0;
  const db = { one: function (kind, _, cb) { cb(null, kind === 'Leader' ? leader : null); }, query: function (sql, ids, cb) { if(sql.includes('MIN(timestamp)'))return cb(null,[]);reads++; assert.deepEqual(ids, [[group.id]]); cb(null, [{ id: group.id, processed: group.quantities }]); }, transaction: function(work,cb){checkpointLocks++;work({...db,query:function(_,__,next){next(null,[]);},insert:function(){assert.fail('duplicate overlap must not create an intent');}},cb);}, save: function (_, row, cb) { cb(null, row); } };
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, route, params, cb) { cb(null, [trade]); });
  source.create(db).poll('wallet', function (err) { assert.ifError(err); assert.equal(reads, 1); assert.equal(checkpointLocks,1,'Only checkpoint commit takes a lock, not each duplicate trade'); done(); });
});


test('a slow SELL activity check does not block a BUY on another asset', function (t, done) {
  const source = require('../server/service/source-service'); let activityDone; const intents = [];
  const leader = { id: 'wallet', joinedAt: new Date(0), inventory: { a: '10' }, inventoryValid: true, raw: { inventoryTimestamp: 0 }, active: true };
  const rows = [{ proxy_wallet: 'wallet', transaction_hash: 'tx1', token_id: 'a', condition_id: 'c', side: 'SELL', price: 0.5, size: 1, timestamp: 100 }, { proxy_wallet: 'wallet', transaction_hash: 'tx2', token_id: 'b', condition_id: 'd', side: 'BUY', price: 0.4, size: 3, timestamp: 101 }];
  rows.splice(1, 0, { ...rows[0], token_id: 'c', transaction_hash: 'tx3' }, { ...rows[0], token_id: 'd', transaction_hash: 'tx4' });
  const tx = { query: function (_, __, cb) { cb(null, []); }, one: function (kind, _, cb) { cb(null, kind === 'Leader' ? leader : null); }, save: function (_, row, cb) { cb(null, row); }, insert: function (_, row, cb) { intents.push(row); cb(null, row); } };
  const db = { ...tx, transaction: function (work, cb) { work(tx, cb); } };
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, route, params, cb) { if (route === '/v2/activity') activityDone = cb; else cb(null, rows); });
  source.create(db).poll('wallet', function (err) { assert.ifError(err); assert.equal(intents.length, 4); done(); });
  assert.equal(intents.filter(x => x.payload.side === 'BUY').length, 1, 'unrelated BUY must be ingested before activity responds');
  activityDone(null, []);
});

test('SELL cannot adopt a concurrently refreshed inventory that its activity check did not validate', function (t, done) {
  const source = require('../server/service/source-service'); const intents = [];
  const leader = { id: 'wallet', joinedAt: new Date(0), inventory: { a: '10' }, inventoryValid: false, raw: { inventoryTimestamp: 0 }, active: true };
  const row = { proxy_wallet: 'wallet', transaction_hash: 'tx', token_id: 'a', condition_id: 'c', side: 'SELL', price: 0.5, size: 1, timestamp: 100 };
  const tx = { query: function (_, __, cb) { cb(null, []); }, one: function (kind, _, cb) { cb(null, kind === 'Leader' ? leader : null); }, save: function (_, row, cb) { cb(null, row); }, insert: function (_, row, cb) { intents.push(row); cb(null, row); } };
  const db = { ...tx, transaction: function (work, cb) { leader.inventoryValid = true; leader.raw.inventoryTimestamp = 50; work(tx, cb); } };
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, route, params, cb) { cb(null, route === '/v2/trades' ? [row] : []); });
  source.create(db).poll('wallet', function (err) { assert.ifError(err); assert.equal(intents[0].payload.beforeInventory, null); done(); });
});
