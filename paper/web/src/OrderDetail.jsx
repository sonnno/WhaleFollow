/* explicit-ui-i18n */
import { t, translateHumanMessage, getIntlLocale, useLanguage } from './i18n';
import React from 'react';
import {marketFields} from './market-fields-view';

export function executionTime(value){if(!value||!Number.isFinite(Date.parse(value)))return t("暂无成交时间");return new Intl.DateTimeFormat(getIntlLocale(),{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hour12:false}).format(new Date(value));}
export function comparisonDelay(row){if(row.copyClock==='legacy-database'||row.executionDelayMs==null||!Number.isFinite(Number(row.executionDelayMs)))return t("暂无数据");return(Number(row.executionDelayMs)/1000).toFixed(3)+t(" 秒");}

const states = { pending: '待结算', settled: '已结算', sold: '已卖出', skipped: '未成交', waiting: '未成交' };
const reasons = { MATCH_IDENTITY_UNAVAILABLE: '无法确认所属比赛，本笔未买入', ORDER_BACKFILL_REMOVED: '旧任务已结束，不再补单', EXECUTION_STATE_UNAVAILABLE: '跟单配置暂不可用', BUY_PAUSED: '买入已暂停', TASK_PAUSED: '该人的买入已暂停', TASK_STOPPED: '已停止跟买该人', TASK_GENERATION_CHANGED: '任务已重新启用，旧买单不补做', TASK_CONTROL_CANCELLED: '控制开关已取消这笔未执行买单', TASK_FUNDS_EXHAUSTED: '该人的独立账户现金不足，不会借用公共钱包', SHARED_FUNDS_EXHAUSTED: '公共钱包可用现金不足，独立账户预留不可动用', TASK_BUDGET_LIMIT: '该人的当前投入已达到新额度，等待卖出或结算后再跟买', ORDER_AMOUNT_LIMIT: '该来源订单已达到单笔含手续费上限', INSUFFICIENT_CASH: '剩余现金不足', MARKET_LIMIT: '该市场的投入已达到上限', SIGNAL_EXPIRED: '发现这笔交易时已超过允许跟单时间', PAUSED: '跟单已暂停', BUYS_PAUSED: '新增买入已暂停', PAUSED_AT_DISCOVERY: '发现交易时跟单处于暂停状态', LEADER_INACTIVE: '该人员已停止跟买', LEADER_CURRENTLY_INACTIVE: '该人员已停止跟买', BEFORE_CURRENT_JOIN: '交易发生在加入跟单之前', HISTORICAL: '历史交易，不补做买入', NO_OWN_POSITION: '没有可以卖出的持仓', SOURCE_SELL_FROM_OLD_POSITION_CYCLE: '这是上一轮持仓的卖出消息，不卖出新买的持仓', SOURCE_SELL_ALREADY_SATISFIED: '这笔来源卖单应跟卖的份额已全部卖出', LEADER_INVENTORY_UNVERIFIED: '来源人员的持仓数量尚未核实', STALE_BOOK: '报价已过期', QUOTE_MISSING: '未取得可用报价', NO_EXECUTABLE_DEPTH: '可成交的数量不足', MARKET_ALREADY_RESOLVED: '市场已经结算', MARKET_NOT_EXECUTABLE: '市场当前不能交易', UNSUPPORTED_OR_UNKNOWN_OUTCOME: '暂不支持此下注方向' };
export function readableReason(value) {
  if (!value) return t("未满足跟单条件");
  if (reasons[value]) return t(reasons[value]);
  if (value === 'Market is closed') return t("市场已经关闭");
  if (/temporarily unavailable|mapping mismatch/i.test(value)) return t("未取得交易所需信息，本笔未成交");
  if (/temporarily not accepting/i.test(value)) return t("市场暂时停止接单，本笔未成交");
  if (/TLS|socket|connect|timeout|timed out|backoff|HTTP/i.test(value)) return t("行情接口暂时连接失败，本笔未执行");
  if (/price|slippage/i.test(value)) return t("价格变动超过允许范围");
  if (/depth|liquidity|book/i.test(value)) return t("没有足够的可成交报价");
  if (/fee/i.test(value)) return t("尚未确认该市场的费用");
  if (/size|minimum/i.test(value)) return t("成交数量未达到市场要求");
  return t("本笔未满足执行条件");
}
export default function OrderDetail({ value, onClose, money, time, pnl, Table }) {
  const order = value.summary;
  if (!order) return null;
  const buy = order.side === 'BUY', executed = ['FILLED', 'PARTIAL'].includes(order.executionStatus);
  const market=marketFields(order);
  const date = !buy && executed ? [t("到账状态"), t("卖出已到账")] : order.status === 'settled' ? [t("实际结算时间"), time(value.settlements[0]?.createdAt)] : order.expectedSettlementAt ? [t("预计结算时间"), time(order.expectedSettlementAt)] : [t("预计结算时间"), t("待官方确认")];
  const facts = [
    { label: t("跟单人员"), value: order.traderName }, { label: buy ? t("买入方向") : t("卖出方向"), value: market.direction },
    ...(order.matchRatio ? [{ label: t("本场固定跟单比例"), value: order.matchRatio.copyPercent + '%' }, { label: t("本场首次买入时间"), value: executionTime(order.matchRatio.lockedAt) }] : []),
    { label: t("赛事 / 预测事件"), value: market.event }, { label: t("玩法"), value: market.play },
    { label: t("盘口"), value: market.line }, { label: t("投注对象"), value: market.subject||order.title },
    ...(buy ? [{ label: t("他本人买入金额 · 不含手续费"), value: money(order.sourceAmount) + ' USDT' }, { label: t("我们买入金额 · 不含手续费"), value: money(order.gross) + ' USDT' }] : []),
    ...(buy ? [{ label: t("原主买入价（赔率）· 每份 USDT"), value: order.sourcePrice == null ? t("暂无原主成交价") : money(order.sourcePrice) + ' USDT' }, { label: t("我的买入价（赔率）· 每份 USDT"), value: executed && order.averagePrice != null ? money(order.averagePrice) + ' USDT' : t("尚未成交") }] : []),
    { label: t("原主成交时间 · 北京时间"), value: executionTime(order.sourceTime) },
    { label: t("我们的成交时间 · 北京时间"), value: executed ? order.copyClock==='legacy-database'?t("暂无准确时间"):executionTime(order.copyTime) : t("尚未成交") },
    { label: t("成交时间差"), value: executed ? comparisonDelay(order) : t("尚未成交") },
    ...(!executed ? [{ label: t("记录时间"), value: time(order.createdAt) }] : []),
    { label: t("订单类型"), value: t(order.category) || t("分类待更新") },
    { label: date[0], value: date[1] },
    ...(order.marketEndAt && order.status === 'pending' ? [{ label: t("市场截止时间"), value: time(order.marketEndAt) + t("（不代表结算时间）") }] : [])
  ];
  return <div className="modal-backdrop" onClick={onClose}><section className="modal order-detail" role="dialog" aria-modal="true" aria-label={t("订单详情")} onClick={event => event.stopPropagation()}>
    <div className="section-title"><h2>{t("订单详情")}</h2><button className="secondary" onClick={onClose}>{t("关闭")}</button></div>
    <div className="order-title"><span className="tag">{t(states[order.status])}</span><h3>{order.title}</h3>{order.officialUrl ? <a className="official-link" href={order.officialUrl} target="_blank" rel="noreferrer">{t("查看 Polymarket 官网 ↗")}</a> : <span className="note">{t("官网链接待更新")}</span>}</div>
    {executed ? <div className="order-money"><div><span>{t(buy ? t("实际下注金额 · 含费用") : t("卖出到账 · 已扣费用"))}</span><strong>{t(money(order.amount))}<small> USDT</small></strong></div><div><span>{t("成交份额")}</span><strong>{t(money(order.quantity))}</strong></div><div><span>{t("成交均价 · 每份 USDT")}</span><strong>{t(money(order.averagePrice))}</strong></div></div> : <p className="order-message">{t(order.status === 'waiting' ? t("等待跟单") : t("未成交"))}：{t(readableReason(order.reason))}{t("。本笔没有扣款。")}{t(order.executionAttempts >= 3 && t("已尝试3次，不再重试。"))}</p>}
    <dl className="order-facts">{facts.map(row => <div key={row.label}><dt>{t(row.label)}</dt><dd>{row.value}</dd></div>)}</dl>
    {executed && <><div className="order-subheading"><h3>{t("成交明细")}</h3><span>{t("本笔费用：")}{t(money(order.fee))} USDT{t(order.executionStatus === 'PARTIAL' ? buy ? t(" · 部分成交，其余未买入") : t(" · 部分成交，其余未卖出") : '')}</span></div><Table rows={value.fills} columns={[["price", t("成交价 · 每份 USDT"), money], ["quantity", t("成交份额"), money], ["fee", t("费用 · USDT"), money]]}/></>}
    {value.holding && <div className="holding-summary"><h3>{t("这位跟单人的同方向持仓")}</h3><p>{t("尚持有")}<strong>{t(money(value.holding.quantity))}</strong>{t("份，剩余投入")}<strong>{t(money(value.holding.cost))}</strong> USDT。</p><p className="note">{t("同一人员在这个方向的多次买入合并计算，尚未结算。")}</p></div>}
    {value.settlements.length > 0 && <div className="holding-summary"><h3>{t("合并持仓结算")}</h3><p className="note">{t("以下是这位跟单人同一方向合并持仓的结算结果，包含该笔买入；不是单笔买入的独立盈亏。")}</p><Table rows={value.settlements} columns={[["createdAt", t("结算时间"), time], ["revenue", t("结算到账 · USDT"), money], ["cost", t("结算成本 · USDT"), money], ["profit", t("结算盈亏 · USDT"), pnl]]}/></div>}
  </section></div>;
}
