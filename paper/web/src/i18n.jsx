import { useEffect, useSyncExternalStore } from 'react';
import en from './locales/en.json';
import traditional from './locales/zh-Hant.json';
import { createLocaleStore, getIntlLocale as intlLocale, translateMessage, translateHumanMessage as humanMessage } from './i18n-core';

const catalogs = { en, 'zh-Hant': traditional };
const store = createLocaleStore({ window: typeof window === 'undefined' ? undefined : window });

export function t(value, params) {
  return translateMessage(value, store.getSnapshot(), catalogs, params);
}

export function translateHumanMessage(value, params) {
  return humanMessage(value, store.getSnapshot(), catalogs, params);
}

export function getIntlLocale() {
  return intlLocale(store.getSnapshot());
}

export function useLanguage() {
  const language = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { language, setLanguage: store.setLanguage };
}

export function LanguageProvider({ children }) {
  const { language } = useLanguage();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = language;
    const title = t('Polymarket 虚拟跟单');
    document.title = title === 'Polymarket 虚拟跟单'
      ? language === 'en' ? 'Polymarket Paper Copy Trading' : 'Polymarket 虛擬跟單'
      : title;
  }, [language]);
  return children;
}
