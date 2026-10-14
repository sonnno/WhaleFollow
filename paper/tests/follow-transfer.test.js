const test = require('node:test'), assert = require('node:assert/strict'), async = require('async');
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
function fixture(options) {
  const state = { Account: { paper: { id: 'paper', cash: '1000', initialCash: '1000', realized: '0', fees: '0' } },
    FollowTask: { [A]: { id: A, fundingMode: 'dedicated', cash: '480', fundedCapital: '500', allocation: '500', realized: '-20', fees: '1' } }, FollowFundTransfer: {}, Setting:{}, ...options };
  let busy = false; const jobs = [];
  function run() {
    if (busy || !jobs.length) return;
    busy = true; const [work, callback] = jobs.shift(), original = structuredClone(state); let locked = false;
    const tx = {
      query: function (sql, _, cb) {
        if (/paper_accounts.*FOR UPDATE/.test(sql)) { locked = true; return cb(null, [structuredClone(state.Account.paper)]); }
        assert.ok(locked);
        if (/SUM\(cash\)/.test(sql)) return cb(null, [{ cash: String(Object.values(state.FollowTask).reduce(function (n, t) { return n + (t.fundingMode === 'dedicated' ? Number(t.cash) : 0); }, 0)) }]);
        if (/clock_timestamp/.test(sql)) return cb(null, [{ at: new Date('2026-10-13T08:00:00Z') }]);
        cb(new Error('Unexpected SQL ' + sql));
      },
      one: function (entity, options, cb) { assert.ok(locked); cb(null, structuredClone(state[entity][options.where.id] || null)); },
      save: function (entity, value, cb) { assert.ok(locked); state[entity][value.id] = structuredClone(value); cb(null, value); },
      insert: function (entity, value, cb) { assert.ok(locked); if (state.failInsert) return cb(new Error('disk unavailable')); state[entity][value.id] = structuredClone(value); cb(null, value); }
    };
    work(tx, function (err, result) { if (err) Object.assign(state, original); busy = false; callback(err, result); setImmediate(run); });
  }
  const db = { transaction: function (work, cb) { jobs.push([work, cb]); run(); } };
  return { state, service: require('../server/service/follow-transfer-service').create(db) };
}
function input(extra) { return { direction: 'in', amount: '20', requestId: 'transfer-request-0001', ...extra }; }
test('manual top-up changes cash without changing the 500 target, account totals, or PnL', function (_, done) {
  const f = fixture(); f.service.transfer(A, input(), function (err, result) {
    assert.ifError(err); assert.equal(f.state.FollowTask[A].cash, '500'); assert.equal(f.state.FollowTask[A].fundedCapital, '520'); assert.equal(f.state.FollowTask[A].allocation, '500');
    assert.equal(f.state.Account.paper.cash, '1000'); assert.equal(f.state.FollowTask[A].realized, '-20'); assert.equal(f.state.FollowTask[A].fees, '1');
    assert.equal(result.transfer.publicCashBefore, '520'); assert.equal(result.transfer.publicCashAfter, '500'); done();
  });
});
test('replaying a transfer ID applies exactly once and conflicting reuse is rejected', function (_, done) {
  const f = fixture(); f.service.transfer(A, input(), function (err) {
    assert.ifError(err); f.service.transfer(A, input({ amount: '20.00' }), function (err, result) {
      assert.ifError(err); assert.equal(result.duplicate, true); assert.equal(f.state.FollowTask[A].cash, '500'); assert.equal(Object.keys(f.state.FollowFundTransfer).length, 1);
      f.service.transfer(A, input({ amount: '21' }), function (err) { assert.equal(err.status, 409); assert.equal(f.state.FollowTask[A].cash, '500'); done(); });
    });
  });
});
test('profits as well as principal can be manually withdrawn without changing PnL', function (_, done) {
  const f = fixture({ FollowTask: { [A]: { id: A, fundingMode: 'dedicated', cash: '700', fundedCapital: '500', allocation: '500', realized: '200', fees: '0' } } });
  f.service.transfer(A, input({ direction: 'out', amount: '700' }), function (err, result) { assert.ifError(err); assert.equal(f.state.FollowTask[A].cash, '0'); assert.equal(f.state.FollowTask[A].fundedCapital, '0'); assert.equal(f.state.FollowTask[A].allocation, '500'); assert.equal(f.state.FollowTask[A].realized, '200'); assert.equal(result.transfer.publicCashAfter, '1000'); done(); });
});
test('concurrent manual transfers cannot reserve the same public money twice', function (_, done) {
  const f = fixture({ FollowTask: { [A]: { id: A, fundingMode: 'dedicated', cash: '0', fundedCapital: '0', allocation: '1000' }, [B]: { id: B, fundingMode: 'dedicated', cash: '0', fundedCapital: '0', allocation: '1000' } } });
  async.parallel([A, B].map(function (wallet) { return function (next) { f.service.transfer(wallet, input({ amount: '600', requestId: 'transfer-for-' + wallet }), function (err, result) { next(null, { err, result }); }); }; }), function (err, rows) {
    assert.ifError(err); assert.equal(rows.filter(function (r) { return !r.err; }).length, 1); assert.equal(rows.find(function (r) { return r.err; }).err.status, 409); assert.equal(Object.keys(f.state.FollowFundTransfer).length, 1); done();
  });
});
test('invalid transfer amounts/directions/IDs and shared tasks are rejected', function (_, done) {
  const f = fixture();
  async.eachSeries([{ amount: '0' }, { amount: '-1' }, { amount: '' }, { amount: 'NaN' }, { amount: '0.0000000000000000001' }, { amount: '100000000000000000000' }, { direction: 'bad' }, { requestId: '' }, { requestId: undefined }], function (value, cb) {
    f.service.transfer(A, input(value), function (err) { assert.equal(err.status, 400); cb(); });
  }, function () { f.state.FollowTask[A].fundingMode = 'shared'; f.service.transfer(A, input(), function (err) { assert.equal(err.status, 409); assert.equal(Object.keys(f.state.FollowFundTransfer).length, 0); done(); }); });
});
test('withdrawal is limited to idle cash and unavailable tasks are not created', function (_, done) {
  const f = fixture(); f.service.transfer(A, input({ direction: 'out', amount: '481' }), function (err) { assert.equal(err.status, 409); assert.equal(f.state.FollowTask[A].cash, '480'); f.service.transfer(B, input(), function (err) { assert.equal(err.status, 404); done(); }); });
});
test('a failed transfer journal insert rolls back the cash mutation', function (_, done) {
  const f = fixture({ failInsert: true }); f.service.transfer(A, input(), function (err) { assert.match(err.message, /disk/); assert.equal(f.state.FollowTask[A].cash, '480'); assert.equal(Object.keys(f.state.FollowFundTransfer).length, 0); done(); });
});
test('a request ID retired by task deletion cannot fund a recreated account',function(_,done){const hash=require('node:crypto').createHash('sha256').update(input().requestId).digest('hex');const f=fixture({Setting:{['retired-transfer:'+hash]:{value:{retired:true}}}});f.service.transfer(A,input(),function(err){assert.equal(err.status,409);assert.equal(f.state.FollowTask[A].cash,'480');done();});});
test('an uncommitted delayed transfer cannot apply to a recreated task version',function(_,done){const f=fixture({Setting:{['task-deletion:'+A]:{value:{generation:8}}}});f.service.transfer(A,input({taskVersion:'initial'}),function(err){assert.equal(err.status,409);assert.equal(f.state.FollowTask[A].cash,'480');f.service.transfer(A,input({taskVersion:'8'}),function(err){assert.ifError(err);assert.equal(f.state.FollowTask[A].cash,'500');done();});});});
