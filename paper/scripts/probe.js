const async = require('async');
const http = require('../server/lib/http-client');
const config = require('../config').paper;
async.waterfall([
  function (next) { http.request(config.dataUrl, '/v2/leaderboard', { category: 'overall', time_period: 'month', sort_by: 'PNL', limit: 10 }, next); },
  function (response, next) { console.log('Monthly leaderboard rows:', Array.isArray(response.data) ? response.data.length : 'invalid'); next(); }
], function (err) { if (err) { console.error(err.message); process.exitCode = 1; } });
