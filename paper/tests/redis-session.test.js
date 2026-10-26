const test = require('node:test'), assert = require('node:assert/strict');
const { RedisSessionStore } = require('../server/service/auth-service');

test('session reads, writes and expiry renewal use isolated Redis keys without PostgreSQL', function (_, done) {
  const calls = [], value = { user: { username: 'admin' } };
  const store = new RedisSessionStore({
    get: function (key, cb) { calls.push(['get', key]); cb(null, JSON.stringify(value)); },
    set: function (key, payload, ex, seconds, cb) { calls.push(['set', key, ex, seconds]); assert.deepEqual(JSON.parse(payload), value); cb(); },
    expire: function (key, seconds, cb) { calls.push(['expire', key, seconds]); cb(null, 1); },
    del: function (key, cb) { calls.push(['del', key]); cb(null, 1); }
  });
  store.get('abc', function (err, session) {
    assert.ifError(err); assert.deepEqual(session, value);
    store.set('abc', value, function (error) {
      assert.ifError(error);
      store.touch('abc', value, function (touchError) {
        assert.ifError(touchError);
        store.destroy('abc', function (deleteError) {
          assert.ifError(deleteError);
          assert.deepEqual(calls, [['get','paper:session:abc'],['set','paper:session:abc','EX',43200],['expire','paper:session:abc',43200],['del','paper:session:abc']]); done();
        });
      });
    });
  });
});
