const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), esbuild = require('esbuild');
function helpers() {
  const file = 'web/src/Leaderboards.jsx';
  assert.ok(fs.existsSync(file), '排行榜查询页面尚未实现');
  const module = { exports: {} };
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, { module, exports: module.exports, URLSearchParams, require: function (name) { if (name === 'react') return {}; if (name === './api') return {}; throw new Error(name); } });
  return module.exports;
}
test('cursor pages preserve the exact official continuation token and permit going back', function () {
  const api = helpers();
  const state = api.nextPage({ history: [''], index: 0 }, { paginationKind: 'cursor', nextCursor: 'pinned-month-sports', hasMore: true });
  assert.equal(state.index, 1); assert.equal(state.history[1], 'pinned-month-sports');
  assert.equal(api.boardParams({ type: 'traders', version: 'v2', timePeriod: 'month', category: 'sports', orderBy: 'PNL', limit: 20 }, state).cursor, 'pinned-month-sports');
  assert.equal(api.boardParams({ type: 'traders', version: 'v2', limit: 20 }, { ...state, index: 0 }).cursor, undefined);
});
test('non-cursor pages advance by page size and end-of-board cannot advance', function () {
  const api = helpers(); const state = api.nextPage({ history: [''], index: 0 }, { paginationKind: 'offset', limit: 20, hasMore: true });
  assert.equal(api.boardParams({ type: 'builders', version: 'v1', limit: 20 }, state).offset, 20);
  assert.equal(api.nextPage(state, { hasMore: false }), state);
});
test('builder entries cannot be selected as trader follow tasks', function () {
  const api = helpers(); assert.equal(api.followable({ wallet: '0x' + 'a'.repeat(40), canFollow: false }), false);
  assert.equal(api.followable({ wallet: 'builder-name', canFollow: true }), false);
  assert.equal(api.followable({ wallet: '0x' + 'a'.repeat(40), canFollow: true }), true);
});
