const async = require('async');
const WebSocket = require('ws');
const http = require('../lib/http-client');
const config = require('../../config').paper;
const { D, str } = require('./accounting-service');
const agent = require('../lib/network-agent');

function create(db, redis, dependencies) {
  const config = dependencies && dependencies.config || require('../../config').paper;
  const transport = dependencies && dependencies.http || http;
  const Socket = dependencies && dependencies.WebSocket || WebSocket;
  const books = new Map(), metadata = new Map(), tokens = new Set(), unavailable = new Set(), states = new Map();
  const metadataPending = new Map();
  const preparationPending = new Map();
  const eventSlugs = new Map(), closedEvents = new Set();
  const policyMarkets = new Map(), policyPending = new Map(), policyRetriedAt = new Map(), policyRunning = new Set();
  const policyQueue = async.priorityQueue(function (condition, complete) {
    policyRunning.add(condition);
    transport.request(config.gammaUrl, '/markets', { condition_ids: condition, closed: 'any', include_tag: true }, function (err, response) {
      const row = !err && Array.isArray(response) && response.find(value => value.conditionId === condition);
      if (!err && !row) err = new Error('Sports market metadata unavailable');
      if (stopped) err = new Error('Market service stopped');
      if (row && !stopped) rememberEvent(row);
      policyRunning.delete(condition);
      const waiting = policyPending.get(condition) || []; policyPending.delete(condition);
      waiting.forEach(function (callback) { callback(err); }); complete();
      if (row && !stopped) setImmediate(function () { saveSchedule(row, function (error) { if (error) health.error = error.message; }); });
    });
  }, 2);
  function rememberEvent(row) {
    const event = (row.events || [])[0] || {};
    policyMarkets.set(row.conditionId, { gameStartTime: row.gameStartTime || null, sportsMarketType: row.sportsMarketType || null, question: row.question || null,
      eventTitle: event.title || row.eventTitle || null, eventSlug: event.slug || row.eventSlug || null, active: row.active, acceptingOrders: row.acceptingOrders, closed: row.closed, observedAt: row.policyObservedAt ? Date.parse(row.policyObservedAt) : Date.now() });
    if (event.slug) eventSlugs.set(row.conditionId, event.slug);
    const key = require('./match-ratio-service').eventKey(event.slug);
    if (key && event.closed === true && key === event.slug.trim().toLowerCase()) closedEvents.add(key);
  }
  function policyMarket(signal) {
    const value = policyMarkets.get(signal.condition);
    return value && Date.now() - value.observedAt < 300000 ? value : null;
  }
  function warmPolicy(signal, callback, urgent) {
    callback = callback || function () {};
    if (stopped) return callback(new Error('Market service stopped'));
    if (policyMarket(signal)) return callback();
    if (policyPending.has(signal.condition)) {
      policyPending.get(signal.condition).push(callback);
      if (urgent && !policyRunning.has(signal.condition)) { policyQueue.remove(item => item.data === signal.condition); policyQueue.push(signal.condition, 0); }
      return;
    }
    if (!urgent && (policyPending.size >= 2000 || Date.now() - (policyRetriedAt.get(signal.condition) || 0) < 30000)) return callback(new Error('Metadata warmup deferred'));
    policyRetriedAt.set(signal.condition, Date.now()); policyPending.set(signal.condition, [callback]); policyQueue.push(signal.condition, urgent ? 0 : 10);
  }
  function ensurePolicy(signal, callback) {
    const began = Date.now(); health.policyWaits = (health.policyWaits || 0) + 1;
    warmPolicy(signal, function (err) {
      const key = err ? 'policyWaitFailures' : 'policyWaitSuccesses'; health[key] = (health[key] || 0) + 1;
      health.lastPolicyWait = { condition: signal.condition, durationMs: Date.now() - began, error: err ? err.message : null };
      callback(err);
    }, true);
  }
  function warmLeader(wallet, callback) {
    transport.request(config.dataUrl, '/v2/activity', { user: wallet, type: 'TRADE', limit: 1000 }, function (err, response) {
      if (err) return callback(err);
      const rows = Array.isArray(response) ? response : response.data;
      if (!Array.isArray(rows)) return callback(new Error('Invalid leader warmup response'));
      const conditions = [...new Set(rows.filter(row => String(row.proxy_wallet || row.proxyWallet || '').toLowerCase() === wallet.toLowerCase()).map(row => row.condition_id || row.conditionId).filter(Boolean))];
      async.eachLimit(conditions, 2, function (condition, next) { warmPolicy({ condition }, function () { next(); }); }, callback);
    });
  }
  function loadPolicies(callback) {
    db.query(`SELECT raw->'gamma' AS gamma FROM paper_markets WHERE "updatedAt">clock_timestamp()-interval '5 minutes' AND raw ? 'gamma' LIMIT 3000`, [], function (err, rows) {
      if (!err) rows.forEach(function (row) { if (row.gamma?.conditionId && row.gamma.policyObservedAt) rememberEvent(row.gamma); });
      callback(err);
    });
  }
  const depthIndexes = new WeakMap(), dirtyBooks = new Set();
  const watchedSignals = new Map();
  const streamId = require('node:crypto').randomUUID();
  let connectionEpoch = 0;
  let lastAliveAt = 0;
  let socket, stopped = false, reconnect, ping, cacheTimer, resolutionListener;
  const health = { connected: false, lastMessage: null, error: null };
  function publish(token, book) {
    books.set(token, book);
    dirtyBooks.add(token);
    if (!cacheTimer) { cacheTimer = setInterval(flushBooks, 1000); cacheTimer.unref(); }
  }
  function flushBooks() {
    // Cache copies are for restart assistance. Execution reads the current memory book.
    // Bound each turn so unrelated trade callbacks can run between book serializations.
    const pending = [...dirtyBooks]; dirtyBooks.clear(); let index = 0;
    function writeNext() {
      if (stopped || index >= pending.length) return;
      const token = pending[index++], book = books.get(token);
      if (book) redis.set('paper:book:' + token, JSON.stringify(book), 'EX', 120, function () {});
      if (index < pending.length) setImmediate(writeNext);
    }
    writeNext();
  }
  function depthIndex(book, side) {
    let index = depthIndexes.get(book);
    if (!index) { index = {}; depthIndexes.set(book, index); }
    if (!index[side]) {
      index[side] = new Map();
      book[side].forEach(function (level, position) { index[side].set(D(level.price).toString(), { level, position }); });
    }
    return index[side];
  }
  function changeLevel(book, name, change) {
    const levels = book[name], index = depthIndex(book, name), key = D(change.price).toString(), existing = index.get(key);
    if (D(change.size).gt(0)) {
      if (existing) { existing.level.size = String(change.size); return; }
      const level = { price: String(change.price), size: String(change.size) };
      index.set(key, { level, position: levels.length }); levels.push(level); return;
    }
    if (!existing) return;
    const last = levels.pop(); index.delete(key);
    if (existing.position < levels.length) {
      levels[existing.position] = last;
      index.get(D(last.price).toString()).position = existing.position;
    }
  }
  function apply(message) {
    health.lastMessage = new Date().toISOString();
    if (message.event_type === 'book') {
      const prior = books.get(message.asset_id);
      publish(message.asset_id, prior && message.hash && message.hash === prior.hash ? { ...prior, observedAt: Date.now(), needsFullSnapshot: false, streamEpoch: connectionEpoch, streamId } : { bids: message.bids || [], asks: message.asks || [], observedAt: Date.now(), version: message.hash || message.timestamp, hash: message.hash, needsFullSnapshot: false, streamEpoch: connectionEpoch, streamId });
    }
    if (message.event_type === 'price_change') (message.price_changes || []).forEach(function (change) {
      const book = books.get(change.asset_id);
      if (!book || book.needsFullSnapshot) return;
      changeLevel(book, change.side === 'BUY' ? 'bids' : 'asks', change);
      book.observedAt = Date.now(); book.version = change.hash || message.timestamp; book.streamEpoch = connectionEpoch; book.streamId = streamId;
      publish(change.asset_id, book);
    });
    if (message.event_type === 'tick_size_change') metadata.clear();
    if (message.event_type === 'market_resolved') {
      if (message.market) unavailable.add(message.market);
      (message.assets_ids || []).forEach(function (token) { unavailable.add(token); });
      if (resolutionListener) resolutionListener();
    }
  }
  function connect() {
    if (stopped) return;
    const connection = new Socket(config.marketWsUrl, { agent, handshakeTimeout: config.requestTimeoutMs });
    socket = connection;
    socket.on('open', function () {
      if (stopped || socket !== connection) return connection.terminate();
      connectionEpoch++;
      lastAliveAt = Date.now();
      health.connected = true; health.error = null;
      if (tokens.size) socket.send(JSON.stringify({ type: 'market', assets_ids: [...tokens], custom_feature_enabled: true }));
      // A reconnected incremental stream needs fresh full books before execution.
      books.forEach(function (book) { book.observedAt = 0; book.needsFullSnapshot = true; });
      clearInterval(ping);
      ping = setInterval(function () {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastAliveAt > 30000) { health.connected = false; health.error = 'Market stream heartbeat timed out'; return socket.terminate(); }
        socket.send('PING');
      }, 10000);
    });
    socket.on('message', function (data) { if (stopped || socket !== connection) return; lastAliveAt = Date.now(); if (String(data) === 'PONG') return; try { const values = JSON.parse(String(data)); (Array.isArray(values) ? values : [values]).forEach(apply); } catch (_) { health.error = 'Invalid WS payload'; } });
    socket.on('error', function (err) { if (socket === connection) health.error = err.message; });
    socket.on('close', function () { if (socket !== connection) return; health.connected = false; clearInterval(ping); if (!stopped) reconnect = setTimeout(connect, 3000); });
  }
  function subscribe(token) {
    if (tokens.has(token)) return;
    tokens.add(token);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ operation: 'subscribe', assets_ids: [token], custom_feature_enabled: true }));
  }
  function snapshotSide(levels) {
    let executableLevels = 0, quantity = 0, bestPrice = null;
    levels.forEach(function (level) {
      const price = Number(level.price), size = Number(level.size);
      if (price > 0 && price < 1 && size > 0 && Number.isFinite(size)) { executableLevels++; quantity += size; if (bestPrice === null || price < bestPrice) bestPrice = price; }
    });
    return { levels: levels.length, executableLevels, quantity, lowestPrice: bestPrice };
  }
  function getBook(token, callback, force) {
    subscribe(token);
    let previous = books.get(token);
    if (!force && usableBook(previous)) return callback(null, JSON.parse(JSON.stringify(previous)));
    function fetch() { transport.request(config.clobUrl, '/book', { token_id: token }, function (err, raw) {
      if (err) return callback(err);
      if (!Array.isArray(raw.bids) || !Array.isArray(raw.asks)) return callback(new Error('Invalid order book'));
      // Identical full snapshots do not reset locally consumed depth.
      let book;
      const current = books.get(token) || previous;
      if (current && raw.hash && raw.hash === current.hash) book = { ...current, observedAt: Date.now(), needsFullSnapshot: false };
      else book = { bids: raw.bids, asks: raw.asks, observedAt: Date.now(), version: raw.hash || raw.timestamp, hash: raw.hash, minSize: raw.min_order_size, needsFullSnapshot: false };
      if (force) book.refreshSnapshot = { at: new Date().toISOString(), hash: raw.hash || null, asks: snapshotSide(raw.asks), bids: snapshotSide(raw.bids) };
      publish(token, book); callback(null, JSON.parse(JSON.stringify(book)));
    }); }
    if (previous) return fetch();
    redis.get('paper:book:' + token, function (err, cached) {
      if (!err && cached) { try { const value = JSON.parse(cached); if (Array.isArray(value.bids) && Array.isArray(value.asks)) { previous = value; books.set(token, value); } } catch (_) {} }
      fetch();
    });
  }
  function getMetadata(condition, callback, force) {
    const cached = metadata.get(condition);
    if (!force && cached && Date.now() - cached.observedAt < 300000) return callback(null, cached);
    if (metadataPending.has(condition)) { metadataPending.get(condition).push(callback); return; }
    metadataPending.set(condition, [callback]);
    function finish(err, value) { const waiting = metadataPending.get(condition); metadataPending.delete(condition); waiting.forEach(function (next) { next(err, value); }); }
    transport.request(config.clobUrl, '/clob-markets/' + encodeURIComponent(condition), {}, function (err, raw) {
      if (err) return finish(err);
      if (!Array.isArray(raw.t) || raw.t.length !== 2) return finish(new Error('Only ordinary binary markets are supported'));
      const fd = raw.fd;
      if (!fd || fd.r === null || fd.r === undefined || fd.e === null || fd.e === undefined) return finish(new Error('Unknown market fee curve'));
      const value = { rate: String(fd.r), exponent: Number(fd.e), minSize: String(raw.mos || 0), tick: String(raw.mts || ''), observedAt: Date.now(), raw };
      metadata.set(condition, value);
      if (raw.ao === true) states.set(condition, { observedAt: Date.now() });
      else { states.delete(condition); states.forEach(function (state, key) { if (state.condition === condition) states.delete(key); }); }
      finish(null, value);
      setImmediate(function () {
        db.query("INSERT INTO paper_markets(id,raw) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET raw=EXCLUDED.raw || jsonb_build_object('gamma',COALESCE(paper_markets.raw->'gamma','{}'::jsonb)),\"updatedAt\"=NOW()", [condition, JSON.stringify(raw)], function (error) { if (error) health.error = error.message; });
      });
    });
  }
  function isExecutable(signal) { return !unavailable.has(signal.condition) && !unavailable.has(signal.token) && !closedEvents.has(require('./smart-pause-service').signalEvent({...signal,eventSlug:eventSlugs.get(signal.condition)})); }
  function tradingState(signal, callback, force) {
    if (!isExecutable(signal)) return callback(new Error('Market is not executable'));
    const cached = states.get(signal.token);
    if (!force && cached && Date.now() - cached.observedAt < config.bookMaxAgeMs) return callback();
    transport.request(config.gammaUrl, '/markets', { condition_ids: signal.condition, include_tag: true }, function (err, response) {
      if (err) return callback(err);
      const raw = Array.isArray(response) ? response.find(function (row) { return row.conditionId === signal.condition; }) : null;
      if (!raw) return callback(new Error('Market metadata temporarily unavailable'));
      rememberEvent(raw);
      if (!isExecutable(signal)) return callback(new Error('Market is closed'));
      if (raw.closed === true) return callback(new Error('Market is closed'));
      if (raw.acceptingOrders !== true || raw.active !== true || raw.closed !== false) return callback(new Error('Market is temporarily not accepting orders'));
      states.set(signal.token, { observedAt: Date.now(), condition: signal.condition });
      callback();
      setImmediate(function () { saveSchedule(raw, function (error) { if (error) health.error = error.message; }); });
    });
  }
  function prepareLookup(signal, callback) {
    if (!isExecutable(signal)) return callback(new Error('Market is not executable'));
    let params, book;
    const state = states.get(signal.condition) || states.get(signal.token);
    async.waterfall([
      function (next) { async.parallel({ metadata: function (done) { getMetadata(signal.condition, done, !state || Date.now() - state.observedAt >= config.bookMaxAgeMs); }, book: function (done) { getBook(signal.token, done, signal.refreshBook === true); } }, next); },
      function (values, next) {
        params = values.metadata; book = values.book;
        const index = params.raw.t.findIndex(function (token) { return String(token.t) === String(signal.token); });
        if (index < 0) return next(new Error('Token outcome mapping mismatch'));
        signal.outcomeIndex = index;
        if (params.raw.ao === true) return next();
        tradingState(signal, next, params.raw.ao === false);
      },
      function (next) {
        function complete() { if (!isExecutable(signal)) return next(new Error('Market is not executable')); next(null, { metadata: params, book, outcomeIndex: signal.outcomeIndex }); }
        // Re-read locally consumed/updated depth after waiting for metadata or state.
        // Warm preparation can overlap an earlier order on the same token.
        getBook(signal.token, function (err, fresh) { if (err) return next(err); book = fresh; complete(); });
      }
    ], callback);
  }
  function prepare(signal, callback) {
    watchedSignals.set(signal.token, { signal: { condition: signal.condition, token: signal.token }, lastUsedAt: Date.now() });
    const cached = cachedQuote(signal);
    const ready = signal.refreshBook === true ? null : cached;
    if (ready) { signal.outcomeIndex = ready.outcomeIndex; return callback(null, ready); }
    const key = signal.condition + ':' + signal.token + ':' + (signal.refreshBook === true ? 'refresh' : 'current');
    if (preparationPending.has(key)) { preparationPending.get(key).push({ signal, callback }); return; }
    preparationPending.set(key, [{ signal, callback }]);
    function finish(err, value) {
      const waiting = preparationPending.get(key); preparationPending.delete(key);
      waiting.forEach(function (entry) { if (value) entry.signal.outcomeIndex = value.outcomeIndex; entry.callback(err, value); });
    }
    // An empty-depth retry needs a new book, not another fee/market lookup.
    if (signal.refreshBook === true && cached) return getBook(signal.token, function (err, book) {
      finish(err, err ? null : { ...cached, book, quoteSource: 'book-refresh' });
    }, true);
    prepareLookup(signal, function (err, value) {
      if (value) value.quoteSource = 'rest-preparation';
      finish(err, value);
    });
  }
  function usableBook(book) {
    return !!book && !book.needsFullSnapshot && (liveBook(book) || Date.now() - book.observedAt <= config.bookMaxAgeMs);
  }
  function liveBook(book) { return health.connected && Date.now() - lastAliveAt <= 30000 && book.streamId === streamId && book.streamEpoch === connectionEpoch; }
  function cachedQuote(signal) {
    const params = metadata.get(signal.condition), book = books.get(signal.token);
    if (!isExecutable(signal) || !params || Date.now() - params.observedAt >= 300000 || !usableBook(book) || (!states.has(signal.condition) && !states.has(signal.token))) return null;
    const outcomeIndex = params.raw.t.findIndex(function (item) { return String(item.t) === String(signal.token); });
    if (outcomeIndex < 0) return null;
    return { metadata: params, book: JSON.parse(JSON.stringify(book)), outcomeIndex, quoteSource: liveBook(book) ? 'websocket-cache' : 'local-cache' };
  }
  function latestQuote(signal, previous) {
    return cachedQuote(signal);
  }
  function refreshParameters(callback) {
    const conditions = new Map();
    watchedSignals.forEach(function (value, token) {
      if (Date.now() - value.lastUsedAt > 300000) { watchedSignals.delete(token); return; }
      const params = metadata.get(value.signal.condition);
      if (!params || Date.now() - params.observedAt >= 30000) conditions.set(value.signal.condition, value.signal);
    });
    async.eachLimit([...conditions.values()], 2, function (signal, next) {
      getMetadata(signal.condition, function (err, params) {
        if (err) return next(err);
        if (params.raw.ao === true) return next();
        states.delete(signal.token);
        tradingState(signal, function (error) { if (error && error.message === 'Market is closed') unavailable.add(signal.condition); next(error); }, true);
      }, true);
    }, callback);
  }
  function warm(signal) { prepare(signal, function () {}); }
  function consume(token, side, fills) {
    const book = books.get(token);
    if (!book) return;
    const index = depthIndex(book, side === 'BUY' ? 'asks' : 'bids');
    fills.forEach(function (fill) { const found = index.get(D(fill.price).toString()); if (found) found.level.size = str(D(found.level.size).minus(fill.quantity).clamp(0, Infinity)); });
    publish(token, book);
  }
  function mark(callback) {
    db.query('SELECT DISTINCT token FROM paper_positions WHERE quantity>0', [], function (err, rows) {
      if (err) return callback(err);
      async.eachLimit(rows, 3, function (row, next) {
        getBook(row.token, function (error, book) {
          if (error || !book.bids.length || !book.asks.length) return next();
          const bid = book.bids.reduce(function (value, level) { return D(level.size).gt(0) && D(level.price).gt(value) ? D(level.price) : value; }, D(0));
          const ask = book.asks.reduce(function (value, level) { return D(level.size).gt(0) && D(level.price).lt(value) ? D(level.price) : value; }, D(1));
          if (bid.lte(0) || ask.gte(1) || bid.gt(ask)) return next();
          db.query('UPDATE paper_positions SET mark=$1,"markedAt"=$2 WHERE token=$3 AND quantity>0', [str(bid.plus(ask).div(2)), new Date(book.observedAt), row.token], function (updateError) { next(updateError); });
        }, !health.connected);
      }, callback);
    });
  }
  function resolutions(callback) {
    db.query('SELECT DISTINCT condition FROM paper_positions WHERE quantity>0', [], function (err, rows) {
      if (err) return callback(err);
      const batches = [];
      for (let i = 0; i < rows.length; i += 20) batches.push(rows.slice(i, i + 20).map(function (row) { return row.condition; }));
      const values = [];
      async.eachSeries(batches, function (batch, next) { transport.request(config.dataUrl, '/v2/resolutions', { condition: batch.join(',') }, function (error, response) {
        if (error) return next(error);
        const data = Array.isArray(response) ? response : response.data;
        if (!Array.isArray(data)) return next(new Error('Invalid resolution response'));
        const scoped = data.filter(function (row) { return batch.includes(row.condition_id); });
        // A resolved market cannot use old position inventory while its cash payout
        // is being recorded. Other markets keep trading against reserved memory funds.
        scoped.forEach(function (row) { if (row.status === 'resolved') unavailable.add(row.condition_id); });
        values.push(...scoped);
        // Only paper.settle may persist an authoritative resolved payout. Pending estimates cannot overwrite it.
        async.eachSeries(scoped, function (row, saveNext) {
          if (row.status === 'resolved' || !batch.includes(row.condition_id)) return saveNext();
          db.query("INSERT INTO paper_markets(id,resolution) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET resolution=CASE WHEN paper_markets.resolution->>'status'='resolved' THEN paper_markets.resolution ELSE EXCLUDED.resolution END,\"updatedAt\"=NOW()", [row.condition_id, JSON.stringify(row)], function (failure) { saveNext(failure); });
        }, next);
      }); }, function (error) { callback(error, values); });
    });
  }
  function saveSchedule(row, callback, scope) {
    const event = (row.events || [])[0] || {};
    rememberEvent(row);
    const tags = [...(row.tags || []), ...(event.tags || [])];
    const uniqueTags = [...new Map(tags.map(function (tag) { return [tag.id || tag.slug || tag.label, tag]; })).values()];
    const gamma = { id: row.id, question: row.question || null, conditionId: row.conditionId, endDate: row.endDate || null, slug: row.slug || null,
      eventSlug: event.slug || null, eventTitle: event.title || null, gameStartTime: row.gameStartTime || null, active: row.active, closed: row.closed, acceptingOrders: row.acceptingOrders, policyObservedAt: new Date().toISOString(),
      eventClosed: event.closed === true && require('./match-ratio-service').eventKey(event.slug) === event.slug?.trim().toLowerCase(), category: row.category || event.category || null, sportsMarketType: row.sportsMarketType || null,
      tags: uniqueTags.map(function (tag) { return { id: tag.id, slug: tag.slug, label: tag.label }; }) };
    (scope || db).query('INSERT INTO paper_markets(id,raw) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET raw=COALESCE(paper_markets.raw,\'{}\'::jsonb)||EXCLUDED.raw,"updatedAt"=NOW()', [row.conditionId, JSON.stringify({ gamma })], function (err) { callback(err); });
  }
  function identifyEvent(signal, callback) {
    if (eventSlugs.has(signal.condition)) return callback(null, eventSlugs.get(signal.condition));
    transport.request(config.gammaUrl, '/markets', { condition_ids: signal.condition, include_tag: true }, function (err, response) {
      if (err) return callback(err);
      const row = Array.isArray(response) && response.find(function (value) { return value.conditionId === signal.condition; });
      const event = row && (row.events || [])[0];
      if (!event || !event.slug) return callback(new Error('Market event identity missing'));
      rememberEvent(row); callback(null, event.slug);
      setImmediate(function () { saveSchedule(row, function (error) { if (error) health.error = error.message; }); });
    });
  }
  function schedules(callback) {
    db.query("SELECT DISTINCT condition FROM paper_orders WHERE side='BUY' AND status IN ('FILLED','PARTIAL')", [], function (err, rows) {
      if (err) return callback(err);
      const batches = [];
      for (let i = 0; i < rows.length; i += 20) batches.push(rows.slice(i, i + 20).map(function (row) { return row.condition; }));
      async.eachLimit(batches, 2, function (batch, next) {
        const query = new URLSearchParams();
        batch.forEach(function (id) { query.append('condition_ids', id); });
        transport.request(config.gammaUrl, '/markets?' + query.toString(), { limit: batch.length, include_tag: true }, function (error, data) {
          if (error) return next(error);
          if (!Array.isArray(data)) return next(new Error('Invalid market schedule response'));
          async.eachSeries(data.filter(function (row) { return batch.includes(row.conditionId); }), saveSchedule, next);
        });
      }, callback);
    });
  }
  return { policyMarket, warmPolicy, ensurePolicy, warmLeader, loadPolicies, identifyEvent, prepare, warm, latestQuote, isFreshQuote: function (quote) { return usableBook(quote && quote.book); }, refreshParameters, consume, mark, resolutions, schedules, saveSchedule, isExecutable, health, onResolved: function (listener) { resolutionListener = listener; }, start: connect, stop: function () { stopped = true; health.connected = false; policyQueue.kill(); const waiting = [...policyPending.values()]; policyPending.clear(); waiting.flat().forEach(function (callback) { callback(new Error('Market service stopped')); }); clearInterval(ping); clearInterval(cacheTimer); dirtyBooks.clear(); clearTimeout(reconnect); if (socket) socket.terminate(); } };
}
module.exports = { create };
