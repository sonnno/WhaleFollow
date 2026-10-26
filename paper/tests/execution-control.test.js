const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../server/service/execution-control-service');
const wallet = 'wallet';
function fixture() { const reads = []; return { reads, controls: create({ query: function (_, __, cb) { reads.push(cb); } }, {}) }; }

test('tracks identifies cached roster membership even while admission is invalidated', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ roster: [{ leader: { id: wallet } }], settings: {} }]);
  assert.equal(f.controls.tracks(wallet), true); assert.equal(f.controls.tracks('unknown'), false);
  f.controls.invalidate();
  assert.equal(f.controls.tracks(wallet), true); assert.equal(f.controls.peek(wallet), null); assert.equal(f.controls.get(wallet), null);
  assert.equal(f.reads.length, 0);
});

test('a stale background error cannot invalidate freshly observed pause and generation', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ roster: [{ leader: { id: wallet } }], settings: {} }]);
  f.controls.refresh(function () {}); const late = f.reads.shift();
  f.controls.observe({ claimed: { wallet }, leader: { id: wallet, active: false, raw: { followGeneration: 2 } }, task: { state: 'paused' }, settings: { pauseBuys: true } });
  late(new Error('stale DB failure'));
  const current = f.controls.peek(wallet);
  assert.ok(current); assert.equal(current.settings.pauseBuys, true); assert.equal(current.leader.raw.followGeneration, 2); assert.equal(current.task.state, 'paused');
});

test('peek clones admission controls without reading positions, spending or account', function () {
  const f = fixture(), entry = { leader: { id: wallet, raw: { followGeneration: 7 } }, task: { state: 'running', raw: { generation: 7 } } };
  ['positions', 'sourceSpending'].forEach(function (key) { Object.defineProperty(entry, key, { enumerable: true, get: function () { throw new Error('large snapshot accessed'); } }); });
  f.controls.refresh(function () {});
  f.reads.shift()(null, [{ roster: [entry], settings: { pauseBuys: false }, account: { get cash() { throw new Error('account accessed'); } } }]);
  const state = f.controls.peek(wallet);
  assert.deepEqual(Object.keys(state).sort(), ['leader', 'settings', 'task']);
  state.leader.raw.followGeneration = 0; state.task.raw.generation = 0; state.settings.pauseBuys = true;
  assert.equal(f.controls.peek(wallet).leader.raw.followGeneration, 7);
  assert.equal(f.controls.peek(wallet).task.raw.generation, 7);
  assert.equal(f.controls.peek(wallet).settings.pauseBuys, false);
  assert.equal(f.reads.length, 0);
});

test('selected reads only clone the requested position and source without DB reads', function () {
  const f = fixture(), positions = { selected: { quantity: '2', raw: { label: 'original' } } }, sourceSpending = { source: '3' };
  Object.defineProperty(positions, 'unselected', { enumerable: true, get: function () { throw new Error('unselected position accessed'); } });
  Object.defineProperty(sourceSpending, 'other', { enumerable: true, get: function () { throw new Error('unselected source accessed'); } });
  f.controls.refresh(function () {});
  f.reads.shift()(null, [{ roster: [{ leader: { id: wallet, raw: { followGeneration: 2 } }, task: { raw: { value: 1 } }, positions, sourceSpending, positionCost: '4' }], account: { cash: '10', raw: { value: 1 } }, sharedCash: '6', settings: { raw: { value: 1 } } }]);
  const state = f.controls.get(wallet, 'selected', 'source');
  assert.deepEqual(state.positions, { selected: { quantity: '2', raw: { label: 'original' } } });
  assert.deepEqual(state.sourceSpending, { source: '3' }); assert.equal(state.positionCost, '4');
  state.positions.selected.raw.label = 'changed'; state.account.raw.value = 0; state.task.raw.value = 0; state.leader.raw.followGeneration = 0; state.settings.raw.value = 0;
  const again = f.controls.get(wallet, 'selected', 'source');
  assert.equal(again.positions.selected.raw.label, 'original'); assert.equal(again.account.raw.value, 1); assert.equal(again.task.raw.value, 1); assert.equal(again.leader.raw.followGeneration, 2); assert.equal(again.settings.raw.value, 1);
  assert.deepEqual(f.controls.get(wallet, 'missing', 'missing').positions, {});
  assert.deepEqual(f.controls.get(wallet, 'missing', 'missing').sourceSpending, {});
  assert.equal(f.reads.length, 0);
});

test('memory control reads require no DB request and cannot mutate cached settings', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ roster: [{ leader: { id: wallet, active: true }, task: { state: 'running' } }], settings: { pauseBuys: false } }]);
  const state = f.controls.get(wallet); assert.equal(state.leader.active, true); state.settings.pauseBuys = true;
  assert.equal(f.controls.get(wallet).settings.pauseBuys, false); assert.equal(f.reads.length, 0);
});

