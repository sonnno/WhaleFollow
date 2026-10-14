const https = require('node:https');
const config = require('../../config').paper;
const agent = require('./network-agent');
const failures = new Map();

function request(base, route, params, callback, body) {
  const url = new URL(route, base);
  const bucket = url.origin + url.pathname;
  const paused = [failures.get(url.origin), failures.get(bucket)].find(function (value) { return value && Date.now() < value.until; });
  if (paused && Date.now() < paused.until) return callback(Object.assign(new Error('Polymarket backoff active'), { code: 'POLYMARKET_BACKOFF', retryAfterMs: paused.until - Date.now(), causeMessage: paused.message }));
  Object.entries(params || {}).forEach(function ([key, value]) { if (value !== undefined && value !== null) url.searchParams.set(key, String(value)); });
  // External write paths are forbidden. POST /books only retrieves order books.
  if (body && (url.origin !== new URL(config.clobUrl).origin || url.pathname !== '/books')) return callback(new Error('External write is disabled in paper mode'));
  let done = false;
  let timeout;
  function finish(err, value) {
    if (done) return; done = true; clearTimeout(timeout);
    if (err && (!err.statusCode || err.statusCode === 429 || err.statusCode >= 500)) {
      const failureBucket = err.statusCode === 429 ? url.origin : bucket;
      const attempt = Math.min(5, ((failures.get(failureBucket) || {}).attempt || 0) + 1);
      const delay = Math.max(err.retryAfterMs || 0, Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500));
      failures.set(failureBucket, { attempt, until: Date.now() + delay, message: err.message });
    } else if (!err) failures.delete(bucket);
    callback(err, value);
  }
  const data = body ? JSON.stringify(body) : null;
  const req = https.request(url, { agent, method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, function (res) {
    let chunks = '', length = 0;
    res.setEncoding('utf8');
    res.on('data', function (chunk) { length += chunk.length; if (length > 16 * 1024 * 1024) req.destroy(new Error('Response too large')); else chunks += chunk; });
    res.on('error', finish);
    res.on('end', function () {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const err = new Error('Polymarket HTTP ' + res.statusCode + ' ' + url.pathname);
        err.statusCode = res.statusCode;
        err.retryAfterMs = Number(res.headers['retry-after'] || 0) * 1000;
        return finish(err);
      }
      let parsed;
      try { parsed = JSON.parse(chunks); } catch (_) { return finish(new Error('Invalid JSON ' + url.pathname)); }
      finish(null, parsed);
    });
  });
  req.setTimeout(config.requestTimeoutMs, function () { req.destroy(new Error('Polymarket request timed out')); });
  timeout = setTimeout(function () { req.destroy(new Error('Polymarket connection timed out')); }, config.requestTimeoutMs);
  req.on('error', finish);
  if (data) req.write(data);
  req.end();
}
function pages(base, route, params, callback) {
  const rows = [], seen = new Set();
  function page(cursor) {
    request(base, route, { ...params, cursor }, function (err, body) {
      if (err) return callback(err);
      const data = Array.isArray(body) ? body : body.data;
      if (!Array.isArray(data)) return callback(new Error('Invalid paginated response'));
      rows.push(...data);
      const next = body.pagination && body.pagination.next_cursor;
      if (!next) return callback(null, rows);
      if (seen.has(next) || seen.size >= 1000) return callback(new Error('Invalid pagination cursor'));
      seen.add(next); page(next);
    });
  }
  page();
}
module.exports = { request, pages };
