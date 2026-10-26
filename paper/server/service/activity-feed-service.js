// Shared identity cache for both subscriptions and overlapping connections.
function create(options) {
  options = options || {};
  const seen = new Map(), now = options.now || Date.now, ttlMs = options.ttlMs || 600000, maxEntries = options.maxEntries || 50000;
  function claim(id) {
    const time = now();
    for (const [key, expires] of seen) { if (expires > time) break; seen.delete(key); }
    if (seen.has(id)) return false;
    while (seen.size >= maxEntries) seen.delete(seen.keys().next().value);
    seen.set(id, time + ttlMs); return true;
  }
  function telemetry(message, trade, receipt, rawReceivedAtMs, connectionId, eventLoop) {
    const publishedAtMs = typeof message.timestamp === 'number' && Number.isSafeInteger(message.timestamp) && message.timestamp > 0 ? message.timestamp : null;
    const received = Date.parse(receipt.receivedAt), source = Number(trade.timestamp) * 1000;
    return { type: message.type, connectionId, publishedAtMs, rawReceivedAtMs, receivedAt: receipt.receivedAt,
      sourceToPublishMs: publishedAtMs && Number.isFinite(source) ? publishedAtMs - source : null,
      transitMs: publishedAtMs && Number.isFinite(received) ? received - publishedAtMs : null, eventLoop };
  }
  return { claim, telemetry, size: function () { return seen.size; } };
}
module.exports = { create };
