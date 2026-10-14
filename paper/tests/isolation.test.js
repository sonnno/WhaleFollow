const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
test('paper application contains no financial SDK, credentials or live runtime files', function () {
  const pkg = require('../package.json');
  ['@polymarket/client', 'viem', 'undici'].forEach(function (name) { assert.equal(pkg.dependencies[name], undefined, 'real financial dependency must be absent'); });
  ['config/live.js', 'config/live.json', 'server/live-worker.js', 'server/lib/polymarket-sdk.js', 'server/service/live-service.js', 'web/src/LiveTrading.jsx'].forEach(function (name) { assert.equal(fs.existsSync(path.join(root, name)), false, name + ' must be absent'); });
  const keys = fs.readFileSync(path.join(root, fs.existsSync(path.join(root, '.env')) ? '.env' : '.env.example'), 'utf8').split(/\r?\n/).map(function (line) { return line.split('=')[0]; });
  assert.equal(keys.some(function (key) { return /SIGNER|WALLET_ADDRESS|RELAYER|API_KEY|API_SECRET|API_PASSPHRASE/.test(key); }), false, 'paper private config must not hold live wallet credentials');
});
test('every paper entity table has its own prefix', function () { require('../server/db/entities').entities.forEach(function (entity) { assert.match(entity.options.tableName, /^paper_/); assert.equal(/^Live/.test(entity.options.name), false); }); });
test('homepage exposes all-buy pause control without a real trading page', function () { const app = fs.readFileSync(path.join(root, 'web/src/App.jsx'), 'utf8'); assert.equal(app.includes('LiveTrading'), false); assert.match(app, /暂停所有买入/); });
test('paper buy pause is account-mutex protected and preserves unrelated switches', function (_, done) {
  let locked = false, transactionUsed = false, value = { pauseAll: true, pauseBuys: false };
  const db = { transaction: function (work, cb) { transactionUsed = true; work(db, cb); }, query: function (sql, params, cb) { assert.match(sql, /paper_accounts.*FOR UPDATE/); locked = true; cb(null, [{}]); }, one: function (_, __, cb) { cb(null, { value }); }, save: function (_, row, cb) { assert.equal(locked, true); value = row.value; cb(null, row); } };
  require('../server/service/admin-service').create(db).pause({ pauseBuys: true }, function (err) { assert.ifError(err); assert.equal(transactionUsed, true); assert.deepEqual(value, { pauseAll: true, pauseBuys: true }); done(); });
});
