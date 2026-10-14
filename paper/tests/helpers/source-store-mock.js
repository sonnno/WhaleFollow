// In-memory storage adapter for existing Source business-rule tests. Real SQL
// and its rollback/precision are exercised by deploy/copy-store-smoke.js.
module.exports = function () {
  const async = require('async'), store = require('../../server/service/source-store');
  store.read = function (tx, group, callback) {
    async.parallel({
      job: function (done) { if (!group.reconciliationJobId) return done(null, null); tx.one('Outbox', { where: { id: group.reconciliationJobId } }, done); },
      quarantine: function (done) { tx.one('Setting', { where: { id: 'quarantine:' + group.id } }, done); },
      source: function (done) { tx.one('Source', { where: { id: group.id } }, done); },
      leader: function (done) { tx.one('Leader', { where: { id: group.wallet } }, done); },
      runtime: function (done) { tx.one('Setting', { where: { id: 'runtime' } }, done); }
    }, callback);
  };
  store.save = function (tx, source, leader, callback) {
    async.series([
      function (next) { if (!source) return next(); tx.save('Source', source, function (err) { next(err); }); },
      function (next) { if (!leader) return next(); tx.save('Leader', leader, function (err) { next(err); }); }
    ], callback);
  };
};
