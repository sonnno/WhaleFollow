try {
  if (process.argv[2] === 'worker') {
    require('./runtime').load(process.env.RUNTIME_DIR || '/var/lib/whalefollow');
    const settings = require('../config/DBsettings');
    const client = new (require('pg').Client)({ host: settings.POSTGRES_HOST, port: settings.POSTGRES_PORT, user: settings.POSTGRES_USER, password: settings.POSTGRES_PASSWORD, database: settings.POSTGRES_DATABASE, connectionTimeoutMillis: 4000 });
    client.on('error', function () { process.exitCode = 1; });
    client.connect(function (err) {
      if (err) { process.exitCode = 1; return; }
      client.query('SELECT "updatedAt",value FROM paper_settings WHERE id=$1', ['worker-health'], function (error, result) {
        if (error || !result.rows[0] || result.rows[0].value && result.rows[0].value.executionHalted || Date.now() - new Date(result.rows[0].updatedAt).getTime() > 180000) process.exitCode = 1;
        client.end(function () {});
      });
    });
  } else {
    const req = require('node:http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', function (res) { res.resume(); if (res.statusCode !== 200) process.exitCode = 1; });
    req.setTimeout(4000, function () { req.destroy(new Error('Healthcheck timeout')); });
    req.on('error', function () { process.exitCode = 1; });
  }
} catch (_) { process.exitCode = 1; }
