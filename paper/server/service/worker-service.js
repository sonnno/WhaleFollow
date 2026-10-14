const async = require('async');
const WebSocket = require('ws');
const config = require('../../config').paper;
const agent = require('../lib/network-agent');

function create(db, redis, leaders, sources, markets, paper, dashboard, options) {
  options = options || {};
  const config = options.config || require('../../config').paper;
  const health = { processId: process.pid, latencyVersion: 5,executionClockVersion:2,taskDeletionVersion:1,dailyReportVersion:1,persistenceVersion:2, activityConnected: false, lastTradePoll: null, lastBoardRefresh: null, lastSettlement: null, lastError: null, startedAt: new Date().toISOString() };
  let stopped = false, socket, reconnect, heartbeat, activityFailures = 0;
  const timers = [], locks = new Set(), walletBusy = new Set(), inventoryBusy = new Set(), walletPending = new Set(), lastPeriodic = new Map(), tokenQueues = new Map(), admitted = new Set();
  let trackedWallets = config.followWallets && config.followWallets.length ? new Set(config.followWallets) : null;
  const observedGeneration = new Map();
  let dispatchRequested = false, dispatchScheduled = false, equityDirty = true, lastEquityAt = 0;
  const recordHealth = require('./health-service').create(health);
  const dailyReports = options.dailyReports || require('./daily-report-service').create(db);
  const enrichment = options.enrichment || require('./market-enrichment-service').create(db, markets);
  function report(label, err, result) { recordHealth(label, err, result); if (err && err.code !== 'POLYMARKET_BACKOFF') console.error(new Date().toISOString() + ' ' + label + ': ' + err.message); }
  function every(label, seconds, task, immediate) {
    function run() {
      if (stopped || locks.has(label)) return;
      locks.add(label);
      task(function (err, result) { locks.delete(label); report(label, err, result); if (label === 'dispatch' && dispatchRequested) wakeDispatch(); });
    }
    timers.push(setInterval(run, seconds * 1000));
    if (immediate) run();
  }
  function pollWallet(wallet, callback) {
    if (stopped) return callback();
    if (walletBusy.has(wallet)) { walletPending.add(wallet); return callback(); }
    walletBusy.add(wallet);
    const began = Date.now();
    sources.poll(wallet, function (err) {
      walletBusy.delete(wallet); health.lastTradePollMs = Date.now() - began;
      if (!err) health.lastTradePoll = new Date().toISOString();
      if (walletPending.delete(wallet) && !stopped) setImmediate(function () { pollWallet(wallet, function (error) { report('activity-trigger', error); }); });
      callback(err);
    });
  }
  function poll(callback) { let checked = 0; leaders.tracked(function (err, rows) { if (err) return callback(err); trackedWallets = new Set(rows.map(function (row) { return row.id; })); async.eachLimit(rows, 3, function (leader, next) {
    const generation = Number(leader.raw && leader.raw.followGeneration || 0);
    if (typeof leaders.inventory === 'function' && observedGeneration.get(leader.id) !== generation && !inventoryBusy.has(leader.id)) { observedGeneration.set(leader.id, generation); inventoryBusy.add(leader.id); setImmediate(function () { leaders.inventory(leader, function (error) { inventoryBusy.delete(leader.id); if (error) observedGeneration.delete(leader.id); report('inventory', error); }); }); }
    const seconds = health.activityConnected ? config.tradePollSeconds : config.fallbackTradePollSeconds;
    if (walletBusy.has(leader.id) || Date.now() - (lastPeriodic.get(leader.id) || 0) < seconds * 1000) return next();
    checked++; lastPeriodic.set(leader.id, Date.now()); pollWallet(leader.id, next);
  }, function (error) { callback(error, { checked }); }); }); }
  function inventory(callback) { let checked = 0; leaders.tracked(function (err, rows) { if (err) return callback(err); async.eachLimit(rows, 2, function (leader, next) {
    if (inventoryBusy.has(leader.id)) return next();
    checked++; inventoryBusy.add(leader.id);
    leaders.inventory(leader, function (error) { inventoryBusy.delete(leader.id); next(error); });
  }, function (error) { if (!error && checked) health.lastInventoryPoll = new Date().toISOString(); callback(error, { checked }); }); }); }
  function board(callback) { leaders.refresh(function (err) { if (!err) health.lastBoardRefresh = new Date().toISOString(); callback(err); }); }
  function settle(callback) {
    markets.resolutions(function (err, values) {
      if (err) return callback(err);
      async.eachSeries(values, function (row, next) { if (row.status !== 'resolved') return next(); paper.settle(row.condition_id, row, next); }, function (error) { if (!error) health.lastSettlement = new Date().toISOString(); callback(error); });
    });
  }
  function wakeDispatch() {
    dispatchRequested = true;
    if (dispatchScheduled || stopped) return;
    dispatchScheduled = true;
    setImmediate(function () {
      dispatchScheduled = false;
      if (stopped || locks.has('dispatch')) return;
      dispatchRequested = false; locks.add('dispatch');
      dispatch(function (err) { locks.delete('dispatch'); report('dispatch', err); if (dispatchRequested) wakeDispatch(); });
    });
  }
  sources.onSignal(function (id, signal) {
    health.discoveredSignals = (health.discoveredSignals || 0) + 1;
    health.lastSignalAt = new Date().toISOString();
    if (signal) health.lastDiscoveryLagMs = Math.max(0, Date.parse(require('../lib/execution-clock').receipt().receivedAt) - signal.timestamp * 1000);
    if (!signal || signal.origin !== 'websocket' || stopped || admitted.size >= (options.maxInFlight || 8)) return wakeDispatch();
    if (admitted.has(id)) return;
    // Reserve before the async eligibility read so Redis cannot execute/retry
    // this same intent while a direct admission still holds an older snapshot.
    admitted.add(id); health.inFlight = admitted.size;
    eligible(id, function (error, ready) {
      if (!error && ready.length && !stopped) { const job = ready[0]; return admit({ ...job, payload: { ...job.payload, dispatchMode: 'direct' } }, true); }
      admitted.delete(id); health.inFlight = admitted.size;
      redis.del('paper:queued:' + id, function (releaseError) { report('direct-copy', error || releaseError); wakeDispatch(); });
    });
  });
  function dispatch(callback) {
    db.query(`SELECT j.id FROM paper_outbox j WHERE j.status=$1 AND j.kind='copy'
    AND COALESCE((j.payload->>'retryAt')::bigint,0)<=$2 AND NOT EXISTS (
      SELECT 1 FROM paper_outbox earlier WHERE earlier.status=$1
      AND earlier.kind IN ('copy','source-confirmation')
      AND earlier.payload->>'wallet'=j.payload->>'wallet' AND earlier.payload->>'token'=j.payload->>'token'
      AND (earlier."createdAt",earlier.id)<(j."createdAt",j.id)
    ) ORDER BY j.attempts,j."createdAt",j.id LIMIT 100`, ['pending', Date.now()], function (err, rows) {
      if (err) return callback(err);
      async.eachSeries(rows, function (row, next) {
        // Delivery is recoverable and can repeat. Database order ids prevent repeated effects.
        redis.set('paper:queued:' + row.id, '1', 'EX', 30, 'NX', function (error, added) {
          if (error || !added) return next(error);
          redis.lpush('paper:work', row.id, function (failure) { if (failure) redis.del('paper:queued:' + row.id, function () {}); next(failure); });
        });
      }, callback);
    });
  }
  const sharedBuys = async.queue(executeJob, 1);
  function eligible(id, callback) {
    db.query(`SELECT j.* FROM paper_outbox j WHERE j.id=$1 AND j.status='pending' AND j.kind='copy'
      AND COALESCE((j.payload->>'retryAt')::bigint,0)<=$2 AND NOT EXISTS (
      SELECT 1 FROM paper_outbox earlier WHERE earlier.status='pending'
      AND earlier.kind IN ('copy','source-confirmation')
      AND earlier.payload->>'wallet'=j.payload->>'wallet' AND earlier.payload->>'token'=j.payload->>'token'
      AND (earlier."createdAt",earlier.id)<(j."createdAt",j.id)
    )`, [id, Date.now()], callback);
  }
  function admit(job, reserved) {
    if (stopped || !reserved && (admitted.has(job.id) || admitted.size >= (options.maxInFlight || 8))) return false;
    admitted.add(job.id); health.inFlight = admitted.size;
    const token = job.payload.token;
    let queue = tokenQueues.get(token);
    if (!queue) {
      queue = async.queue(function (item, done) {
        if (item.payload.side === 'BUY' && item.payload.fundingMode !== 'dedicated') return sharedBuys.push(item, done);
        executeJob(item, done);
      }, 1);
      queue.drain(function () { tokenQueues.delete(token); });
      tokenQueues.set(token, queue);
    }
    queue.push(job); return true;
  }
  function executeJob(item, done) {
            if (stopped) { admitted.delete(item.id); return done(); }
            const began = performance.now();
            paper.copy(item.payload, function (copyError, result) {
              health.lastCopyMs = Math.round(performance.now() - began);
              if (result && result.fill && item.payload.timing && item.payload.timing.processId === process.pid) health.lastReceivedToFillMs = Math.round(performance.now() - item.payload.timing.receivedMonotonicMs);
              if (copyError) return retry(copyError.message, copyError.retryAfterMs, copyError);
              if (result && result.retry) {
                return retry(result.order.reason, result.retryAfterMs);
              }
              db.update('Outbox', item.id, { status: 'done', error: '', attempts: item.attempts + 1 }, function (saveError) {
                if (saveError) return finish(saveError);
                if (result && result.fill && !result.duplicate) equityDirty = true;
                finish();
              });
              function retry(reason, retryAfterMs, originalError) {
                const delay = Math.max(Number(retryAfterMs) || 0, reason === 'STALE_BOOK' ? 200 : Math.min(30000, 1000 * 2 ** Math.min(5, item.attempts)));
                const payload = { ...item.payload, refreshBook: reason === 'STALE_BOOK', retryAt: Date.now() + delay };
                db.update('Outbox', item.id, { payload, attempts: item.attempts + 1, error: reason }, function (saveError) { finish(saveError || originalError); });
              }
              function finish(failure) { redis.del('paper:queued:' + item.id, function (releaseError) { admitted.delete(item.id); health.inFlight = admitted.size; report('copy', failure || releaseError); if (!failure && !releaseError) wakeDispatch(); done(); }); }
            });

  }
  function consume(callback) {
    if (admitted.size >= (options.maxInFlight || 8)) return callback();
    redis.rpop('paper:work', function (err, id) {
      if (err || !id) return callback(err);
      if (admitted.has(id)) return callback();
      if (stopped || admitted.size >= (options.maxInFlight || 8)) return redis.del('paper:queued:' + id, function (releaseError) { callback(releaseError); });
      // Both direct and recovered delivery reserve before any asynchronous read.
      admitted.add(id); health.inFlight = admitted.size;
      eligible(id, function (eligibilityError, ready) {
        if (!eligibilityError && ready.length && !stopped) { admit(ready[0], true); return callback(); }
        admitted.delete(id); health.inFlight = admitted.size;
        redis.del('paper:queued:' + id, function (releaseError) { callback(eligibilityError || releaseError); });
      });
    });
  }
  function snapshot(callback) {
    if (!equityDirty && Date.now() - lastEquityAt < config.equitySeconds * 1000) return callback();
    equityDirty = false;
    dashboard.snapshot(function (err) { if (err) equityDirty = true; else lastEquityAt = Date.now(); callback(err); });
  }
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
      const wallet = String(value.proxyWallet || value.proxy_wallet || '').toLowerCase();
      if (!wallet) return;
      if (trackedWallets && !trackedWallets.has(wallet)) return;
      function processLeader(err, row, retried) {
        if (stopped || err || !row) return;
        health.followedActivityMessages = (health.followedActivityMessages || 0) + 1;
        health.lastFollowedActivityAt = new Date().toISOString();
        health.lastActivityLagMs = Math.max(0, Date.parse(receivedAt) - Number(value.timestamp) * 1000);
        const trade = require('./trade-signal-service').normalize(value);
        if (trade && typeof markets.warm === 'function' && (row.active || trade.side === 'SELL')) markets.warm({ condition: trade.condition_id, token: trade.token_id, side: trade.side });
        if (!sources.ingestWebsocket) return pollWallet(wallet, function (error) { report('activity-trigger', error); });
        sources.ingestWebsocket(value, { generation: Number(row.raw && row.raw.followGeneration || 0), receivedAt, receivedMonotonicMs }, function (error, result) {
          report('activity-ingest', error);
          if (!error && result && result.result && result.result.stale && !retried) return db.one('Leader', { where: { id: wallet } }, function (failure, current) { if (current && options.controls) options.controls.observeLeader(current); processLeader(failure, current, true); });
          if (error || !result || !result.handled || result.needsRest) pollWallet(wallet, function (failure) { report('activity-trigger', failure); });
        });
      }
      const cached = options.controls && options.controls.get(wallet);
      if (cached && cached.leader) processLeader(null, cached.leader, false);
      else db.one('Leader', { where: { id: wallet } }, function (err, row) { processLeader(err, row, false); });
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
    async.waterfall([
      function (next) { paper.initialize(function (err) { next(err); }); }
    ], function (err) {
      if (err) return callback(err);
      markets.start(); activity();
      markets.onResolved(function () { if (stopped || locks.has('settlement')) return; locks.add('settlement'); settle(function (error) { locks.delete('settlement'); report('settlement', error); }); });
      every('leaderboard', config.leaderboardSeconds, function (next) { board(function (error) { if (error) return next(error); inventory(function (failure, result) { report('inventory', failure, result); next(); }); }); }, true);
      every('trades', 1, poll, true);
      every('inventory', config.inventorySeconds, inventory);
      every('dispatch', 1, dispatch, true);
      every('consume', 0.05, consume, true);
      every('mark', 2, markets.mark, true);
      every('settlement', config.settlementSeconds, settle, true);
      every('schedule', 600, markets.schedules, true);
      every('market-enrich', 2, enrichment.run);
      if (markets.refreshParameters) every('market-parameters', 10, markets.refreshParameters);
      if (options.controls && options.controls.refresh) every('execution-controls', 1, options.controls.refresh);
      if (sources.reconcile) every('source-reconcile', 5, sources.reconcile);
      every('equity', 2, snapshot, true);
      every('daily-report', 30, dailyReports.runDue, true);
      every('health', 5, function (next) { db.save('Setting', { id: 'worker-health', value: { ...health, market: markets.health } }, function (error) { next(error); }); }, true);
      if (options.clockSync) every('clock-sync', 60, function (next) { options.clockSync(function (error, state) { if (!error) health.clock = state; next(error); }); });
      callback();
    });
  }
  function stop(callback) { stopped = true; enrichment.stop(); timers.forEach(clearInterval); clearTimeout(reconnect); clearInterval(heartbeat); if (socket) socket.terminate(); markets.stop(); callback(); }
  return { start, stop, health, dispatch, consume };
}
module.exports = { create };
