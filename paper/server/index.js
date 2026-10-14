const async = require('async');
const express = require('express');
const session = require('express-session');
const path = require('node:path');
require('../config');
const db = require('./db/adapter').create();
const controlRedis = require('./lib/redis')();
const dashboard = require('./service/dashboard-service').create(db);
const marketStatistics=require('./service/market-statistics-service').create(db);
const dailyReports = require('./service/daily-report-service').create(db);
const admin = require('./service/admin-service').create(db);
const leaderboardQuery = require('./service/leaderboard-query-service').create();
const followTasks = require('./service/follow-task-service').create(db);
const followTransfers = require('./service/follow-transfer-service').create(db);
const taskDeletion = require('./service/task-deletion-service').create(db);
const taskOnboarding = require('./service/task-onboarding-service').create(db);
const paper = require('./service/paper-service').create(db, null);
const { DatabaseSessionStore } = require('./service/auth-service');
const auth = require('./service/auth-service').create();
const app = express();
const refreshStreams = new Set();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(function (req, res, next) { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY'); if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(session({ name: 'paper.sid', secret: process.env.SESSION_SECRET || 'disabled-until-configured', resave: false, saveUninitialized: false, store: new DatabaseSessionStore(db), cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600000 } }));
app.get('/healthz', function (req, res) { if (closing) return res.status(503).json({ ok: false }); db.query('SELECT 1', [], function (err) { res.status(err ? 503 : 200).json({ ok: !err }); }); });
app.use('/api', function (req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return res.status(403).json({ error: '缺少请求校验头' });
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: '跨站请求被拒绝' });
  }
  next();
});
function reply(res) { return function (err, data) { if (err) res.status(err.status || err.statusCode || 500).json({ error: err.message }); else res.json(data === undefined ? { ok: true } : data); }; }
function controlReply(res) { return function (err, data) { if (err) return reply(res)(err); controlRedis.publish(require('./service/execution-control-service').channel, 'refresh', function () { reply(res)(null, data); }); }; }
app.post('/api/login', function (req, res) {
  auth.login(req.body.username, req.body.password, req.ip, function (err, user) {
    if (err) return reply(res)(err);
    req.session.regenerate(function (error) { if (error) return reply(res)(error); req.session.user = user; req.session.save(function (saveError) { reply(res)(saveError, user); }); });
  });
});
app.get('/api/me', function (req, res) { if (!req.session.user) return res.status(401).json({ error: '请登录' }); res.json(req.session.user); });
app.use('/api', function (req, res, next) { if (!req.session.user) return res.status(401).json({ error: '请登录' }); next(); });
app.post('/api/logout', function (req, res) { req.session.destroy(reply(res)); });
app.get('/api/leaderboards/catalog', function (req, res) { res.json(leaderboardQuery.catalog()); });
app.get('/api/leaderboards', function (req, res) { leaderboardQuery.query(req.query, reply(res)); });
app.get('/api/follow-tasks', function (req, res) { followTasks.list(reply(res)); });
app.post('/api/follow-tasks', function (req, res) { followTasks.save(req.body, controlReply(res)); });
app.post('/api/follow-tasks/setup', function (req, res) { taskOnboarding.setup(req.body, controlReply(res)); });
app.post('/api/follow-tasks/:wallet/control', function (req, res) { followTasks.control(req.params.wallet, req.body, controlReply(res)); });
app.post('/api/follow-tasks/:wallet/transfers', function (req, res) { followTransfers.transfer(req.params.wallet, req.body, controlReply(res)); });
app.get('/api/follow-tasks/:wallet/transfers', function (req, res) { followTransfers.list(req.params.wallet, req.query, reply(res)); });
app.post('/api/follow-tasks/:wallet/delete', function (req, res) { taskDeletion.remove(req.params.wallet, req.body, controlReply(res)); });
app.get('/api/overview', function (req, res) { dashboard.overview(reply(res)); });
app.get('/api/cash-summary', function (req, res) { dashboard.cashSummary(reply(res)); });
app.get('/api/bets', function (req, res) { dashboard.bets(req.query, reply(res)); });
const collections = { leaders: 'leaders', 'copy-events': 'copies', 'paper-orders': 'copies', positions: 'positions', settlements: 'settlements', ledger: 'ledger', sources: 'sources' };
Object.entries(collections).forEach(function ([route, kind]) { app.get('/api/' + route, function (req, res) { dashboard.list(kind, req.query, reply(res)); }); });
app.get('/api/paper-orders/:id', function (req, res) { dashboard.detail(req.params.id, reply(res)); });
app.get('/api/analytics', function (req, res) { dashboard.analytics(reply(res)); });
app.get('/api/market-statistics',function(req,res){marketStatistics.list(req.query,reply(res));});
app.get('/api/daily-reports', function (req, res) { dailyReports.list(req.query, reply(res)); });
app.get('/api/daily-task-reports',function(req,res){dailyReports.listTasks(req.query,reply(res));});
app.get('/api/daily-report-traders',function(req,res){dailyReports.traders(reply(res));});
app.get('/api/settings', function (req, res) { admin.settings(reply(res)); });
app.post('/api/settings', function (req, res) { admin.pause(req.body, controlReply(res)); });
app.get('/api/health', function (req, res) { admin.health(reply(res)); });
app.get('/api/events', function (req, res) {
  if (!require('./service/http-lifecycle-service').registerRefreshStream(refreshStreams,res,closing)) return;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  function push() { res.write('event: refresh\ndata: ' + JSON.stringify({ at: Date.now() }) + '\n\n'); }
  push();
  const timer = setInterval(push, 5000);
  req.on('close', function () { clearInterval(timer); refreshStreams.delete(res); });
});
app.get('/api/export/:kind', function (req, res) {
  dashboard.list(req.params.kind, { ...req.query, limit: 500 }, function (err, result) {
    if (err) return reply(res)(err);
    const keys = result.data.length ? Object.keys(result.data[0]).filter(function (key) { return !['details', 'raw', 'evidence', 'totalRows'].includes(key); }) : ['id'];
    function cell(value) { let text = value === null || value === undefined ? '' : String(value); if (/^[=+\-@]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="paper-' + req.params.kind + '.csv"');
    res.send('\uFEFF' + [keys.map(cell).join(','), ...result.data.map(function (row) { return keys.map(function (key) { return cell(row[key]); }).join(','); })].join('\r\n'));
  });
});
app.use(express.static(path.join(__dirname, '../web/dist')));
app.get('/{*path}', function (req, res) { res.sendFile(path.join(__dirname, '../web/dist/index.html')); });
app.use(function (err, req, res, next) { if (res.headersSent) return next(err); res.status(400).json({ error: err.message }); });
let server, releaseApi, closing = false;
async.waterfall([
  function (next) { if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) return next(new Error('请运行 node scripts/setup-local.js 生成管理员配置，或在 .env 设置 ADMIN_PASSWORD 和 SESSION_SECRET')); db.connect(function (err) { next(err); }); },
  function (next) { db.apiLease(function () { process.exitCode = 1; shutdown(); }, function (err, release) { releaseApi = release; next(err); }); },
  function (next) { paper.initialize(function (err) { next(err); }); },
  function (next) { followTasks.initialize(function (err) { next(err); }); },
  function (next) { controlRedis.connect(function () { next(); }); }
], function (err) {
  if (err) { console.error('API start failed:', err.message); process.exitCode = 1; shutdown(); return; }
  const listen = require('./lib/listen-options').listenOptions();
  server = app.listen(listen.port, listen.host, function () { console.log('Paper dashboard listening on ' + listen.host + ':' + listen.port); });
  server.on('error', function (error) { console.error(error.message); process.exitCode = 1; shutdown(); });
});
function shutdown() { if (closing) return; closing = true; function close() { controlRedis.disconnect(); if (releaseApi) { const release = releaseApi; releaseApi = null; release(function () { db.close(function () {}); }); } else db.close(function () {}); } require('./service/http-lifecycle-service').closeServer(server,refreshStreams,close); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
