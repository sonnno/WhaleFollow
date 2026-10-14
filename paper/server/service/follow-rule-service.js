const { D, str } = require('./accounting-service');
function executionConfig(task, base) { return { ...base, copySizing: 'fixed_ratio', copyRatio: str(D(task.copyPercent).div(100)) }; }
function availableCash(account, task, spent, sharedCash, positionCost) {
  const pool = task.fundingMode === 'shared' ? sharedCash === undefined ? account.cash : sharedCash : task.cash;
  let value = D(account.cash).clamp(0, D(pool).clamp(0, Infinity));
  if (task.allocation !== undefined) value = value.clamp(0, D(task.allocation).minus(positionCost || 0).clamp(0, Infinity));
  if (task.maxOrderAmount !== null && task.maxOrderAmount !== undefined) value = value.clamp(0, D(task.maxOrderAmount).minus(spent || 0).clamp(0, Infinity));
  return str(value);
}
function buyBlocked(signal, task, job) {
  if (job && job.status === 'done' && ['TASK_CONTROL_CANCELLED','BUYS_PAUSED'].includes(job.error)) return 'TASK_CONTROL_CANCELLED';
  if (!task) return '';
  if (task.state !== 'running') return task.state === 'paused' ? 'TASK_PAUSED' : 'TASK_STOPPED';
  if (Number(signal.followGeneration || 0) !== task.generation) return 'TASK_GENERATION_CHANGED';
  if (signal.timestamp < Math.ceil(new Date(task.startedAt).getTime() / 1000)) return 'BEFORE_CURRENT_JOIN';
  return '';
}
module.exports = { executionConfig, availableCash, buyBlocked };
