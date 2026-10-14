const async = require('async');
const config = require('../../config').paper;
function create(db) {
  function pause(value, callback) {
    for (const key of ['pauseBuys', 'pauseAll']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') return callback(Object.assign(new Error('暂停开关必须为 true 或 false'), { status: 400 }));
    db.transaction(function (tx, done) {
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (_, next) { tx.one('Setting', { where: { id: 'runtime' } }, next); },
        function (row, next) { const runtime = { ...(row && row.value || {}) }; for (const key of ['pauseBuys', 'pauseAll']) if (Object.hasOwn(value, key)) runtime[key] = value[key]; tx.save('Setting', { id: 'runtime', value: runtime }, function (err) { next(err, { ok: true, runtime }); }); }
      ], done);
    }, callback);
  }
  return {
    settings: function (callback) { db.one('Setting', { where: { id: 'runtime' } }, function (err, row) { callback(err, { config, runtime: row ? row.value : {}, mode: 'paper' }); }); },
    pause,
    health: function (callback) { db.one('Setting', { where: { id: 'worker-health' } }, function (err, row) { callback(err, { database: !err, worker: row ? row.value : null, workerUpdatedAt: row ? row.updatedAt : null }); }); }
  };
}
module.exports = { create };
