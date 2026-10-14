const Decimal = require('decimal.js');
Decimal.set({ precision: 50 });
const D = function (value) { return new Decimal(value || 0); };
const str = function (value) { return D(value).toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed(); };

function buy(position, fill) {
  return { quantity: str(D(position.quantity).plus(fill.quantity)), cost: str(D(position.cost).plus(fill.gross).plus(fill.fee)) };
}
function sell(position, fill) {
  const quantity = D(fill.quantity);
  if (quantity.lte(0) || quantity.gt(position.quantity)) throw new Error('Invalid sale quantity');
  const released = D(position.cost).mul(quantity).div(position.quantity);
  const profit = D(fill.gross).minus(fill.fee).minus(released);
  return { quantity: str(D(position.quantity).minus(quantity)), cost: str(D(position.cost).minus(released)), released: str(released), profit: str(profit), realized: str(D(position.realized).plus(profit)), cycleRealized: str(D(position.cycleRealized).plus(profit)) };
}
function settle(position, resolution) {
  if (resolution.status !== 'resolved') throw new Error('Resolution is not final');
  if (!Array.isArray(resolution.payouts) || resolution.payouts.length !== 2 || !Number.isInteger(position.outcomeIndex) || position.outcomeIndex < 0 || position.outcomeIndex > 1 || resolution.payouts.some(function (value) { return !['number', 'string'].includes(typeof value) || value === '' || !Number.isSafeInteger(Number(value)) || D(value).lt(0) || D(value).gt(1000000); })) throw new Error('Incomplete or invalid binary payout vector');
  const totalPayout = D(resolution.payouts[0]).plus(resolution.payouts[1]);
  if (totalPayout.lt(999999) || totalPayout.gt(1000000)) throw new Error('Invalid binary payout total');
  const payout = D(resolution.payouts[position.outcomeIndex]).div(1000000);
  if (payout.lt(0) || payout.gt(1)) throw new Error('Invalid payout');
  const revenue = D(position.quantity).mul(payout);
  return { payout: str(payout), revenue: str(revenue), cost: str(position.cost), profit: str(revenue.minus(position.cost)) };
}
module.exports = { buy, sell, settle, D, str };
