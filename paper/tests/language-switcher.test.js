const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function screen(initial, blocked = false) {
  let persisted = initial;
  const document = { documentElement: { lang: '' }, title: '' };
  const browser = {
    get localStorage() {
      if (blocked) throw Error('disabled');
      return { getItem: () => persisted, setItem: (key, value) => { persisted = value; } };
    }, addEventListener() {}, removeEventListener() {}
  };
  const hookReact = { ...React, useSyncExternalStore: (subscribe, snapshot) => snapshot(), useEffect: fn => fn() };
  const catalogs = {
    en: { '语言': 'Language', '系统设置': 'Settings', '你好，{name}': 'Hello, {name}', 'Polymarket 虚拟跟单': 'Polymarket Paper Copy Trading' },
    'zh-Hant': { '语言': '語言', '系统设置': '系統設定', 'Polymarket 虚拟跟单': 'Polymarket 虛擬跟單' }
  };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    assert.ok(fs.existsSync(file), `${path.basename(file)} must exist`);
    const module = { exports: {} };
    vm.runInNewContext(esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code, {
      module, exports: module.exports, window: browser, document,
      require(name) {
        if (name === 'react') return hookReact;
        if (name.endsWith('/en.json')) return catalogs.en;
        if (name.endsWith('/zh-Hant.json')) return catalogs['zh-Hant'];
        const target = path.resolve(path.dirname(file), name);
        return load(fs.existsSync(target) ? target : fs.existsSync(target + '.js') ? target + '.js' : target + '.jsx');
      }
    });
    cache.set(file, module.exports);
    return module.exports;
  }
  const i18n = load('web/src/i18n.jsx');
  const Switcher = load('web/src/LanguageSwitcher.jsx').default;
  return { i18n, tree: () => Switcher({}), document, persisted: () => persisted };
}
function buttons(tree) { return React.Children.toArray(tree.props.children).filter(child => child?.type === 'button'); }

test('selector is an accessible group with Taiwan/US vectors, names and selected state', () => {
  const app = screen(), tree = app.tree(), choices = buttons(tree);
  assert.equal(tree.props.role, 'group');
  assert.ok(tree.props['aria-label']);
  assert.equal(choices.length, 2);
  assert.equal(choices[0].props['aria-pressed'], true);
  assert.equal(choices[1].props['aria-pressed'], false);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /繁體中文/);
  assert.match(html, /English/);
  assert.equal((html.match(/<svg/g) || []).length, 2);
  assert.equal((html.match(/aria-hidden="true"/g) || []).length, 2);
  assert.doesNotMatch(html, /<img|https?:|🇹🇼|🇺🇸/);
});
test('clicking either choice changes language immediately and cannot submit a containing form', () => {
  const app = screen();
  const choices = buttons(app.tree());
  assert.ok(choices.every(button => button.props.type === 'button'));
  choices[1].props.onClick();
  assert.equal(app.i18n.useLanguage().language, 'en');
  assert.equal(app.persisted(), 'en');
  assert.equal(buttons(app.tree())[1].props['aria-pressed'], true);
  assert.equal(app.i18n.t('系统设置'), 'Settings');
  buttons(app.tree())[0].props.onClick();
  assert.equal(app.i18n.t('Settings'), '系統設定');
});
test('saved preference reloads and disabled storage still permits switching', () => {
  assert.equal(screen('en').i18n.useLanguage().language, 'en');
  assert.equal(screen('invalid').i18n.useLanguage().language, 'zh-Hant');
  const app = screen(undefined, true);
  buttons(app.tree())[1].props.onClick();
  assert.equal(app.i18n.useLanguage().language, 'en');
});
test('provider updates document language/title and numeric/date locale without altering numbers', () => {
  const app = screen();
  app.i18n.LanguageProvider({ children: null });
  assert.equal(app.document.documentElement.lang, 'zh-Hant');
  assert.equal(app.document.title, 'Polymarket 虛擬跟單');
  buttons(app.tree())[1].props.onClick();
  app.i18n.LanguageProvider({ children: null });
  assert.equal(app.document.documentElement.lang, 'en');
  assert.equal(app.document.title, 'Polymarket Paper Copy Trading');
  assert.equal(app.i18n.getIntlLocale(), 'en-US');
  assert.equal(app.i18n.t('001.200'), '001.200');
  assert.equal(app.i18n.t(1.234), 1.234);
});
test('interpolated untrusted text remains escaped by React', () => {
  const app = screen('en');
  const html = renderToStaticMarkup(React.createElement('p', null, app.i18n.t('你好，{name}', { name: '<img src=x onerror=alert(1)>' })));
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});
