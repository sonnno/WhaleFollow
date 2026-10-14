const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config').paper;
const http = require('../server/lib/http-client');
const selected = '0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7';
const other = '0x51698a47f840a242abc2ca0351371c7ffac41842';

test('fixed selection survives leaderboard refresh and leaving the top ten', function (t, done) {
  const original = config.followWallets;
  config.followWallets = [selected];
  t.after(function () { config.followWallets = original; });
  const leaders = new Map([
    [selected, { id: selected, name: 'UpTheBlues', active: true, joinedAt: new Date(0), inventory: {}, raw: {}, inventoryValid: true }],
    [other, { id: other, name: 'Other', active: true, joinedAt: new Date(0), inventory: {}, raw: {} }]
  ]);
  const tx = {
    query: function (sql, params, cb) {
      if (sql.startsWith('UPDATE paper_leaders')) leaders.forEach(function (row) { if (!params[0].includes(row.id)) row.active = false; });
      cb(null, []);
    },
    one: function (_, options, cb) { cb(null, leaders.get(options.where.id)); },
    save: function (_, row, cb) { leaders.set(row.id, row); cb(null, row); },
    insert: function (_, row, cb) { cb(null, row); }
  };
  t.mock.method(http, 'request', function (_, __, ___, cb) { cb(null, { data: [{ user_id: other, user_name: 'Other', rank: 1, pnl: 100 }] }); });
  require('../server/service/leader-service').create({ one: function (_, __, cb) { cb(null, null); }, transaction: function (work, cb) { work(tx, cb); } }).refresh(function (err) {
    assert.ifError(err);
    assert.equal(leaders.get(other).active, false);
    assert.equal(leaders.get(selected).active, true);
    assert.equal(leaders.get(selected).joinedAt.getTime(), 0);
    done();
  });
});
