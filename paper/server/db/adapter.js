require('reflect-metadata');
const async = require('async');
const { DataSource } = require('typeorm');
const { entities } = require('./entities');
const config = require('../../config');
const { callbackify } = require('node:util');

// TypeORM has Promise-only APIs. Business services see error-first callbacks only.
function invoke(operation, callback) {
  let result;
  try { result = operation(); } catch (err) { return callback(err); }
  callbackify(function () { return result; })(callback);
}

function scope(manager) {
  return {
    query: function (sql, params, callback) { invoke(function () { return manager.query(sql, params); }, callback); },
    find: function (entity, options, callback) { invoke(function () { return manager.getRepository(entity).find(options); }, callback); },
    one: function (entity, options, callback) { invoke(function () { return manager.getRepository(entity).findOne(options); }, callback); },
    save: function (entity, value, callback) { invoke(function () { return manager.getRepository(entity).save(value); }, callback); },
    insert: function (entity, value, callback) { invoke(function () { return manager.getRepository(entity).insert(value); }, callback); },
    update: function (entity, where, value, callback) { invoke(function () { return manager.getRepository(entity).update(where, value); }, callback); }
  };
}

function watchLease(client, onLost) {
  let armed = true;
  function lost(err) { if (!armed) return; armed = false; onLost(err || new Error('Worker lease connection closed')); }
  client.on('error', lost);
  client.on('end', lost);
  return function () { armed = false; client.removeListener('error', lost); client.removeListener('end', lost); };
}

function runTransaction(runner, work, callback) {
  let begun = false;
  async.waterfall([
    function (next) { invoke(function () { return runner.connect(); }, next); },
    function (_, next) { invoke(function () { return runner.startTransaction(); }, next); },
    function (_, next) {
      begun = true;
      let completed = false;
      function done(err, result) { if (completed) return; completed = true; next(err, result); }
      try { work(scope(runner.manager), done); } catch (err) { next(err); }
    },
    function (result, next) { invoke(function () { return runner.commitTransaction(); }, function (err) { if (!err) begun = false; next(err, result); }); }
  ], function (error, result) {
    function release(err) { invoke(function () { return runner.release(); }, function (releaseError) { callback(error || err || releaseError, result); }); }
    if (error && begun) invoke(function () { return runner.rollbackTransaction(); }, release);
    else release();
  });
}

function create(options) {
  options = options || {};
  const settings = config.db;
  const migrations = [require('./migrations/initial'), require('./migrations/daily-reports')];
  migrations.push(require('./migrations/independence'));
  migrations.push(require('./migrations/follow-tasks'));
  migrations.push(require('./migrations/manual-transfers'));
  migrations.push(require('./migrations/daily-task-reports'));
  migrations.push(require('./migrations/execution-indexes'));
  const source = new DataSource({ type: 'postgres', host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, username: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: options.database || settings.POSTGRES_DATABASE, entities, migrations, migrationsTableName: 'paper_migrations', synchronize: false, logging: false, extra: { connectionTimeoutMillis: 5000, max: 10, options: '-c max_parallel_workers_per_gather=0' } });
  function acquireLease(key, onLost, callback) {
      const runner = source.createQueryRunner();
      async.waterfall([
        function (next) { invoke(function () { return runner.connect(); }, function (err) { next(err); }); },
        function (next) { invoke(function () { return runner.query('SELECT pg_try_advisory_lock($1) AS acquired', [key]); }, next); }
      ], function (err, rows) {
        if (err || !rows[0].acquired) return invoke(function () { return runner.release(); }, function () { callback(err || new Error('Another process owns this database lease')); });
        const disarm = watchLease(runner.databaseConnection, onLost);
        callback(null, function (released) { disarm(); invoke(function () { return runner.query('SELECT pg_advisory_unlock($1)', [key]); }, function (error) { invoke(function () { return runner.release(); }, function (releaseError) { released(error || releaseError); }); }); });
      });
  }
  return {
    ...scope(source.manager),
    connect: function (callback) { invoke(function () { return source.initialize(); }, callback); },
    close: function (callback) { if (!source.isInitialized) return callback(); invoke(function () { return source.destroy(); }, callback); },
    migrate: function (callback) {
      invoke(function () { return source.query("DO $$ BEGIN IF to_regclass('public.live_system_identity') IS NOT NULL OR to_regclass('public.live_migrations') IS NOT NULL OR to_regclass('public.live_intents') IS NOT NULL THEN RAISE EXCEPTION 'Paper cannot migrate a live-owned database'; END IF; IF to_regclass('public.migrations') IS NOT NULL AND to_regclass('public.paper_migrations') IS NOT NULL THEN RAISE EXCEPTION 'Ambiguous migration histories'; END IF; IF to_regclass('public.migrations') IS NOT NULL THEN ALTER TABLE migrations RENAME TO paper_migrations; END IF; END $$"); }, function (err) { if (err) return callback(err); invoke(function () { return source.runMigrations(); }, callback); });
    },
    transaction: function (work, callback) { runTransaction(source.createQueryRunner(), work, callback); },
    lease: function(onLost, callback) { acquireLease(options.leaseKey || 178002, onLost, callback); },
    apiLease: function(onLost, callback) { acquireLease(178004, onLost, callback); }
  };
}
module.exports = { create, invoke, runTransaction, watchLease };
