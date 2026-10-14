const async = require('async');
const { Client } = require('pg');
const settings = require('../config/DBsettings');
const db = require('../server/db/adapter').create();
const admin = new Client({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
let releaseLease, releaseApi;
async.waterfall([
  function (next) { admin.connect(function (err) { next(err); }); },
  function (next) { admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [settings.POSTGRES_DATABASE], next); },
  function (result, next) {
    if (result.rowCount) return next();
    const name = '"' + settings.POSTGRES_DATABASE.replace(/"/g, '""') + '"';
    admin.query('CREATE DATABASE ' + name, function (err) { next(err); });
  },
  function (next) { admin.end(next); },
  function (next) { db.connect(function (err) { next(err); }); },
  function (next) { db.lease(function () { process.exitCode = 1; }, function (err, release) { releaseLease = release; next(err); }); },
  function (next) { db.apiLease(function () { process.exitCode = 1; }, function (err, release) { releaseApi = release; next(err); }); },
  function (next) { db.migrate(function (err, rows) { if (!err) console.log('Migrations applied:', rows.length); next(err); }); }
], function (err) {
  function close() { db.close(function () { if (err) { console.error('Database initialization failed:', err.message); process.exitCode = 1; } }); }
  function workerRelease() { if (releaseLease) releaseLease(close); else close(); }
  if (releaseApi) releaseApi(workerRelease); else workerRelease();
  if (err) admin.end(function () {});
});
