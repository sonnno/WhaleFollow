const async = require('async');
const config = require('../../config').paper;
const http = require('../lib/http-client');

function create(db, markets, options) {
  const transport = options && options.http || http;
  let stopped = false;
  function finishJob(job, raw, error, callback) {
    db.transaction(function (tx, done) {
      let current;
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) { next(err); }); },
        function (next) { tx.one('Outbox', { where: { id: job.id } }, next); },
        function (row, next) { current = row; if (stopped || !row || row.status !== 'pending') return done(); tx.one('Leader', { where: { id: job.payload.wallet } }, next); },
        function (leader, next) { if (!leader) return done(); tx.one('Setting', { where: { id: 'task-deletion:' + job.payload.wallet } }, next); },
        function (marker, next) {
          if (marker && Number(job.payload.followGeneration || 0) <= Number(marker.value.generation)) return done();
          if (error) return next();
          markets.saveSchedule(raw, function (err) { next(err); }, tx);
        },
        function (next) {
          if (error || !raw.question) return next();
          tx.query("UPDATE paper_orders SET details=jsonb_set(details,'{signal,title}',to_jsonb($3::text),true) WHERE wallet=$1 AND condition=$2 AND COALESCE(details->'signal'->>'title','')=''", [job.payload.wallet, job.payload.condition, raw.question], function (err) { next(err); });
        },
        function (next) {
          if (error || !raw.question) return next();
          tx.query("UPDATE paper_positions SET title=$3 WHERE wallet=$1 AND condition=$2 AND title=''", [job.payload.wallet, job.payload.condition, raw.question], function (err) { next(err); });
        },
        function (next) {
          const delay = Math.max(error && error.retryAfterMs || 0, Math.min(60000, 2000 * 2 ** Math.min(5, current.attempts)));
          tx.update('Outbox', job.id, { status: error ? 'pending' : 'done', attempts: current.attempts + 1, error: error ? error.message : '', payload: { ...current.payload, retryAt: error ? Date.now() + delay : 0 } }, function (err) { next(err); });
        }
      ], done);
    }, callback);
  }
  function run(callback) {
    if (stopped) return callback();
    db.query("SELECT * FROM paper_outbox WHERE kind='market-enrich' AND status='pending' AND COALESCE((payload->>'retryAt')::bigint,0)<=$1 ORDER BY attempts,\"createdAt\" LIMIT 3", [Date.now()], function (err, rows) {
      if (err) return callback(err);
      async.eachSeries(rows, function (job, next) {
        if (stopped) return next();
        transport.request(config.gammaUrl, '/markets', { condition_ids: job.payload.condition, include_tag: true }, function (error, response) {
          const raw = !error && Array.isArray(response) && response.find(function (row) { return row.conditionId === job.payload.condition; });
          finishJob(job, raw, error || (!raw ? new Error('Market display information unavailable') : null), next);
        });
      }, callback);
    });
  }
  return { run, stop: function () { stopped = true; } };
}
module.exports = { create };
