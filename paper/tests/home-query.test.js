const test = require('node:test'), assert = require('node:assert/strict');
function database(results) {
  const queries = [];
  return { queries, readSnapshot: function (work, done) { work({ query: function (sql, values, cb) { queries.push(sql); cb(null, results.shift()); } }, done); } };
}
test('balance snapshot reads current balances without visiting settlement or ledger history', function (_, done) {
  const db = database([
    [{ cash: '300', initialCash: '350', totalProfit: '10', fees: '1', createdAt: new Date('2026-10-18Z') }],
    [{ pendingCost: '60', pendingBets: 4 }],
    [{ id: 'a', name: 'A', cash: '100', createdAt: new Date('2026-10-18Z') }],
    [{ id: 'runtime', value: { pauseBuys: true } }, { id: 'balance-warning:total', value: { insufficient: true } }]
  ]);
  require('../server/service/home-query-service').create(db).cashSummary(function (err, value) {
    assert.ifError(err); assert.equal(value.cash, '300'); assert.equal(value.totalProfit, '10');
    assert.equal(value.pendingBets, 4); assert.equal(value.pendingCost, '60');
    assert.equal(value.walletBalances[1].cash, '200'); assert.equal(value.walletBalances[2].cash, '100');
    assert.equal(value.walletBalances[0].warning.insufficient, true); assert.equal(value.runtime.pauseBuys, true);
    assert.doesNotMatch(db.queries.join('\n'), /paper_settlements|paper_cash_ledger|paper_daily_reports|paper_equity_snapshots/);
    done();
  });
});
test('prepared history preserves deleted-task profit, exact cumulative total and closed daily reports', function (_, done) {
  const db = database([
    [{ createdAt: new Date('2026-10-18Z') }],
    [{ wallet: 'a', name: 'A', profit: '5', createdAt: '2026-10-18T01:00:00Z' },
      { wallet: null, name: null, profit: '-2', createdAt: '2026-10-18T02:00:00Z' },
      { wallet: 'a', name: 'A', profit: '1', createdAt: '2026-10-18T03:00:00Z' }],
    [{ day: '2026-10-17', profit: '8' }]
  ]);
  require('../server/service/home-query-service').create(db).homeHistory(function (err, value) {
    assert.ifError(err); assert.equal(value.history.at(-1).settledProfit, '4');
    assert.equal(value.leaders[0].profit, '6'); assert.equal(value.leaders[0].count, 2);
    assert.deepEqual(value.days, [{ day: '2026-10-17', profit: '8' }]);
    assert.match(db.queries[1], /recordsDeleted/); assert.match(db.queries[2], /"breakdownVersion">=1/);
    done();
  });
});
test('curve sampling stays bounded and preserves first, final and extreme values', function () {
  const { sample } = require('../server/service/home-query-service');
  const rows = Array.from({ length: 10000 }, function (_, i) { return { createdAt: i, settledProfit: String(i === 5201 ? -500 : i) }; });
  const output = sample(rows);
  assert.ok(output.length <= 1000); assert.equal(output[0], rows[0]); assert.equal(output.at(-1), rows.at(-1));
  assert.ok(output.includes(rows[5201]));
});

test('large history aggregation yields so cached HTTP reads are not blocked by processing', function (_, done) {
  let turn = false;
  setImmediate(function () { turn = true; });
  const db = database([[{ createdAt: new Date('2026-10-18Z') }],
    Array.from({ length: 4000 }, function (_, i) { return { wallet: 'a', name: 'A', profit: '0.01', createdAt: new Date(1792281600000 + i) }; }), []]);
  require('../server/service/home-query-service').create(db).homeHistory(function (err, value) {
    assert.ifError(err); assert.equal(turn, true); assert.equal(value.history.at(-1).settledProfit, '40'); done();
  });
});
