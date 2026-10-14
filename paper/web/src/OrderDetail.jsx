import React from 'react';
import {marketFields} from './market-fields';

export function executionTime(value){if(!value||!Number.isFinite(Date.parse(value)))return'暂无成交时间';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hour12:false}).format(new Date(value));}
export function comparisonDelay(row){if(row.copyClock==='legacy-database')return'历史时间未校准';if(row.executionDelayMs==null||!Number.isFinite(Number(row.executionDelayMs)))return'无法准确计算';return'约 '+(Number(row.executionDelayMs)/1000).toFixed(3)+' 秒';}
export function processingDelay(row){return row.receivedToExecutionMs==null?'暂无计时记录':(Number(row.receivedToExecutionMs)/1000).toFixed(3)+' 秒';}

const states = { pending: '待结算', settled: '已结算', sold: '已卖出', skipped: '未成交', waiting: '等待跟单 · 自动重试' };
const reasons = { TASK_PAUSED: '该人的买入已暂停', TASK_STOPPED: '已停止跟买该人', TASK_GENERATION_CHANGED: '任务已重新启用，旧买单不补做', TASK_CONTROL_CANCELLED: '控制开关已取消这笔未执行买单', TASK_FUNDS_EXHAUSTED: '该人的独立账户现金不足，不会借用公共钱包', SHARED_FUNDS_EXHAUSTED: '公共钱包可用现金不足，独立账户预留不可动用', TASK_BUDGET_LIMIT: '该人的当前投入已达到新额度，等待卖出或结算后再跟买', ORDER_AMOUNT_LIMIT: '该来源订单已达到单笔含手续费上限', INSUFFICIENT_CASH: '剩余现金不足', MARKET_LIMIT: '该市场的投入已达到上限', SIGNAL_EXPIRED: '发现这笔交易时已超过允许跟单时间', PAUSED: '跟单已暂停', BUYS_PAUSED: '新增买入已暂停', PAUSED_AT_DISCOVERY: '发现交易时跟单处于暂停状态', LEADER_INACTIVE: '该人员已停止跟买', LEADER_CURRENTLY_INACTIVE: '该人员已停止跟买', BEFORE_CURRENT_JOIN: '交易发生在加入跟单之前', HISTORICAL: '历史交易，不补做买入', NO_OWN_POSITION: '没有可以卖出的持仓', SOURCE_SELL_FROM_OLD_POSITION_CYCLE: '这是上一轮持仓的卖出消息，不卖出新买的持仓', SOURCE_SELL_ALREADY_SATISFIED: '这笔来源卖单应跟卖的份额已全部卖出', LEADER_INVENTORY_UNVERIFIED: '来源人员的持仓数量尚未核实', STALE_BOOK: '报价已过期', QUOTE_MISSING: '未取得可用报价', NO_EXECUTABLE_DEPTH: '可成交的数量不足', MARKET_ALREADY_RESOLVED: '市场已经结算', MARKET_NOT_EXECUTABLE: '市场当前不能交易', UNSUPPORTED_OR_UNKNOWN_OUTCOME: '暂不支持此下注方向' };
export function readableReason(value) {
  if (!value) return '未满足跟单条件';
  if (reasons[value]) return reasons[value];
  if (value === 'Market is closed') return '市场已经关闭';
  if (/temporarily unavailable|mapping mismatch/i.test(value)) return '正在补查市场或投注方向';
  if (/temporarily not accepting/i.test(value)) return '市场暂时停止接单，等待恢复';
  if (/TLS|socket|connect|timeout|timed out|backoff|HTTP/i.test(value)) return '行情接口暂时连接失败，本笔未执行';
  if (/price|slippage/i.test(value)) return '价格变动超过允许范围';
  if (/depth|liquidity|book/i.test(value)) return '没有足够的可成交报价';
  if (/fee/i.test(value)) return '尚未确认该市场的费用';
  if (/size|minimum/i.test(value)) return '成交数量未达到市场要求';
  return '本笔未满足执行条件';
}
export default function OrderDetail({ value, onClose, money, time, pnl, Table }) {
  const order = value.summary;
  if (!order) return null;
  const buy = order.side === 'BUY', executed = ['FILLED', 'PARTIAL'].includes(order.executionStatus);
  const market=marketFields(order);
  const date = !buy && executed ? ['到账状态', '卖出已到账'] : order.status === 'settled' ? ['实际结算时间', time(value.settlements[0]?.createdAt)] : order.expectedSettlementAt ? ['预计结算时间', time(order.expectedSettlementAt)] : ['预计结算时间', '待官方确认'];
  const facts = [
    { label: '跟单人员', value: order.traderName }, { label: buy ? '买入方向' : '卖出方向', value: market.direction },
    { label: '赛事 / 预测事件', value: market.event }, { label: '玩法', value: market.play },
    { label: '盘口', value: market.line }, { label: '投注对象', value: market.subject||order.title },
    ...(buy ? [{ label: '他本人买入金额 · 不含手续费', value: money(order.sourceAmount) + ' USDT' }, { label: '我们买入金额 · 不含手续费', value: money(order.gross) + ' USDT' }] : []),
    ...(buy ? [{ label: '原主买入价（赔率）· 每份 USDT', value: order.sourcePrice == null ? '暂无原主成交价' : money(order.sourcePrice) + ' USDT' }, { label: '我的买入价（赔率）· 每份 USDT', value: executed && order.averagePrice != null ? money(order.averagePrice) + ' USDT' : '尚未成交' }] : []),
    { label: '原主成交时间 · 北京时间', value: executionTime(order.sourceTime) },
    { label: '我们的成交时间 · 北京时间', value: executed ? executionTime(order.copyTime)+(order.copyClock==='legacy-database'?'（历史时间未校准）':'') : '尚未成交' },
    { label: '成交时间差 · 原主时间按官网记录', value: executed ? comparisonDelay(order) : '尚未成交' },
    ...(executed ? [{ label: '我们收到成交数据的时间 · 北京时间', value: executionTime(order.receivedAt) }, { label: '收到数据至跟单成交 · 含排队和重试等待', value: processingDelay(order) }] : []),
    ...(!executed ? [{ label: '记录时间', value: time(order.createdAt) }] : []),
    { label: '订单类型', value: order.category || '分类待更新' },
    { label: date[0], value: date[1] },
    ...(order.marketEndAt && order.status === 'pending' ? [{ label: '市场截止时间', value: time(order.marketEndAt) + '（不代表结算时间）' }] : [])
  ];
  return <div className="modal-backdrop" onClick={onClose}><section className="modal order-detail" role="dialog" aria-modal="true" aria-label="订单详情" onClick={event => event.stopPropagation()}>
    <div className="section-title"><h2>订单详情</h2><button className="secondary" onClick={onClose}>关闭</button></div>
    <div className="order-title"><span className="tag">{states[order.status]}</span><h3>{order.title}</h3>{order.officialUrl ? <a className="official-link" href={order.officialUrl} target="_blank" rel="noreferrer">查看 Polymarket 官网 ↗</a> : <span className="note">官网链接待更新</span>}</div>
    {executed ? <div className="order-money"><div><span>{buy ? '实际下注金额 · 含费用' : '卖出到账 · 已扣费用'}</span><strong>{money(order.amount)}<small> USDT</small></strong></div><div><span>成交份额</span><strong>{money(order.quantity)}</strong></div><div><span>成交均价 · 每份 USDT</span><strong>{money(order.averagePrice)}</strong></div></div> : <p className="order-message">{order.status === 'waiting' ? '等待跟单' : '未成交'}：{readableReason(order.reason)}。本笔没有扣款。{order.status === 'waiting' && '系统会自动重试，成交后在这里更新。'}</p>}
    <dl className="order-facts">{facts.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    {executed && <><div className="order-subheading"><h3>成交明细</h3><span>本笔费用：{money(order.fee)} USDT{order.executionStatus === 'PARTIAL' ? buy ? ' · 部分成交，其余未买入' : ' · 部分成交，其余未卖出' : ''}</span></div><Table rows={value.fills} columns={[["price", "成交价 · 每份 USDT", money], ["quantity", "成交份额", money], ["fee", "费用 · USDT", money]]}/></>}
    {value.holding && <div className="holding-summary"><h3>这位跟单人的同方向持仓</h3><p>尚持有 <strong>{money(value.holding.quantity)}</strong> 份，剩余投入 <strong>{money(value.holding.cost)}</strong> USDT。</p><p className="note">同一人员在这个方向的多次买入合并计算，尚未结算。</p></div>}
    {value.settlements.length > 0 && <div className="holding-summary"><h3>合并持仓结算</h3><p className="note">以下是这位跟单人同一方向合并持仓的结算结果，包含该笔买入；不是单笔买入的独立盈亏。</p><Table rows={value.settlements} columns={[["createdAt", "结算时间", time], ["revenue", "结算到账 · USDT", money], ["cost", "结算成本 · USDT", money], ["profit", "结算盈亏 · USDT", pnl]]}/></div>}
  </section></div>;
}
