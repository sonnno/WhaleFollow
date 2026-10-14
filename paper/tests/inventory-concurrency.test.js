const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../server/service/leader-service').create;
test('inventory request overlapping a newly discovered trade cannot restore a valid SELL baseline', function (t, done) {
  let response;
  t.mock.method(require('../server/lib/http-client'), 'pages', function (_, __, ___, cb) { response = cb; });
  const row = { id: 'wallet', inventory: {}, inventoryValid: false, raw: {} };
  const tx = { query: function (_, __, cb) { cb(null, []); }, one: function (_, __, cb) { cb(null, row); }, save: function (_, value, cb) { cb(null, value); } };
  const svc = create({ transaction: function (work, cb) { work(tx, cb); } });
  svc.inventory({ id: 'wallet' }, function (err) { assert.ifError(err); assert.equal(row.inventoryValid, false, 'concurrent trades make the returned inventory baseline uncertain'); done(); });
  row.raw.lastTradeObservedAt = Date.now() + 1;
  response(null, [{ token_id: 'a', current_size: 10 }]);
});
