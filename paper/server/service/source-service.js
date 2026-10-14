const async = require('async');
const crypto = require('node:crypto');
const { D, str } = require('./accounting-service');
const http = require('../lib/http-client');
const config = require('../../config').paper;
const signals = require('./trade-signal-service');

function groupTrades(rows) {
  const groups = new Map();
  rows.forEach(function (row) {
    if (!row.proxy_wallet || !row.transaction_hash || !row.token_id || !row.condition_id || !['BUY', 'SELL'].includes(row.side) || !Number.isFinite(Number(row.timestamp))) throw new Error('Incomplete source trade');
    const wallet = row.proxy_wallet.toLowerCase();
    const id = [wallet, row.transaction_hash, row.token_id, row.side].join(':');
    const group = groups.get(id) || { id, wallet, token: row.token_id, condition: row.condition_id, side: row.side, timestamp: String(row.timestamp), quantities: {}, raw: [] };
    const price = str(row.price);
    if (D(row.size).lte(0) || D(price).lte(0) || D(price).gte(1)) return;
    group.quantities[price] = str(D(group.quantities[price]).plus(row.size));
    group.raw.push(row); groups.set(id, group);
  });
  const result = Array.from(groups.values());
  const sequences = new Map();
  result.forEach(function (row) { const key = [row.wallet, row.token, row.timestamp].join(':'); sequences.set(key, (sequences.get(key) || 0) + 1); });
  result.forEach(function (row) { row.ambiguousSequence = sequences.get([row.wallet, row.token, row.timestamp].join(':')) > 1; });
  return result.sort(function (a, b) { return Number(a.timestamp) - Number(b.timestamp) || a.id.localeCompare(b.id); });
}
function delta(current, processed) {
  const result = {};
  new Set([...Object.keys(current), ...Object.keys(processed)]).forEach(function (price) {
    const value = D(current[price]).minus(processed[price] || 0);
    if (value.lt(0)) throw new Error('Source quantities regressed');
    if (value.gt(0)) result[price] = str(value);
  });
  return result;
}
function sum(values) { return Object.values(values).reduce(function (total, size) { return total.plus(size); }, D(0)); }

