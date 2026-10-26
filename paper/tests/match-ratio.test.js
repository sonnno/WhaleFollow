const test = require('node:test'), assert = require('node:assert/strict');
const { create, eventKey } = require('../server/service/match-ratio-service');
const task = { id: 'w', createdAt: '2026-10-19T00:00:00Z', copyPercent: '10' };
function signal(condition, event) { return { wallet: 'w', condition, side: 'BUY', raw: event ? [{ event_slug: event }] : [] }; }
function fixture() {
  const service = create({ query: function (sql, params, cb) { cb(null, []); } }, { identifyEvent: function (_, cb) { cb(null, 'other-match'); } });
  return service;
}
test('one match locks at the first successful buy and all its markets retain that ratio', function (_, done) {
  const service = fixture();
  service.select(signal('winner', 'a-b-2026-10-19'), task, function (err, selected) {
    assert.ifError(err); service.lock(selected, 'first', '2026-10-19T01:00:00Z');
    service.select(signal('totals', 'a-b-2026-10-19-more-markets'), { ...task, copyPercent: '20' }, function (error, next) {
      assert.ifError(error); assert.equal(next.copyPercent, '10'); assert.equal(next.firstOrderId, 'first'); done();
    });
  });
});
test('new matches use the new ratio; other tasks never inherit another task lock', function (_, done) {
  const service = fixture();
  service.select(signal('one', 'game-a'), task, function (_, selected) {
    service.lock(selected, 'first', '2026-10-19T01:00:00Z');
    service.select(signal('two', 'game-b'), { ...task, copyPercent: '20' }, function (err, next) {
      assert.ifError(err); assert.equal(next.copyPercent, '20');
      service.select({ ...signal('one', 'game-a'), wallet: 'other' }, { ...task, id: 'other', copyPercent: '30' }, function (error, other) {
        assert.ifError(error); assert.equal(other.copyPercent, '30'); done();
      });
    });
  });
});
test('failed attempts do not lock a match, and overlapping first orders re-read the successful lock', function (_, done) {
  const service = fixture();
  service.select(signal('one', 'game-a'), task, function (_, failed) {
    service.select(signal('two', 'game-a'), { ...task, copyPercent: '20' }, function (err, successful) {
      assert.ifError(err); assert.equal(successful.copyPercent, '20'); service.lock(successful, 'success', '2026-10-19T01:00:00Z');
      assert.equal(service.effective(failed).copyPercent, '20'); done();
    });
  });
});
test('pause and restart generation do not reset a match; a genuinely new task is independent', function (_, done) {
  const service = fixture();
  service.select(signal('one', 'game-a'), task, function (_, selected) {
    service.lock(selected, 'first', '2026-10-19T01:00:00Z');
    service.select(signal('one', 'game-a'), { ...task, generation: 9, copyPercent: '20' }, function (err, current) {
      assert.ifError(err); assert.equal(current.copyPercent, '10');
      service.select(signal('one', 'game-a'), { ...task, createdAt: '2026-10-19T02:00:00Z', copyPercent: '30' }, function (error, next) {
        assert.ifError(error); assert.equal(next.copyPercent, '30'); done();
      });
    });
  });
});
test('old matches recover the first executed ratio and preserve it after service restart', function (_, done) {
  let persisted = [];
  const db = { query: function (sql, params, cb) {
    if (sql.includes('match-ratio-history')) return cb(null, [
      { wallet: 'w', condition: 'c', taskCreatedAt: task.createdAt, eventSlug: 'game-a', copyPercent: '5', firstOrderId: 'old-first', lockedAt: '2026-10-19T01:00:00Z' },
      { wallet: 'w', condition: 'c', taskCreatedAt: task.createdAt, eventSlug: 'game-a', copyPercent: '20', firstOrderId: 'later', lockedAt: '2026-10-19T02:00:00Z' }
    ]);
    if (sql.includes('INSERT INTO paper_match_ratios')) { persisted = JSON.parse(params[0]); return cb(null, persisted); }
    cb(null, persisted);
  } };
  const service = create(db, {});
  service.start(function (err) {
    assert.ifError(err);
    service.select(signal('another', 'game-a'), { ...task, copyPercent: '50' }, function (error, restored) {
      assert.ifError(error); assert.equal(restored.copyPercent, '5'); assert.equal(restored.firstOrderId, 'old-first');
      assert.equal(persisted.length, 1); done();
    });
  });
});

test('history recovery includes seeded legacy buys and preserves the first order provenance', function (_, done) {
  const db={query:function(sql,args,cb){
    if(sql.includes('match-ratio-history')) {
      assert.doesNotMatch(sql,/o\."createdAt">=t\."createdAt"/);
      assert.match(sql,/COALESCE\(NULLIF\(o\.details->'matchRatio'->>'firstOrderId',''\),o\.id\)/);
      return cb(null,[]);
    }
    cb(null,[]);
  }};
  create(db,{}).start(done);
});
test('event identity must be known rather than silently treating an unknown market as a new match', function (_, done) {
  const service = create({}, { identifyEvent: function (_, cb) { cb(new Error('metadata offline')); } });
  service.select(signal('unknown'), task, function (err) { assert.equal(err.code, 'MATCH_IDENTITY_UNAVAILABLE'); done(); });
});
test('the extra-markets event shares the parent match key', function () {
  assert.equal(eventKey('epl-a-b-2026-10-19-more-markets'), eventKey('epl-a-b-2026-10-19'));
  assert.notEqual(eventKey('game-a-2026-10-19'), eventKey('game-a-2026-10-20'));
});

test('recording a previously executed receipt restores its ratio into memory after restart', function (_, done) {
  const service = fixture();
  service.select(signal('first', 'game-a'), task, function (err, selected) {
    assert.ifError(err);
    const receipt = {...selected, firstOrderId:'executed-before-restart', lockedAt:'2026-10-19T01:00:00.000Z'};
    service.persist({query:function (_, args, cb) { cb(null,[{copyPercent:'10'}]); }}, receipt, function (error) {
      assert.ifError(error);
      service.select(signal('second', 'game-a'), {...task,copyPercent:'30'}, function (issue, next) {
        assert.ifError(issue); assert.equal(next.copyPercent,'10'); assert.equal(next.firstOrderId,receipt.firstOrderId); done();
      });
    });
  });
});
