// Run only against a disposable Compose project, never a real following account.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const async = require('async');
require('./runtime').load(process.env.RUNTIME_DIR || '/var/lib/whalefollow');
const db = require('../server/db/adapter').create();
const phase = process.argv[2];
let cookie, taskState;
function request(route, body, callback) {
  const payload = body && JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: 3000, path: route, method: payload ? 'POST' : 'GET', headers: { ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'content-length': Buffer.byteLength(payload) } : {}) } }, function (res) {
    let text = '';
    if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].map(function (value) { return value.split(';')[0]; }).join('; ');
    res.setEncoding('utf8'); res.on('data', function (chunk) { text += chunk; });
    res.on('end', function () { let value; try { value = JSON.parse(text); assert.equal(res.statusCode, 200); } catch (err) { return callback(err); } callback(null, value); });
    res.on('error', callback);
  });
  req.setTimeout(5000, function () { req.destroy(new Error('Smoke HTTP timed out')); });
  req.on('error', callback); req.end(payload || undefined);
}
const fingerprint = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD + process.env.SESSION_SECRET + process.env.POSTGRES_PASSWORD).digest('hex');
async.waterfall([
  function (next) { if (!['prepare', 'check'].includes(phase)) return next(new Error('Expected prepare or check')); if (fs.existsSync('/app/.env') || fs.existsSync('/app/config/local.json')) return next(new Error('Local secrets leaked into image')); request('/healthz', null, next); },
  function (_, next) { request('/api/login', { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }, next); },
  function (_, next) { request('/api/follow-tasks', null, next); },
  function (result, next) {
    try { assert.equal(result.wallet.initialCash, '350.000000000000000000'); assert.equal(Number(result.wallet.cash), 350); assert.equal(result.data.length, 0); taskState = result.wallet; } catch (err) { return next(err); }
    const until = Date.now() + 90000;
    function ready() { request('/api/health', null, function (err, health) { if (err) return next(err); if (health.database && health.worker && Date.now() - Date.parse(health.workerUpdatedAt) < 180000) return next(); if (Date.now() > until) return next(new Error('Worker heartbeat not ready')); setTimeout(ready, 1000); }); }
    ready();
  },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.one('Setting', { where: { id: 'deploy-smoke' } }, next); },
  function (prior, next) {
    if (phase === 'prepare') { if (prior) return next(new Error('Smoke must start from a fresh disposable database')); return db.save('Setting', { id: 'deploy-smoke', value: { fingerprint, wallet: taskState } }, function (err) { next(err); }); }
    try { assert.ok(prior, 'Persistent database marker disappeared'); assert.equal(prior.value.fingerprint, fingerprint, 'Persistent credentials changed'); assert.deepEqual(prior.value.wallet, taskState); } catch (err) { return next(err); }
    next();
  }
], function (err) { db.close(function () { if (err) { console.error('Compose smoke failed:', err.message); process.exitCode = 1; } else console.log('Compose ' + phase + ' verified: login, wallet350, empty tasks, worker heartbeat, isolated image and persistent state'); }); });
