const async = require('async');
const db = require('../server/db/adapter').create();
let releaseLease;
async.waterfall([
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.lease(function (err) { console.error(err.message); process.exitCode = 1; }, function (err, release) { releaseLease = release; next(err); }); },
  function (next) { require('../server/service/repair-service').create(db).zeroValueBuys(next); }
], function (err, result) {
  if (err) { console.error(err.message); process.exitCode = 1; }
  else console.log(JSON.stringify(result));
  function close() { db.close(function () {}); }
  if (releaseLease) releaseLease(function (releaseError) { if (releaseError) { console.error(releaseError.message); process.exitCode = 1; } close(); });
  else close();
});
