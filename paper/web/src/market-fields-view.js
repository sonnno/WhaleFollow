import { marketFields as readMarketFields } from './market-fields';
import { t } from './i18n';

// Parse upstream values in their original form; localize presentation afterwards.
export function marketFields(order = {}) {
  const raw = readMarketFields(order);
  const line = raw.line.replace(/^([+-]?\d+(?:\.\d+)?)\s+(球|张|个|分)$/, (_, number, unit) => number + ' ' + t(unit));
  let direction = t(raw.direction);
  if (/^Under$/i.test(order.outcome || '') && raw.line !== '不适用' && raw.line !== '暂未取得') direction = t('小于 {0}（Under）', { 0: line });
  if (/^Over$/i.test(order.outcome || '') && raw.line !== '不适用' && raw.line !== '暂未取得') direction = t('大于 {0}（Over）', { 0: line });
  return { ...raw, play: t(raw.play), line: t(line), direction };
}
