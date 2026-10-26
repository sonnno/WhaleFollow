const async = require('async');
const accounting = require('./accounting-service');
const simulation = require('./simulation-service');
const rules = require('./follow-rule-service');
const policy = require('./paper-execution-policy');
const { D, str } = accounting;
const config = require('../../config').paper;

function create(db, markets, options) {
  options = options || {};
  const executionSession = require('node:crypto').randomUUID(); let executionSequence = 0;
  const store = require('./paper-copy-store');
  const warnings = options.warnings || require('./balance-warning-service').create(db);
  const skips = options.skips || require('./copy-skip-service').create(db);
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
    let attempts = 0, fundsState, requiredCash, lastState, refreshQuote = false, matchSelection, lastSaleSizing;
    const matchRatios = options.matchRatios;
    function executionSizing(task, base) {
      if (!task) return base;
      const matched = matchSelection && matchRatios.effective(matchSelection, task);
      return rules.executionConfig(matched ? { ...task, copyPercent: matched.copyPercent } : task, base);
    }
    function buyBlocked(task, resolving) { return rules.buyBlocked(matchSelection ? {...signal,eventKey:matchSelection.eventKey} : signal, resolving && task ? {...task,smartPause:null} : task); }
    const executionAttempts = [];
    function quoteEvidence(quote) {
      if (!quote || !quote.book) return null;
      const book = quote.book, levels = signal.side === 'BUY' ? book.asks || [] : book.bids || [];
      const executable = levels.filter(function (level) { return Number(level.price) > 0 && Number(level.price) < 1 && Number(level.size) > 0; });
      return { source: quote.quoteSource || null, hash: book.hash || book.version || null, observedAt: book.observedAt || null,
        levels: levels.length, executableLevels: executable.length, head: levels.slice(0, 5).map(function (level) { return { price: String(level.price), size: String(level.size) }; }),
        refreshSnapshot: book.refreshSnapshot || null };
    }
    function skipped(reason) {
      if (policy.reasons.has(reason)) {
        const state = lastState || controls && controls.get(signal.wallet, signal.token, signal.sourceId);
        if (state?.task) skips.record(signal, state.task, reason, simulation.buyAmount(signal, executionSizing(state.task, signal.config || config)));
        return callback(null, { order: null, fill: null, retry: false, reason, attempts, ...(signal.side === 'SELL' ? { saleSizing: lastSaleSizing || signal.saleSizing || null } : {}) });
      }
      if (signal.side === 'BUY' && ['ORDER_AMOUNT_BELOW_PRECISION','SMART_PAUSE_NEW_EVENT'].includes(reason)) return callback(null, { order: null, fill: null, retry: false, reason, attempts });
      if (signal.side === 'BUY' && reason === 'INSUFFICIENT_CASH') {
        const state = fundsState || lastState;
        if (state?.task) skips.record(signal, state.task, reason, requiredCash);
        const result = { order: null, fill: null, retry: false, insufficientFunds: true, attempts };
        if (!state) return callback(null, result);
        return warnings.mark(signal, state, requiredCash || simulation.buyAmount(signal, executionSizing(state.task, signal.config || config)), function (err) { callback(err, result); });
      }
      const order = { id: signal.id, sourceId: signal.sourceId, wallet: signal.wallet, token: signal.token, condition: signal.condition, side: signal.side, status: 'SKIPPED', reason, quantity: '0', gross: '0', fee: '0', details: { signal, sourceAmount: signal.sourceAmount, attempts, executionAttempts, config: signal.config || config, timings: { origin: signal.origin || 'websocket', feed: signal.feed || null } } };
      if (signal.side === 'SELL') order.details.saleSizing = lastSaleSizing || signal.saleSizing || null;
      db.transaction(function (tx, done) {
        async.waterfall([
          function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) { next(err); }); },
          function (next) { tx.query('INSERT INTO paper_orders(id,"sourceId",wallet,token,condition,side,status,reason,details) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb WHERE EXISTS(SELECT 1 FROM paper_follow_tasks WHERE id=$3 AND generation=$10) ON CONFLICT(id) DO NOTHING', [order.id,order.sourceId,order.wallet,order.token,order.condition,order.side,order.status,order.reason,JSON.stringify(order.details),Number(signal.followGeneration || 0)], function (err) { next(err); }); }
        ], done);
      }, function (err) { callback(err, { order, fill: null, retry: false }); });
    }
    function attempt() {
      attempts++;
      fundsState = null;
      const state = controls && controls.get(signal.wallet, signal.token, signal.sourceId);
      if (state) lastState = state;
      const blocked = !state ? 'EXECUTION_STATE_UNAVAILABLE' : signal.historical ? 'HISTORICAL' : state.settings.pauseAll ? 'PAUSED' : signal.side === 'BUY' && state.settings.pauseBuys ? 'BUYS_PAUSED' : signal.side === 'BUY' && !state.leader.active ? 'LEADER_INACTIVE' : signal.side === 'BUY' ? buyBlocked(state.task) : '';
      if (blocked) return skipped(blocked);
      function cashCap(current) {
        let cap = D(Infinity);
        if (current.task) {
          if (current.task.allocation != null) cap = cap.clamp(0, D(current.task.allocation).minus(current.positionCost || 0).clamp(0, Infinity));
          if (current.task.maxOrderAmount != null) cap = cap.clamp(0, D(current.task.maxOrderAmount).minus(current.sourceSpending && current.sourceSpending[signal.sourceId] || 0).clamp(0, Infinity));
        }
        return cap;
      }
      function insufficient(current, required) {
        const pool = current.task && current.task.fundingMode === 'dedicated' ? current.task.cash : current.sharedCash;
        if (D(current.account.cash).clamp(0, D(pool).clamp(0, Infinity)).lt(required)) { fundsState = current; requiredCash = required; return true; }
        return false;
      }
      if (signal.side === 'BUY') {
        const sizing = executionSizing(state.task, signal.config || config);
        const amount = D(simulation.buyAmount(signal, sizing));
        if (sizing.realisticExecution && amount.lt(1)) return skipped('BELOW_MIN_BUY_AMOUNT');
        if (sizing.realisticExecution && amount.gt(cashCap(state))) return skipped(state.task.maxOrderAmount != null && amount.gt(D(state.task.maxOrderAmount).minus(state.sourceSpending?.[signal.sourceId] || 0)) ? 'ORDER_LIMIT_EXCEEDED' : 'TASK_BUDGET_LIMIT');
        const filter = policy.eligibility(signal, state.task, markets.policyMarket ? markets.policyMarket(signal) : null, Date.now());
        if (filter === 'SPORTS_METADATA_MISSING' && markets.ensurePolicy) {
          const started = performance.now();
          return markets.ensurePolicy(signal, function (error) {
            executionAttempts.push({ attempt: attempts, stage: 'sports-metadata', durationMs: Math.round(performance.now() - started), error: error ? error.message : null });
            if (error || !markets.policyMarket(signal)) return attempts < 3 ? attempt() : skipped(filter);
            // This is the same current signal. No historical order or durable retry
            // is created. Re-read controls before any execution after the wait.
            attempts--; attempt();
          });
        }
        if (filter) return skipped(filter);
        const required = amount.clamp(0, cashCap(state));
        if (insufficient(state, required)) return attempts < 3 ? attempt() : skipped('INSUFFICIENT_CASH');
      }
      const began = performance.now();
      const attemptTrace = { attempt: attempts, startedAt: new Date().toISOString(), freshQuoteRequested: refreshQuote };
      const request = refreshQuote ? { ...signal, refreshBook: true } : signal;
      markets.prepare(request, function (error, quote) {
        let fill, executionConfig, executionTask, fillSequence, executionTiming, executionMatch, saleSizing;
        attemptTrace.preparedSource = quote && quote.quoteSource || null;
        if (!error) {
          try {
            if (markets.latestQuote) quote = markets.latestQuote(signal, quote);
            if (!quote) throw new Error('QUOTE_MISSING');
            if (Number.isInteger(quote.outcomeIndex)) signal.outcomeIndex = quote.outcomeIndex;
            if (!Number.isInteger(signal.outcomeIndex) || signal.outcomeIndex < 0 || signal.outcomeIndex > 1) throw new Error('UNSUPPORTED_OR_UNKNOWN_OUTCOME');
            // Refresh only the memory snapshot after asynchronous preparation.
            const current = controls.get(signal.wallet, signal.token, signal.sourceId);
            if (!current) throw new Error('EXECUTION_STATE_UNAVAILABLE');
            lastState = current;
            if (current.settings.pauseAll) throw new Error('PAUSED');
            if (signal.side === 'BUY' && (current.settings.pauseAll || current.settings.pauseBuys || !current.leader.active || buyBlocked(current.task))) throw new Error(buyBlocked(current.task) || 'BUY_PAUSED');
            executionTask = current.task;
            executionMatch = matchSelection && matchRatios.effective(matchSelection, current.task);
            executionConfig = executionSizing(current.task, signal.config || config);
            const filter = policy.eligibility(signal, current.task, markets.policyMarket ? markets.policyMarket(signal) : null, Date.now());
            if (filter) throw new Error(filter);
            const available = current.task ? rules.availableCash(current.account, current.task, current.sourceSpending && current.sourceSpending[signal.sourceId] || '0', current.sharedCash, current.positionCost) : current.account.cash;
            const position = current.positions && current.positions[signal.token];
            saleSizing = signal.side === 'SELL' ? require('./leader-position-sale-service').size(signal, position ? position.quantity : '0', executionConfig.copyRatio) : null;
            if (saleSizing) { lastSaleSizing = saleSizing; attemptTrace.saleSizing = saleSizing; }
            const target = saleSizing ? saleSizing.quantity : undefined;
            if (signal.side === 'BUY') {
              const cap = cashCap(current);
              if (cap.lte(0)) throw new Error('TASK_BUDGET_LIMIT');
              if (executionConfig.realisticExecution && D(simulation.buyAmount(signal, executionConfig)).gt(cap)) throw new Error('ORDER_LIMIT_EXCEEDED');
              const desired = simulation.execute(signal, quote.book, quote.metadata, { ...executionConfig, availableCash: Infinity });
              if (desired.reason && policy.reasons.has(desired.reason)) throw new Error(desired.reason);
              if (executionConfig.realisticExecution && D(desired.cash).gt(cap)) throw new Error(current.task.maxOrderAmount != null && D(desired.cash).gt(D(current.task.maxOrderAmount).minus(current.sourceSpending?.[signal.sourceId] || 0)) ? 'ORDER_LIMIT_EXCEEDED' : 'TASK_BUDGET_LIMIT');
              if (insufficient(current, D(desired.cash).clamp(0, cap))) throw new Error('INSUFFICIENT_CASH');
            }
            fill = simulation.execute(signal, quote.book, quote.metadata, { ...executionConfig, availableCash: available }, target);
            if (D(fill.quantity).lte(0) || D(fill.gross).lte(0) || D(fill.cash).lte(0)) {
              if (signal.side === 'BUY' && fill.reason === 'INSUFFICIENT_CASH') {
                const pool = D(current.account.cash).clamp(0, current.task && current.task.fundingMode === 'dedicated' ? current.task.cash : current.sharedCash);
                if (cashCap(current).lt(pool)) throw new Error('ORDER_AMOUNT_BELOW_PRECISION');
                fundsState = current; requiredCash = simulation.buyAmount(signal, executionConfig);
              }
              throw new Error(fill.reason || 'NO_EXECUTABLE_DEPTH');
            }
            controls.reserve(signal, fill);
            markets.consume(signal.token, signal.side, fill.fills);
            fillSequence = ++executionSequence;
            executionTiming = require('../lib/execution-clock').stamp(signal);
            if (executionMatch && signal.side === 'BUY') executionMatch = matchRatios.lock(executionMatch, signal.id, executionTiming.executedAt);
          } catch (failure) { error = failure; }
        }
        attemptTrace.durationMs = Math.round(performance.now() - began);
        attemptTrace.book = quoteEvidence(quote);
        attemptTrace.error = error ? error.message : null;
        executionAttempts.push(attemptTrace);
        if (error) {
          if (error.message === 'SPORTS_METADATA_MISSING' && markets.ensurePolicy && attempts < 3) return attempt();
          if (error.message === 'SMART_PAUSE_NEW_EVENT' || policy.reasons.has(error.message)) return skipped(error.message);
          if (['NO_EXECUTABLE_DEPTH', 'QUOTE_MISSING', 'STALE_BOOK'].includes(error.message)) refreshQuote = true;
          return attempts < 3 ? attempt() : skipped(error.message);
        }
        const order = { id: signal.id, sourceId: signal.sourceId, wallet: signal.wallet, token: signal.token, condition: signal.condition, side: signal.side, status: fill.partial ? 'PARTIAL' : 'FILLED', reason: '', quantity: fill.quantity, gross: fill.gross, fee: fill.fee,
          details: { signal, sourceAmount: signal.sourceAmount, attempts, executionAttempts, config: executionConfig, quote, remaining: fill.remaining, feeAccounting: 'Virtual fee debited in cash equivalent', timings: { ...executionTiming, feed: signal.feed || null, executionSession, executionSequence: fillSequence, origin: signal.origin || 'websocket', prepareMs: Math.round(performance.now() - began), quoteSource: quote.quoteSource || 'prepared', dispatchMode: 'immediate', persistenceVersion: 3 } } };
        if (executionTask) order.details.followTask = { generation: executionTask.generation, taskCreatedAt: executionTask.createdAt ? new Date(executionTask.createdAt).toISOString() : null, fundingMode: executionTask.fundingMode, copyPercent: executionTask.copyPercent, allocation: executionTask.allocation, maxOrderAmount: executionTask.maxOrderAmount, smartPauseId: executionTask.smartPause?.id || null };
        if (saleSizing) order.details.saleSizing = saleSizing;
        if (executionMatch) {
          order.details.matchRatio = executionMatch;
          order.details.followTask.copyPercent = executionMatch.copyPercent;
          order.details.configuredCopyPercent = executionTask.copyPercent;
        }
        const balanceEvent = warnings.event(signal, executionTask, false);
        // The fill is already computed and the book consumed. Database work below
        // records this result; failures here must never initiate another purchase.
        let writes = 0;
        function record() {
          writes++;
          persistFill(signal, order, fill, balanceEvent, function (err, result) {
            if (err && writes < 3) return record();
            if (err) { err.executedOrder = { order, fill }; controls.complete(signal.id, true, true); }
            else controls.complete(signal.id, result && (result.duplicate || result.taskDeleted));
            callback(err, result);
          });
        }
        record();
      });
    }
    const initial = controls && controls.get(signal.wallet, signal.token, signal.sourceId);
    if (matchRatios && initial && initial.task && !initial.settings.pauseAll &&
        (signal.side !== 'BUY' || !initial.settings.pauseBuys && initial.leader.active && !buyBlocked(initial.task,true))) {
      return matchRatios.select(signal, initial.task, function (err, value) {
        if (err) return skipped(err.code || 'MATCH_IDENTITY_UNAVAILABLE');
        matchSelection = value; signal.eventKey = value.eventKey; attempt();
      });
    }
    attempt();
  }
  function persistFill(signal, order, fill, balanceEvent, callback, recording) {
    db.transaction(function (tx, done) {
      let recordedTask;
      async.waterfall([
        function (next) { store.read(tx, signal, next); },
        function (context, next) {
          if (context.taskDeleted) return next(new Error('Task deleted before executed result was recorded'));
          if (!context.claimed) return next(new Error('Executed order could not be claimed'));
          if (!context.claimed.inserted && context.claimed.status !== 'WAITING') {
            if (!recording) return done(null, { duplicate: true, retry: false });
            const previous = context.claimed, ledger = context.tradeLedger;
            if (['FILLED', 'PARTIAL'].includes(previous.status)) {
              if (!ledger || ['quantity', 'gross', 'fee'].some(function (key) { return D(previous[key]).minus(fill[key]).abs().gt('0.000000000000000001'); }) ||
                  D(ledger.delta).minus(signal.side === 'BUY' ? D(fill.cash).negated() : fill.cash).abs().gt('0.000000000000000001')) return next(new Error('Executed receipt accounting does not match'));
              return done(null, { duplicate: true, retry: false });
            }
            if (previous.status !== 'SKIPPED' || ledger || ['quantity', 'gross', 'fee'].some(function (key) { return !D(previous[key]).isZero(); })) return next(new Error('Executed receipt conflicts with existing accounting'));
          }
          const account = context.account, task = context.task; recordedTask = task;
          const executedTask = order.details.followTask;
          const sameTask = executedTask?.taskCreatedAt && task?.createdAt && new Date(executedTask.taskCreatedAt).toISOString() === new Date(task.createdAt).toISOString();
          if (executedTask && (!task || task.generation !== executedTask.generation && !sameTask || task.fundingMode !== executedTask.fundingMode)) return next(new Error('Task funding or generation changed before result was recorded'));
          if (signal.side === 'BUY' && D(fill.cash).gt(task ? rules.availableCash(account, task, context.spent || '0', context.sharedCash, context.positionCost) : account.cash)) return next(new Error('Funds changed before paper result was recorded'));
          let position = context.position || { id: signal.wallet + ':' + signal.token, wallet: signal.wallet, token: signal.token, condition: signal.condition, title: signal.title || '', outcomeIndex: signal.outcomeIndex, quantity: '0', cost: '0', realized: '0', cycleRealized: '0', cycle: 1 };
          if (D(position.quantity).isZero() && signal.side === 'BUY') { position.openedAt = order.details.timings.executedAt; if (context.position) { position.cycle++; position.cycleRealized = '0'; } }
          try {
            if (signal.side === 'BUY') { position.fundingMode = task ? task.fundingMode : 'shared'; Object.assign(position, accounting.buy(position, fill)); account.cash = str(D(account.cash).minus(fill.cash)); }
            else { const sold = accounting.sell(position, fill); Object.assign(position, sold); order.details.realizedProfit = sold.profit; order.details.releasedCost = sold.released; account.cash = str(D(account.cash).plus(fill.cash)); account.realized = str(D(account.realized).plus(sold.profit)); }
          } catch (failure) { return next(failure); }
          account.fees = str(D(account.fees).plus(fill.fee)); position.outcomeIndex = signal.outcomeIndex;
          if (task) { if (task.fundingMode === 'dedicated') task.cash = str(D(task.cash).plus(signal.side === 'BUY' ? D(fill.cash).negated() : fill.cash)); task.fees = str(D(task.fees).plus(fill.fee)); task.realized = str(D(task.realized).plus(order.details.realizedProfit || 0)); }
          order.details.positionCycle = position.cycle;
          store.commit(tx, account, task, position, order, fill, function (err) { next(err); });
        },
        function (next) {
          if (order.side === 'BUY' && order.details.matchRatio && options.matchRatios) return options.matchRatios.persist(tx, order.details.matchRatio, next);
          next();
        },
        function (next) { require('./smart-pause-service').recordExecuted(tx,recordedTask,order,next); },
        function (next) { warnings.write(tx, balanceEvent, next); },
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
  // Record an existing execution only. Never reprice, consume a book or buy again.
  function recordExecuted(receipt, callback) {
    let order, fill, signal;
    try {
      order = receipt.order; fill = receipt.fill; signal = order.details.signal;
      if (!['FILLED', 'PARTIAL'].includes(order.status) || !['BUY', 'SELL'].includes(signal.side) ||
          ['id', 'sourceId', 'wallet', 'token', 'condition', 'side'].some(function (key) { return !signal[key] || order[key] !== signal[key]; }) ||
          !Array.isArray(fill.fills) || !fill.fills.length) throw new Error('Invalid executed receipt');
      ['quantity', 'gross', 'cash', 'fee'].forEach(function (key) { if (!D(fill[key]).isFinite() || D(fill[key]).lt(0)) throw new Error('Invalid executed amount'); });
      if (D(fill.quantity).lte(0) || D(fill.cash).lte(0) || !D(signal.side === 'BUY' ? D(fill.gross).plus(fill.fee) : D(fill.gross).minus(fill.fee)).eq(fill.cash)) throw new Error('Invalid executed cash');
      if (['quantity', 'gross', 'fee'].some(function (key) { return !D(order[key]).eq(fill[key]); })) throw new Error('Executed order and fill disagree');
    } catch (err) { return callback(err); }
    persistFill(signal, order, fill, warnings.event(signal, order.details.followTask, false), callback, true);
  }
  return { initialize, copy, settle, recordExecuted };
}
module.exports = { create };

