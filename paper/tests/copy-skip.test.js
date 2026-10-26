const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../server/service/copy-skip-service');

test('meaningful rejected buys retain a per-signal diagnostic without creating an order',function(t){
 const logs=[];t.mock.method(console,'warn',value=>logs.push(value));
 const stats=create({query(){assert.fail('diagnostics must not query before a fill');}}),task={createdAt:new Date(0),generation:1};
 stats.record({id:'fill-a',sourceId:'tx-a',wallet:'w',token:'token',condition:'condition',sourceAmount:'181480',price:'.52',size:'349000'},task,'SPORTS_METADATA_MISSING','9.07');
 stats.record({id:'tiny',wallet:'w'},task,'BELOW_MIN_BUY_AMOUNT','.01');
 assert.equal(logs.length,1);const row=JSON.parse(logs[0].split(' copy-skip: ')[1]);assert.equal(row.signalId,'fill-a');assert.equal(row.reason,'SPORTS_METADATA_MISSING');assert.equal(row.amount,'9.07');
});
test('skip counters batch writes without creating orders or queues; failed flush retains counts', (_, done) => {
  let fail = true; const writes = [];
  const db = { query(sql, args, cb) { writes.push({ sql, rows: JSON.parse(args[0]) }); cb(fail ? Error('offline') : null, []); } };
  const stats = create(db), signal = { wallet: 'w', title: 'Game', sourceAmount: '20', id: 's' }, task = { createdAt: new Date(0), generation: 2 };
  stats.record(signal, task, 'BELOW_MIN_BUY_AMOUNT', '0.0005');
  stats.record({ ...signal, id: 's2' }, task, 'BELOW_MIN_BUY_AMOUNT', '0.0005');
  assert.equal(writes.length, 0);
  stats.flush(err => {
    assert.match(err.message, /offline/); fail = false;
    stats.record({ ...signal, id: 's3' }, task, 'BELOW_MIN_BUY_AMOUNT', '0.0005');
    stats.flush(error => {
      assert.ifError(error); assert.equal(writes[1].rows[0].count, 3);
      assert.match(writes[1].sql, /paper_follow_tasks/); assert.match(writes[1].sql, /createdAt/);
      assert.doesNotMatch(writes[1].sql, /paper_orders|paper_outbox/);
      stats.flush(issue => { assert.ifError(issue); assert.equal(writes.length, 2); done(); });
    });
  });
});
test('different task creations cannot merge their skip counters', (_, done) => {
  let rows;
  const stats = create({ query(sql, args, cb) { rows = JSON.parse(args[0]); cb(null, []); } });
  stats.record({ wallet: 'w' }, { createdAt: new Date(0), generation: 1 }, 'SPORTS_TOO_FAR', '1');
  stats.record({ wallet: 'w' }, { createdAt: new Date(1000), generation: 1 }, 'SPORTS_TOO_FAR', '1');
  stats.flush(err => { assert.ifError(err); assert.equal(rows.length, 2); done(); });
});
test('pending counters across pause/start generations remain separate until the current generation is selected', (_, done) => {
  let rows; const stats = create({ query(sql, args, cb) { rows = JSON.parse(args[0]); cb(null, []); } });
  stats.record({ wallet: 'w' }, { createdAt: new Date(0), generation: 1 }, 'SPORTS_TOO_FAR', '1');
  stats.record({ wallet: 'w' }, { createdAt: new Date(0), generation: 3 }, 'SPORTS_TOO_FAR', '1');
  stats.flush(err => { assert.ifError(err); assert.equal(rows.length, 2); assert.equal(rows[0].generation, 1); assert.equal(rows[1].generation, 3); done(); });
});
