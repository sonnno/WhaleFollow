const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const https = require('node:https');
function fixture(t, status) {
  const path = require.resolve('../server/lib/http-client'); delete require.cache[path]; const client = require(path); let calls = 0;
  t.mock.method(https, 'request', function (url, options, receive) {
    const req = new EventEmitter(); req.setTimeout = function () {}; req.destroy = function (err) { req.emit('error', err); };
    req.end = function () { setImmediate(function () {
      calls++;
      if (calls === 1 && !status) return req.emit('error', new Error('inventory TLS failure'));
      const res = new EventEmitter(); res.statusCode = calls === 1 ? status : 200; res.headers = {}; res.setEncoding = function () {}; receive(res); res.emit('data', '[]'); res.emit('end');
    }); };
    return req;
  });
  return { client, calls: function () { return calls; } };
}
test('inventory network backoff cannot suppress the trades endpoint', function (t, done) {
  const f = fixture(t);
  f.client.request('https://data-api.polymarket.com', '/v2/positions', {}, function (err) {
    assert.match(err.message, /TLS/);
    f.client.request('https://data-api.polymarket.com', '/v2/trades', {}, function (error) { assert.ifError(error); assert.equal(f.calls(), 2); done(); });
  });
});
test('HTTP 429 continues to throttle all routes on the origin', function (t, done) {
  const f = fixture(t, 429);
  f.client.request('https://data-api.polymarket.com', '/v2/positions', {}, function (err) {
    assert.equal(err.statusCode, 429);
    f.client.request('https://data-api.polymarket.com', '/v2/trades', {}, function (error) { assert.match(error.message, /backoff/); assert.equal(error.code, 'POLYMARKET_BACKOFF'); assert.match(error.causeMessage, /HTTP 429/); assert.equal(f.calls(), 1); done(); });
  });
});
