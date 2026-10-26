const async = require('async');
const WebSocket = require('ws');
const agent = require('../lib/network-agent');
const clock = require('../lib/execution-clock');
const { monitorEventLoopDelay } = require('node:perf_hooks');
function create(db, redis, leaders, markets, paper, dashboard, options) {
  options = options || {};
  const config = options.config || require('../../config').paper;
  const sourcePositions = options.sourcePositions;
  const health = { processId: process.pid, latencyVersion: 11, policyWaitVersion: 1, executionClockVersion: 2, persistenceVersion: 3, taskDeletionVersion: 1, dailyReportVersion: 1, activityConnected: false, lastError: null, startedAt: new Date().toISOString() };
  let stopped = false, socket, reconnect, heartbeat, activityFailures = 0, equityDirty = true, executing = 0, receiptWriteFailed = false;
  const timers = [], locks = new Set();
  const feed = require('./activity-feed-service').create(), connections = new Set(), connectionHeartbeats = new Set(), connectionTimeouts = new Set();
  const loop = options.eventLoopMonitor || monitorEventLoopDelay({ resolution: 20 });
  let connectionSequence = 0, replacement, nextHandoverAt = 0, loopWindowStartedAt = Date.now();
  health.activitySkips = {}; health.activityStreams = {}; health.activityDuplicateMessages = 0;
  function skip(reason, value, diagnostic) {
    health.activitySkips[reason] = (health.activitySkips[reason] || 0) + 1;
    if (value) health.lastActivitySkip = { reason, tx: value.transactionHash || value.transaction_hash, asset: value.asset || value.token_id, sourceTimestamp: value.timestamp, feed: diagnostic };
  }
  function loopStatus() { return { meanMs: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null, maxMs: loop.max / 1e6, p99Ms: loop.percentile(99) / 1e6, windowStartedAtMs: loopWindowStartedAt, sampledAtMs: Date.now() }; }
  const recordHealth = require('./health-service').create(health);
  const dailyReports = options.dailyReports || require('./daily-report-service').create(db);
  const path = require('node:path');
  const receiptDirectory = process.env.RUNTIME_DIR || (process.platform !== 'win32' && process.env.NODE_ENV === 'production' ? '/var/lib/whalefollow' : path.resolve(__dirname, '../../data'));
  const receipts = options.receiptJournal || require('./executed-receipt-service').create(receiptDirectory);
  function recordReceipts(callback) {
    if (!health.executionHalted || executing || receiptWriteFailed) return callback();
    receipts.flush(paper.recordExecuted, function (receipt) {
      if (options.controls) options.controls.complete(receipt.order.id);
      equityDirty = true;
    }, function (err) {
      if (err) return callback(err);
      if (receipts.count()) return callback();
      function resumed(error) {
        if (!error) { health.executionHalted = false; health.recordingRecoveredAt = new Date().toISOString(); }
        callback(error);
      }
      async.waterfall([
        // Older executed receipts have no ratio metadata. Rebuild from their
        // recorded buys before accepting any new execution after recovery.
        function (next) { if (options.matchRatios) return options.matchRatios.start(next); next(); },
        function (next) { if (options.controls && options.controls.resume) return options.controls.resume(next); next(); }
      ], resumed);
    });
  }
  function report(label, error, result) { recordHealth(label, error, result); if (error && error.code !== 'POLYMARKET_BACKOFF') console.error(new Date().toISOString() + ' ' + label + ': ' + error.message); }
  function every(label, seconds, task, immediate) {
    function run() { if (stopped || locks.has(label)) return; locks.add(label); task(function (err, result) { locks.delete(label); report(label, err, result); }); }
    timers.push(setInterval(run, seconds * 1000)); if (immediate) run();
  }
  function settle(callback) {
    if (health.executionHalted || executing) return callback();
    markets.resolutions(function (error, values) {
      if (error) return callback(error);
      const resolved = values.filter(function (row) { return row.status === 'resolved'; });
      if (!resolved.length) return callback();
      async.eachSeries(resolved, function (row, next) { paper.settle(row.condition_id, row, next); }, function (err) { if (!err && options.controls) options.controls.refresh(function () {}); callback(err); });
    });
  }
  function snapshot(callback) { if (!equityDirty) return callback(); equityDirty = false; dashboard.snapshot(function (err) { if (err) equityDirty = true; callback(err); }); }
  function scheduleReconnect() {
    if (stopped || replacement || connections.has(socket) || reconnect) return;
    const delay = Math.min(30000, 3000 * 2 ** Math.min(4, activityFailures++));
    health.nextActivityRetryAt = new Date(Date.now() + delay).toISOString();
    reconnect = setTimeout(function () { reconnect = null; activity(); }, delay);
  }
  function activity(previous) {
    if (stopped || (!previous && replacement)) return;
    const connection = new WebSocket(config.activityWsUrl, { agent, handshakeTimeout: config.requestTimeoutMs });
    if (!previous) socket = connection; else replacement = connection;
    connections.add(connection);
    const connectionId = process.pid + ':' + (++connectionSequence);
    let lastTradeAt = Date.now(), connectionHeartbeat, staleMessages = 0, subscriptionSent = false, deliveryTimeout, silenceReported = false;
    if (previous) {
      nextHandoverAt = Date.now() + 30000;
      deliveryTimeout = setTimeout(function () { connectionTimeouts.delete(deliveryTimeout); if (!stopped && replacement === connection) connection.terminate(); }, 15000);
      connectionTimeouts.add(deliveryTimeout);
    }
    function send(value) { connection.send(value, function (err) { if (!stopped && err) { report('activity', err); connection.terminate(); } }); }
    connection.on('open', function () {
      if (stopped || (socket !== connection && replacement !== connection)) return connection.terminate();
      lastTradeAt = Date.now(); health.activityConnected = true; health.nextActivityRetryAt = null;
      report('activity', null);
      connection.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'orders_matched' }, { topic: 'activity', type: 'trades' }] }), function (err) {
        if (stopped) return connection.terminate();
        if (err) { report('activity', err); return connection.terminate(); }
        subscriptionSent = true;
      });
      connectionHeartbeat = setInterval(function () {
        if (connection.readyState !== WebSocket.OPEN || stopped) return;
        const silenceMs = Date.now() - lastTradeAt;
        if (silenceMs >= 10000 && socket === connection && !replacement && Date.now() >= nextHandoverAt) {
          if (sourcePositions) sourcePositions.invalidate('FEED_GAP');
          const gap = { connectionId, lastMessageAt: new Date(lastTradeAt).toISOString(), detectedAt: new Date().toISOString(), silenceMs };
          health.activityGaps = [...(health.activityGaps || []), gap].slice(-20);
          console.error(new Date().toISOString() + ' activity-gap: ' + JSON.stringify(gap));
          // Keep the old subscription until the replacement delivers an actual
          // trade. This is reconnecting the live feed, never replaying old buys.
          activity(connection);
        }
        // A transport PONG alone does not prove the public activity subscription is still delivering.
        if (silenceMs >= 60000) {
          health.activityConnected = false;
          if (!silenceReported) { silenceReported = true; report('activity', Object.assign(new Error('交易推送超过60秒未更新，正在重新连接'), { code: 'ACTIVITY_STALE' })); }
        }
        send('ping');
      }, 5000);
      heartbeat = connectionHeartbeat;
      connectionHeartbeats.add(connectionHeartbeat);
    });
    connection.on('error', function (err) { if (stopped) return; if (socket === connection) health.activityConnected = false; report('activity', err); });
    connection.on('message', function (data) {
      const rawReceivedAtMs = Date.now(), receipt = clock.receipt();
      if (stopped || (socket !== connection && replacement !== connection)) return;
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (message.topic !== 'activity' || !['trades', 'orders_matched'].includes(message.type)) return;
      lastTradeAt = Date.now(); activityFailures = 0; silenceReported = false; health.activityConnected = true;
      health.activityMessages = (health.activityMessages || 0) + 1;
      health.lastActivityMessageAt = new Date().toISOString();
      const value = message.payload || {};
      const { receivedAt, receivedMonotonicMs } = receipt;
      const diagnostic = feed.telemetry(message, value, receipt, rawReceivedAtMs, connectionId, { ...health.eventLoop, currentMaxMs: loop.max / 1e6 });
      health.activityStreams[message.type] = { messages: (health.activityStreams[message.type]?.messages || 0) + 1, ...diagnostic };
      staleMessages = diagnostic.transitMs !== null && diagnostic.transitMs > 5000 ? staleMessages + 1 : 0;
      if (staleMessages >= 3 && !replacement && socket === connection && rawReceivedAtMs >= nextHandoverAt) { health.activityDelayedReconnects = (health.activityDelayedReconnects || 0) + 1; activity(connection); }
      let trade;
      if (previous && replacement === connection && subscriptionSent) {
        trade = require('./trade-signal-service').normalize(value);
        if (trade) {
          clearTimeout(deliveryTimeout); connectionTimeouts.delete(deliveryTimeout);
          clearTimeout(reconnect); reconnect = null; socket = connection; replacement = null;
          previous.terminate(); health.activityConnected = true;
          health.activityHandovers = (health.activityHandovers || 0) + 1;
        }
      }
      const rawWallet = String(value.proxyWallet || value.proxy_wallet || '').toLowerCase();
      if (options.controls?.tracks && !options.controls.tracks(rawWallet)) return skip('untrackedWallet');
      trade = trade || require('./trade-signal-service').normalize(value);
      if (!trade) return skip('invalidTrade', value, diagnostic);
      const cached = options.controls && (options.controls.peek ? options.controls.peek(trade.proxy_wallet) : options.controls.get(trade.proxy_wallet));
      if (!cached || !cached.leader) {
        if (sourcePositions) sourcePositions.invalidate('SOURCE_CONTROL_UNAVAILABLE');
        return skip('snapshotUnavailable', value, diagnostic);
      }
      health.followedActivityMessages = (health.followedActivityMessages || 0) + 1;
      health.lastFollowedActivityAt = new Date().toISOString();
      const sourceId = [trade.proxy_wallet,trade.transaction_hash,trade.token_id,trade.side].join(':');
      const signal = { id: sourceId + ':' + require('node:crypto').createHash('sha256').update(trade.price + ':' + trade.size).digest('hex').slice(0,16), sourceId, wallet: trade.proxy_wallet, token: trade.token_id, condition: trade.condition_id, side: trade.side, size: trade.size, price: trade.price,
        sourceAmount: require('./accounting-service').str(require('./accounting-service').D(trade.size).mul(trade.price)), timestamp: trade.timestamp,
        title: trade.title, outcomeIndex: trade.outcome_index, raw: [trade], origin: 'websocket', receivedAt, discoveredAt: receivedAt,
        feed: diagnostic, timing: clock.timing(receivedMonotonicMs), followGeneration: cached.task ? cached.task.generation : Number(cached.leader.raw && cached.leader.raw.followGeneration || 0), active: cached.leader.active, config: { ...config } };
      // Fresh notifications execute directly. No historical source polling,
      // persisted job lookup, Redis delivery or delayed purchase recovery.
      if (!feed.claim(signal.id)) { health.activityDuplicateMessages++; return; }
      if (sourcePositions) {
        const sizing = sourcePositions.observe(signal, cached.task);
        if (sizing) signal.saleSizing = sizing;
        if (sizing?.mode === 'fixed_ratio_fallback') console.error(new Date().toISOString() + ' sale-sizing-fallback: ' + JSON.stringify({ wallet: signal.wallet, token: signal.token, signalId: signal.id, reason: sizing.reason }));
      }
      if (health.executionHalted) return skip('executionHalted', value, diagnostic);
      if (trade.side === 'BUY' && !cached.leader.active) return skip('inactiveLeader', value, diagnostic);
      diagnostic.eventLoop = loopStatus();
      health.activityIdentityCacheSize = feed.size();
      health.activityCopyAttempts = (health.activityCopyAttempts || 0) + 1;
      executing++;
      paper.copy(signal, function (error, result) {
        executing--;
        if (error && error.executedOrder) {
          health.executionHalted = true;
          try { receipts.append(error.executedOrder); }
          catch (failure) { receiptWriteFailed = true; console.error('Could not preserve executed result:', failure.message); }
        }
        if (result && result.fill) {
          health.activityCopyFilled = (health.activityCopyFilled || 0) + 1;
          equityDirty = true; health.lastReceivedToFillMs = Math.round(performance.now() - receivedMonotonicMs);
          health.lastReceivedToExecutionMs = result.order.details.timings.receivedToExecutionMs;
        }
        health.lastCopy = { signalId: signal.id, feed: diagnostic, reason: error ? error.message : result?.order?.reason || result?.reason || null, status: error ? 'error' : result?.order?.status || (result?.fill ? 'FILLED' : 'SKIPPED') };
        if (signal.side === 'SELL' && signal.saleSizing) {
          const receipt = error?.executedOrder || result;
          health.lastSaleCopy = { ...health.lastCopy, wallet: signal.wallet, token: signal.token, filledQuantity: receipt?.fill?.quantity || '0', sizing: receipt?.order?.details?.saleSizing || result?.saleSizing || signal.saleSizing };
          if (!receipt?.fill) console.error(new Date().toISOString() + ' sale-copy-skipped: ' + JSON.stringify(health.lastSaleCopy));
        }
        if (error) health.activityCopyErrors = (health.activityCopyErrors || 0) + 1;
        if (!error && !result?.fill) skip(result?.order?.reason || result?.reason || 'copySkipped');
        report('copy', error, result);
      });
    });
    connection.on('close', function () {
      clearInterval(connectionHeartbeat);
      connectionHeartbeats.delete(connectionHeartbeat);
      connections.delete(connection);
      clearTimeout(deliveryTimeout); connectionTimeouts.delete(deliveryTimeout);
      if (replacement === connection) { replacement = null; scheduleReconnect(); return; }
      if (socket !== connection) return;
      if (sourcePositions) sourcePositions.invalidate('FEED_DISCONNECTED');
      health.activityConnected = false;
      scheduleReconnect();
    });
  }
  function start(callback) {
    if (receipts.count() > 0) {
      health.executionHalted = true;
      report('recording', new Error('成交回執尚未入帳，暫停執行；正在重寫帳務，不會重買舊單'));
    }
    async.waterfall([
      function (next) { paper.initialize(function (err) { next(err); }); },
      function (next) { db.query("UPDATE paper_outbox SET status='done',error='ORDER_BACKFILL_REMOVED',\"updatedAt\"=clock_timestamp() WHERE status='pending' AND kind IN ('copy','source-confirmation','source-reconcile','market-enrich')", [], function (err) { next(err); }); },
      function (next) { db.query("UPDATE paper_orders SET status='SKIPPED',reason='ORDER_BACKFILL_REMOVED',\"updatedAt\"=clock_timestamp() WHERE status='WAITING'", [], function (err) { next(err); }); }
    ], function (err) {
      if (err) return callback(err);
      every('recording', 5, recordReceipts, true);
      loop.enable(); markets.start(); activity();
      markets.onResolved(function () { if (stopped || locks.has('settlement')) return; locks.add('settlement'); settle(function (error) { locks.delete('settlement'); report('settlement', error); }); });
      every('leaderboard', config.leaderboardSeconds, function (next) { leaders.refresh(next); }, true);
      if (options.skips) every('skip-statistics', 5, options.skips.flush);
      if (sourcePositions) {
        health.sourcePositions = sourcePositions.health;
        every('source-positions', config.inventorySeconds, sourcePositions.refresh, true);
      }
      if (markets.warmLeader) every('sports-warmup', 60, function (next) { leaders.tracked(function (err, rows) { if (err) return next(err); async.eachLimit(rows.filter(row => row.active), 1, function (row, done) { const task = options.controls?.peek ? options.controls.peek(row.id)?.task : null; if (!task?.shortSportsHours) return done(); markets.warmLeader(row.id, done); }, next); }); }, true);
      every('mark', 2, markets.mark, true);
      every('settlement', config.settlementSeconds, settle, true);
      every('schedule', 600, markets.schedules, true);
      if (markets.refreshParameters) every('market-parameters', 10, markets.refreshParameters);
      if (options.controls && options.controls.refresh) every('execution-controls', 1, options.controls.refresh);
      every('equity', 2, snapshot, true);
      every('daily-report', 30, dailyReports.runDue, true);
      every('health', 5, function (next) { health.eventLoop = loopStatus(); loop.reset(); loopWindowStartedAt = Date.now(); db.save('Setting', { id: 'worker-health', value: { ...health, market: markets.health } }, function (error) { next(error); }); }, true);
      if (options.clockSync) every('clock-sync', 60, function (next) { options.clockSync(function (error, state) { if (!error) health.clock = state; next(error); }); });
      callback();
    });
  }
  function stop(callback) { stopped = true; health.activityConnected = false; if (sourcePositions) sourcePositions.stop(); timers.forEach(clearInterval); clearTimeout(reconnect); clearInterval(heartbeat); connectionHeartbeats.forEach(clearInterval); connectionHeartbeats.clear(); connectionTimeouts.forEach(clearTimeout); connectionTimeouts.clear(); loop.disable(); connections.forEach(function (connection) { connection.terminate(); }); markets.stop(); callback(); }
  return { start, stop, health, recordReceipts };
}
module.exports = { create };
