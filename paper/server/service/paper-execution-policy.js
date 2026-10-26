const { D, str } = require('./accounting-service');
// CLOB share minimums are distinct from Gamma's USDC-labelled orderMinSize.
const ticks = { '0.1': 3, '0.01': 4, '0.005': 5, '0.0025': 6, '0.001': 5, '0.0001': 6 };
const gameTypes = new Set(['moneyline','child_moneyline','spreads','spread','totals','total','both_teams_to_score','both_teams_to_score_first_half','both_teams_to_score_second_half','soccer_exact_score','correct_score','soccer_halftime_result','soccer_second_half_result','double_chance','soccer_team_to_advance','total_goals','total_corners','first_half_moneyline','second_half_moneyline','first_half_totals','second_half_totals','team_totals','tennis_exact_score','tennis_set_winner','tennis_first_set_winner','tennis_match_totals']);
const reasons = new Set(['SPORTS_METADATA_MISSING','SPORTS_TIME_UNKNOWN','NOT_SINGLE_SPORTS_GAME','SPORTS_TOO_FAR','SPORTS_MARKET_CLOSED','BELOW_MIN_BUY_AMOUNT','BELOW_MIN_ORDER_SHARES','ORDER_CONSTRAINTS_UNAVAILABLE','INVALID_MARKET_TICK','TASK_BUDGET_LIMIT','ORDER_LIMIT_EXCEEDED']);
function eligibility(signal, task, market, now) {
  if (signal.side !== 'BUY' || !task?.shortSportsHours) return '';
  if (!market) return 'SPORTS_METADATA_MISSING';
  if (market.closed !== false || market.acceptingOrders !== true || market.active !== true) return 'SPORTS_MARKET_CLOSED';
  const title = [market.question, market.eventTitle].filter(Boolean).join(' ');
  if (!gameTypes.has(market.sportsMarketType) || /\b(season winner|league winner|win the (?:championship|league|cup|tournament)|outright|(?:be|become) (?:the )?champion)\b/i.test(title)) return 'NOT_SINGLE_SPORTS_GAME';
  const start = market.gameStartTime && Date.parse(market.gameStartTime);
  if (!Number.isFinite(start)) return 'SPORTS_TIME_UNKNOWN';
  return start - now > Number(task.shortSportsHours) * 3600000 ? 'SPORTS_TOO_FAR' : '';
}
function input(amount) { return D(amount).toDecimalPlaces(2, D(0).constructor.ROUND_DOWN); }
function requestReason(signal, book, metadata, amount) {
  if (signal.side === 'BUY' && amount.lt(1)) return 'BELOW_MIN_BUY_AMOUNT';
  let tick, minimum;
  try { tick = D(metadata.tick); minimum = D(book.minSize ?? metadata.minSize); } catch (_) { return 'ORDER_CONSTRAINTS_UNAVAILABLE'; }
  const decimals = ticks[str(tick)];
  if (!decimals || !minimum.isFinite() || minimum.lte(0)) return 'ORDER_CONSTRAINTS_UNAVAILABLE';
  const levels = (signal.side === 'BUY' ? book.asks : book.bids).filter(level => D(level.size).gt(0) && D(level.price).gt(0) && D(level.price).lt(1)).slice().sort((a,b) => signal.side === 'BUY' ? D(a.price).cmp(b.price) : D(b.price).cmp(a.price));
  if (!levels.length) return 'NO_EXECUTABLE_DEPTH';
  let remaining = amount, worst;
  for (const level of levels) {
    const price = D(level.price);
    if (price.lt(tick) || price.gt(D(1).minus(tick)) || !price.mod(tick).isZero()) return 'INVALID_MARKET_TICK';
    worst = price;
    remaining = remaining.minus(signal.side === 'BUY' ? price.mul(level.size) : level.size);
    if (remaining.lte(0)) break;
  }
  const submittedShares = signal.side === 'BUY' ? amount.div(worst).toDecimalPlaces(decimals, D(0).constructor.ROUND_DOWN) : amount;
  return submittedShares.lt(minimum) ? 'BELOW_MIN_ORDER_SHARES' : '';
}
module.exports = { eligibility, input, requestReason, reasons };
