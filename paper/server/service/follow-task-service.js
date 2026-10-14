const async = require('async');
const { D, str } = require('./accounting-service');
const config = require('../../config').paper;

function invalid(message, status) { return Object.assign(new Error(message), { status: status || 400 }); }
function publicWallet(value) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value.trim())) throw invalid('请输入有效的公开钱包地址');
  return value.trim().toLowerCase();
}
function money(value, label, zero) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw invalid(label + '必填');
  let amount;
  try { amount = D(value); } catch (_) { throw invalid(label + '必须是有效金额'); }
  if (!amount.isFinite() || (zero ? amount.lt(0) : amount.lte(0)) || amount.gte('100000000000000000000') || amount.decimalPlaces() > 18) throw invalid(label + '必须是有效的' + (zero ? '非负' : '正') + '数，最多18位小数');
  return str(amount);
}
function validate(value) {
  value = value || {};
  if(value.operation!==undefined&&!['create','update'].includes(value.operation))throw invalid('无效的任务保存操作');
  const wallet = publicWallet(value.wallet);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 200) throw invalid('名称必填，最多200个字符');
  if (value.fundingMode !== undefined && !['shared', 'dedicated'].includes(value.fundingMode)) throw invalid('资金模式必须为 shared 或 dedicated');
  return { wallet, name: value.name.trim(), fundingMode: value.fundingMode, allocation: money(value.allocation, '个人投入额度', true), copyPercent: money(value.copyPercent, '跟单比例', false), maxOrderAmount: value.maxOrderAmount === null || value.maxOrderAmount === undefined || typeof value.maxOrderAmount === 'string' && !value.maxOrderAmount.trim() ? null : money(value.maxOrderAmount, '单笔含费上限', false) };
}

const legacySql = `/* follow-task-legacy */
  WITH wallets AS (SELECT id FROM paper_leaders UNION SELECT wallet FROM paper_positions UNION SELECT wallet FROM paper_orders),
  positions AS (SELECT wallet,SUM(CASE WHEN quantity>0 THEN cost ELSE 0 END) AS cost,SUM(realized) AS realized FROM paper_positions GROUP BY wallet),
  fees AS (SELECT wallet,SUM(fee) AS fees FROM paper_orders GROUP BY wallet)
  SELECT w.id,l.name,l.rank,l.pnl,l.active,l."joinedAt",l.inventory,l."inventoryValid",l.raw,
    COALESCE(p.cost,0)::text AS "positionCost",COALESCE(p.realized,0)::text AS realized,COALESCE(f.fees,0)::text AS fees
  FROM wallets w LEFT JOIN paper_leaders l ON l.id=w.id LEFT JOIN positions p ON p.wallet=w.id LEFT JOIN fees f ON f.wallet=w.id ORDER BY w.id`;

