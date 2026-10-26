const test = require('node:test'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const { sendPrepared } = require('../server/service/web-response-service');
test('prepared history is gzip-compressed for browsers and decodes to the same data', function (_, done) {
  const data = { history: Array.from({ length: 100 }, function (_, i) { return { createdAt: i, settledProfit: '1.234' }; }) };
  const headers = {};
  const res = { req: { get: function () { return 'gzip, deflate'; }, acceptsEncodings: function () { return 'gzip'; } },
    vary: function () { return res; }, type: function () { return res; }, set: function (key, value) { headers[key] = value; return res; },
    send: function (body) { assert.equal(headers['Content-Encoding'], 'gzip'); assert.ok(body.length < 1000); assert.deepEqual(JSON.parse(zlib.gunzipSync(body)), data); done(); } };
  sendPrepared(res, null, data);
});
test('clients without gzip receive JSON and initialization errors finish immediately', function () {
  let response, code;
  const res = { req: { get: function () { return ''; } }, vary: function () { return res; }, type: function () { return res; },
    send: function (body) { response = body; }, status: function (value) { code = value; return res; }, json: function (value) { response = value; } };
  sendPrepared(res, null, { cash: '350' }); assert.equal(response, '{"cash":"350"}');
  sendPrepared(res, Object.assign(new Error('initializing'), { status: 503 })); assert.equal(code, 503); assert.equal(response.error, 'initializing');
});
