const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const servicePath = '../server/service/leaderboard-query-service';
const wallet = '0x' + 'a'.repeat(40);
function create(options) {
  assert.ok(fs.existsSync(require('node:path').join(__dirname, servicePath + '.js')), 'leaderboard query service exists');
  return require(servicePath).create(options);
}
function stub(body, options) {
  const calls = [];
  const service = create({ ...options, http: { request: function (base, endpoint, params, cb, writeBody) {
    calls.push({ base, endpoint, params, writeBody }); cb(null, body);
  } } });
  return { service, calls };
}
const page = { data: [{ user_id: wallet, user_name: 'Trader', rank: 3, pnl: 12.5, volume: 120 }], pagination: { has_more: true, next_cursor: 'opaque:next', limit: 20, offset: 0 } };

test('catalog names every supported official board/version and returns independent values', function () {
  const { service } = stub(page);
  const catalog = service.catalog();
  assert.deepEqual(catalog.types.map(function (row) { return [row.id, row.versions]; }), [['traders', ['v2', 'v1']], ['wins', ['v2']], ['builders', ['v2', 'v1']], ['builder-volume', ['v2', 'v1']]]);
  assert.ok(catalog.categories.some(function (row) { return row.id === 'esports'; }));
  assert.ok(catalog.categories.some(function (row) { return row.id === 'combos'; }));
  assert.deepEqual(catalog.periods.map(function (row) { return row.id; }), ['day', 'week', 'month', 'all']);
  assert.deepEqual(catalog.orders.map(function (row) { return row.id; }), ['PNL', 'VOLUME']);
  catalog.types[0].versions.pop();
  assert.equal(service.catalog().types[0].versions.length, 2);
});
test('V2 trader first page maps filters and readable rows without fetching further pages', function (t, done) {
  const { service, calls } = stub(page);
  service.query({ category: 'sports', timePeriod: 'week', orderBy: 'VOLUME' }, function (err, result) {
    assert.ifError(err);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { time_period: 'week', category: 'sports', sort_by: 'VOLUME', limit: 20 });
    assert.equal(calls[0].writeBody, undefined);
    assert.equal(result.endpoint, '/v2/leaderboard');
    assert.equal(result.paginationKind, 'cursor');
    assert.equal(result.nextCursor, 'opaque:next');
    assert.equal(result.hasMore, true);
    assert.equal(result.volumeUnit, 'shares');
    assert.equal(result.pnlBasis, 'marked-equity-change');
    assert.equal(result.total, undefined);
    assert.deepEqual(result.data[0], { wallet, name: 'Trader', rank: 3, pnl: 12.5, volume: 120, canFollow: true, profileUrl: 'https://polymarket.com/profile/' + wallet });
    assert.ok(result.sourceUrl.startsWith('https://docs.polymarket.com/'));
    assert.ok(!Number.isNaN(Date.parse(result.fetchedAt)));
    done();
  });
});
['traders', 'wins', 'builders'].forEach(function (type) {
  test('V2 ' + type + ' follows an opaque cursor with only cursor parameters', function (t, done) {
    const { service, calls } = stub({ ...page, pagination: { has_more: false, next_cursor: null, limit: 7, offset: 42 } });
    service.query({ type, cursor: 'not+decoded=/token', limit: 20, timePeriod: 'week' }, function (err, result) {
      assert.ifError(err); assert.deepEqual(calls[0].params, { cursor: 'not+decoded=/token' });
      assert.equal(result.limit, 7); assert.equal(result.offset, 42); assert.equal(result.hasMore, false); done();
    });
  });
});
test('V2 wallet standing omits sort/limit/cursor and preserves unranked zero', function (t, done) {
  const { service, calls } = stub({ user_id: wallet, user_name: 'Trader', pnl: 8, volume: 12, pnl_rank: 0, volume_rank: 4 });
  service.query({ user: wallet.toUpperCase().replace('0X', '0x'), timePeriod: 'all', orderBy: 'VOLUME', cursor: 'ignored' }, function (err, result) {
    assert.ifError(err); assert.deepEqual(calls[0].params, { user: wallet, time_period: 'all', category: 'overall' });
    assert.equal(result.paginationKind, 'standing'); assert.equal(result.data[0].rank, 4);
    assert.equal(result.data[0].pnlRank, 0); assert.equal(result.data[0].volumeRank, 4);
    assert.equal(result.hasMore, false); assert.equal(result.nextCursor, null); assert.equal(result.pnlBasis, 'realized-lifetime'); done();
  });
});
test('biggest wins retain position details and do not fabricate combo event links', function (t, done) {
  const { service, calls } = stub({ data: [
    { user_id: wallet, win_rank: 2, event_title: 'A / B', event_slug: '', kind: 'combo', initial_value: 5, final_value: 20, pnl: 15, resolved_at: 123 },
    { user_id: 'not-an-address', win_rank: 3, event_title: 'Event', event_slug: 'event-a', kind: 'single' }
  ], pagination: { has_more: false, next_cursor: null } });
  service.query({ type: 'wins', category: 'combos', timePeriod: 'day' }, function (err, result) {
    assert.ifError(err); assert.equal(calls[0].endpoint, '/v2/biggest-winners');
    assert.deepEqual(calls[0].params, { time_period: 'day', category: 'combos', limit: 20 });
    assert.equal(result.data[0].eventTitle, 'A / B'); assert.equal(result.data[0].officialUrl, null);
    assert.equal(result.data[0].initialValue, 5); assert.equal(result.data[0].finalValue, 20); assert.equal(result.data[0].resolvedAt, 123);
    assert.equal(result.data[1].officialUrl, 'https://polymarket.com/event/event-a'); assert.equal(result.data[1].canFollow, false); done();
  });
});
test('V2 builders retain identity but cannot become followed wallets', function (t, done) {
  const { service, calls } = stub({ data: [{ builder_code: wallet, builder_name: 'Builder', active_users: 10, rank: 1, volume: 30 }], pagination: { has_more: false } });
  service.query({ type: 'builders', timePeriod: 'month' }, function (err, result) {
    assert.ifError(err); assert.equal(calls[0].endpoint, '/v2/builders/leaderboard');
    assert.deepEqual(calls[0].params, { time_period: 'month', limit: 20 });
    assert.equal(result.data[0].wallet, null); assert.equal(result.data[0].canFollow, false); assert.equal(result.data[0].profileUrl, null);
    assert.equal(result.data[0].builderCode, wallet); assert.equal(result.data[0].activeUsers, 10); done();
  });
});
test('V2 builder series requests bounded buckets and locally pages the received rows', function (t, done) {
  const rows = Array.from({ length: 45 }, function (_, i) { return { builder_code: 'b' + i, builder_name: 'Builder ' + i, volume: i, date: '2026-10-01' }; });
  const { service, calls } = stub({ data: rows });
  service.query({ type: 'builder-volume', timePeriod: 'all', limit: 20, offset: 20, bucketLimit: 30 }, function (err, result) {
    assert.ifError(err); assert.equal(calls[0].endpoint, '/v2/builders/volume');
    assert.deepEqual(calls[0].params, { interval: 'all', limit: 30 });
    assert.equal(result.paginationKind, 'local'); assert.equal(result.total, 45); assert.equal(result.data.length, 20);
    assert.equal(result.data[0].builderCode, 'b20'); assert.equal(result.data[0].date, '2026-10-01'); assert.equal(result.hasMore, true); assert.equal(result.nextCursor, null); done();
  });
});
test('V1 trader uses documented enums and bounded offset without claiming a total', function (t, done) {
  const { service, calls } = stub([{ proxyWallet: wallet, userName: 'Old Trader', rank: '7', vol: 900, pnl: -2 }]);
  service.query({ version: 'v1', category: 'esports', timePeriod: 'all', orderBy: 'VOLUME', limit: 1, offset: 1000, userName: 'Old Trader' }, function (err, result) {
    assert.ifError(err); assert.equal(calls[0].endpoint, '/v1/leaderboard');
    assert.deepEqual(calls[0].params, { category: 'ESPORTS', timePeriod: 'ALL', orderBy: 'VOL', limit: 1, offset: 1000, userName: 'Old Trader' });
    assert.equal(result.paginationKind, 'offset'); assert.equal(result.hasMore, false); assert.equal(result.total, undefined);
    assert.equal(result.data[0].name, 'Old Trader'); assert.equal(result.data[0].volume, 900); assert.equal(result.data[0].rank, 7); done();
  });
});
test('V1 builder series locally pages the received array with dt/activeUsers fields', function (t, done) {
  const { service, calls } = stub([{ builder: 'A', builderCode: 'a', activeUsers: 3, volume: 5, dt: '2026-01-01' }, { builder: 'B', builderCode: 'b', volume: 6, dt: '2026-01-02' }]);
  service.query({ type: 'builder-volume', version: 'v1', timePeriod: 'week', limit: 1, offset: 1 }, function (err, result) {
    assert.ifError(err); assert.equal(calls[0].endpoint, '/v1/builders/volume'); assert.deepEqual(calls[0].params, { timePeriod: 'WEEK' });
    assert.equal(result.total, 2); assert.equal(result.paginationKind, 'local'); assert.equal(result.data[0].date, '2026-01-02'); assert.equal(result.hasMore, false); done();
  });
});
test('V1 builder leaderboard supports official bounded offset pagination', function (t, done) {
  const { service, calls } = stub([{ builder: 'Builder', builderCode: 'code', activeUsers: 6, rank: '1', volume: 8 }]);
  service.query({ type: 'builders', version: 'v1', timePeriod: 'week', limit: 1, offset: 20 }, function (err, result) {
    assert.ifError(err); assert.deepEqual(calls[0].params, { timePeriod: 'WEEK', limit: 1, offset: 20 });
    assert.equal(calls[0].endpoint, '/v1/builders/leaderboard'); assert.equal(result.paginationKind, 'offset');
    assert.equal(result.total, undefined); assert.equal(result.hasMore, true); assert.equal(result.data[0].activeUsers, 6); done();
  });
});
const invalid = [
  { type: 'arbitrary' }, { version: 'v3' }, { type: 'wins', version: 'v1' }, { category: 'http://example.com' },
  { category: 'combos', orderBy: 'VOLUME' }, { category: 'custom', version: 'v1' }, { timePeriod: 'year' }, { orderBy: 'VOL' },
  { limit: 0 }, { limit: 1001 }, { limit: '1.5' }, { offset: -1 }, { version: 'v1', limit: 51 }, { version: 'v1', offset: 1001 },
  { version: 'v1', cursor: 'unsupported' }, { cursor: [] }, { user: 'bad' }, { userName: 'unsupported-v2' },
  { type: 'builders', user: wallet }, { type: 'builder-volume', cursor: 'unsupported' }, { type: 'builder-volume', bucketLimit: 91 }, { url: 'https://example.com' }, { offset: 20 }
];
invalid.forEach(function (filters) {
  test('invalid filters return 400 before any request: ' + JSON.stringify(filters), function (t, done) {
    const { service, calls } = stub(page);
    service.query(filters, function (err) { assert.ok(err); assert.equal(err.statusCode, 400); assert.equal(calls.length, 0); done(); });
  });
});
test('cached wallet standing selects the requested rank independently for each query', function (t, done) {
  const { service, calls } = stub({ user_id: wallet, pnl_rank: 0, volume_rank: 7 });
  service.query({ user: wallet, orderBy: 'VOLUME' }, function (err, volume) {
    assert.ifError(err); assert.equal(volume.data[0].rank, 7);
    service.query({ user: wallet, orderBy: 'PNL' }, function (error, pnl) {
      assert.ifError(error); assert.equal(pnl.data[0].rank, 0); assert.equal(calls.length, 1); done();
    });
  });
});
test('opaque cursor content is preserved exactly including surrounding spaces', function (t, done) {
  const { service, calls } = stub(page);
  service.query({ cursor: ' opaque / token= ' }, function (err) {
    assert.ifError(err); assert.equal(calls[0].params.cursor, ' opaque / token= '); done();
  });
});
test('local next pages reuse the cached complete upstream series', function (t, done) {
  const rows = [{ builder_code: 'a' }, { builder_code: 'b' }];
  const { service, calls } = stub({ data: rows });
  service.query({ type: 'builder-volume', limit: 1 }, function (err, first) {
    assert.ifError(err); assert.equal(first.data[0].builderCode, 'a');
    service.query({ type: 'builder-volume', limit: 1, offset: 1 }, function (error, second) {
      assert.ifError(error); assert.equal(second.data[0].builderCode, 'b'); assert.equal(calls.length, 1); done();
    });
  });
});
test('V2 accepts safe custom Gamma category slugs', function (t, done) {
  const { service, calls } = stub(page);
  service.query({ category: 'science-and-space' }, function (err) { assert.ifError(err); assert.equal(calls[0].params.category, 'science-and-space'); done(); });
});
test('identical requests coalesce and cached rows are independent per caller', function (t, done) {
  let pending, calls = 0;
  const service = create({ http: { request: function (_, __, ___, cb) { calls++; pending = cb; } } });
  let received = 0;
  service.query({}, function (err, result) { assert.ifError(err); result.data[0].name = 'mutated'; received++; });
  service.query({}, function (err, result) { assert.ifError(err); assert.equal(result.data[0].name, 'Trader'); received++; });
  assert.equal(calls, 1); pending(null, page); assert.equal(received, 2);
  service.query({}, function (err, result) { assert.ifError(err); assert.equal(result.data[0].name, 'Trader'); assert.equal(calls, 1); done(); });
});
test('cache expires after 30 seconds and force only invalidates the exact query', function (t, done) {
  let now = 1000;
  const { service, calls } = stub(page, { now: function () { return now; } });
  service.query({}, function (err) {
    assert.ifError(err);
    service.query({ category: 'sports' }, function (error) {
      assert.ifError(error);
      service.query({ force: 'true' }, function (failure) {
        assert.ifError(failure); assert.equal(calls.length, 3);
        service.query({ category: 'sports' }, function (other) {
          assert.ifError(other); assert.equal(calls.length, 3); now += 30001;
          service.query({ category: 'sports' }, function (expired) { assert.ifError(expired); assert.equal(calls.length, 4); done(); });
        });
      });
    });
  });
});
test('cache retains at most 100 upstream queries', function (t, done) {
  const { service, calls } = stub(page);
  for (let i = 0; i < 101; i++) service.query({ category: 'category-' + i }, function (err) { assert.ifError(err); });
  service.query({ category: 'category-0' }, function (err) { assert.ifError(err); assert.equal(calls.length, 102); done(); });
});
test('upstream errors and malformed responses do not poison the cache', function (t, done) {
  let calls = 0;
  const service = create({ http: { request: function (_, __, ___, cb) { calls++; if (calls === 1) return cb(new Error('offline')); if (calls === 2) return cb(null, { wrong: [] }); cb(null, page); } } });
  service.query({}, function (err) {
    assert.equal(err.message, 'offline');
    service.query({}, function (malformed) {
      assert.ok(malformed); assert.equal(malformed.statusCode, 502);
      service.query({}, function (failure) { assert.ifError(failure); assert.equal(calls, 3); done(); });
    });
  });
});
