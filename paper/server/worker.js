const async = require('async');
const db = require('./db/adapter').create();
const redis = require('./lib/redis')();
const leaders = require('./service/leader-service').create(db);
const sources = require('./service/source-service').create(db);
const markets = require('./service/market-service').create(db, redis);
const paper = require('./service/paper-service').create(db, markets);
const dashboard = require('./service/dashboard-service').create(db);
const worker = require('./service/worker-service').create(db, redis, leaders, sources, markets, paper, dashboard);
const tasks = require('./service/follow-task-service').create(db);
let releaseLease;
async.waterfall([
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.lease(function (err) { console.error('Worker stopped after lease loss:', err.message); process.exitCode = 1; shutdown(); }, function (err, release) { releaseLease = release; next(err); }); },
  function (next) { redis.connect(function (err) { next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { tasks.initialize(function (err) { next(err); }); },
  function (next) { worker.start(next); }
], function (err) {
  if (err) { console.error('Worker start failed:', err.message); shutdown(); process.exitCode = 1; }
  else console.log('Paper worker started');
});
function shutdown() { worker.stop(function () { redis.disconnect(); if (releaseLease) { const release = releaseLease; releaseLease = null; release(function () { db.close(function () {}); }); } else db.close(function () {}); }); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
