const { D, str } = require('./accounting-service');

function normalize(payload) {
  const x = payload || {};
  const row = { proxy_wallet: String(x.proxyWallet || x.proxy_wallet || '').toLowerCase(), transaction_hash: String(x.transactionHash || x.transaction_hash || '').toLowerCase(), token_id: String(x.asset || x.token_id || ''), condition_id: String(x.conditionId || x.condition_id || '').toLowerCase(), side: x.side, timestamp: Number(x.timestamp), price: x.price, size: x.size, outcome_index: Number(x.outcomeIndex === undefined ? x.outcome_index : x.outcomeIndex), title: x.title || '', outcome: x.outcome || '', event_slug: x.eventSlug || x.event_slug || '', slug: x.slug || '' };
  if (!/^0x[a-f0-9]{40}$/.test(row.proxy_wallet) || !/^0x[a-f0-9]{64}$/.test(row.transaction_hash) || !/^\d+$/.test(row.token_id) || !/^0x[a-f0-9]{64}$/.test(row.condition_id) || !['BUY', 'SELL'].includes(row.side) || !Number.isSafeInteger(row.timestamp) || row.timestamp <= 0) return null;
  try {
    if (row.price === undefined || row.size === undefined || !D(row.price).isFinite() || !D(row.size).isFinite() || D(row.price).lte(0) || D(row.price).gte(1) || D(row.size).lte(0)) return null;
    row.price = str(row.price); row.size = str(row.size);
    if (D(row.price).lte(0) || D(row.price).gte(1) || D(row.size).lte(0)) return null;
  } catch (_) { return null; }
  return row;
}
function maximum() {
  const result = {};
  Array.from(arguments).forEach(function (values) { Object.entries(values || {}).forEach(function ([price, size]) { result[price] = str(D(result[price] || 0).gte(size) ? result[price] || 0 : size); }); });
  return result;
}
function reconcile(group, stored) {
  const prior = stored && stored.raw || {}, websocket = group.origin === 'websocket';
  const ws = websocket ? maximum(prior.wsQuantities, group.quantities) : prior.wsQuantities;
  const rest = websocket ? prior.restQuantities || (stored && !prior.wsQuantities ? stored.processed : {}) : group.quantities;
  const quantities = ws ? maximum(stored && stored.processed, ws, rest) : group.quantities;
  const pending = !!ws && Object.entries(ws).some(function ([price, size]) { return D(rest && rest[price] || 0).lt(size); });
  const inventoryBefore = prior.inventoryProcessed || (stored && !prior.wsQuantities ? stored.processed : {}) || {};
  return { quantities, raw: { ...prior, trades: websocket && prior.trades && prior.trades.length ? prior.trades : group.raw, ...(ws ? { wsQuantities: ws, restQuantities: rest || {}, wsPending: pending, wsPendingInventory: pending, inventoryProcessed: websocket ? inventoryBefore : maximum(inventoryBefore, rest) } : prior.wsSellPending ? { wsPending: false } : {}) }, inventoryBefore };
}
module.exports = { normalize, maximum, reconcile };
