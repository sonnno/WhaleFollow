const test = require('node:test'), assert = require('node:assert/strict');

test('raising total principal adds only the difference and never changes realized profit', function (_, done) {
  const account = { id: 'paper', initialCash: '10000', cash: '4524.09', realized: '4978.43', fees: '517.50' }, entries = [];
  const bookedAt = new Date('2026-10-01T16:00:01Z');
  const tx = {
    query: function (sql, _, cb) { cb(null, sql.includes('clock_timestamp()') ? [{ at: bookedAt }] : [{ ...account }]); },
    save: function (_, row, cb) { Object.assign(account, row); cb(null, row); },
    insert: function (_, row, cb) { entries.push(row); cb(null, row); }
  };
  const db = { transaction: function (work, cb) { work(tx, cb); } };
  const capital = require('../server/service/capital-service').create(db);
  capital.increaseTo('100000', function (err, first) {
    assert.ifError(err); assert.equal(first.added, '90000'); assert.equal(account.cash, '94524.09');
    assert.equal(account.initialCash, '100000'); assert.equal(account.realized, '4978.43'); assert.equal(account.fees, '517.50');
    capital.increaseTo('100000', function (error, second) {
      assert.ifError(error); assert.equal(second.added, '0'); assert.equal(account.cash, '94524.09');
      assert.equal(entries.length, 1); assert.equal(entries[0].kind, 'DEPOSIT'); assert.equal(entries[0].delta, '90000'); assert.deepEqual(entries[0].createdAt, bookedAt); done();
    });
  });
});
