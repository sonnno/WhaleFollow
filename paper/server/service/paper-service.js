const async = require('async');
const crypto = require('node:crypto');
const accounting = require('./accounting-service');
const simulation = require('./simulation-service');
const rules = require('./follow-rule-service');
const { D, str } = accounting;
const config = require('../../config').paper;

function create(db, markets) {
  function initialize(callback) {
    db.transaction(function (tx, done) {
      async.waterfall([
        function (next) { tx.query('SELECT pg_advisory_xact_lock(178001)', [], next); },
        function (_, next) { tx.one('Account', { where: { id: 'paper' } }, next); },
        function (account, next) {
          if (account) return next(null, account);
          let bookedAt;
          async.waterfall([
            function (save) { tx.query('SELECT clock_timestamp() AS at', [], save); },
            function (rows, save) { bookedAt = rows[0].at; tx.insert('Account', { id: 'paper', cash: config.initialCash, initialCash: config.initialCash, createdAt: bookedAt }, function (err) { save(err); }); },
            function (save) { tx.insert('Ledger', { id: 'initial-deposit', reference: 'paper', kind: 'DEPOSIT', delta: config.initialCash, balance: config.initialCash, details: {}, createdAt: bookedAt }, save); }
          ], next);
        }
      ], done);
    }, callback);
  }
  function copy(signal, callback) {
    let quote = null, preparationError = null, prepareMs = 0;
    async.waterfall([
      function (next) {
        if (signal.historical || (!signal.active && signal.side === 'BUY') || signal.pausedAtDiscovery) return next();
        const began = performance.now();
        markets.prepare(signal, function (err, value) { prepareMs = performance.now() - began; preparationError = err; quote = value; next(); });
      },
      function (next) {
        db.transaction(function (tx, done) {
          let account, position, order, fill, settings, currentLeader, currentMarket, previousOrder, currentTask, sourceSpent = '0', queuedJob, sharedCash, ownPositionCost = '0', saleBaseline = null, sourceSold = '0';
          const positionId = signal.wallet + ':' + signal.token;
          async.waterfall([
            function (step) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], step); },
            function (rows, step) { account = rows[0]; if (!account) return step(new Error('Paper account missing')); tx.one('Order', { where: { id: signal.id } }, step); },
            function (existing, step) { if (existing && existing.status !== 'WAITING') return done(null, { duplicate: true, order: existing }); previousOrder = existing; tx.one('Position', { where: { id: positionId } }, step); },
            function (row, step) { position = row; tx.one('Leader', { where: { id: signal.wallet } }, step); },
            function (row, step) { currentLeader = row; tx.one('FollowTask', { where: { id: signal.wallet } }, step); },
            function (row, step) { currentTask = row; tx.one('Setting',{where:{id:'task-deletion:'+signal.wallet}},function(err,marker){if(err)return step(err);if(marker&&Number(signal.followGeneration||0)<=Number(marker.value.generation))return done(null,{taskDeleted:true,retry:false});tx.one('Outbox', { where: { id: signal.id } }, step);}); },
            function (row, step) { queuedJob = row; tx.one('Market', { where: { id: signal.condition } }, step); },
            function (row, step) { currentMarket = row; if (!signal.title && row && row.raw && row.raw.gamma && row.raw.gamma.question) signal.title = row.raw.gamma.question; tx.one('Setting', { where: { id: 'runtime' } }, step); },
            function (row, step) { settings = row ? row.value : {};
              if (signal.side === 'SELL') return tx.query(`SELECT
                (SELECT details->'saleBaseline' FROM paper_orders WHERE "sourceId"=$1 AND side='SELL' AND status IN ('FILLED','PARTIAL') AND details ? 'saleBaseline' ORDER BY "createdAt",id LIMIT 1) AS "saleBaseline",
                (SELECT COALESCE(SUM(quantity),0)::text FROM paper_orders WHERE "sourceId"=$1 AND side='SELL' AND status IN ('FILLED','PARTIAL')) AS "soldQuantity"`, [signal.sourceId], step);
              if (!currentTask) return step(null, []); tx.query(`SELECT
              (SELECT COALESCE(SUM(gross+fee),0)::text FROM paper_orders WHERE "sourceId"=$1 AND side='BUY' AND status IN ('FILLED','PARTIAL')) spent,
              ($3::numeric-(SELECT COALESCE(SUM(cash),0) FROM paper_follow_tasks WHERE "fundingMode"='dedicated'))::text "sharedCash",
              (SELECT COALESCE(SUM(cost),0)::text FROM paper_positions WHERE wallet=$2 AND quantity>0) "positionCost"`, [signal.sourceId, signal.wallet, account.cash], step); },
            function (rows, step) {
              sourceSpent = rows[0] ? rows[0].spent : '0';
              saleBaseline = rows[0] && rows[0].saleBaseline || null; sourceSold = rows[0] && rows[0].soldQuantity || '0';
              sharedCash = rows[0] ? rows[0].sharedCash : account.cash; ownPositionCost = rows[0] ? rows[0].positionCost : '0';
              order = { id: signal.id, sourceId: signal.sourceId, wallet: signal.wallet, token: signal.token, condition: signal.condition, side: signal.side, status: 'SKIPPED', reason: '', quantity: '0', gross: '0', fee: '0', details: { signal, config: signal.config || config, detectedAt: previousOrder ? previousOrder.details.detectedAt : new Date().toISOString(), lastAttemptAt: new Date().toISOString() } };
              if (previousOrder) order.createdAt = previousOrder.createdAt;
              order.details.timings = { prepareMs: Math.round(prepareMs), origin: signal.origin || 'rest' };
              const executionConfig = currentTask ? rules.executionConfig(currentTask, signal.config || config) : signal.config || config;
              order.details.config = executionConfig;
              if (currentTask) order.details.followTask = { generation: currentTask.generation, fundingMode: currentTask.fundingMode, copyPercent: currentTask.copyPercent, allocation: currentTask.allocation, maxOrderAmount: currentTask.maxOrderAmount };
              order.details.sourceAmount = str(signal.sourceAmount === undefined ? D(signal.size).mul(signal.price) : signal.sourceAmount);
              if (quote && markets.latestQuote) quote = markets.latestQuote(signal, quote);
              let reason = signal.historical ? 'HISTORICAL' : signal.pausedAtDiscovery ? 'PAUSED_AT_DISCOVERY' : (!signal.active && signal.side === 'BUY') ? 'LEADER_INACTIVE' : settings.pauseAll ? 'PAUSED' : settings.pauseBuys && signal.side === 'BUY' ? 'BUYS_PAUSED' : preparationError ? preparationError.message : !quote ? 'QUOTE_MISSING' : (markets.isFreshQuote ? !markets.isFreshQuote(quote) : Date.now() - quote.book.observedAt > config.bookMaxAgeMs) ? 'STALE_BOOK' : '';
              if (signal.side === 'BUY') reason = rules.buyBlocked(signal, currentTask, queuedJob) || reason;
              if (!reason && (!Number.isInteger(signal.outcomeIndex) || signal.outcomeIndex < 0 || signal.outcomeIndex > 1)) reason = 'UNSUPPORTED_OR_UNKNOWN_OUTCOME';
              if (!reason && signal.side === 'BUY' && (!currentLeader || !currentLeader.active)) reason = 'LEADER_CURRENTLY_INACTIVE';
              if (!reason && signal.side === 'BUY' && currentLeader && signal.timestamp < Math.ceil(new Date(currentLeader.joinedAt).getTime() / 1000)) reason = 'BEFORE_CURRENT_JOIN';
              if (signal.side === 'SELL' && (!position || D(position.quantity).lte(0))) reason = 'NO_OWN_POSITION';
              if (signal.side === 'SELL' && !saleBaseline && (signal.beforeInventory === null || signal.beforeInventory === undefined || D(signal.beforeInventory).lte(0))) reason = 'LEADER_INVENTORY_UNVERIFIED';
              if (signal.side === 'SELL' && saleBaseline && position && Number(saleBaseline.positionCycle) !== Number(position.cycle)) reason = 'SOURCE_SELL_FROM_OLD_POSITION_CYCLE';
              if (markets.isExecutable && !markets.isExecutable(signal)) reason = 'MARKET_NOT_EXECUTABLE';
              if (currentMarket && currentMarket.resolution.status === 'resolved') reason = 'MARKET_ALREADY_RESOLVED';
              if (reason) { order.reason = reason; return step(null, false); }
              let target;
              try {
                if (signal.side === 'BUY' && D(account.cash).lte(0)) reason = 'INSUFFICIENT_CASH';
                if (signal.side === 'BUY' && currentTask && currentTask.fundingMode === 'dedicated' && D(currentTask.cash).lte(0)) reason = 'TASK_FUNDS_EXHAUSTED';
                if (signal.side === 'BUY' && currentTask && currentTask.fundingMode === 'shared' && D(sharedCash).lte(0)) reason = 'SHARED_FUNDS_EXHAUSTED';
                if (signal.side === 'BUY' && currentTask && D(currentTask.allocation).minus(ownPositionCost).lte(0)) reason = 'TASK_BUDGET_LIMIT';
                if (signal.side === 'BUY' && currentTask && currentTask.maxOrderAmount != null && D(currentTask.maxOrderAmount).minus(sourceSpent).lte('0.000000000000000001')) reason = 'ORDER_AMOUNT_LIMIT';
                if (!reason) {
                  if (signal.side === 'BUY') order.details.targetAmount = str(simulation.buyAmount(signal, executionConfig));
                  if (signal.side === 'SELL') {
                    if (!saleBaseline && D(sourceSold).isZero()) saleBaseline = { leaderQuantity: str(signal.beforeInventory), ownQuantity: position.quantity, positionCycle: position.cycle, sourceOffset: str(D(signal.cumulativeSize === undefined ? signal.size : signal.cumulativeSize).minus(signal.size).clamp(0,Infinity)) };
                    if (saleBaseline) {
                      order.details.saleBaseline = saleBaseline;
                      const cumulative = signal.cumulativeSize === undefined ? D(sourceSold).mul(saleBaseline.leaderQuantity).div(saleBaseline.ownQuantity).plus(signal.size) : D(signal.cumulativeSize).minus(saleBaseline.sourceOffset || 0);
                      target = str(D(saleBaseline.ownQuantity).mul(cumulative.div(saleBaseline.leaderQuantity).clamp(0,1)).minus(sourceSold).clamp(0, position.quantity));
                    } else target = simulation.saleQuantity(position.quantity, signal.size, signal.beforeInventory);
                  }
                  if (signal.side === 'SELL' && D(target).lte(0)) reason = 'SOURCE_SELL_ALREADY_SATISFIED';
                  else {
                    fill = simulation.execute(signal, quote.book, quote.metadata, { ...executionConfig, availableCash: currentTask ? rules.availableCash(account, currentTask, sourceSpent, sharedCash, ownPositionCost) : account.cash }, target);
                    if (D(fill.quantity).lte(0)) reason = fill.reason || 'NO_EXECUTABLE_DEPTH';
                    else if (D(fill.gross).lte(0) || D(fill.cash).lte(0)) reason = signal.side === 'BUY' ? 'INSUFFICIENT_CASH' : 'BELOW_ACCOUNTING_PRECISION';
                  }
                }
              } catch (error) { reason = error.message; }
              order.reason = reason;
              step(null, !reason);
            },
            function (executable, step) {
              if (!executable) {
                const terminal = ['TASK_PAUSED', 'TASK_STOPPED', 'TASK_GENERATION_CHANGED', 'TASK_CONTROL_CANCELLED', 'TASK_FUNDS_EXHAUSTED', 'SHARED_FUNDS_EXHAUSTED', 'TASK_BUDGET_LIMIT', 'ORDER_AMOUNT_LIMIT', 'HISTORICAL', 'PAUSED_AT_DISCOVERY', 'LEADER_INACTIVE', 'PAUSED', 'BUYS_PAUSED', 'LEADER_CURRENTLY_INACTIVE', 'BEFORE_CURRENT_JOIN', 'NO_OWN_POSITION', 'LEADER_INVENTORY_UNVERIFIED', 'SOURCE_SELL_FROM_OLD_POSITION_CYCLE', 'SOURCE_SELL_ALREADY_SATISFIED', 'INSUFFICIENT_CASH', 'BELOW_ACCOUNTING_PRECISION', 'MARKET_NOT_EXECUTABLE', 'MARKET_ALREADY_RESOLVED', 'Market is closed'];
                if (!terminal.includes(order.reason)) order.status = 'WAITING';
                return tx.save('Order', order, function (err) { step(err, order); });
              }
              if (!position) position = { id: positionId, wallet: signal.wallet, token: signal.token, condition: signal.condition, title: signal.title, outcomeIndex: signal.outcomeIndex, quantity: '0', cost: '0', realized: '0', cycleRealized: '0', cycle: 1 };
              else if (D(position.quantity).isZero() && signal.side === 'BUY') { position.cycle++; position.cycleRealized = '0'; }
              if (signal.side === 'BUY') position.fundingMode = currentTask ? currentTask.fundingMode : 'shared';
              position.outcomeIndex = signal.outcomeIndex;
              if (signal.side === 'BUY') {
                Object.assign(position, accounting.buy(position, fill));
                account.cash = str(D(account.cash).minus(fill.cash));
              } else {
                const sold = accounting.sell(position, fill);
                order.details.realizedProfit = sold.profit;
                order.details.releasedCost = sold.released;
                Object.assign(position, sold);
                account.cash = str(D(account.cash).plus(fill.cash));
                account.realized = str(D(account.realized).plus(sold.profit));
              }
              account.fees = str(D(account.fees).plus(fill.fee));
              if (currentTask) { if (currentTask.fundingMode === 'dedicated') currentTask.cash = str(D(currentTask.cash).plus(signal.side === 'BUY' ? D(fill.cash).negated() : fill.cash)); currentTask.fees = str(D(currentTask.fees).plus(fill.fee)); if (signal.side === 'SELL') { currentTask.realized = str(D(currentTask.realized).plus(order.details.realizedProfit)); } }
              order.status = fill.partial ? 'PARTIAL' : 'FILLED';
              order.details.positionCycle = position.cycle;
              Object.assign(order, { quantity: fill.quantity, gross: fill.gross, fee: fill.fee });
              order.details.quote = quote;
              order.details.remaining = fill.remaining;
              order.details.feeAccounting = 'Virtual fee debited in cash equivalent';
              async.waterfall([
                function (save) { tx.save('Account', account, function (err) { save(err); }); },
                function (save) { if (currentTask) tx.save('FollowTask', currentTask, function (err) { save(err); }); else save(); },
                function (save) { tx.save('Position', position, function (err) { save(err); }); },
                function (save) {
                  tx.query('SELECT clock_timestamp() AS at', [], function (err, rows) {
                    if (err) return save(err);
                    order.createdAt = rows[0].at;
                    Object.assign(order.details.timings, require('../lib/execution-clock').stamp(signal));
                    order.details.timings.quoteSource = quote.quoteSource || 'prepared';
                    order.details.timings.dispatchMode = signal.dispatchMode || 'recovery';
                    tx.save('Order', order, function (error) { save(error); });
                  });
                },
                function (save) { async.eachSeries(fill.fills, function (part, saved) { tx.insert('Fill', { id: crypto.randomUUID(), orderId: order.id, wallet: signal.wallet, token: signal.token, side: signal.side, ...part, createdAt: order.createdAt }, function (err) { saved(err); }); }, save); },
                function (save) { tx.insert('Ledger', { id: 'trade:' + order.id, reference: order.id, kind: signal.side, delta: signal.side === 'BUY' ? str(D(fill.cash).negated()) : fill.cash, balance: account.cash, details: { gross: fill.gross, fee: fill.fee }, createdAt: order.createdAt }, function (err) { save(err); }); },
                function (save) {
                  if (D(position.quantity).isZero()) tx.insert('Cycle', { id: position.id + ':' + position.cycle, wallet: position.wallet, token: position.token, profit: position.cycleRealized, reason: 'SELL', createdAt: order.createdAt }, function (err) { save(err); });
                  else save();
                }
              ], function (err) { step(err, order); });
            }
          ], function (err, value) { done(err, { order: value, retry: !!value && value.status === 'WAITING', retryAfterMs: preparationError && preparationError.retryAfterMs || 0, fill: fill && value && ['FILLED', 'PARTIAL'].includes(value.status) ? fill : null }); });
        }, next);
      }
    ], function (err, result) {
      if (!err && result && result.fill && !result.duplicate) markets.consume(signal.token, signal.side, result.fill.fills);
      callback(err, result);
    });
  }
  function settle(condition, resolution, callback) {
    if (resolution.status !== 'resolved' || !Array.isArray(resolution.payouts)) return callback(null, { pending: true });
    try { accounting.settle({ outcomeIndex: 0, quantity: '0', cost: '0' }, resolution); } catch (error) { return callback(error); }
    db.transaction(function (tx, done) {
      let account, bookedAt;
      async.waterfall([
        function (next) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (rows, next) { account = rows[0]; tx.query('SELECT clock_timestamp() AS at', [], next); },
        function (rows, next) { bookedAt = rows[0].at; tx.query('SELECT * FROM paper_positions WHERE condition=$1 AND quantity>0 FOR UPDATE', [condition], next); },
        function (positions, next) {
          async.eachSeries(positions, function (position, saved) {
            let value;
            try { value = accounting.settle(position, resolution); } catch (err) { return saved(err); }
            const id = position.id + ':' + position.cycle;
            const settledQuantity = position.quantity;
            account.cash = str(D(account.cash).plus(value.revenue));
            account.realized = str(D(account.realized).plus(value.profit));
            position.quantity = '0'; position.cost = '0';
            position.realized = str(D(position.realized).plus(value.profit));
            position.cycleRealized = str(D(position.cycleRealized).plus(value.profit));
            async.waterfall([
              function (step) { tx.insert('Settlement', { id, wallet: position.wallet, token: position.token, condition, quantity: settledQuantity, ...value, evidence: resolution, createdAt: bookedAt }, function (err) { step(err); }); },
              function (step) { tx.save('Position', position, function (err) { step(err); }); },
              function (step) { tx.one('FollowTask', { where: { id: position.wallet } }, step); },
              function (task, step) { if (!task) return step(); if (position.fundingMode === 'dedicated') task.cash = str(D(task.cash).plus(value.revenue)); task.realized = str(D(task.realized).plus(value.profit)); tx.save('FollowTask', task, function (err) { step(err); }); },
              function (step) { tx.insert('Ledger', { id: 'settle:' + id, reference: id, kind: 'SETTLEMENT', delta: value.revenue, balance: account.cash, details: resolution, createdAt: bookedAt }, function (err) { step(err); }); },
              function (step) { tx.insert('Cycle', { id, wallet: position.wallet, token: position.token, profit: position.cycleRealized, reason: 'SETTLEMENT', createdAt: bookedAt }, function (err) { step(err); }); }
            ], saved);
          }, function (err) { next(err); });
        },
        function (next) { tx.query('INSERT INTO paper_markets(id,resolution) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET resolution=EXCLUDED.resolution,"updatedAt"=NOW()', [condition, JSON.stringify(resolution)], function (err) { next(err); }); },
        function (next) { tx.save('Account', account, next); }
      ], done);
    }, callback);
  }
  return { initialize, copy, settle };
}
module.exports = { create };

