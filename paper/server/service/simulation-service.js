const { D, str } = require('./accounting-service');

function saleQuantity(own, sold, before) {
  if (D(before).lte(0)) throw new Error('Leader inventory unavailable');
  return str(D(own).mul(D(sold).div(before).clamp(0, 1)));
}
function buyAmount(signal, config) {
  const source = D(signal.sourceAmount === undefined ? D(signal.size).mul(signal.price) : signal.sourceAmount);
  if (config.copySizing !== 'fixed_ratio') return source;
  const ratio = D(config.copyRatio);
  if (!ratio.isFinite() || ratio.lte(0)) throw new Error('Invalid copyRatio');
  return source.mul(ratio);
}
function execute(signal, book, metadata, config, target) {
  if (!metadata || metadata.rate === undefined || metadata.exponent === undefined || D(metadata.rate).lt(0)) throw new Error('Unknown fee parameters');
  const buy = signal.side === 'BUY';
  if (!buy && signal.side !== 'SELL') throw new Error('Unsupported side');
  const reference = D(signal.price);
  if (reference.lte(0) || reference.gte(1)) throw new Error('Invalid source price');
  let remaining = buy ? buyAmount(signal, config) : D(target || 0);
  if (!remaining.isFinite() || remaining.lte(0)) throw new Error('Invalid source amount or quantity');
  let availableCash = config.availableCash === undefined ? D(Infinity) : D(config.availableCash);
  let quantity = D(0), gross = D(0), fee = D(0);
  let cashLimited = false;
  const fills = [];
  const levels = (buy ? book.asks : book.bids).slice().sort(function (a, b) { return buy ? D(a.price).cmp(b.price) : D(b.price).cmp(a.price); });
  for (const level of levels) {
    const p = D(level.price), available = D(level.size);
    if (p.lte(0) || p.gte(1) || available.lte(0)) continue;
    const perShareFee = D(metadata.rate).mul(p.mul(D(1).minus(p)).pow(metadata.exponent));
    const wanted = buy ? available.clamp(0, remaining.div(p)) : available.clamp(0, remaining);
    const affordable = buy ? availableCash.div(p.plus(perShareFee)).clamp(0, Infinity) : wanted;
    if (buy && affordable.lt(wanted)) cashLimited = true;
    const size = buy ? wanted.clamp(0, affordable) : wanted;
    const q = D(str(size));
    if (q.lte(0)) continue;
    const f = D(str(q.mul(perShareFee))), g = q.mul(p);
    // A positive share quantity must not become a free fill when NUMERIC(38,18) stores its value.
    if (D(str(g)).isZero()) continue;
    quantity = quantity.plus(q); gross = gross.plus(g); fee = fee.plus(f);
    remaining = remaining.minus(buy ? g : q);
    if (buy) availableCash = availableCash.minus(g.plus(f)).clamp(0, Infinity);
    fills.push({ price: str(p), quantity: str(q), fee: str(f) });
    if (remaining.lte('0.000000000000000001')) break;
  }
  // Virtual allocations can be fractional; no real exchange order is submitted.
  if (quantity.isZero()) return { quantity: '0', gross: '0', fee: '0', cash: '0', fills: [], reason: cashLimited ? 'INSUFFICIENT_CASH' : 'NO_EXECUTABLE_DEPTH' };
  return { quantity: str(quantity), gross: str(gross), fee: str(fee), cash: str(buy ? gross.plus(fee) : gross.minus(fee)), fills, partial: remaining.gt('0.000001'), remaining: str(remaining) };
}
module.exports = { execute, saleQuantity, buyAmount };
