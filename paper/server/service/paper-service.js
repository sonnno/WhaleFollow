const async = require('async');
const accounting = require('./accounting-service');
const simulation = require('./simulation-service');
const rules = require('./follow-rule-service');
const { D, str } = accounting;
const config = require('../../config').paper;

function create(db, markets, options) {
  options = options || {};
  const store = require('./paper-copy-store');
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
    const controls = options.controls;
    let attempts = 0;
    function skipped(reason) {
      const order = { id: signal.id, sourceId: signal.sourceId, wallet: signal.wallet, token: signal.token, condition: signal.condition, side: signal.side, status: 'SKIPPED', reason, quantity: '0', gross: '0', fee: '0', details: { signal, sourceAmount: signal.sourceAmount, attempts, config: signal.config || config, timings: { origin: signal.origin || 'websocket' } } };
      db.transaction(function (tx, done) {
        async.waterfall([
          function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) { next(err); }); },
          function (next) { tx.query('INSERT INTO paper_orders(id,"sourceId",wallet,token,condition,side,status,reason,details) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb WHERE EXISTS(SELECT 1 FROM paper_follow_tasks WHERE id=$3 AND generation=$10) ON CONFLICT(id) DO NOTHING', [order.id,order.sourceId,order.wallet,order.token,order.condition,order.side,order.status,order.reason,JSON.stringify(order.details),Number(signal.followGeneration || 0)], function (err) { next(err); }); }
        ], done);
      }, function (err) { callback(err, { order, fill: null, retry: false }); });
    }
    function attempt() {
      attempts++;
      const state = controls && controls.get(signal.wallet);
      const blocked = !state ? 'EXECUTION_STATE_UNAVAILABLE' : signal.historical ? 'HISTORICAL' : state.settings.pauseAll ? 'PAUSED' : signal.side === 'BUY' && state.settings.pauseBuys ? 'BUYS_PAUSED' : signal.side === 'BUY' && !state.leader.active ? 'LEADER_INACTIVE' : signal.side === 'BUY' ? rules.buyBlocked(signal, state.task) : '';
      if (blocked) return skipped(blocked);
      const began = performance.now();
      markets.prepare(signal, function (error, quote) {
        let fill, executionConfig, executionTask;
        if (!error) {
          try {
            if (markets.latestQuote) quote = markets.latestQuote(signal, quote);
            if (!quote) throw new Error('QUOTE_MISSING');
            if (Number.isInteger(quote.outcomeIndex)) signal.outcomeIndex = quote.outcomeIndex;
            if (!Number.isInteger(signal.outcomeIndex) || signal.outcomeIndex < 0 || signal.outcomeIndex > 1) throw new Error('UNSUPPORTED_OR_UNKNOWN_OUTCOME');
            // Refresh only the memory snapshot after asynchronous preparation.
            const current = controls.get(signal.wallet);
            if (!current) throw new Error('EXECUTION_STATE_UNAVAILABLE');
            if (signal.side === 'BUY' && (current.settings.pauseAll || current.settings.pauseBuys || !current.leader.active || rules.buyBlocked(signal, current.task))) throw new Error('BUY_PAUSED');
            executionTask = current.task;
            executionConfig = current.task ? rules.executionConfig(current.task, signal.config || config) : signal.config || config;
            const available = current.task ? rules.availableCash(current.account, current.task, '0', current.sharedCash, current.positionCost) : current.account.cash;
            const position = current.positions && current.positions[signal.token];
            const target = signal.side === 'SELL' ? str(D(signal.size).mul(executionConfig.copyRatio || 1).clamp(0, position ? position.quantity : 0)) : undefined;
            fill = simulation.execute(signal, quote.book, quote.metadata, { ...executionConfig, availableCash: available }, target);
            if (D(fill.quantity).lte(0) || D(fill.gross).lte(0) || D(fill.cash).lte(0)) throw new Error(fill.reason || 'NO_EXECUTABLE_DEPTH');
            controls.reserve(signal, fill);
            markets.consume(signal.token, signal.side, fill.fills);
          } catch (failure) { error = failure; }
        }
        if (error) return attempts < 3 ? attempt() : skipped(error.message);
        const order = { id: signal.id, sourceId: signal.sourceId, wallet: signal.wallet, token: signal.token, condition: signal.condition, side: signal.side, status: fill.partial ? 'PARTIAL' : 'FILLED', reason: '', quantity: fill.quantity, gross: fill.gross, fee: fill.fee,
          details: { signal, sourceAmount: signal.sourceAmount, attempts, config: executionConfig, quote, remaining: fill.remaining, feeAccounting: 'Virtual fee debited in cash equivalent', timings: { ...require('../lib/execution-clock').stamp(signal), origin: signal.origin || 'websocket', prepareMs: Math.round(performance.now() - began), quoteSource: quote.quoteSource || 'prepared', dispatchMode: 'immediate', persistenceVersion: 3 } } };
        if (executionTask) order.details.followTask = { generation: executionTask.generation, fundingMode: executionTask.fundingMode, copyPercent: executionTask.copyPercent, allocation: executionTask.allocation, maxOrderAmount: executionTask.maxOrderAmount };
        // The fill is already computed and the book consumed. Database work below
        // records this result; failures here must never initiate another purchase.
        let writes = 0;
        function record() {
          writes++;
          persistFill(signal, order, fill, function (err, result) {
            if (err && writes < 3) return record();
            if (err) { err.executedOrder = { order, fill }; controls.complete(signal.id, true, true); }
            else controls.complete(signal.id, result && (result.duplicate || result.taskDeleted));
            callback(err, result);
          });
        }
        record();
      });
    }
    attempt();
  }
  function persistFill(signal, order, fill, callback) {
    db.transaction(function (tx, done) {
      async.waterfall([
        function (next) { store.read(tx, signal, next); },
        function (context, next) {
          if (context.taskDeleted) return next(new Error('Task deleted before executed result was recorded'));
          if (!context.claimed || !context.claimed.inserted && context.claimed.status !== 'WAITING') return done(null, { duplicate: true, retry: false });
          const account = context.account, task = context.task;
          const executedTask = order.details.followTask;
          if (executedTask && (!task || task.generation !== executedTask.generation || task.fundingMode !== executedTask.fundingMode)) return next(new Error('Task funding or generation changed before result was recorded'));
          if (signal.side === 'BUY' && D(fill.cash).gt(task ? rules.availableCash(account, task, context.spent || '0', context.sharedCash, context.positionCost) : account.cash)) return next(new Error('Funds changed before paper result was recorded'));
          let position = context.position || { id: signal.wallet + ':' + signal.token, wallet: signal.wallet, token: signal.token, condition: signal.condition, title: signal.title || '', outcomeIndex: signal.outcomeIndex, quantity: '0', cost: '0', realized: '0', cycleRealized: '0', cycle: 1 };
          if (D(position.quantity).isZero() && signal.side === 'BUY' && context.position) { position.cycle++; position.cycleRealized = '0'; }
          try {
            if (signal.side === 'BUY') { position.fundingMode = task ? task.fundingMode : 'shared'; Object.assign(position, accounting.buy(position, fill)); account.cash = str(D(account.cash).minus(fill.cash)); }
            else { const sold = accounting.sell(position, fill); Object.assign(position, sold); order.details.realizedProfit = sold.profit; order.details.releasedCost = sold.released; account.cash = str(D(account.cash).plus(fill.cash)); account.realized = str(D(account.realized).plus(sold.profit)); }
          } catch (failure) { return next(failure); }
          account.fees = str(D(account.fees).plus(fill.fee)); position.outcomeIndex = signal.outcomeIndex;
          if (task) { if (task.fundingMode === 'dedicated') task.cash = str(D(task.cash).plus(signal.side === 'BUY' ? D(fill.cash).negated() : fill.cash)); task.fees = str(D(task.fees).plus(fill.fee)); task.realized = str(D(task.realized).plus(order.details.realizedProfit || 0)); }
          order.details.positionCycle = position.cycle;
          store.commit(tx, account, task, position, order, fill, function (err) { next(err); });
        },
        function (next) { tx.query('INSERT INTO paper_source_trades(id,wallet,token,condition,side,timestamp,quantities,processed,budget,raw) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$7::jsonb,$8,$9::jsonb) ON CONFLICT(id) DO NOTHING', [signal.sourceId, signal.wallet, signal.token, signal.condition, signal.side, String(signal.timestamp), JSON.stringify({ [signal.price]: signal.size }), signal.sourceAmount, JSON.stringify({ trades: signal.raw || [] })], function (err) { next(err); }); }
      ], function (err) { done(err, { order, fill, retry: false }); });
    }, callback);
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

