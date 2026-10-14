const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../server/service/execution-control-service');
const wallet = 'wallet';
function fixture() { const reads = []; return { reads, controls: create({ query: function (_, __, cb) { reads.push(cb); } }, {}) }; }

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
});

test('notification invalidation, expired cache and DB failure fall back instead of serving old controls', function (t) {
  let now = Date.now(); t.mock.method(Date, 'now', function () { return now; });
  const f = fixture(), rows = [{ roster: [{ leader: { id: wallet } }], settings: {} }];
  f.controls.refresh(function () {}); f.reads.shift()(null, rows); assert.ok(f.controls.get(wallet));
  now += 5001; assert.equal(f.controls.get(wallet), null);
  f.controls.refresh(function () {}); f.reads.shift()(null, rows); f.controls.invalidate(); assert.equal(f.controls.get(wallet), null);
  f.controls.refresh(function () {}); f.reads.shift()(new Error('DB unavailable')); assert.equal(f.controls.get(wallet), null);
});
