require('../config');
const http = require('node:http');
const async = require('async');
const assert = require('node:assert/strict');
let cookie;
function request(route, data, callback) {
  const body = data ? JSON.stringify(data) : null;
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/api' + route, method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Requested-With': 'XMLHttpRequest' } : {}) } }, function (res) {
    let chunks = '';
    res.on('data', function (value) { chunks += value; });
    res.on('end', function () { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; try { callback(null, { status: res.statusCode, body: JSON.parse(chunks) }); } catch (err) { callback(err); } });
  });
  req.on('error', callback); req.setTimeout(5000, function () { req.destroy(new Error('Timeout')); }); req.end(body);
}
async.waterfall([
  function (next) { request('/overview', null, next); },
  function (result, next) { assert.equal(result.status, 401); request('/daily-reports', null, next); },
  function (result, next) { assert.equal(result.status, 401); request('/login', { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }, next); },
  function (result, next) { assert.equal(result.status, 200); request('/overview', null, next); },
  function (result, next) { assert.equal(result.status, 200); assert.equal(result.body.mode, 'paper'); request('/settings', null, next); },
  function (result, next) { assert.equal(result.status, 200); assert.ok(!JSON.stringify(result.body).includes(process.env.ADMIN_PASSWORD)); request('/analytics', null, next); },
  function (result, next) { assert.equal(result.status, 200); assert.ok(Array.isArray(result.body.snapshots)); request('/cash-summary', null, next); },
  function (result, next) {
    assert.equal(result.status, 200); const stats = result.body; const D = require('../server/service/accounting-service').D;
    assert.ok(D(stats.settledWins).minus(stats.settledLosses).eq(stats.settledProfit));
    assert.ok(D(stats.initialCash).minus(stats.wagered).plus(stats.settlementRevenue).plus(stats.saleRevenue).eq(stats.cash));
    assert.ok(Array.isArray(stats.history)); assert.equal(typeof stats.pendingBets, 'number'); assert.ok(stats.totalProfit !== undefined); request('/bets?limit=20', null, next);
  },
  function (result, next) {
    assert.equal(result.status, 200); const bets = result.body; assert.ok(bets.data.length <= 20); assert.ok(bets.total >= bets.data.length);
    bets.data.forEach(function (row, index) { assert.ok(Number(row.amount) > 0); assert.ok(row.traderName); assert.ok(row.title); if (index) assert.ok(new Date(row.createdAt) <= new Date(bets.data[index - 1].createdAt)); });
    request('/bets?limit=20&offset=20&asOf=' + encodeURIComponent(bets.asOf) + '&snapshot=' + encodeURIComponent(bets.snapshot), null, next);
  },
  function (result, next) { assert.equal(result.status, 200); assert.equal(result.body.offset, 20); request('/daily-reports?limit=20&offset=0', null, next); },
  function (result, next) { assert.equal(result.status, 200); assert.equal(result.body.timezone, 'Asia/Shanghai'); assert.equal(result.body.closeTime, '10:00'); assert.ok(Array.isArray(result.body.data)); assert.ok(result.body.total >= result.body.data.length); next(); }
], function (err) { if (err) { console.error(err.message); process.exitCode = 1; } else console.log('HTTP integration passed: authentication, overview, masked configuration, analytics.'); });
