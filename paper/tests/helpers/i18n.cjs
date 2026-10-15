const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const source = path.join(__dirname, '../../web/src');
const core = { exports: {} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(source, 'i18n-core.js'), 'utf8'), { format: 'cjs' }).code, { module: core, exports: core.exports });
const catalogs = { en: JSON.parse(fs.readFileSync(path.join(source, 'locales/en.json'), 'utf8')), 'zh-Hant': JSON.parse(fs.readFileSync(path.join(source, 'locales/zh-Hant.json'), 'utf8')) };
// Keep hook state out of the hand-written React harness while using real translations.
const language = 'zh-Hant';
module.exports = {
  t: (value, params) => core.exports.translateMessage(value, language, catalogs, params),
  translateHumanMessage: (value, params) => core.exports.translateHumanMessage(value, language, catalogs, params),
  getIntlLocale: () => core.exports.getIntlLocale(language),
  useLanguage: () => ({ language, setLanguage() {} })
};