const listSql = `WITH totals AS (SELECT COALESCE(SUM(cash),0) cash,COALESCE(SUM("fundedCapital"),0) allocation FROM paper_follow_tasks WHERE "fundingMode"='dedicated'),
  positions AS (SELECT wallet,SUM(cost) cost,COUNT(*)::int count FROM paper_positions WHERE quantity>0 GROUP BY wallet),
  buys AS (SELECT wallet,COUNT(*)::int count FROM paper_orders WHERE side='BUY' AND gross>0 GROUP BY wallet),
  transfers AS (SELECT wallet,COALESCE(SUM(amount) FILTER(WHERE direction='in'),0) incoming,COALESCE(SUM(amount) FILTER(WHERE direction='out'),0) outgoing FROM paper_follow_fund_transfers GROUP BY wallet)
  SELECT json_build_object('wallet',json_build_object('initialCash',a."initialCash"::text,'cash',a.cash::text,'totalProfit',a.realized::text,
    'allocatedCapital',x.allocation::text,'dedicatedCash',x.cash::text,'unallocatedCash',(a.cash-x.cash)::text),
    'defaults',json_build_object('allocation',a."initialCash"::text,'fundingMode','shared','copyPercent','100','maxOrderAmount',NULL),
    'creationVersions',COALESCE((SELECT json_object_agg(SUBSTRING(id FROM 15),value->>'generation') FROM paper_settings WHERE id LIKE 'task-deletion:%'),'{}'::json),
    'data',COALESCE((SELECT json_agg(json_build_object('id',t.id,'wallet',t.id,'name',COALESCE(l.name,t.id),'state',t.state,
      'allocation',t.allocation::text,'fundingMode',t."fundingMode",'fundedCapital',t."fundedCapital"::text,'cash',t.cash::text,
      'availableCash',(CASE WHEN t."fundingMode"='shared' THEN LEAST(GREATEST(a.cash-x.cash,0),GREATEST(t.allocation-COALESCE(p.cost,0),0)) ELSE LEAST(t.cash,GREATEST(t.allocation-COALESCE(p.cost,0),0)) END)::text,
      'unusedCash',(CASE WHEN t."fundingMode"='dedicated' THEN GREATEST(t.cash-GREATEST(t.allocation-COALESCE(p.cost,0),0),0) ELSE 0 END)::text,
      'realized',t.realized::text,'fees',t.fees::text,'totalProfit',t.realized::text,
      'accountFunds',CASE WHEN t."fundingMode"='dedicated' THEN (t.cash+COALESCE(p.cost,0))::text ELSE NULL END,
      'recordedTransferredIn',CASE WHEN f.wallet IS NULL AND t."fundedCapital">0 THEN NULL ELSE COALESCE(f.incoming,0)::text END,
      'recordedTransferredOut',CASE WHEN f.wallet IS NULL AND t."fundedCapital">0 THEN NULL ELSE COALESCE(f.outgoing,0)::text END,
      'copyPercent',t."copyPercent"::text,'maxOrderAmount',t."maxOrderAmount"::text,'generation',t.generation,'startedAt',t."startedAt",
      'taskVersion',COALESCE((SELECT value->>'generation' FROM paper_settings WHERE id='task-deletion:'||t.id),'initial'),
      'positionCost',COALESCE(p.cost,0)::text,'pendingBets',COALESCE(p.count,0),'buyCount',COALESCE(b.count,0),'createdAt',t."createdAt",'updatedAt',t."updatedAt") ORDER BY t."createdAt",t.id)
      FROM paper_follow_tasks t LEFT JOIN paper_leaders l ON l.id=t.id LEFT JOIN positions p ON p.wallet=t.id LEFT JOIN buys b ON b.wallet=t.id LEFT JOIN transfers f ON f.wallet=t.id),'[]'::json)) result
  FROM paper_accounts a CROSS JOIN totals x WHERE a.id=$1`;

