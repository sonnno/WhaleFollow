const async = require('async');
const WebSocket = require('ws');
const agent = require('../lib/network-agent');
function create(db, redis, leaders, markets, paper, dashboard, options) {
  options = options || {};
  const config = options.config || require('../../config').paper;
  const health = { processId: process.pid, latencyVersion: 7, executionClockVersion: 2, persistenceVersion: 3, taskDeletionVersion: 1, dailyReportVersion: 1, activityConnected: false, lastError: null, startedAt: new Date().toISOString() };
  let stopped = false, socket, reconnect, heartbeat, activityFailures = 0, equityDirty = true;
  const timers = [], locks = new Set();
  const recordHealth = require('./health-service').create(health);
  const dailyReports = options.dailyReports || require('./daily-report-service').create(db);
  const fs = require('node:fs'), path = require('node:path');
  const receiptDirectory = process.env.RUNTIME_DIR || (process.platform !== 'win32' && process.env.NODE_ENV === 'production' ? '/var/lib/whalefollow' : path.resolve(__dirname, '../../data'));
  const receiptFile = path.join(receiptDirectory, 'unrecorded-fills.jsonl');
  function report(label, error, result) { recordHealth(label, error, result); if (error && error.code !== 'POLYMARKET_BACKOFF') console.error(new Date().toISOString() + ' ' + label + ': ' + error.message); }
  function every(label, seconds, task, immediate) {
    function run() { if (stopped || locks.has(label)) return; locks.add(label); task(function (err, result) { locks.delete(label); report(label, err, result); }); }
    timers.push(setInterval(run, seconds * 1000)); if (immediate) run();
  }
  function settle(callback) {
    markets.resolutions(function (error, values) {
      if (error) return callback(error);
      async.eachSeries(values, function (row, next) { if (row.status !== 'resolved') return next(); paper.settle(row.condition_id, row, next); }, function (err) { if (!err && options.controls) { options.controls.invalidate(); options.controls.refresh(function () {}); } callback(err); });
    });
  }
  function snapshot(callback) { if (!equityDirty) return callback(); equityDirty = false; dashboard.snapshot(function (err) { if (err) equityDirty = true; callback(err); }); }
  function activity() {
    if (stopped) return;
    const connection = new WebSocket(config.activityWsUrl, { agent, handshakeTimeout: config.requestTimeoutMs });
    socket = connection;
    let lastTradeAt = Date.now(), connectionHeartbeat;
    function send(value) { connection.send(value, function (err) { if (err) { report('activity', err); connection.terminate(); } }); }
    connection.on('open', function () {
      if (stopped || socket !== connection) return connection.terminate();
      lastTradeAt = Date.now(); health.activityConnected = true; health.nextActivityRetryAt = null;
      report('activity', null);
      send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] }));
      connectionHeartbeat = setInterval(function () {
        if (connection.readyState !== WebSocket.OPEN || stopped) return;
        // A transport PONG alone does not prove the public activity subscription is still delivering.
        if (Date.now() - lastTradeAt >= 60000) {
          health.activityConnected = false;
          report('activity', Object.assign(new Error('交易推送超过60秒未更新，正在重新连接'), { code: 'ACTIVITY_STALE' }));
          return connection.terminate();
        }
        send('ping');
      }, 5000);
      heartbeat = connectionHeartbeat;
    });
    connection.on('error', function (err) { if (socket === connection) health.activityConnected = false; report('activity', err); });
    connection.on('message', function (data) {
      if (stopped || socket !== connection) return;
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (message.topic !== 'activity' || message.type !== 'trades') return;
      lastTradeAt = Date.now(); activityFailures = 0;
      health.activityMessages = (health.activityMessages || 0) + 1;
      health.lastActivityMessageAt = new Date().toISOString();
      const value = message.payload || {};
      const { receivedAt, receivedMonotonicMs } = require('../lib/execution-clock').receipt();
      const trade = require('./trade-signal-service').normalize(value);
      if (!trade) return;
      if (health.executionHalted) return;
      const cached = options.controls && options.controls.get(trade.proxy_wallet);
      if (!cached || !cached.leader) return;
      if (trade.side === 'BUY' && !cached.leader.active) return;
      health.followedActivityMessages = (health.followedActivityMessages || 0) + 1;
      health.lastFollowedActivityAt = new Date().toISOString();
      const sourceId = [trade.proxy_wallet,trade.transaction_hash,trade.token_id,trade.side].join(':');
      const signal = { id: sourceId + ':' + require('node:crypto').createHash('sha256').update(trade.price + ':' + trade.size).digest('hex').slice(0,16), sourceId, wallet: trade.proxy_wallet, token: trade.token_id, condition: trade.condition_id, side: trade.side, size: trade.size, price: trade.price,
        sourceAmount: require('./accounting-service').str(require('./accounting-service').D(trade.size).mul(trade.price)), timestamp: trade.timestamp,
        title: trade.title, outcomeIndex: trade.outcome_index, raw: [trade], origin: 'websocket', receivedAt, discoveredAt: receivedAt,
        timing: require('../lib/execution-clock').timing(receivedMonotonicMs), followGeneration: cached.task ? cached.task.generation : Number(cached.leader.raw && cached.leader.raw.followGeneration || 0), active: cached.leader.active, config: { ...config } };
      // Fresh notifications execute directly. No historical source polling,
      // persisted job lookup, Redis delivery or delayed purchase recovery.
      paper.copy(signal, function (error, result) {
        if (error && error.executedOrder) {
          health.executionHalted = true;
          try { fs.mkdirSync(receiptDirectory, { recursive: true }); fs.appendFileSync(receiptFile, JSON.stringify(error.executedOrder) + '\n'); }
          catch (failure) { console.error('Could not preserve executed result:', failure.message); }
        }
        if (result && result.fill) {
          equityDirty = true; health.lastReceivedToFillMs = Math.round(performance.now() - receivedMonotonicMs);
          health.lastReceivedToExecutionMs = result.order.details.timings.receivedToExecutionMs;
        }
        report('copy', error, result);
      });
    });
    connection.on('close', function () {
      clearInterval(connectionHeartbeat);
      if (socket !== connection) return;
      health.activityConnected = false;
      if (!stopped) {
        const delay = Math.min(30000, 3000 * 2 ** Math.min(4, activityFailures++));
        health.nextActivityRetryAt = new Date(Date.now() + delay).toISOString();
        reconnect = setTimeout(activity, delay);
      }
    });
  }
  function start(callback) {
    if (fs.existsSync(receiptFile) && fs.statSync(receiptFile).size > 0) {
      health.executionHalted = true;
      report('recording', new Error('存在未写入数据库的成交回执，停止新执行；需核对回执，不补买旧订单'));
    }
    async.waterfall([
      function (next) { paper.initialize(function (err) { next(err); }); },
      function (next) { db.query("UPDATE paper_outbox SET status='done',error='ORDER_BACKFILL_REMOVED',\"updatedAt\"=clock_timestamp() WHERE status='pending' AND kind IN ('copy','source-confirmation','source-reconcile','market-enrich')", [], function (err) { next(err); }); },
      function (next) { db.query("UPDATE paper_orders SET status='SKIPPED',reason='ORDER_BACKFILL_REMOVED',\"updatedAt\"=clock_timestamp() WHERE status='WAITING'", [], function (err) { next(err); }); }
    ], function (err) {
      if (err) return callback(err);
      markets.start(); activity();
      markets.onResolved(function () { if (stopped || locks.has('settlement')) return; locks.add('settlement'); settle(function (error) { locks.delete('settlement'); report('settlement', error); }); });
      every('leaderboard', config.leaderboardSeconds, function (next) { leaders.refresh(next); }, true);
      every('mark', 2, markets.mark, true);
      every('settlement', config.settlementSeconds, settle, true);
      every('schedule', 600, markets.schedules, true);
      if (markets.refreshParameters) every('market-parameters', 10, markets.refreshParameters);
      if (options.controls && options.controls.refresh) every('execution-controls', 1, options.controls.refresh);
      every('equity', 2, snapshot, true);
      every('daily-report', 30, dailyReports.runDue, true);
      every('health', 5, function (next) { db.save('Setting', { id: 'worker-health', value: { ...health, market: markets.health } }, function (error) { next(error); }); }, true);
      if (options.clockSync) every('clock-sync', 60, function (next) { options.clockSync(function (error, state) { if (!error) health.clock = state; next(error); }); });
      callback();
    });
  }
  function stop(callback) { stopped = true; timers.forEach(clearInterval); clearTimeout(reconnect); clearInterval(heartbeat); if (socket) socket.terminate(); markets.stop(); callback(); }
  return { start, stop, health };
}
module.exports = { create };
