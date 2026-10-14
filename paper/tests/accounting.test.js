const test = require('node:test');
const assert = require('node:assert/strict');

test('part sale releases proportional fee inclusive cost', function () {
  const ledger = require('../server/service/accounting-service');
  const result = ledger.sell({ quantity: '20', cost: '11', realized: '0', cycleRealized: '0' }, { quantity: '5', gross: '4', fee: '0.1' });
  assert.equal(result.quantity, '15');
  assert.equal(result.cost, '8.25');
  assert.equal(result.profit, '1.15');
});

test('fractional resolution is final only and supports zero payout', function () {
  const ledger = require('../server/service/accounting-service');
  const position = { quantity: '20', cost: '11', outcomeIndex: 0 };
  assert.throws(function () { ledger.settle(position, { status: 'proposed', payouts: [500000, 500000] }); }, /final/i);
  assert.equal(ledger.settle(position, { status: 'resolved', payouts: [500000, 500000] }).profit, '-1');
  assert.equal(ledger.settle(position, { status: 'resolved', payouts: [0, 1000000] }).profit, '-11');
});

test('null and incomplete payout vectors cannot close a position', function () {
  const ledger = require('../server/service/accounting-service');
  const position = { quantity: '20', cost: '11', outcomeIndex: 0 };
  [ [null], [500000], [1000000, null], [-1, 1000001] ].forEach(function (payouts) {
    assert.throws(function () { ledger.settle(position, { status: 'resolved', payouts }); }, /payout/i);
  });
});

test('buy sale and settlement conserve cash and net profit', function () {
  const ledger = require('../server/service/accounting-service');
  const bought = ledger.buy({ quantity: '0', cost: '0' }, { quantity: '20', gross: '10', fee: '1' });
  const sold = ledger.sell({ ...bought, realized: '0', cycleRealized: '0' }, { quantity: '5', gross: '4', fee: '0.1' });
  const settled = ledger.settle({ ...sold, outcomeIndex: 0 }, { status: 'resolved', payouts: [1000000, 0] });
  assert.equal(Number(sold.profit) + Number(settled.profit), 7.9);
  assert.equal(100 - 11 + 3.9 + Number(settled.revenue), 107.9);
});
