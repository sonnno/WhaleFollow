import React from 'react';
import { t, useLanguage } from './i18n';

function TaiwanFlag() {
  return <svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true" focusable="false">
    <path fill="#fe0000" d="M0 0h30v20H0z" />
    <path fill="#000095" d="M0 0h15v10H0z" />
    <g fill="#fff" transform="translate(7.5 5)">
      {Array.from({ length: 12 }, (_, index) => <path key={index} d="M0 -4L.65 -2.35H-.65Z" transform={`rotate(${index * 30})`} />)}
      <circle r="2.55" fill="#000095" /><circle r="2.15" />
    </g>
  </svg>;
}

function UnitedStatesFlag() {
  return <svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true" focusable="false">
    <path fill="#fff" d="M0 0h30v20H0z" />
    {Array.from({ length: 7 }, (_, index) => <path key={index} fill="#b22234" d={`M0 ${index * 40 / 13}h30v${20 / 13}H0z`} />)}
    <path fill="#3c3b6e" d="M0 0h12v10.77H0z" />
    {Array.from({ length: 9 }, (_, row) => Array.from({ length: row % 2 ? 5 : 6 }, (_, column) =>
      <path key={`${row}-${column}`} fill="#fff" d="M0 -.52L.12 -.16H.5L.19 .07L.31 .44L0 .21L-.31 .44L-.19 .07L-.5 -.16H-.12Z" transform={`translate(${(row % 2 ? 2 : 1) + column * 2} ${.85 + row * 1.13})`} />))}
  </svg>;
}

export default function LanguageSwitcher({ className = '' }) {
  const { language, setLanguage } = useLanguage();
  return <div className={`language-switcher ${className}`.trim()} role="group" aria-label={t('语言')}>
    <button type="button" lang="zh-Hant" aria-pressed={language === 'zh-Hant'} onClick={() => setLanguage('zh-Hant')}>
      <TaiwanFlag /><span>繁體中文</span>
    </button>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>
      <UnitedStatesFlag /><span>English</span>
    </button>
  </div>;
}
