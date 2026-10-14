function create(health) {
  health.tasks = {};
  health.lastError = null;
  health.lastIncident = null;
  return function report(task, err, result) {
    if (!err && result && result.checked === 0) return;
    const now = new Date().toISOString();
    const state = health.tasks[task] || { status: 'pending', error: null, lastSuccess: null };
    if (err && err.code === 'POLYMARKET_BACKOFF') {
      state.status = 'retrying'; state.retryAt = new Date(Date.now() + err.retryAfterMs).toISOString();
      if (!state.error) {
        state.error = { task, message: err.causeMessage || 'Polymarket 连接暂不可用，等待重试', at: now };
        health.lastIncident = state.error;
      }
    } else if (err) {
      state.retryAt = null;
      state.status = 'error';
      state.error = { task, message: err.message, at: now };
      health.lastIncident = state.error;
    } else {
      if (state.error) health.lastIncident = { ...state.error, recoveredAt: now };
      state.status = 'ok'; state.error = null; state.retryAt = null; state.lastSuccess = now;
    }
    health.tasks[task] = state;
    health.lastError = Object.values(health.tasks).map(function (value) { return value.error; }).filter(Boolean).sort(function (a, b) { return b.at.localeCompare(a.at); })[0] || null;
  };
}
module.exports = { create };
