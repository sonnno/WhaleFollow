const async = require('async');
const { D, str } = require('./accounting-service');
let sequence = 0;
const runId = require('node:crypto').randomUUID();
function event(signal, task, insufficient, required, account) {
  const scope = task && task.fundingMode === 'dedicated' ? 'dedicated' : 'shared';
  const suffix = scope === 'dedicated' ? ':' + signal.wallet : '';
  const value = { insufficient, scope, wallet: signal.wallet, taskCreatedAt: task && task.createdAt || null, at: new Date().toISOString(), runId, sequence: ++sequence, required: required == null ? null : str(required) };
  const rows = [{ id: 'balance-warning:' + scope + suffix, value }];
  if (!insufficient || account && D(account.cash).lt(required)) rows.push({ id: 'balance-warning:total', value: { ...value, scope: 'total' } });
  return rows;
}
function write(tx, rows, callback, guard) {
  if (!rows.length) return callback();
  tx.query(`INSERT INTO paper_settings(id,value)
    SELECT item->>'id',item->'value' FROM jsonb_array_elements($1::jsonb) item
    WHERE $2::text IS NULL OR EXISTS(SELECT 1 FROM paper_follow_tasks WHERE id=$2 AND "createdAt"=$3::timestamptz AND "fundingMode"=$4)
    ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=clock_timestamp()
    WHERE CASE WHEN paper_settings.value->>'runId'=EXCLUDED.value->>'runId'
      THEN COALESCE((paper_settings.value->>'sequence')::bigint,0)<=(EXCLUDED.value->>'sequence')::bigint
      ELSE COALESCE(paper_settings.value->>'at','')<=EXCLUDED.value->>'at' END`,
  [JSON.stringify(rows), guard ? guard.wallet : null, guard ? guard.createdAt : null, guard ? guard.mode : null], function (err) { callback(err); });
}
function create(db) {
  function mark(signal, state, required, callback) {
    const rows = event(signal, state.task, true, required, state.account);
    db.transaction(function (tx, done) {
      async.waterfall([
        function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], function (err) { next(err); }); },
        function (next) { write(tx, rows, next, state.task ? { wallet: signal.wallet, createdAt: state.task.createdAt, mode: state.task.fundingMode } : null); }
      ], done);
    }, callback);
  }
  return { event, write, mark };
}
module.exports = { create, event, write };