test('a delayed background snapshot cannot overwrite freshly observed pause or generation', function () {
  const f = fixture(), old = { roster: [{ leader: { id: wallet, active: true, raw: { followGeneration: 1 } } }], settings: { pauseBuys: false } };
  f.controls.refresh(function () {}); f.reads.shift()(null, [old]);
  f.controls.refresh(function () {}); const late = f.reads.shift();
  f.controls.observe({ claimed: { wallet }, leader: { id: wallet, active: false, raw: { followGeneration: 2 } }, task: { state: 'paused' }, settings: { pauseBuys: true } });
  late(null, [old]);
  const current = f.controls.get(wallet); assert.equal(current.settings.pauseBuys, true); assert.equal(current.leader.raw.followGeneration, 2); assert.equal(current.task.state, 'paused');
  assert.deepEqual(f.controls.peek(wallet), { leader: current.leader, task: current.task, settings: current.settings });
});

test('coherent memory survives time and background DB failures but explicit invalidation remains closed', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(), rows = [{ roster: [{ leader: { id: wallet } }], settings: {} }];
  f.controls.refresh(function () {}); f.reads.shift()(null, rows); assert.ok(f.controls.get(wallet));
  now += 60000; assert.ok(f.controls.get(wallet)); assert.ok(f.controls.peek(wallet)); assert.ok(f.controls.get(wallet, 't', 's'));
  f.controls.refresh(function () {}); f.reads.shift()(new Error('background connection timeout'));
  assert.ok(f.controls.get(wallet)); assert.ok(f.controls.peek(wallet)); assert.equal(f.reads.length, 0);
  f.controls.refresh(function () {}); f.reads.shift()(null, rows); f.controls.invalidate(); assert.equal(f.controls.get(wallet), null); assert.equal(f.controls.peek(wallet), null);
  f.controls.refresh(function () {}); f.reads.shift()(new Error('DB unavailable')); assert.equal(f.controls.get(wallet), null); assert.equal(f.controls.peek(wallet), null);
});

test('failed initial load and stopped controls never admit execution', function () {
  const f = fixture(); f.controls.refresh(function () {}); f.reads.shift()(new Error('connection timeout'));
  assert.equal(f.controls.peek(wallet), null); assert.equal(f.controls.get(wallet), null);
  f.controls.refresh(function () {}); f.reads.shift()(null, [{ roster: [{ leader: { id: wallet } }], settings: {} }]);
  assert.ok(f.controls.peek(wallet)); f.controls.stop();
  assert.equal(f.controls.peek(wallet), null); assert.equal(f.controls.get(wallet), null);
});

test('pubsub pause notification and subscription errors close memory until a successful reload', function () {
  const reads = [], handlers = {}, rows = [{ roster: [{ leader: { id: wallet, active: true }, task: { state: 'running' } }], settings: { pauseBuys: false } }];
  const subscriber = { on: function (name, fn) { handlers[name] = fn; }, connect: function (cb) { cb(); }, subscribe: function (_, cb) { cb(); }, disconnect: function () {} };
  const controls = create({ query: function (_, __, cb) { reads.push(cb); } }, { duplicate: function () { return subscriber; } });
  controls.start(function () {}); handlers.ready(); reads.shift()(null, rows);
  assert.equal(controls.peek(wallet), null); reads.shift()(null, rows); assert.ok(controls.peek(wallet));
  handlers.message('paper:execution-controls'); assert.equal(controls.peek(wallet), null);
  reads.shift()(new Error('connection timeout')); assert.equal(controls.peek(wallet), null);
  controls.refresh(function () {});
  reads.shift()(null, [{ roster: [{ leader: { id: wallet, active: false, raw: { followGeneration: 3 } }, task: { state: 'paused' } }], settings: { pauseBuys: true } }]);
  assert.equal(controls.peek(wallet).settings.pauseBuys, true); assert.equal(controls.peek(wallet).leader.raw.followGeneration, 3);
  handlers.error(new Error('subscription disconnected')); assert.equal(controls.peek(wallet), null);
  controls.refresh(function () {}); reads.shift()(new Error('connection timeout')); assert.equal(controls.get(wallet), null);
});

