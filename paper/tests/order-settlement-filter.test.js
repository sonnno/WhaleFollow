const test = require('node:test');
const assert = require('node:assert/strict');

test('copy settlement filter is validated before querying', function () {
  const service = require('../server/service/dashboard-service').create({ query: function () { throw Error('Invalid filter reached SQL'); } });
  service.list('copies', { settlementStatus: "settled' OR true --" }, function (err) {
    assert.ok(err); assert.equal(err.status, 400);
  });
});

for (const settlementStatus of ['settled', 'pending']) test('copy ' + settlementStatus + ' filter applies before pagination with original filters', function () {
  let captured;
  const service = require('../server/service/dashboard-service').create({ query: function (sql, params, callback) {
    captured = { sql, params }; callback(null, [{ id: 'order', status: 'FILLED', settlementStatus, totalRows: 3 }]);
  } });
  service.list('copies', { settlementStatus, wallet: 'trader', status: 'FILLED', limit: 1, offset: 1 }, function (err, result) {
    assert.ifError(err); assert.equal(result.total, 3); assert.equal(result.offset, 1); assert.equal(result.data[0].settlementStatus, settlementStatus);
  });
  assert.match(captured.sql, /"settlementStatus"=\$\d+/);
  assert.ok(captured.params.includes(settlementStatus));
  assert.ok(captured.params.includes('trader')); assert.ok(captured.params.includes('FILLED'));
  assert.deepEqual(captured.params.slice(-2), [1, 1]);
  assert.ok(captured.sql.indexOf('"settlementStatus"=$') < captured.sql.lastIndexOf('LIMIT $'));
  assert.match(captured.sql, /LEFT JOIN paper_settlements s ON s\.id=o\.wallet\|\|':'\|\|o\.token\|\|':'\|\|COALESCE\(o\.details->>'positionCycle','1'\)/);
  assert.match(captured.sql, /LEFT JOIN paper_positions p ON p\.id=o\.wallet\|\|':'\|\|o\.token/);
  assert.match(captured.sql, /p\.cycle=COALESCE\(\(o\.details->>'positionCycle'\)::int,1\)/);
  assert.match(captured.sql, /p\.quantity>0/);
  assert.match(captured.sql, /o\.side='BUY' AND o\.status IN \('FILLED','PARTIAL'\)/);
  assert.match(captured.sql, /s\.profit::text[^\n]*"settlementProfit"/);
});

test('unfiltered copies retain execution status while returning independent settlement status', function () {
  let captured;
  require('../server/service/dashboard-service').create({ query: function (sql, params, callback) {
    captured = sql; callback(null, [{ id: 'settled-order', status: 'FILLED', settlementStatus: 'settled', totalRows: 1 }]);
  } }).list('copies', {}, function (err, result) {
    assert.ifError(err); assert.equal(result.data[0].status, 'FILLED'); assert.equal(result.data[0].settlementStatus, 'settled');
  });
  assert.match(captured, /AS "settlementStatus"/);
  assert.doesNotMatch(captured, /WHERE "settlementStatus"=/);
});
