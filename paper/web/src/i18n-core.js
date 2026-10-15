export const LANGUAGE_STORAGE_KEY = 'whalefollow.paper.language';
export const DEFAULT_LANGUAGE = 'zh-Hant';
const validLanguage = value => value === 'zh-Hant' || value === 'en';
const normalizeLanguage = value => validLanguage(value) ? value : DEFAULT_LANGUAGE;

export function getIntlLocale(language) {
  return language === 'en' ? 'en-US' : 'zh-TW';
}

// The browser is injected so storage failures and server rendering remain harmless.
export function createLocaleStore({ window: browser } = {}) {
  const listeners = new Set();
  const read = () => {
    try { return normalizeLanguage(browser?.localStorage?.getItem(LANGUAGE_STORAGE_KEY)); }
    catch { return DEFAULT_LANGUAGE; }
  };
  let language = read();
  const notify = next => {
    if (next === language) return;
    language = next;
    listeners.forEach(listener => listener());
  };
  const onStorage = event => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== browser?.localStorage) return;
    } catch { return; }
    notify(normalizeLanguage(event.newValue));
  };
  return {
    getSnapshot: () => language,
    setLanguage(next) {
      if (!validLanguage(next)) return;
      try { browser?.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Keep the in-memory preference. */ }
      notify(next);
    },
    subscribe(listener) {
      if (!listeners.size) browser?.addEventListener?.('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) browser?.removeEventListener?.('storage', onStorage);
      };
    }
  };
}

const numericText = value => /^[\s]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\s]*$/.test(value);
const catalogFor = (language, catalogs) => catalogs?.[normalizeLanguage(language)] || {};
const lookup = (catalog, key) => Object.prototype.hasOwnProperty.call(catalog, key) && typeof catalog[key] === 'string' ? catalog[key] : undefined;
const aliasCache = new WeakMap();
const aliasesFor = (language, catalogs) => {
  if (!catalogs || typeof catalogs !== 'object') return new Map();
  let languages = aliasCache.get(catalogs);
  if (!languages) { languages = new Map(); aliasCache.set(catalogs, languages); }
  const normalized = normalizeLanguage(language);
  if (languages.has(normalized)) return languages.get(normalized);
  const catalog = catalogFor(normalized, catalogs);
  const aliases = new Map(Object.entries(catalog).filter(([, translated]) => typeof translated === 'string'));
  for (const messages of Object.values(catalogs || {})) {
    for (const [source, translated] of Object.entries(messages)) {
      const result = lookup(catalog, source);
      if (result !== undefined && typeof translated === 'string' && !aliases.has(translated)) aliases.set(translated, result);
    }
  }
  languages.set(normalized, aliases);
  return aliases;
};
const interpolate = (value, params) => params ? value.replace(/\{([\w]+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match) : value;

export function translateMessage(value, language, catalogs, params) {
  if (typeof value !== 'string' || numericText(value)) return value;
  const aliases = aliasesFor(language, catalogs);
  const exact = aliases.get(value);
  if (exact !== undefined) return interpolate(exact, params);
  const trimmed = value.trim();
  const translated = aliases.get(trimmed);
  if (translated !== undefined) {
    const start = value.indexOf(trimmed);
    return value.slice(0, start) + interpolate(translated, params) + value.slice(start + trimmed.length);
  }
  return interpolate(value, params);
}

// Only call for application-owned human messages, never titles, names or IDs.
export function translateHumanMessage(value, language, catalogs, params) {
  const exact = translateMessage(value, language, catalogs, params);
  if (typeof value !== 'string' || exact !== value || numericText(value)) return exact;
  const aliases = aliasesFor(language, catalogs);
  const keys = [...aliases.keys()].filter(key => key.length >= 4 && /[\u3400-\u9fffA-Za-z]/.test(key)).sort((a, b) => b.length - a.length);
  if (!keys.length) return exact;
  const pattern = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return interpolate(value.replace(pattern, match => aliases.get(match)), params);
}