function create(db) {
  function lock(tx, callback) {
    tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err, rows) { if (err) return callback(err); if (!rows[0]) return callback(invalid('虚拟钱包尚未初始化', 409)); callback(null, rows[0]); });
  }
  function initialize(callback) {
    db.transaction(function (tx, done) {
      let account, seeded = [];
      async.waterfall([
        function (next) { lock(tx, next); },
        function (row, next) { account = row; tx.one('Setting', { where: { id: 'follow-tasks-initialized' } }, next); },
        function (marker, next) { if (marker) return done(null, { initialized: false }); tx.find('FollowTask', {}, next); },
        function (tasks, next) { if (tasks.length) return next(invalid('历史任务初始化标记缺失，请人工核对，原账本已保留', 409)); tx.query(legacySql, [], next); },
        function (leaders, next) {
          let percent;
          try {
            percent = money(config.copySizing === 'fixed_ratio' ? str(D(config.copyRatio).mul(100)) : '100', '原跟单比例', false);
            seeded = leaders.map(function (row) { return { leader: row, task: { id: row.id, state: row.active ? 'running' : 'paused', allocation: str(account.initialCash), fundingMode: 'shared', fundedCapital: '0', cash: '0', realized: str(row.realized), fees: str(row.fees), copyPercent: percent, maxOrderAmount: null, generation: 0, startedAt: row.joinedAt || new Date() } }; });
            if (seeded.length === 1) Object.assign(seeded[0].task, { realized: str(account.realized), fees: str(account.fees) });
            if (seeded.length > 1) {
              let realized = D(0), fees = D(0);
              seeded.forEach(function (item) { realized = realized.plus(item.task.realized); fees = fees.plus(item.task.fees); });
              if (!realized.eq(account.realized) || !fees.eq(account.fees)) throw invalid('历史盈亏或手续费无法无损恢复，需人工核对；原账本已保留', 409);
            }
          } catch (err) { return next(err); }
          async.eachSeries(seeded, function (item, saved) {
            const row = item.leader;
            const leader = { id: row.id, name: row.name || row.id, rank: row.rank || 0, pnl: row.pnl || '0', active: !!row.active, joinedAt: item.task.startedAt, inventory: row.inventory || {}, inventoryValid: !!row.inventoryValid, raw: { ...(row.raw || {}), followGeneration: 0, followFundingMode: 'shared' } };
            async.waterfall([function (save) { tx.save('FollowTask', item.task, function (err) { save(err); }); }, function (save) { tx.save('Leader', leader, function (err) { save(err); }); }], saved);
          }, next);
        },
        function (next) { tx.save('Setting', { id: 'follow-tasks-initialized', value: { version: 1, count: seeded.length } }, function (err) { next(err); }); }
      ], function (err) { done(err, { initialized: true, count: seeded.length }); });
    }, callback);
  }
  function list(callback) {
    db.query(listSql, ['paper'], function (err, rows) { if (err) return callback(err); if (!rows[0]) return callback(invalid('虚拟钱包尚未初始化', 409)); callback(null, rows[0].result); });
  }
  function cancelBuys(tx, wallet, callback) {
    async.waterfall([
      function (next) { tx.query(`UPDATE paper_outbox SET status='done',error='TASK_CONTROL_CANCELLED',"updatedAt"=clock_timestamp() WHERE status='pending' AND payload->>'wallet'=$1 AND payload->>'side'='BUY'`, [wallet], function (err) { next(err); }); },
      function (next) { tx.query(`UPDATE paper_orders SET status='SKIPPED',reason='TASK_CONTROL_CANCELLED',details=COALESCE(details,'{}'::jsonb)||'{"completed":true}'::jsonb,"updatedAt"=clock_timestamp() WHERE wallet=$1 AND side='BUY' AND status='WAITING'`, [wallet], function (err) { next(err); }); }
    ], callback);
  }
  function boundary(task, leader, at) {
    task.startedAt = at; leader.joinedAt = at; leader.inventory = {}; leader.inventoryValid = false;
    delete leader.raw.inventoryTimestamp; delete leader.raw.inventoryRevision; delete leader.raw.lastTradeObservedAt;
  }
  function retireSourceWaits(tx, wallet, callback) {
    async.waterfall([
      function (next) { tx.query("UPDATE paper_outbox SET status='done',error='TASK_CONTROL_CANCELLED',\"updatedAt\"=clock_timestamp() WHERE status='pending' AND payload->>'wallet'=$1 AND kind IN ('source-confirmation','source-reconcile')", [wallet], function (err) { next(err); }); },
      function (next) { tx.query("UPDATE paper_source_trades SET raw=raw||'{\"wsPending\":false,\"wsPendingInventory\":false,\"wsSellPending\":false}'::jsonb WHERE wallet=$1", [wallet], function (err) { next(err); }); }
    ], callback);
  }
  function save(value, callback) {
    let input;
    try { input = validate(value); } catch (err) { return callback(err); }
    db.transaction(function (tx, done) {
      let account, task, leader, reserved, modeChanged = false, available, positionCost, newGeneration=0,taskVersion='initial';
      async.waterfall([
        function (next) { lock(tx, next); },
        function (row, next) { account = row; tx.one('FollowTask', { where: { id: input.wallet } }, next); },
        function (row, next) { if(value.operation==='create'&&row)return next(invalid(row.state==='running'?'该地址已有跟单任务且正在跟单，不能重复新建。请修改现有任务。':'该地址已有跟单任务，请修改现有任务或点击“开始跟单”。',409));if(value.operation==='update'&&!row)return next(invalid('任务已不存在，请刷新后重新新建',404));task = row; tx.one('Setting',{where:{id:'task-deletion:'+input.wallet}},function(err,marker){if(err)return next(err);taskVersion=marker?String(marker.value.generation):'initial';newGeneration=marker?Number(marker.value.generation)+1:0;if(!Number.isSafeInteger(newGeneration)||newGeneration>2147483647)return next(invalid('任务代次已达到上限，请联系维护人员',409));tx.one('Leader',{where:{id:input.wallet}},next);}); },
        function (row, next) { leader = row; tx.query(`SELECT COALESCE(SUM(cash),0)::text cash FROM paper_follow_tasks WHERE "fundingMode"='dedicated'`, [], next); },
        function (rows, next) {
          reserved = D(rows[0].cash); available = D(account.cash).minus(reserved);
          tx.query('SELECT COUNT(*)::int count,COALESCE(SUM(cost),0)::text cost FROM paper_positions WHERE wallet=$1 AND quantity>0', [input.wallet], next);
        },
        function (rows, next) {
          const oldMode = task && task.fundingMode || 'shared', mode = input.fundingMode || oldMode;
          positionCost = D(rows[0].cost);
          modeChanged = !!task && mode !== oldMode;
          if ((modeChanged || !task && mode === 'dedicated') && rows[0].count > 0) return next(invalid('存在未结算持仓，暂不能切换资金模式；仍可调整个人投入额度', 409));
          const oldCash = oldMode === 'dedicated' && task ? D(task.cash) : D(0);
          if (modeChanged && oldMode === 'dedicated' && oldCash.gt(0)) return next(invalid('独立账户仍有闲置现金，请先手动转出，再切换资金模式', 409));
          const cash = mode === 'dedicated' && oldMode === 'dedicated' ? oldCash : D(0);
          const funded = mode === 'dedicated' && oldMode === 'dedicated' && task ? D(task.fundedCapital) : D(0);
          available = D(account.cash).minus(reserved.minus(oldCash).plus(cash));
          task = { ...(task || { id: input.wallet, state: 'paused', realized: '0', fees: '0', generation: newGeneration, startedAt: new Date() }), allocation: input.allocation, fundingMode: mode, fundedCapital: str(funded), cash: str(cash), copyPercent: input.copyPercent, maxOrderAmount: input.maxOrderAmount };
          if (modeChanged) task.generation += 1;
          leader = { ...(leader || { id: input.wallet, rank: 0, pnl: '0', joinedAt: new Date(), inventory: {}, inventoryValid: false, raw: {} }), name: input.name, active: task.state === 'running', raw: { ...(leader && leader.raw || {}), followGeneration: task.generation, followFundingMode: task.fundingMode } };
          if (modeChanged) return tx.query('SELECT clock_timestamp() AS at', [], next);
          next(null, null);
        },
        function (rows, next) {
          if (modeChanged) boundary(task, leader, rows[0].at);
          tx.save('FollowTask', task, function (err, row) { if (!err) task = row; next(err); });
        },
        function (next) { tx.save('Leader', leader, function (err) { next(err); }); },
        function (next) { if (modeChanged) return cancelBuys(tx, input.wallet, function (err) { if (err) return next(err); retireSourceWaits(tx, input.wallet, next); }); next(); }
      ], function (err) { if (err) return done(err); const canBuy = task.fundingMode === 'shared' ? available.clamp(0, D(task.allocation).minus(positionCost).clamp(0, Infinity)) : D(task.cash).clamp(0,D(task.allocation).minus(positionCost).clamp(0,Infinity)); done(null, { ...task, taskVersion, wallet: task.id, name: input.name, availableCash: str(canBuy), unusedCash: task.fundingMode === 'dedicated' ? str(D(task.cash).minus(canBuy).clamp(0, Infinity)) : '0' }); });
    }, callback);
  }
  function control(value, options, callback) {
    let wallet, action;
    try { wallet = publicWallet(value); action = options && options.action; if (!['start', 'pause', 'stop'].includes(action)) throw invalid('任务操作必须为 start、pause 或 stop'); } catch (err) { return callback(err); }
    db.transaction(function (tx, done) {
      let task, leader;
      async.waterfall([
        function (next) { lock(tx, function (err) { next(err); }); },
        function (next) { tx.one('FollowTask', { where: { id: wallet } }, next); },
        function (row, next) { if (!row) return next(invalid('跟单任务不存在', 404));if(action==='start'&&row.state==='running')return next(invalid('该地址已有正在跟单的任务，请勿重复开始。',409)); task = row; tx.one('Leader', { where: { id: wallet } }, next); },
        function (row, next) { if (!row) return next(invalid('任务人员记录缺失，请人工核对', 409)); leader = row; tx.query('SELECT clock_timestamp() AS at', [], next); },
        function (rows, next) {
          task.state = { start: 'running', pause: 'paused', stop: 'stopped' }[action]; task.generation += 1;
          leader.active = action === 'start'; leader.raw = { ...(leader.raw || {}), followGeneration: task.generation, followFundingMode: task.fundingMode || 'shared' };
          if (action === 'start') boundary(task, leader, rows[0].at);
          tx.save('FollowTask', task, function (err) { next(err); });
        },
        function (next) { tx.save('Leader', leader, function (err) { next(err); }); },
        function (next) { cancelBuys(tx, wallet, next); },
        function (next) { if (action === 'start') return retireSourceWaits(tx, wallet, next); next(); }
      ], function (err) { done(err, task && { ...task, wallet, name: leader && leader.name }); });
    }, callback);
  }
  return { initialize, list, save, control };
}
module.exports = { create, validate };
