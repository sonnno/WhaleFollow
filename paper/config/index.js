const fs = require('node:fs');
const path = require('node:path');
const Decimal = require('decimal.js');
const paper = { ...require('./paper.example.json') };
const local = path.join(__dirname, 'local.json');
if (fs.existsSync(local)) Object.assign(paper, JSON.parse(fs.readFileSync(local, 'utf8')));
if (process.env.INITIAL_CASH !== undefined) paper.initialCash = process.env.INITIAL_CASH;
// Old local settings must not silently restore the rejected strategy limits.
['slippage', 'marketCostLimit', 'signalTtlSeconds', 'latencyMs', 'buyBudget'].forEach(function (key) { delete paper[key]; });
paper.currency = 'USDT';

function validate(value) {
  if (value.mode !== 'paper') throw new Error('Only paper mode is supported');
  if (!['equal_amount', 'fixed_ratio'].includes(value.copySizing)) throw new Error('Invalid copySizing');
  if (value.copySizing === 'fixed_ratio') {
    let ratio;
    try { ratio = new Decimal(value.copyRatio); } catch (_) { throw new Error('Invalid copyRatio'); }
    if (!ratio.isFinite() || ratio.lte(0)) throw new Error('Invalid copyRatio');
  }
  if (value.followWallets !== undefined && (!Array.isArray(value.followWallets) || value.followWallets.some(function (wallet) { return !/^0x[a-f0-9]{40}$/.test(wallet); }))) throw new Error('Invalid followWallets');
  ['initialCash'].forEach(function (key) {
    const amount = new Decimal(value[key]);
    if (!amount.isFinite() || amount.lte(0) || amount.gte('100000000000000000000') || amount.decimalPlaces() > 18) throw new Error('Invalid ' + key);
  });
  ['bookMaxAgeMs', 'leaderboardSeconds', 'tradePollSeconds', 'fallbackTradePollSeconds', 'overlapSeconds', 'inventorySeconds', 'settlementSeconds', 'equitySeconds', 'requestTimeoutMs'].forEach(function (key) {
    if (!Number.isFinite(value[key]) || value[key] < 1) throw new Error('Invalid ' + key);
  });
  ['dataUrl', 'clobUrl', 'gammaUrl'].forEach(function (key) { if (!value[key].startsWith('https://')) throw new Error('HTTPS required'); });
  return value;
}
validate(paper);
module.exports = { paper, validate, db: require('./DBsettings') };
