const async = require('async');
const db = require('./db/adapter').create();
const redis = require('./lib/redis')();
const leaders = require('./service/leader-service').create(db);
const markets = require('./service/market-service').create(db, redis);
const controls = require('./service/execution-control-service').create(db, redis);
const matchRatios = require('./service/match-ratio-service').create(db, markets);
const sourcePositions = require('./service/leader-position-sale-service').create(db, { controls });
const skips = require('./service/copy-skip-service').create(db);
const paper = require('./service/paper-service').create(db, markets, { controls, matchRatios, skips });
const dashboard = require('./service/dashboard-service').create(db);
function clockSync(callback) { require('./lib/execution-clock').synchronize(require('./lib/http-client'), require('../config').paper.clobUrl, callback); }
const worker = require('./service/worker-service').create(db, redis, leaders, markets, paper, dashboard, { clockSync, controls, matchRatios, skips, sourcePositions });
const tasks = require('./service/follow-task-service').create(db);
let releaseLease;
async.waterfall([
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.lease(function (err) { console.error('Worker stopped after lease loss:', err.message); process.exitCode = 1; shutdown(); }, function (err, release) { releaseLease = release; next(err); }); },
  function (next) { redis.connect(function (err) { next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { tasks.initialize(function (err) { next(err); }); },
  function (next) { matchRatios.start(next); },
  function (next) { controls.start(next); },
  function (next) { markets.loadPolicies(next); },
  function (next) { clockSync(function (error, state) { if (error) console.error('Official clock sync unavailable:', error.message); else worker.health.clock = state; next(); }); },
  function (next) { worker.start(next); }
], function (err) {
  if (err) { console.error('Worker start failed:', err.message); shutdown(); process.exitCode = 1; }
  else console.log('Paper worker started');
});
function shutdown() { worker.stop(function () { controls.stop(); redis.disconnect(); if (releaseLease) { const release = releaseLease; releaseLease = null; release(function () { db.close(function () {}); }); } else db.close(function () {}); }); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
