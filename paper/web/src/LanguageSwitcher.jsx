import React from 'react';
import { t, useLanguage } from './i18n';

export default function LanguageSwitcher({ className = '' }) {
  const { language, setLanguage } = useLanguage();
  return <div className={`language-switcher ${className}`.trim()} role="group" aria-label={t('语言')}>
    <button type="button" lang="zh-Hant" aria-pressed={language === 'zh-Hant'} onClick={() => setLanguage('zh-Hant')}>
      <span>繁體中文</span>
    </button>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>
      <span>English</span>
    </button>
  </div>;
}
