const test = require('node:test'), assert = require('node:assert/strict');
const html = '<html><head></head><body><div id="root"></div></body></html>';
test('authenticated HTML includes prepared balances without PostgreSQL or an initial login round trip', function (_, done) {
  const handler = require('../server/service/home-page-service').create({
    summary: function (cb) { cb(null, { cash: '350', walletBalances: [{ name: '</script><script>evil()</script>' }] }); },
    settings: function (cb) { cb(null, { runtime: {} }); }
  }, html);
  const res = { headers: {}, set: function (key, value) { res.headers[key] = value; return res; },
    vary: function () { return res; }, type: function () { return res; }, req: { get: function () { return ''; } },
    send: function (body) {
      assert.match(body, /"cash":"350"/); assert.match(body, /"username":"admin"/);
      assert.doesNotMatch(body, /<script>evil/); assert.match(res.headers['Cache-Control'], /no-store/); done();
    } };
  handler({ session: { user: { username: 'admin' } } }, res);
});
test('anonymous HTML never includes wallet data', function (_, done) {
  const handler = require('../server/service/home-page-service').create({ summary: function () { throw new Error('Anonymous account access'); } }, html);
  const res = { set: function () { return res; }, vary: function () { return res; }, type: function () { return res; }, req: { get: function () { return ''; } },
    send: function (body) { assert.match(body, /"user":null/); assert.doesNotMatch(body, /cash-summary/); done(); } };
  handler({ session: {} }, res);
});
