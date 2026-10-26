const config = require('../../config').paper;
const key = 'paper:dashboard:prepared:v1';

// Browser reads never enter PostgreSQL or wait for an ongoing refresh.
function create(dashboard, redis, options) {
  options = options || {};
  const now = options.now || Date.now, repeat = options.setInterval || setInterval, cancel = options.clearInterval || clearInterval;
  let state = {}, timers = [], stopped = false, summaryBusy = false, historyBusy = false, runtimeVersion = 0;
  function displayConfig() { return { ...config, initialCash: state.summary?.initialCash || config.initialCash }; }
  function persist() { if (!stopped) redis.set(key, JSON.stringify(state), function () {}); }
  function missing() { return Object.assign(new Error('首页数据正在初始化，请稍后刷新'), { status: 503 }); }
  function read(name, age, callback) {
    const value = state[name];
    if (!value || name === 'history' && value.accountCreatedAt !== state.summary?.createdAt) return callback(missing());
    callback(null, { ...value, stale: now() - new Date(value.updatedAt).getTime() > age });
  }
  function refreshSummary() {
    if (stopped || summaryBusy) return;
    summaryBusy = true;
    const version = runtimeVersion;
    dashboard.cashSummary(function (err, value) {
      summaryBusy = false; if (stopped || err) return;
      const runtime = version === runtimeVersion ? value.runtime || {} : state.settings.runtime; delete value.runtime;
      state.summary = { ...value, updatedAt: new Date(now()).toISOString() };
      state.settings = { config: displayConfig(), runtime, mode: 'paper', updatedAt: state.summary.updatedAt };
      if (state.history && state.history.accountCreatedAt !== value.createdAt) delete state.history;
      persist();
    });
  }
  function refreshHistory() {
    if (stopped || historyBusy) return;
    historyBusy = true;
    dashboard.homeHistory(function (err, value) {
      historyBusy = false; if (stopped || err) return;
      if (state.summary && state.summary.createdAt !== value.accountCreatedAt) return;
      state.history = { ...value, updatedAt: new Date(now()).toISOString() }; persist();
    });
  }
  return {
    start: function (callback) {
      redis.get(key, function (err, value) {
        if (stopped) return callback();
        if (!err && value) { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') state = parsed; } catch { /* Rebuild corrupt cache from accounting data. */ } }
        refreshSummary(); refreshHistory();
        timers = [repeat(refreshSummary, 2000), repeat(refreshHistory, 30000)];
        timers.forEach(function (timer) { if (timer.unref) timer.unref(); }); callback();
      });
    },
    summary: function (callback) { read('summary', 10000, callback); },
    history: function (callback) { read('history', 90000, callback); },
    settings: function (callback) { read('settings', 10000, callback); },
    setRuntime: function (runtime) { runtimeVersion++; state.settings = { config: displayConfig(), runtime, mode: 'paper', updatedAt: new Date(now()).toISOString() }; persist(); refreshSummary(); },
    refreshSummary, refreshHistory,
    stop: function () { stopped = true; timers.forEach(cancel); }
  };
}
module.exports = { create, key };
