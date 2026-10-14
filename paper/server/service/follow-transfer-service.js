const async = require('async');
const { D, str } = require('./accounting-service');
const crypto=require('node:crypto');
function invalid(message, status) { return Object.assign(new Error(message), { status: status || 400 }); }
function walletAddress(value) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value.trim())) throw invalid('请输入有效的独立账户钱包地址');
  return value.trim().toLowerCase();
}
function validate(value) {
  value = value || {};
  if (!['in', 'out'].includes(value.direction)) throw invalid('划转方向必须为 in（转入）或 out（转出）');
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.requestId)) throw invalid('requestId必填，需8至128位字母、数字、下划线或短横线');
  if(value.taskVersion!==undefined&&(typeof value.taskVersion!=='string'||!/^(initial|\d{1,10})$/.test(value.taskVersion)))throw invalid('taskVersion无效，请从任务列表读取当前版本');
  let amount;
  try { if (!['string', 'number'].includes(typeof value.amount) || String(value.amount).trim() === '') throw new Error(); amount = D(value.amount); }
  catch (_) { throw invalid('划转金额必须是有效的正数'); }
  if (!amount.isFinite() || amount.lte(0) || amount.gte('100000000000000000000') || amount.decimalPlaces() > 18) throw invalid('划转金额必须大于0、少于10的20次方，最多18位小数');
  return { direction: value.direction, amount: str(amount), id: value.requestId,taskVersion:value.taskVersion };
}
function pageNumber(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw invalid('无效的分页参数');
  return Number(value);
}
function create(db) {
  function transfer(value, body, callback) {
    let wallet, input;
    try { wallet = walletAddress(value); input = validate(body); } catch (err) { return callback(err); }
    db.transaction(function (tx, done) {
      let account, task, publicCash, journal;
      async.waterfall([
        function (next) { tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
        function (rows, next) { if (!rows[0]) return next(invalid('虚拟钱包尚未初始化', 409)); account = rows[0];tx.one('Setting',{where:{id:'retired-transfer:'+crypto.createHash('sha256').update(input.id).digest('hex')}},next); },
        function(marker,next){if(marker)return next(invalid('这笔划转属于已删除的任务，请刷新后创建新的划转请求',409));tx.one('FollowFundTransfer', { where: { id: input.id } }, next);},
        function (existing, next) {
          if (existing) {
            if (existing.wallet !== wallet || existing.direction !== input.direction || !D(existing.amount).eq(input.amount)) return next(invalid('requestId已用于另一笔划转，请使用新的请求ID', 409));
            return done(null, { duplicate: true, transfer: existing });
          }
          tx.one('FollowTask', { where: { id: wallet } }, next);
        },
        function (row, next) {
          if (!row) return next(invalid('跟单任务不存在', 404));
          if (row.fundingMode !== 'dedicated') return next(invalid('只有独立跟单账户支持手动划转', 409));
          task = row;tx.one('Setting',{where:{id:'task-deletion:'+wallet}},next);
        },
        function(marker,next){const version=marker?String(marker.value.generation):'initial';if(input.taskVersion!==undefined&&input.taskVersion!==version||marker&&input.taskVersion===undefined)return next(invalid('任务已删除并重建，请刷新后创建新的划转请求',409));tx.query(`SELECT COALESCE(SUM(cash),0)::text cash FROM paper_follow_tasks WHERE "fundingMode"='dedicated'`, [], next);},
        function (rows, next) {
          publicCash = D(account.cash).minus(rows[0].cash);
          if (publicCash.lt(0)) return next(invalid('独立现金与总钱包余额不一致，请先核对账本', 409));
          const available = input.direction === 'in' ? publicCash : D(task.cash);
          if (D(input.amount).gt(available)) return next(invalid((input.direction === 'in' ? '公共钱包可用现金为 ' : '独立账户可转出闲置现金为 ') + str(available) + '，不足以划转 ' + input.amount, 409));
          const delta = input.direction === 'in' ? D(input.amount) : D(input.amount).negated();
          const cashAfter = D(task.cash).plus(delta), principalAfter = D(task.fundedCapital).plus(delta).clamp(0, Infinity);
          if (cashAfter.gte('100000000000000000000') || principalAfter.gte('100000000000000000000')) return next(invalid('划转后的金额超过账户存储上限'));
          journal = { id: input.id, wallet, direction: input.direction, amount: input.amount, cashBefore: str(task.cash), cashAfter: str(cashAfter), publicCashBefore: str(publicCash), publicCashAfter: str(publicCash.minus(delta)) };
          task.cash = journal.cashAfter; task.fundedCapital = str(principalAfter);
          tx.query('SELECT clock_timestamp() AS at', [], next);
        },
        function (rows, next) { journal.createdAt = rows[0].at; tx.save('FollowTask', task, function (err) { next(err); }); },
        function (next) { tx.insert('FollowFundTransfer', journal, function (err) { next(err); }); }
      ], function (err) { done(err, err ? undefined : { duplicate: false, transfer: journal }); });
    }, callback);
  }
  function list(value, filters, callback) {
    let wallet, limit, offset;
    try { wallet = walletAddress(value); filters = filters || {}; limit = pageNumber(filters.limit, 20, 100); offset = pageNumber(filters.offset, 0, 1000000); if (limit < 1) throw invalid('每页至少1条'); }
    catch (err) { return callback(err); }
    db.query(`WITH page AS (SELECT id,wallet,direction,amount::text,"cashBefore"::text,"cashAfter"::text,"publicCashBefore"::text,"publicCashAfter"::text,"createdAt"
      FROM paper_follow_fund_transfers WHERE wallet=$1 ORDER BY "createdAt" DESC,id DESC LIMIT $2 OFFSET $3)
      SELECT json_build_object('data',COALESCE((SELECT json_agg(row_to_json(p) ORDER BY p."createdAt" DESC,p.id DESC) FROM page p),'[]'::json),
        'total',(SELECT COUNT(*)::int FROM paper_follow_fund_transfers WHERE wallet=$1),'limit',$2::int,'offset',$3::int) result`, [wallet, limit, offset], function (err, rows) { callback(err, rows && rows[0] && rows[0].result); });
  }
  return { transfer, list };
}
module.exports = { create, validate };
