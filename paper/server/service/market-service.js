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
  const watchedSignals = new Map();
  const streamId = require('node:crypto').randomUUID();
  let connectionEpoch = 0;
  let lastAliveAt = 0;
  let socket, stopped = false, reconnect, ping, resolutionListener;
  const health = { connected: false, lastMessage: null, error: null };
  function publish(token, book) {
    books.set(token, book);
    redis.set('paper:book:' + token, JSON.stringify(book), 'EX', 120, function () {});
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
      const side = change.side === 'BUY' ? book.bids : book.asks;
      const index = side.findIndex(function (row) { return D(row.price).eq(change.price); });
      if (index >= 0) side.splice(index, 1);
      if (D(change.size).gt(0)) side.push({ price: String(change.price), size: String(change.size) });
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
      db.query("INSERT INTO paper_markets(id,raw) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET raw=EXCLUDED.raw || jsonb_build_object('gamma',COALESCE(paper_markets.raw->'gamma','{}'::jsonb)),\"updatedAt\"=NOW()", [condition, JSON.stringify(raw)], function (error) { finish(error, value); });
    });
  }
  function isExecutable(signal) { return !unavailable.has(signal.condition) && !unavailable.has(signal.token); }
  function tradingState(signal, callback, force) {
    if (!isExecutable(signal)) return callback(new Error('Market is not executable'));
    const cached = states.get(signal.token);
    if (!force && cached && Date.now() - cached.observedAt < config.bookMaxAgeMs) return callback();
    transport.request(config.gammaUrl, '/markets', { condition_ids: signal.condition, include_tag: true }, function (err, response) {
      if (err) return callback(err);
      const raw = Array.isArray(response) ? response.find(function (row) { return row.conditionId === signal.condition; }) : null;
      if (!raw) return callback(new Error('Market metadata temporarily unavailable'));
      if (raw.closed === true) return callback(new Error('Market is closed'));
      if (raw.acceptingOrders !== true || raw.active !== true || raw.closed !== false) return callback(new Error('Market is temporarily not accepting orders'));
      saveSchedule(raw, function (error) { if (!error) states.set(signal.token, { observedAt: Date.now(), condition: signal.condition }); callback(error); });
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
    const ready = signal.refreshBook === true ? null : cachedQuote(signal);
    if (ready) { signal.outcomeIndex = ready.outcomeIndex; return callback(null, ready); }
    const key = signal.condition + ':' + signal.token + ':' + (signal.refreshBook === true ? 'refresh' : 'current');
    if (preparationPending.has(key)) { preparationPending.get(key).push({ signal, callback }); return; }
    preparationPending.set(key, [{ signal, callback }]);
    prepareLookup(signal, function (err, value) {
      if (value) value.quoteSource = 'rest-preparation';
      const waiting = preparationPending.get(key); preparationPending.delete(key);
      waiting.forEach(function (entry) { if (value) entry.signal.outcomeIndex = value.outcomeIndex; entry.callback(err, value); });
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
    const levels = side === 'BUY' ? book.asks : book.bids;
    fills.forEach(function (fill) { const level = levels.find(function (item) { return D(item.price).eq(fill.price); }); if (level) level.size = str(D(level.size).minus(fill.quantity).clamp(0, Infinity)); });
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
        values.push(...data);
        // Only paper.settle may persist an authoritative resolved payout. Pending estimates cannot overwrite it.
        async.eachSeries(data, function (row, saveNext) {
          if (row.status === 'resolved' || !batch.includes(row.condition_id)) return saveNext();
          db.query("INSERT INTO paper_markets(id,resolution) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET resolution=CASE WHEN paper_markets.resolution->>'status'='resolved' THEN paper_markets.resolution ELSE EXCLUDED.resolution END,\"updatedAt\"=NOW()", [row.condition_id, JSON.stringify(row)], function (failure) { saveNext(failure); });
        }, next);
      }); }, function (error) { callback(error, values); });
    });
  }
  function saveSchedule(row, callback, scope) {
    const event = (row.events || [])[0] || {};
    const tags = [...(row.tags || []), ...(event.tags || [])];
    const uniqueTags = [...new Map(tags.map(function (tag) { return [tag.id || tag.slug || tag.label, tag]; })).values()];
    const gamma = { id: row.id, question: row.question || null, conditionId: row.conditionId, endDate: row.endDate || null, slug: row.slug || null,
      eventSlug: event.slug || null, category: row.category || event.category || null, sportsMarketType: row.sportsMarketType || null,
      tags: uniqueTags.map(function (tag) { return { id: tag.id, slug: tag.slug, label: tag.label }; }) };
    (scope || db).query('INSERT INTO paper_markets(id,raw) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET raw=COALESCE(paper_markets.raw,\'{}\'::jsonb)||EXCLUDED.raw,"updatedAt"=NOW()', [row.conditionId, JSON.stringify({ gamma })], function (err) { callback(err); });
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
  return { prepare, warm, latestQuote, isFreshQuote: function (quote) { return usableBook(quote && quote.book); }, refreshParameters, consume, mark, resolutions, schedules, saveSchedule, isExecutable, health, onResolved: function (listener) { resolutionListener = listener; }, start: connect, stop: function () { stopped = true; health.connected = false; clearInterval(ping); clearTimeout(reconnect); if (socket) socket.terminate(); } };
}
module.exports = { create };
