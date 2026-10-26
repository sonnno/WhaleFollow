const async = require('async');
const { D } = require('./accounting-service');
const crypto=require('node:crypto');
function invalid(message, status) { return Object.assign(new Error(message), { status: status || 400 }); }
function cleanupQueues(wallet, ids, callback, client) {
  if (!ids.length) return callback();
  const redis = client || require('../lib/redis')();
  const wanted = new Set(ids), batches = [];
  for (let index = 0; index < ids.length; index += 500) batches.push(ids.slice(index, index + 500).map(function (id) { return 'paper:queued:' + id; }));
  async.waterfall([
    function (next) { redis.connect(function (err) { next(err); }); },
    function (next) { redis.lrange('paper:work', 0, -1, next); },
    function (queue, next) { async.eachSeries(Array.from(new Set(queue.filter(function (id) { return wanted.has(id) || id.startsWith(wallet + ':'); }))), function (id, removed) { redis.lrem('paper:work', 0, id, function (err) { removed(err); }); }, next); },
    function (next) { async.eachSeries(batches, function (keys, removed) { redis.del(keys, function (err) { removed(err); }); }, next); }
  ], function (err) { redis.disconnect(); callback(err); });
}
function create(db, options) {
  options = options || {};
  function remove(value, input, callback) {
    let wallet;
    try {
      if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value.trim())) throw invalid('请输入有效的跟单钱包地址');
      wallet = value.trim().toLowerCase();
      if (!input || input.confirm !== true) throw invalid('请确认永久删除任务及全部跟单明细');
      if (!Number.isSafeInteger(input.generation) || input.generation < 0 || input.generation > 2147483647) throw invalid('需要当前任务代次，请刷新列表后重试');
    } catch (err) { return callback(err); }
    db.transaction(function (tx, done) {
      let task, outboxIds, conditions,workerRunning=false,workerStartedAt;
      const removed = {};
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err, rows) { if (err) return next(err); if (!rows[0]) return next(invalid('虚拟钱包尚未初始化', 409)); next(); }); },
        function (next) { tx.one('FollowTask', { where: { id: wallet } }, next); },
        function (row, next) {
          if (!row) return next(invalid('任务不存在或已经删除', 404));
          task = row;
          if (task.generation !== input.generation) return next(invalid('任务状态已变化，请刷新列表后重新确认删除', 409));
          if (!['paused', 'stopped'].includes(task.state)) return next(invalid('请先点击“全部暂停”，再删除任务', 409));
          if (task.fundingMode === 'dedicated' && !D(task.cash).isZero()) return next(invalid('独立账户仍有现金，请先通过“转入 / 转出”全部转出，再删除任务', 409));
          tx.query(`/* delete-task-preflight */ SELECT
            (SELECT COUNT(*)::int FROM paper_positions WHERE wallet=$1 AND quantity>0) open,
            ((SELECT COUNT(*) FROM paper_orders o WHERE wallet=$1 AND status IN ('FILLED','PARTIAL') AND gross>0
              AND (NOT EXISTS(SELECT 1 FROM paper_cash_ledger l WHERE l.id='trade:'||o.id)
                OR o.side='SELL' AND (o.details->>'realizedProfit' IS NULL OR o.details->>'releasedCost' IS NULL)))
              +(SELECT COUNT(*) FROM paper_settlements s WHERE wallet=$1 AND NOT EXISTS(SELECT 1 FROM paper_cash_ledger l WHERE l.id='settle:'||s.id)))::int missing,
            EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND objid=178002
              AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS "workerRunning",
            (SELECT MAX(a.backend_start) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
              WHERE l.locktype='advisory' AND l.granted AND l.objid=178002 AND a.datname=current_database()) AS "workerStartedAt"`, [wallet], next);
        },
        function (rows, next) {
          if (rows[0].open) return next(invalid('还有 ' + rows[0].open + ' 个未结算持仓，请等全部结算或卖出后再删除', 409));
          if (rows[0].missing) return next(invalid('历史成交与资金流水不完整，暂不能删除，以免统计余额出错', 409));
          workerRunning=rows[0].workerRunning;workerStartedAt=rows[0].workerStartedAt;
          if(!workerRunning)return next(null,null);
          tx.one('Setting',{where:{id:'worker-health'}},next);
        },
        function(health,next){if(workerRunning&&(!health||health.value.taskDeletionVersion!==1||!health.updatedAt||new Date(health.updatedAt)<new Date(workerStartedAt)))return next(invalid('请先重启虚拟Worker并等待5秒，加载删除保护后再删除任务',409));tx.query(`SELECT id FROM paper_outbox WHERE payload->>'wallet'=$1`,[wallet],next);},
        function (rows, next) { outboxIds = rows.map(function (row) { return row.id; }); tx.query('SELECT condition FROM paper_orders WHERE wallet=$1 UNION SELECT condition FROM paper_positions WHERE wallet=$1 UNION SELECT condition FROM paper_source_trades WHERE wallet=$1 UNION SELECT condition FROM paper_settlements WHERE wallet=$1', [wallet], next); },
        function (rows, next) { conditions = rows.map(function (row) { return row.condition; }); (options.cleanup || cleanupQueues)(wallet, outboxIds, next); },
        function (next) {
          tx.query(`UPDATE paper_cash_ledger l SET id=gen_random_uuid()::text,reference='removed-task-record',
            details=jsonb_build_object('recordsDeleted',true,'gross',o.gross::text,'fee',o.fee::text,
              'realizedProfit',o.details->>'realizedProfit','releasedCost',o.details->>'releasedCost')
            FROM paper_orders o WHERE o.wallet=$1 AND l.id='trade:'||o.id`, [wallet], function (err) { next(err); });
        },
        function (next) {
          tx.query(`UPDATE paper_cash_ledger l SET id=gen_random_uuid()::text,reference='removed-task-record',
            details=jsonb_build_object('recordsDeleted',true,'profit',s.profit::text,'cost',s.cost::text)
            FROM paper_settlements s WHERE s.wallet=$1 AND l.id='settle:'||s.id`, [wallet], function (err) { next(err); });
        },
        function (next) { tx.save('Setting', { id: 'task-deletion:' + wallet, value: { generation: task.generation } }, function (err) { next(err); }); },
        function (next) { tx.query('SELECT id FROM paper_follow_fund_transfers WHERE wallet=$1',[wallet],next); },
        function(rows,next){async.eachSeries(rows,function(row,saved){const hash=crypto.createHash('sha256').update(row.id).digest('hex');tx.save('Setting',{id:'retired-transfer:'+hash,value:{retired:true}},function(err){saved(err);});},next);},
        function (next) {
          const tables = ['paper_fills', 'paper_positions', 'paper_settlements', 'paper_closed_cycles', 'paper_follow_fund_transfers', 'paper_source_trades', 'paper_orders','paper_daily_task_reports', 'paper_match_ratios', 'paper_copy_skip_stats'];
          async.eachSeries(tables, function (table, deleted) { tx.query('DELETE FROM ' + table + ' WHERE wallet=$1 RETURNING id', [wallet], function (err, rows) { if (!err) removed[table] = rows.length; deleted(err); }); }, next);
        },
        function (next) { tx.query(`DELETE FROM paper_outbox WHERE payload->>'wallet'=$1`, [wallet], function (err) { next(err); }); },
        function (next) { tx.query('DELETE FROM paper_sync_checkpoints WHERE id=$1', ['trades:' + wallet], function (err) { next(err); }); },
        function (next) { tx.query('DELETE FROM paper_settings WHERE id LIKE $1', ['quarantine:' + wallet + ':%'], function (err) { next(err); }); },
        function (next) { tx.query('DELETE FROM paper_settings WHERE id LIKE $1', ['task-onboarding:' + wallet + ':%'], function (err) { next(err); }); },
        function (next) { tx.query('UPDATE paper_equity_snapshots SET leaders=leaders-$1 WHERE leaders ? $1', [wallet], function (err) { next(err); }); },
        function (next) {
          tx.query(`DELETE FROM paper_markets m WHERE m.id=ANY($1::text[])
            AND NOT EXISTS(SELECT 1 FROM paper_orders WHERE condition=m.id)
            AND NOT EXISTS(SELECT 1 FROM paper_positions WHERE condition=m.id)
            AND NOT EXISTS(SELECT 1 FROM paper_source_trades WHERE condition=m.id)
            AND NOT EXISTS(SELECT 1 FROM paper_settlements WHERE condition=m.id)`, [conditions], function (err) { next(err); });
        },
        function (next) { tx.query('DELETE FROM paper_leaders WHERE id=$1', [wallet], function (err) { next(err); }); },
        function (next) { tx.query('DELETE FROM paper_follow_tasks WHERE id=$1', [wallet], function (err) { next(err); }); }
      ], function (err) { done(err, err ? undefined : { deleted: true, wallet, removed }); });
    }, callback);
  }
  return { remove };
}
module.exports = { create, cleanupQueues };