test('started controls require subscription acknowledgement and reload after every disconnect', function () {
  const reads = [], handlers = {}, acks = [], rows = [{ roster: [{ leader: { id: wallet, active: true } }], settings: {} }];
  const subscriber = { on: function (name, fn) { handlers[name] = fn; }, connect: function (cb) { cb(); }, subscribe: function (_, cb) { acks.push(cb); }, disconnect: function () {} };
  const controls = create({ query: function (_, __, cb) { reads.push(cb); } }, { duplicate: function () { return subscriber; } });
  controls.start(function () {}); reads.shift()(null, rows); assert.equal(controls.peek(wallet), null);
  handlers.ready(); assert.equal(controls.peek(wallet), null); acks.shift()();
  assert.equal(controls.peek(wallet), null); reads.shift()(null, rows); assert.ok(controls.peek(wallet));
  ['close', 'end', 'reconnecting', 'error'].forEach(function (event) {
    handlers[event](); assert.equal(controls.peek(wallet), null);
    controls.refresh(function () {}); reads.shift()(null, rows); assert.equal(controls.peek(wallet), null, event + ' must remain blocked despite periodic reload');
    handlers.ready(); assert.equal(controls.peek(wallet), null); acks.shift()();
    assert.equal(controls.peek(wallet), null); reads.shift()(null, rows); assert.ok(controls.peek(wallet));
  });
  handlers.ready(); const lateAck = acks.shift(); handlers.close(); lateAck();
  controls.refresh(function () {}); reads.shift()(null, rows); assert.equal(controls.peek(wallet), null, 'late acknowledgement cannot reopen a disconnected subscriber');
});

test('in-flight fills reserve shared and dedicated cash before persistence and cannot be overwritten by a background read', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ account: { cash: '100' }, sharedCash: '40', settings: {}, roster: [
    { leader: { id: 'a' }, task: { fundingMode: 'dedicated', cash: '60' }, positions: {}, positionCost: '0' },
    { leader: { id: 'b' }, task: { fundingMode: 'shared' }, positions: {}, positionCost: '0' }
  ] }]);
  f.controls.refresh(function () {}); const old = f.reads.shift();
  const fill = { quantity: '20', gross: '10', cash: '10', fee: '0' };
  f.controls.reserve({ id: 'same', wallet: 'a', token: 't', side: 'BUY' }, fill);
  f.controls.reserve({ id: 'same', wallet: 'b', token: 't', side: 'BUY' }, fill);
  old(null, [{ account: { cash: '100' }, sharedCash: '40', settings: {}, roster: [] }]);
  assert.equal(f.controls.get('a').account.cash, '80'); assert.equal(f.controls.get('a').task.cash, '50'); assert.equal(f.controls.get('b').sharedCash, '30');
  assert.equal(f.controls.get('a', 't').positions.t.quantity, '20'); assert.equal(f.controls.peek('a').task.cash, '50');
  f.controls.complete('same'); f.controls.refresh(function () {}); assert.equal(f.reads.length, 0, 'second execution is still being recorded');
  f.controls.complete('same'); assert.equal(f.reads.length, 1, 'refresh starts only after both results finish');
});

test('an unrecorded executed fill halts new execution without releasing its funds', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ account: { cash: '10' }, sharedCash: '10', settings: {}, roster: [{ leader: { id: wallet }, task: { fundingMode: 'shared' }, positions: {}, positionCost: '0' }] }]);
  f.controls.reserve({ id: 'o', wallet, token: 't', side: 'BUY' }, { quantity: '10', gross: '5', cash: '5', fee: '0' });
  f.controls.complete('o', true, true); f.controls.refresh(function () {});
  assert.equal(f.controls.get(wallet), null); assert.equal(f.controls.peek(wallet), null); assert.equal(f.controls.get(wallet, 't'), null); assert.equal(f.reads.length, 0, 'cannot reload the old cash over an unrecorded result');
});

test('memory source budget includes pending fills and reloads persisted spending', function () {
  const f = fixture(); f.controls.refresh(function () {});
  f.reads.shift()(null, [{ account: { cash: '10' }, sharedCash: '10', settings: {}, roster: [{ leader: { id: wallet }, task: { fundingMode: 'shared' }, sourceSpending: { source: '2' }, positions: {}, positionCost: '0' }] }]);
  f.controls.reserve({ id: 'o', sourceId: 'source', wallet, token: 't', side: 'BUY' }, { quantity: '2', gross: '1', cash: '1', fee: '0' });
  assert.equal(f.controls.get(wallet).sourceSpending.source, '3');
});

test('accounting recovery cannot resume until every pending fill is recorded and balances refresh', function () {
  const f = fixture(), rows = [{ account: { cash: '10' }, sharedCash: '10', settings: {}, roster: [{ leader: { id: wallet }, positions: {}, positionCost: '0' }] }];
  f.controls.refresh(function () {}); f.reads.shift()(null, rows);
  f.controls.reserve({ id: 'o', wallet, token: 't', side: 'BUY' }, { quantity: '2', gross: '1', cash: '1', fee: '0' });
  f.controls.complete('o', true, true);
  f.controls.resume(function (err) { assert.ok(err); }); assert.equal(f.controls.get(wallet), null);
  f.controls.complete('o'); f.reads.shift()(null, rows);
  let resumed = false; f.controls.resume(function (err) { assert.ifError(err); resumed = true; });
  assert.equal(resumed, false); assert.equal(f.controls.get(wallet), null);
  f.reads.shift()(null, rows); assert.equal(resumed, true); assert.ok(f.controls.get(wallet));
});