function create(db, options) {
  const config = options && options.config || require('../../config').paper;
  let notifySignal = function () {};
  function onSignal(listener) { notifySignal = listener; }
  function queueReconciliation(tx, group, generation, callback) {
    const payload = { wallet: group.wallet, condition: group.condition, token: group.token, sourceId: group.id, timestamp: Number(group.timestamp), followGeneration: generation, retryAt: Date.now() + config.overlapSeconds * 1000 };
    tx.query("INSERT INTO paper_outbox(id,kind,payload) VALUES($1,'source-reconcile',$2::jsonb) ON CONFLICT(id) DO NOTHING", ['source-reconcile:' + group.id + ':' + generation, JSON.stringify(payload)], function (err) { callback(err); });
  }
  function currentLeader(wallet,generation,work,callback){
    db.transaction(function(tx,done){async.waterfall([
      function(next){tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE',['paper'],function(err){next(err);});},
      function(next){tx.one('Leader',{where:{id:wallet}},next);},
      function(row,next){if(!row||Number(row.raw&&row.raw.followGeneration||0)!==generation)return done(null,{stale:true});work(tx,row,next);}
    ],done);},callback);
  }
  function ingest(group, callback) {
    let createdSignal;
    db.transaction(function (tx, done) {
      let stored, leader;
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (_, next) { if (!group.reconciliationJobId) return next(null, null); tx.one('Outbox', { where: { id: group.reconciliationJobId } }, next); },
        function (job, next) { if (group.reconciliationJobId && (!job || job.status !== 'pending')) return done(null, { stale: true }); tx.one('Setting', { where: { id: 'quarantine:' + group.id } }, next); },
        function (quarantine, next) { if (quarantine) return done(null, { quarantined: true }); tx.one('Source', { where: { id: group.id } }, next); },
        function (row, next) { stored = row; tx.one('Leader', { where: { id: group.wallet } }, next); },
        function (row, next) {
          leader = row;
          if (!leader) return next(null, null);
          if(group.collectorGeneration!==undefined&&Number(leader.raw&&leader.raw.followGeneration||0)!==group.collectorGeneration)return done(null,{stale:true});
          if (group.origin === 'websocket' && Number(group.timestamp) < Math.ceil(new Date(leader.joinedAt).getTime() / 1000)) return done(null, { historical: true });
          if (group.side === 'SELL' && stored && stored.raw.wsSellPending && Object.entries(stored.raw.wsSellQuantities || {}).some(function ([price, size]) { return D(group.quantities[price] || 0).lt(size); })) return done(null, { waitingForSellReconciliation: true });
          let increments, merged, inventoryIncrements;
          try {
            merged = signals.reconcile(group, stored);
            increments = delta(merged.quantities, stored ? stored.processed : {});
            inventoryIncrements = group.origin === 'websocket' ? {} : delta(merged.raw.wsQuantities ? merged.raw.inventoryProcessed : group.quantities, merged.inventoryBefore);
          } catch (err) { return next(err); }
          const total = sum(increments);
          const barrierId = group.id + ':source-confirmation';
          function saveDuplicate(finished) {
            if (!stored || !merged.raw.wsQuantities && !(stored.raw && stored.raw.wsSellPending)) return finished();
            tx.save('Source', { ...stored, quantities: merged.quantities, raw: { ...merged.raw, wsSellPending: false } }, function (error) {
              if (error) return finished(error);
              if (group.origin === 'websocket') return queueReconciliation(tx, group, Number(leader.raw.followGeneration || 0), finished);
              tx.query("UPDATE paper_outbox SET status='done',error='',\"updatedAt\"=clock_timestamp() WHERE id=$1 AND kind='source-confirmation'", [barrierId], function (failure) { finished(failure); });
            });
          }
          if (total.isZero() && sum(inventoryIncrements).isZero()) return saveDuplicate(function (error) { next(error, null); });
          const historical = Number(group.timestamp) < Math.ceil(new Date(leader.joinedAt).getTime() / 1000);
          const before = leader.inventory[group.token] || '0';
          const baselineTime = Number(leader.raw.inventoryTimestamp || 0);
          const baselineKey = baselineTime + ':' + (leader.raw.inventoryRevision || '');
          const checkedInventory = group.side !== 'SELL' || group.validatedInventoryBaseline === baselineKey;
          const validInventory = leader.inventoryValid && checkedInventory && Number(group.timestamp) > baselineTime && !group.ambiguousSequence;
          if (group.origin !== 'websocket' && !historical && !validInventory) leader.inventoryValid = false;
          const amount = Object.entries(increments).reduce(function (value, [p, q]) { return value.plus(D(p).mul(q)); }, D(0));
          const price = total.isZero() ? D(group.raw[0].price) : amount.div(total);
          const intentId = group.id + ':' + crypto.createHash('sha256').update(JSON.stringify(merged.quantities)).digest('hex').slice(0, 16);
          const signal = { id: intentId, sourceId: group.id, wallet: group.wallet, token: group.token, condition: group.condition, side: group.side, size: str(total), price: str(price), sourceAmount: str(amount), timestamp: Number(group.timestamp), discoveredAt: require('../lib/execution-clock').receipt().receivedAt, receivedAt: group.receivedAt || null, origin: group.origin || 'rest', title: group.raw[0].title || '', outcomeIndex: Number(group.raw[0].outcome_index), beforeInventory: validInventory ? before : null, active: leader.active, historical, raw: group.raw, config: { ...config } };
          signal.followGeneration = Number(leader.raw.followGeneration || 0);
          signal.cumulativeSize = str(sum(merged.quantities));
          if (group.receivedMonotonicMs !== undefined) signal.timing = require('../lib/execution-clock').timing(group.receivedMonotonicMs);
          signal.fundingMode = leader.raw.followFundingMode || 'shared';
          createdSignal = total.isZero() ? null : signal;
          if (!historical) leader.raw.lastTradeObservedAt = Date.now();
          const inventoryTotal = sum(inventoryIncrements);
          if (validInventory && !historical && group.origin !== 'websocket') leader.inventory[group.token] = str(group.side === 'BUY' ? D(before).plus(inventoryTotal) : D(before).minus(inventoryTotal).clamp(0, Infinity));
          const sourceAmount = Object.entries(merged.quantities).reduce(function (value, [p, q]) { return value.plus(D(p).mul(q)); }, D(0));
          const source = { ...group, raw: { ...merged.raw, wsSellPending: false }, quantities: merged.quantities, processed: merged.quantities, budget: str(sourceAmount) };
          if (total.isZero()) return tx.save('Leader', leader, function (error) { if (error) return next(error); saveDuplicate(function (failure) { next(failure, null); }); });
          async.waterfall([
            function (save) {
              if (group.side !== 'SELL') return save();
              tx.query("SELECT id FROM paper_source_trades WHERE wallet=$1 AND token=$2 AND timestamp<=$3 AND id<>$4 AND raw->>'wsPendingInventory'='true' LIMIT 1", [group.wallet, group.token, group.timestamp, group.id], function (error, rows) { if (error) return save(error); if (rows.length) return done(null, { waitingForBuyReconciliation: true }); save(); });
            },
            function (save) { tx.one('Setting', { where: { id: 'runtime' } }, save); },
            function (runtime, save) { signal.pausedAtDiscovery = runtime ? (runtime.value.pauseAll || runtime.value.pauseBuys && signal.side === 'BUY') : false; save(); },
            function (save) { tx.save('Source', source, function (err) { save(err); }); },
            function (save) { tx.save('Leader', leader, function (err) { save(err); }); },
            function (save) {
              if (group.side !== 'SELL' || !stored || !stored.raw.wsSellPending) return save(null, null);
              tx.one('Outbox', { where: { id: barrierId } }, save);
            },
            function (barrier, save) { tx.insert('Outbox', { id: intentId, kind: 'copy', payload: signal, ...(barrier ? { createdAt: barrier.createdAt } : {}) }, function (err) { save(err); }); },
            function (save) {
              if (group.side !== 'SELL' || !stored || !stored.raw.wsSellPending) return save();
              tx.query("UPDATE paper_outbox SET status='done',error='',\"updatedAt\"=clock_timestamp() WHERE id=$1 AND kind='source-confirmation'", [barrierId], function (error) { save(error); });
            },
            function (save) { tx.query("INSERT INTO paper_outbox(id,kind,payload) VALUES($1,'market-enrich',$2::jsonb) ON CONFLICT(id) DO NOTHING", ['market-enrich:' + group.wallet + ':' + group.condition + ':' + signal.followGeneration, JSON.stringify({ wallet: group.wallet, condition: group.condition, followGeneration: signal.followGeneration })], function (error) { save(error); }); },
            function (save) { if (group.origin !== 'websocket') return save(); queueReconciliation(tx, group, signal.followGeneration, save); }
          ], function (err) { next(err, intentId); });
        }
      ], done);
    }, function (err, result) {
      if (!err && typeof result === 'string') notifySignal(result, createdSignal);
      callback(err, result);
    });
  }
  function ingestWebsocket(payload, context, callback) {
    const row = signals.normalize(payload);
    if (!row) return callback(null, { handled: false });
    const group = groupTrades([row])[0];
    group.origin = 'websocket'; group.collectorGeneration = context.generation; group.receivedAt = context.receivedAt; group.receivedMonotonicMs = context.receivedMonotonicMs;
    if (group.side === 'BUY') return ingest(group, function (err, result) { callback(err, { handled: !err, result }); });
    currentLeader(group.wallet, group.collectorGeneration, function (tx, leader, next) {
      if (Number(group.timestamp) < Math.ceil(new Date(leader.joinedAt).getTime() / 1000)) return next(null, { historical: true });
      tx.one('Source', { where: { id: group.id } }, function (err, stored) {
        if (err) return next(err);
        const id = group.id + ':source-confirmation';
        const source = stored || { id: group.id, wallet: group.wallet, token: group.token, condition: group.condition, side: group.side, timestamp: group.timestamp, quantities: {}, processed: {}, budget: '0' };
        const known = signals.maximum(source.raw && source.raw.wsSellQuantities, group.quantities);
        source.raw = { ...source.raw, trades: source.raw && source.raw.trades || [row], wsSellQuantities: known, wsSellPending: true, wsPending: true };
        async.waterfall([
          function (save) { tx.save('Source', source, function (error) { save(error); }); },
          function (save) { tx.query("INSERT INTO paper_outbox(id,kind,payload) VALUES($1,'source-confirmation',$2::jsonb) ON CONFLICT(id) DO UPDATE SET status='pending',\"updatedAt\"=clock_timestamp()", [id, JSON.stringify({ wallet: group.wallet, token: group.token, side: group.side, followGeneration: group.collectorGeneration })], function (error) { save(error); }); },
          function (save) { queueReconciliation(tx, group, group.collectorGeneration, save); }
        ], next);
      });
    }, function (err, result) { callback(err, { handled: !err, needsRest: true, result }); });
  }
  function reconcile(callback) {
    db.query("SELECT * FROM paper_outbox WHERE kind='source-reconcile' AND status='pending' AND COALESCE((payload->>'retryAt')::bigint,0)<=$1 ORDER BY COALESCE((payload->>'retryAt')::bigint,0),\"createdAt\" LIMIT 3", [Date.now()], function (err, jobs) {
      if (err) return callback(err);
      async.eachSeries(jobs, function (job, next) {
        db.one('Leader', { where: { id: job.payload.wallet } }, function (error, leader) {
          if (error || !leader) return next(error);
          const generation = Number(leader.raw.followGeneration || 0);
          http.pages(config.dataUrl, '/v2/trades', { user: job.payload.wallet, taker_only: false, start: job.payload.timestamp, end: job.payload.timestamp, limit: 1000 }, function (failure, rows) {
            let groups = [];
            if (!failure) { try { groups = groupTrades(rows).filter(function (group) { return group.id === job.payload.sourceId; }); } catch (parseError) { failure = parseError; } }
            const { receivedAt, receivedMonotonicMs } = require('../lib/execution-clock').receipt();
            groups.forEach(function (group) { group.collectorGeneration = generation; group.reconciliationJobId = job.id; group.receivedAt = receivedAt; group.receivedMonotonicMs = receivedMonotonicMs; });
            function finish(processError) {
              currentLeader(job.payload.wallet, generation, function (tx, current, saved) {
                tx.one('Outbox', { where: { id: job.id } }, function (readError, existing) {
                  if (readError || !existing || existing.status !== 'pending') return saved(readError);
                  tx.one('Market', { where: { id: job.payload.condition } }, function (marketError, market) {
                    if (marketError) return saved(marketError);
                    const delay = Math.max(processError && processError.retryAfterMs || 0, 60000 * Math.min(60, 2 ** Math.min(6, existing.attempts)));
                    tx.update('Outbox', job.id, { attempts: existing.attempts + 1, status: !processError && market && market.resolution.status === 'resolved' ? 'done' : 'pending', error: processError ? processError.message : '', payload: { ...existing.payload, retryAt: Date.now() + delay } }, function (updateError) { saved(updateError); });
                  });
                });
              }, next);
            }
            if (failure) return finish(failure);
            processPending(groups, finish);
          });
        });
      }, callback);
    });
  }
  function poll(wallet, callback) {
    let end, start, checkpoint, generation;
    async.waterfall([
      function (next) { db.one('Checkpoint', { where: { id: 'trades:' + wallet } }, next); },
      function (row, next) { checkpoint = row; db.one('Leader', { where: { id: wallet } }, next); },
      function (leader, next) {
        if (!leader) return callback(null,{stale:true});
        generation=Number(leader.raw&&leader.raw.followGeneration||0);
        end = Math.floor(Date.now() / 1000);
        const joined = Math.ceil(new Date(leader.joinedAt).getTime() / 1000);
        start = checkpoint ? Math.max(joined, Number(checkpoint.timestamp) - config.overlapSeconds) : joined;
        if (start > end) return callback(null, { waitingForNextSecond: true });
        function fetch() { http.pages(config.dataUrl, '/v2/trades', { user: wallet, taker_only: false, start, end, limit: 1000 }, next); }
        if (!db.query) return fetch();
        db.query("SELECT MIN(timestamp)::text AS timestamp FROM paper_source_trades WHERE wallet=$1 AND raw->>'wsPending'='true'", [wallet], function (err, rows) { if (err) return next(err); if (rows[0] && rows[0].timestamp) start = Math.max(joined, Math.min(start, Number(rows[0].timestamp))); fetch(); });
      },
      function (rows, next) {
        let groups;
        try { groups = groupTrades(rows); } catch (err) { return next(err); }
        const { receivedAt, receivedMonotonicMs } = require('../lib/execution-clock').receipt();
        groups.forEach(function(group){group.collectorGeneration=generation;group.receivedAt=receivedAt;group.receivedMonotonicMs=receivedMonotonicMs;});
        unprocessed(groups, function (lookupError, pending) {
          if (lookupError) return next(lookupError);
          processPending(pending, next);
        });
      },
      function (next) { currentLeader(wallet,generation,function(tx,_,saved){tx.save('Checkpoint', { id: 'trades:' + wallet, timestamp: String(end), details: { start, end } },saved);},next); }
    ], callback);
  }
  function processPending(groups, callback) {
    const batches = new Map(), buys = [], followingSells = [];
    groups.forEach(function (group) { const batch = batches.get(group.token) || []; batch.push(group); batches.set(group.token, batch); });
    batches.forEach(function (batch) {
      const firstSell = batch.findIndex(function (group) { return group.side === 'SELL'; });
      if (firstSell < 0) buys.push(batch);
      else { if (firstSell) buys.push(batch.slice(0, firstSell)); followingSells.push(batch.slice(firstSell)); }
    });
    function saveBatches(values, done) {
      // Database concurrency stays bounded; waiting for HTTP does not occupy these slots.
      async.mapLimit(values, 3, function (batch, finished) {
        async.eachSeries(batch, function (group, saved) {
          ingest(group, function (err) {
            if (!err || !err.message.includes('regressed')) return saved(err);
            currentLeader(group.wallet,Number(group.collectorGeneration||0),function(tx,current,saveCurrent){async.waterfall([
              function(next){tx.save('Setting', { id: 'quarantine:' + group.id, value: { reason: err.message, source: group, observedAt: new Date().toISOString() } },function(error){next(error);});},
              function(next){current.inventoryValid=false;tx.save('Leader',current,function(error){next(error);});}
            ],saveCurrent);},saved);
          });
        }, function (err) { finished(null, err || null); });
      }, function (err, errors) { done(err || errors.find(function (error) { return error; })); });
    }
    // Validate concurrently with BUY prefixes; never overtake an earlier SELL on the same asset.
    // Collect errors and finish all active writes before ending the wallet poll.
    async.parallel([
      function (done) { saveBatches(buys, function (err) { done(null, err || null); }); },
      function (done) { validateSellInventory(groups, function (err) { done(null, err || null); }); }
    ], function (err, errors) {
      const failure = err || errors.find(function (error) { return error; });
      if (failure) return callback(failure);
      saveBatches(followingSells, callback);
    });
  }
  function unprocessed(groups, callback) {
    if (!groups.length) return callback(null, []);
    db.query('SELECT id,processed,raw FROM paper_source_trades WHERE id=ANY($1::text[])', [groups.map(function (group) { return group.id; })], function (err, rows) {
      if (err) return callback(err);
      const known = new Map(rows.map(function (row) { return [row.id, row]; }));
      const pending = groups.filter(function (group) {
        const stored = known.get(group.id), processed = stored && stored.processed;
        if (!processed || stored.raw && (stored.raw.wsPending || stored.raw.wsSellPending || stored.raw.wsPendingInventory)) return true;
        return Array.from(new Set([...Object.keys(group.quantities), ...Object.keys(processed)])).some(function (price) { return !D(group.quantities[price]).eq(D(processed[price])); });
      });
      // New/increased/regressed groups still go through the locked transactional deduplication.
      callback(null, pending);
    });
  }
  function validateSellInventory(groups, callback) {
    if (!groups.some(function (group) { return group.side === 'SELL'; })) return callback();
    const wallet = groups[0].wallet;
    groups.forEach(function (group) { if (group.side === 'SELL') group.validatedInventoryBaseline = null; });
    db.one('Leader', { where: { id: wallet } }, function (err, leader) {
      if (err) return callback(err);
      const baseline = leader ? Number(leader.raw.inventoryTimestamp || 0) : 0;
      if (!leader || !leader.inventoryValid) return callback();
      const collectorGeneration=groups[0].collectorGeneration;
      if(collectorGeneration!==undefined&&Number(leader.raw&&leader.raw.followGeneration||0)!==collectorGeneration)return callback();
      const key = baseline + ':' + (leader.raw.inventoryRevision || '');
      // SELL sizing needs changes since its inventory baseline, not just the trade overlap window.
      http.pages(config.dataUrl, '/v2/activity', { user: wallet, start: baseline, end: Math.floor(Date.now() / 1000), limit: 100 }, function (error, activity) {
        if (error) return callback(error);
        const uncertain = activity.some(function (row) { return row.type !== 'TRADE' && Number(row.timestamp) >= baseline; });
        if (!uncertain) {
          groups.forEach(function (group) { if (group.side === 'SELL') group.validatedInventoryBaseline = key; });
          return callback();
        }
        currentLeader(wallet,collectorGeneration===undefined?Number(leader.raw&&leader.raw.followGeneration||0):collectorGeneration,function(tx,current,saved){current.inventoryValid=false;tx.save('Leader',current,saved);},function(failure){callback(failure);});
      });
    });
  }
  return { poll, ingest, ingestWebsocket, reconcile, onSignal };
}
module.exports = { create, groupTrades, delta };
