const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

function core() {
  const file = 'web/src/i18n-core.js';
  assert.ok(fs.existsSync(file), 'locale core must exist');
  const module = { exports: {} };
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(file, 'utf8'), { format: 'cjs' }).code, { module, exports: module.exports, Set });
  return module.exports;
}
const catalogs = {
  en: { '系统设置': 'Settings', '请求失败': 'Request failed', '请求失败，请重试': 'Request failed, please retry', '你好，{name}': 'Hello, {name}' },
  'zh-Hant': { '系统设置': '系統設定', '请求失败': '請求失敗' }
};
function browser(initial) {
  const values = new Map(initial === undefined ? [] : [['whalefollow.paper.language', initial]]);
  const listeners = new Set();
  return {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    dispatch: event => listeners.forEach(fn => fn(event)), values, listeners
  };
}
test('locale defaults to Traditional Chinese and uses the paper namespace', () => {
  const api = core(), env = browser(), store = api.createLocaleStore({ window: env });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  assert.equal(api.LANGUAGE_STORAGE_KEY, 'whalefollow.paper.language');
  assert.equal(api.getIntlLocale('zh-Hant'), 'zh-TW');
  assert.equal(api.getIntlLocale('en'), 'en-US');
});
test('selection notifies same-tab consumers, persists and reloads', () => {
  const { createLocaleStore } = core(), env = browser(), store = createLocaleStore({ window: env });
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  store.setLanguage('en');
  assert.equal(store.getSnapshot(), 'en');
  assert.equal(updates, 1);
  assert.equal(env.values.get('whalefollow.paper.language'), 'en');
  assert.equal(createLocaleStore({ window: env }).getSnapshot(), 'en');
  store.setLanguage('en');
  assert.equal(updates, 1);
  unsubscribe();
  store.setLanguage('zh-Hant');
  assert.equal(updates, 1);
});
test('invalid stored choices and invalid updates cannot change locale', () => {
  const store = core().createLocaleStore({ window: browser('zh-CN') });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  store.setLanguage('fr');
  assert.equal(store.getSnapshot(), 'zh-Hant');
});
test('blocked or unavailable storage retains a working in-memory choice', () => {
  const { createLocaleStore } = core();
  const env = { get localStorage() { throw Error('blocked'); } };
  const store = createLocaleStore({ window: env });
  store.setLanguage('en');
  assert.equal(store.getSnapshot(), 'en');
  assert.equal(createLocaleStore().getSnapshot(), 'zh-Hant');
});
test('cross-tab events update subscribers and ignore unrelated keys', () => {
  const env = browser(), store = core().createLocaleStore({ window: env });
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  env.dispatch({ key: 'other', newValue: 'en' });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  env.dispatch({ key: 'whalefollow.paper.language', newValue: 'en' });
  assert.equal(store.getSnapshot(), 'en');
  env.dispatch({ key: 'whalefollow.paper.language', newValue: 'invalid' });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  env.dispatch({ key: 'whalefollow.paper.language', newValue: 'en' });
  env.dispatch({ key: null, newValue: null });
  assert.equal(store.getSnapshot(), 'zh-Hant');
  assert.equal(updates, 4);
  unsubscribe();
  assert.equal(env.listeners.size, 0);
});
test('exact catalog messages preserve surrounding whitespace', () => {
  const { translateMessage } = core();
  assert.equal(translateMessage(' 系统设置\n', 'zh-Hant', catalogs), ' 系統設定\n');
  assert.equal(translateMessage('系统设置', 'en', catalogs), 'Settings');
});
test('previously rendered catalog translations can switch language again', () => {
  const { translateMessage } = core();
  assert.equal(translateMessage('Settings', 'zh-Hant', catalogs), '系統設定');
  assert.equal(translateMessage('系統設定', 'en', catalogs), 'Settings');
  assert.equal(translateMessage(' 系統設定 ', 'en', catalogs), ' Settings ');
});
test('numbers, numeric strings, IDs, and unknown names pass through untouched', () => {
  const { translateMessage } = core();
  for (const value of [null, undefined, 0, 1.0002, '001.2300', '0xabc123', 'Bitcoin 100K', '系统设置精选市场']) {
    assert.equal(translateMessage(value, 'en', catalogs), value);
  }
  const object = { title: '系统设置' };
  assert.equal(translateMessage(object, 'en', catalogs), object);
});
test('interpolation returns plain text and does not interpret HTML', () => {
  const text = core().translateMessage('你好，{name}', 'en', catalogs, { name: '<img src=x onerror=alert(1)>' });
  assert.equal(text, 'Hello, <img src=x onerror=alert(1)>');
});
test('human-message fragments prefer the longest match and retain unknown details', () => {
  const { translateHumanMessage } = core();
  assert.equal(translateHumanMessage('503: 请求失败，请重试 (trace abc)', 'en', catalogs), '503: Request failed, please retry (trace abc)');
  assert.equal(translateHumanMessage('未知错误 0xabc', 'en', catalogs), '未知错误 0xabc');
});
test('human-message fragments already displayed in English switch back to Traditional', () => {
  assert.equal(core().translateHumanMessage('503: Request failed (trace abc)', 'zh-Hant', catalogs), '503: 請求失敗 (trace abc)');
});
