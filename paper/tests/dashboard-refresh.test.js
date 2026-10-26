const i18n = require('./helpers/i18n.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

function screen() {
  const states = [], effects = [], requests = [], loads = [];
  const React = {
    createElement: function () { return null; },
    useState: function (initial) {
      const index = states.length;
      states.push(index === 0 ? { username: 'admin' } : initial);
      return [states[index], function (value) { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: function (value) { return { current: value }; },
    useCallback: function (fn) { loads.push(fn); return fn; },
    useEffect: function (fn) { effects.push(fn); }
  };
  const source = esbuild.transformSync(fs.readFileSync('web/src/App.jsx', 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: function (name) {if(name==='./i18n')return i18n;if(name==='./LanguageSwitcher'||name==='./WalletDeposit')return()=>null;
      if (name === 'react') return React;
      if ((name === './market-fields' || name === './market-fields-view')) return { marketFields: function () { return {}; } };
      if (name === './api') return { request: function (route, body, callback) { requests.push({ route, callback }); } };
      if (name === './OrderDetail') return { default: function () {}, readableReason: function (value) { return value; } };
      if (name === './Leaderboards' || name === './FollowTasks'||name==='./DailyReports'||name==='./MarketStatistics') return { default: function () {} };
      throw new Error('Unexpected import ' + name);
    },
    EventSource: class { addEventListener() {} close() {} },
    setInterval: function () { return 1; }, clearInterval: function () {}, URLSearchParams, Map, Set
  });
  module.exports.default();
  const cleanup = effects[1]();
  return { states, requests, load: loads[0], cleanup };
}

test('slow summary response remains valid after automatic refresh ticks', function () {
  const app = screen();
  const bets = app.requests.find(function (request) { return request.route === '/cash-summary'; });
  app.load(); app.load();
  bets.callback(null, { data: [{ id: 'existing-order' }], total: 1, offset: 0 });
  assert.equal(app.states[2]['/cash-summary'].data[0].id, 'existing-order');
  assert.equal(app.requests.filter(function (request) { return request.route === '/cash-summary'; }).length, 1);
  app.load();
  assert.equal(app.requests.filter(function (request) { return request.route === '/cash-summary'; }).length, 2);
});

test('successful settings response cannot hide a failed summary request', function () {
  const app = screen();
  app.requests.find(function (request) { return request.route === '/cash-summary'; }).callback(new Error('统计查询失败'));
  app.requests.find(function (request) { return request.route === '/settings'; }).callback(null, { runtime: {} });
  assert.equal(app.states[3], '统计查询失败');
  app.load();
  app.requests.filter(function (request) { return request.route === '/cash-summary'; }).at(-1).callback(null, { data: [], total: 0, offset: 0 });
  assert.equal(app.states[3], '');
});

test('responses from a departed page cannot update the current page', function () {
  const app = screen();
  const bets = app.requests.find(function (request) { return request.route === '/cash-summary'; });
  app.cleanup();
  bets.callback(null, { data: [{ id: 'old-page' }], total: 1, offset: 0 });
  assert.equal(app.states[2]['/cash-summary'], undefined);
});
