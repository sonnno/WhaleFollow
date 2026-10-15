/* explicit-ui-i18n */
import { t, translateHumanMessage, getIntlLocale, useLanguage } from './i18n';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { request } from './api';
import OrderDetail, { readableReason, executionTime, comparisonDelay } from './OrderDetail';
import Leaderboards from './Leaderboards';
import FollowTasks from './FollowTasks';
import DailyReports from './DailyReports';
import MarketStatistics from './MarketStatistics';
import LanguageSwitcher from './LanguageSwitcher';
import {marketFields} from './market-fields-view';

const pages = [['overview', '总览'], ['leaderboards', '排行榜'], ['follow-tasks', '跟单任务'], ['copies', '跟单明细'], ['positions', '持仓'], ['settlements', '结算记录'], ['analytics', '盈亏统计'], ['daily', '日表'], ['system', '系统设置']];
const money = value => Number(value || 0).toLocaleString(getIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const time = value => value ? new Date(value).toLocaleString(getIntlLocale(), { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const short = value => value && value.length > 18 ? value.slice(0, 8) + '…' + value.slice(-6) : value || '—';
const pnl = value => <span className={Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : ''}>{t(Number(value) > 0 ? '+' : '')}{t(money(value))}</span>;
const status = { FILLED: '已成交', PARTIAL: '部分成交', SKIPPED: '已跳过', WAITING: '等待跟单', BUY: '买入', SELL: '卖出' };
const taskNames = { inventory: '持仓核对', trades: '成交查询', 'activity-trigger': '成交通知核对', activity: '交易通知', leaderboard: '榜单刷新', settlement: '结算核对', copy: '模拟跟单', 'daily-report': '每日盈亏日表' };
const marketCell = (value, row) => <div className="bet-market" title={value || row.details?.signal?.title}>{marketFields({...row,title:value||row.title||row.details?.signal?.title}).event}</div>;
const originalAmountColumn=['sourceAmount','原主成交金额 · 不含费',value=>value==null?t("暂未取得"):money(value)];
const ownAmountColumn=['gross','我们成交金额 · 不含费',(value,row)=>row.copyTime?<span>{t(money(value))}<small className="cell-note">{t(row.side==='SELL'?t("扣费到账"):t("含费支出"))} {t(money(row.amount))}</small></span>:t("尚未成交")];
const sourcePriceColumn=['sourcePrice','原主成交价（赔率）',value=>value==null?t("暂未取得"):money(value)];
const ownPriceColumn=['averagePrice','我们成交价（赔率）',(value,row)=>row.copyTime&&value!=null?money(value):t("尚未成交")];
const sourceTimeColumn=['sourceTime','原主成交时间 · 北京时间',executionTime];
const copyTimeColumn=['copyTime','我们成交时间 · 北京时间',(value,row)=>value?row.copyClock==='legacy-database'?t("暂无准确时间"):executionTime(value):t("尚未成交")];
const delayColumn=['executionDelay','成交时间差',(_,row)=>row.copyTime?comparisonDelay(row):t("尚未成交")];
const directionColumn=['outcome','买入 / 卖出方向',(value,row)=>marketFields(row).direction];
const marketInfoColumn = ['category', '类型 / 玩法 / 盘口 / 官网', (value, row) => {const fields=marketFields(row);return <div className="market-info"><strong>{t(value || t("分类待更新"))}</strong><span>{t("玩法：")}{t(fields.play)}</span><span>{t("盘口：")}{t(fields.line)}</span>{fields.subject&&<span>{t("投注对象：")}{fields.subject}</span>}{row.officialUrl ? <a className="official-link" href={row.officialUrl} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{t("查看官网 ↗")}</a> : <span className="cell-note">{t("官网链接待更新")}</span>}</div>; }];

function WorkerNotice({ worker }) {
  const incident = worker?.lastError || worker?.lastIncident;
  if (!incident) return null;
  const recovered = !worker.lastError && incident.recoveredAt;
  const connectionError = /TLS|socket|timed out|backoff/i.test(incident.message);
  return <div><p className={recovered ? 'positive' : 'negative'}>{t(taskNames[incident.task] || incident.task)}：{translateHumanMessage(recovered ? t("已恢复（{0}）", {0: time(incident.recoveredAt)}) : `${connectionError ? t("接口连接中断或暂缓，等待重试") : incident.message}（${time(incident.at)}）`)}</p><details><summary>{t("最近异常详情")}</summary><p>{t(time(incident.at))} · {translateHumanMessage(incident.message)}</p></details></div>;
}

function Chart({ rows = [], field = 'equity' }) {
  if (rows.length < 2) return <div className="empty-chart">{t("等待结算记录，结算后显示盈亏变化")}</div>;
  const values = rows.map(row => Number(row[field]));
  const min = Math.min(...values), max = Math.max(...values), range = max - min || Math.max(1, max * 0.001);
  const points = values.map((value, index) => `${48 + index / (values.length - 1) * 824},${188 - (value - min) / range * 152}`).join(' ');
  return <div className="chart"><svg viewBox="0 0 900 235" role="img" aria-label={t("已结算净盈亏曲线")}><line x1="48" x2="872" y1="188" y2="188" className="grid-line"/><line x1="48" x2="872" y1="112" y2="112" className="grid-line"/><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5"/><text x="48" y="22">{t(money(max))} USDT</text><text x="48" y="220">{t(time(rows[0].createdAt))}</text><text x="872" y="220" textAnchor="end">{t(time(rows[rows.length - 1].createdAt))}</text></svg></div>;
}
export function Table({ columns, rows = [], onRow, emptyText = t("暂无记录。Worker 采集到新的有效信号后，记录将显示在这里。") }) {
  return <div className="table-scroll"><table><thead><tr>{columns.map(([key, label]) => <th key={key}>{t(label)}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={row.id || index} onClick={() => onRow && onRow(row)} className={onRow ? 'clickable' : ''}>{columns.map(([key, , render]) => <td key={key}>{render ? render(row[key], row) : (["category","marketType","outcome","status","state","fundingMode","label"].includes(key) ? t(String(row[key] ?? '—')) : String(row[key] ?? '—'))}</td>)}</tr>) : <tr><td colSpan={columns.length} className="empty">{t(emptyText)}</td></tr>}</tbody></table></div>;
}
export function Login({ onLogin }) {
  useLanguage();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  function submit(event) {
    event.preventDefault(); setBusy(true); const data = new FormData(event.currentTarget);
    request('/login', { username: data.get('username'), password: data.get('password') }, (err, user) => { setBusy(false); if (err) setError(err.message); else onLogin(user); });
  }
  return <main className="login"><div className="login-language"><LanguageSwitcher /></div><form onSubmit={submit}><span className="eyebrow">POLYMARKET · PAPER TRADING</span><h1>{t("虚拟跟单后台")}</h1><p>{t("查看下注记录与已结算盈亏")}</p><label>{t("用户名")}<input name="username" defaultValue="admin" autoComplete="username" required/></label><label>{t("密码")}<input name="password" type="password" autoComplete="current-password" required/></label>{error && <div className="error" role="alert">{translateHumanMessage(error)}</div>}<button disabled={busy}>{t(busy ? t("登录中…") : t("登录后台"))}</button><small>{t("本地管理员凭证保存在项目 .env 文件中")}</small></form></main>;
}
export default function App() {
  useLanguage();
  const [user, setUser] = useState(undefined), [page, setPage] = useState('overview'), [data, setData] = useState({}), [error, setError] = useState(''), [detail, setDetail] = useState(null), [filter, setFilter] = useState({ wallet: '', condition: '', status: '', from: '', to: '' }), [offset, setOffset] = useState(0);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [followSelection, setFollowSelection] = useState(null);
  const [refreshVersion,setRefreshVersion]=useState(0);
  const requestVersion = useRef(0);
  const pendingRequests = useRef(new Set()), routeErrors = useRef(new Map());
  useEffect(() => { request('/me', null, (err, value) => setUser(err ? null : value)); }, []);
  const load = useCallback(() => {
    if (!user) return;
    const version = requestVersion.current;
    const routes = ['leaderboards', 'follow-tasks','daily','analytics'].includes(page) ? [] : page === 'overview' ? ['/cash-summary'] : page === 'system' ? ['/settings', '/health'] : [page === 'copies' ? '/paper-orders' : '/' + page];
    if (['copies', 'positions', 'settlements'].includes(page)) routes.push('/leaders');
    if (!routes.includes('/settings')) routes.push('/settings');
    routes.forEach(route => {
      const query = route === '/leaders' ? '?limit=500' : ['copies', 'positions', 'settlements'].includes(page) ? '?' + new URLSearchParams({ ...filter, ...(page === 'positions' ? { open: 'true' } : {}), limit: 100, offset }) : '';
      if (pendingRequests.current.has(route)) return;
      pendingRequests.current.add(route);
      request(route + query, null, (err, value) => {
        if (version !== requestVersion.current) return;
        pendingRequests.current.delete(route);
        if (err) { if (err.status === 401) setUser(null); routeErrors.current.set(route, err.message); }
        else { routeErrors.current.delete(route); setData(prior => ({ ...prior, [route]: value })); }
        setError(Array.from(routeErrors.current.values()).join('；'));
      });
    });
  }, [user, page, filter, offset]);
  useEffect(() => {
    requestVersion.current += 1;
    pendingRequests.current.clear(); routeErrors.current.clear(); setError('');
    load();
    if (!user) return;
    const stream = new EventSource('/api/events');
    stream.addEventListener('refresh', load);
    const interval = setInterval(load, 10000);
    return () => { requestVersion.current += 1; stream.close(); clearInterval(interval); pendingRequests.current.clear(); };
  }, [load, user]);
  if (user === undefined) return <main className="loading">{t("正在连接后台…")}</main>;
  if (!user) return <Login onLogin={setUser}/>;
  const cashStats = data['/cash-summary'], settings = data['/settings'], health = data['/health'];
  const route = page === 'copies' ? '/paper-orders' : page === 'daily' ? '/daily-reports' : '/' + page;
  const listing = data[route] || { data: [] };
  const traders = data['/leaders']?.data || [];
  function openOrder(row) { request('/paper-orders/' + encodeURIComponent(row.id), null, (err, result) => { if (err) setError(err.message); else setDetail({ ...result, bet: row }); }); }
  function pause(key) { if (pauseBusy || !settings) return; setPauseBusy(true); request('/settings', { [key]: !settings.runtime[key] }, (err, value) => { setPauseBusy(false); if (err) setError(err.message); else { setData(prior => ({ ...prior, '/settings': { ...prior['/settings'], runtime: value.runtime } })); load(); } }); }
  return <div className="shell">
    <aside><div className="brand">POLY<span>TRACK</span><small>{t("跟单后台 1.0")}</small></div><nav>{pages.map(([key, label]) => <button key={key} className={page === key ? 'selected' : ''} onClick={() => { setPage(key); setOffset(0); setDetail(null); }}>{t(label)}</button>)}</nav><div className="sidebar-foot"><span className="paper-label">PAPER MODE</span><p>{t("所有资金与成交均为模拟")}</p><button onClick={() => request('/logout', {}, () => setUser(null))}>{t("退出登录")}</button></div></aside>
    <main><header><div><span className="eyebrow">{t("虚拟跟单 · 买卖与结算")}</span><h1>{t(pages.find(item => item[0] === page)[1])}</h1></div><div className="header-right">{page === 'overview' && settings && <button disabled={pauseBusy} className={settings.runtime.pauseBuys ? '' : 'secondary'} onClick={() => pause('pauseBuys')}>{t(pauseBusy ? t("正在保存…") : settings.runtime.pauseBuys ? t("恢复买入") : t("暂停所有买入"))}</button>}<span className="paper-label">{t("虚拟资金")}</span><button className="secondary" onClick={()=>{load();setRefreshVersion(value=>value+1);}}>{t("刷新")}</button></div></header>{error && <div className="error" role="alert">{translateHumanMessage(error)}</div>}
      {page === 'leaderboards' && <Leaderboards onFollow={row => { setFollowSelection(row); setPage('follow-tasks'); setDetail(null); }}/>}
      {page === 'follow-tasks' && <FollowTasks selection={followSelection} onSelectionConsumed={() => setFollowSelection(null)} onOrders={wallet => { setFilter(prior => ({ ...prior, wallet })); setOffset(0); setPage('copies'); }}/>}
      {page === 'overview' && cashStats && <>
        <div className="overview-metrics">
          <div><span>{t("剩余现金 · USDT")}</span><strong>{t(money(cashStats.cash))}</strong></div>
          <div><span>{t("总盈亏 · USDT")}</span><strong>{t(pnl(cashStats.totalProfit))}</strong><small>{t("已结算及已卖出，不含未结算浮盈")}</small></div>
          <div><span>{t("未结算笔数")}</span><strong>{t(cashStats.pendingBets)}<em>{t("笔")}</em></strong></div>
          <div><span>{t("未结算投入 · USDT")}</span><strong>{t(money(cashStats.pendingCost))}</strong><small>{t("剩余持仓的实际成本，含费用")}</small></div>
        </div>
        <section className="wallet-balances"><h2>{t("钱包余额与预警")}</h2>
          {(cashStats.walletBalances || []).some(row => row.warning?.insufficient === true) && <p className="wallet-balance-alert" role="alert">{cashStats.walletBalances.filter(row => row.warning?.insufficient === true).map((row,index)=><React.Fragment key={row.id}>{index ? ", " : ""}{walletName(row)}</React.Fragment>)}{t("：下单余额不足。")}</p>}
          <Table rows={cashStats.walletBalances || []} columns={[["name",t("账户"),(value,row)=>walletName(row)],["cash",t("可用现金 · USDT"),money],["warning",t("余额预警"),value => value?.insufficient === true ? <span className="negative">{t("下单余额不足")}</span> : <span className="note">{t("未触发预警")}</span>]]}/>
          <p className="note">{t("预警由下单时余额不足触发；该账户下单成功后解除。余额不足的尝试不生成订单。")}</p>
        </section>
        <p className="note">{t("总盈亏包含已卖出及已结算的实际盈亏，已扣对应手续费。下面按最终结算记录统计，不计未结算浮盈。")}</p>
        <section><h2>{t("已结算净盈亏历史")}</h2><Chart rows={cashStats.history} field="settledProfit"/></section>
        <section><h2>{t("按人员统计 · 已结算")}</h2><Table rows={cashStats.leaders} columns={[["name",t("人员")],["count",t("结算记录数")],["profit",t("结算净盈亏"),pnl]]}/></section>
        <section><h2>{t("每日已结算盈亏")}</h2><p className="note">{t("每天北京时间10点统计前一天，生成后金额固定；未生成的日期不显示。")}</p><Table rows={cashStats.days} columns={[["day",t("日期")],["profit",t("净盈亏"),pnl]]}/></section>
      </>}
      {page === 'daily' && <DailyReports/>}
      {page === 'leaders' && <><p className="note">{t(settings?.config?.followWallets?.length ? t("只跟选定人员，不随月榜名次变化切换跟单。") : t("官方月度 PNL 包含持仓估值变化。离榜后停止跟买，已有虚拟仓位继续管理。"))}</p><Table rows={listing.data} columns={[["rank", t("月榜名次")], ["name", t("人员")], ["id", t("钱包"), value => <code title={value}>{t(short(value))}</code>], ["pnl", t("官方月度 PNL"), pnl], ["active", t("跟单状态"), value => value ? <span className="positive">{t("跟买中")}</span> : t("仅管理已有仓位")], ["inventoryValid", t("库存基线"), value => value ? t("已核对") : t("待核对")], ["joinedAt", t("本次加入"), time]]}/></>}
      {['copies', 'positions', 'settlements'].includes(page) && <>
        <form className="filters" onSubmit={event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); ['from', 'to'].forEach(key => { if (values[key]) values[key] = new Date(values[key]).toISOString(); }); setFilter(values); setOffset(0); }}>
          <select name="wallet" aria-label={t("跟单人")} className="trader-filter" key={page+filter.wallet} defaultValue={filter.wallet}>
            <option value="">{t("全部跟单人")}</option>
            {filter.wallet && !traders.some(row=>row.id===filter.wallet) && <option value={filter.wallet}>{short(filter.wallet)}</option>}
            {traders.map(row=><option key={row.id} value={row.id}>{row.name || t("未命名")}（{short(row.id)}）</option>)}
          </select>
          <input name="condition" placeholder="Condition ID" defaultValue={filter.condition}/>{page === 'copies' && <select name="status" defaultValue={filter.status}><option value="">{t("全部状态")}</option><option value="FILLED">{t("已成交")}</option><option value="PARTIAL">{t("部分成交")}</option><option value="SKIPPED">{t("已跳过")}</option></select>}<input aria-label={t("开始时间")} name="from" type="datetime-local"/><input aria-label={t("结束时间")} name="to" type="datetime-local"/><button>{t("筛选")}</button><a className="export" href={'/api/export/' + page + '?' + new URLSearchParams(filter)}>{t("导出当前筛选前 500 条")}</a>
        </form>
        {page === 'copies' && <Table rows={listing.data} onRow={openOrder} columns={[["traderName", t("跟单人员")], ["title", t("赛事 / 预测事件"), marketCell], marketInfoColumn, directionColumn, ["side", t("操作"), value => t(status[value])], ["status", t("状态"), value => <span className="tag">{t(status[value] || t("处理中"))}</span>], originalAmountColumn, ownAmountColumn, sourcePriceColumn, ownPriceColumn, sourceTimeColumn, copyTimeColumn, delayColumn, ["quantity", t("成交份额"), money], ["fee", t("费用 · USDT"), money], ["reason", t("说明"), (value, row) => ['SKIPPED', 'WAITING'].includes(row.status) ? readableReason(value) : '—']]}/>}
        {page === 'positions' && <Table rows={listing.data} columns={[["title", t("未结算市场"), marketCell], marketInfoColumn, ["traderName", t("跟单人员")], ["outcome", t("下注方向")], ["quantity", t("剩余份额"), money], ["cost", t("未结算投入 · 含费"), money]]}/>}
        {page === 'settlements' && <Table rows={listing.data} columns={[["createdAt", t("结算时间"), time], ["title", t("市场"), marketCell], marketInfoColumn, ["outcome", t("下注方向")], ["traderName", t("跟单人员")], ["quantity", t("结算份额"), money], ["payout", t("每份兑付"), money], ["revenue", t("结算收入"), money], ["cost", t("投入成本"), money], ["profit", t("净利润"), pnl]]}/>}
        <div className="pagination"><span>{t("共")}{t(listing.total || 0)}{t("条 · 当前")}{t(offset + 1)}–{t(offset + listing.data.length)}</span><button className="secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>{t("上一页")}</button><button className="secondary" disabled={offset + listing.data.length >= (listing.total || 0)} onClick={() => setOffset(offset + 100)}>{t("下一页")}</button></div>
      </>}
      {page === 'analytics' && <MarketStatistics refreshVersion={refreshVersion}/>}
      {page === 'system' && settings && <><LanguageSettings /><section><h2>{t("跟单开关")}</h2><div className="actions"><button className={settings.runtime.pauseBuys ? '' : 'secondary'} onClick={() => pause('pauseBuys')}>{t(settings.runtime.pauseBuys ? t("恢复买入") : t("暂停所有买入"))}</button><button className={settings.runtime.pauseAll ? '' : 'secondary'} onClick={() => pause('pauseAll')}>{t(settings.runtime.pauseAll ? t("恢复模拟买卖") : t("暂停模拟买卖"))}</button></div><p className="note">{t("暂停后仍会查询交易和结算结果。恢复后继续跟新单，不补做暂停期间的买入。")}</p></section><section className="settings-table"><h2>{t("跟单设置")}</h2><Table rows={[
        { label: t("模式"), value: t("虚拟跟单") }, { label: t("跟单人员"), value: settings.config.followWallets?.length ? t("只跟指定人员（见跟单人员页）") : t("月度盈亏榜前 10 名") },
        { label: t("跟买金额"), value: settings.config.copySizing === 'fixed_ratio' ? t("按对方成交金额的 {0}% 买入，手续费另计",{0:money(Number(settings.config.copyRatio) * 100)}) : t("按被跟人员本人实际成交金额，1:1 等额买入") },
        { label: t("虚拟本金"), value: money(settings.config.initialCash) + ' USDT' },
        { label: t("跟单方式"), value: t("跟着买卖，按当前盘口模拟成交") },
        { label: t("暂时无法成交"), value: t("立即尝试，累计3次后结束；余额不足不生成订单") },
        { label: t("榜单更新间隔"), value: settings.config.leaderboardSeconds / 60 + t(" 分钟") }, { label: t("交易通知"), value: t("WebSocket实时推送，不补旧买单") },
        { label: t("结算查询间隔"), value: settings.config.settlementSeconds + t(" 秒") }
      ]} columns={[["label", t("设置")], ["value", t("当前值")]]}/></section><section><h2>{t("运行状态")}</h2><Table rows={[
        { label: t("后台数据库"), value: health?.database ? t("已连接") : t("未连接") },
        { label: t("成交通知"), value: health?.worker?.activityConnected ? t("已连接") : t("正在重连，定时查询继续运行") },
        { label: t("行情通知"), value: health?.worker?.market?.connected ? t("已连接") : t("正在重连，定时查询继续运行") },
        { label: t("最近查询交易"), value: time(health?.worker?.lastTradePoll) }, { label: t("最近核对结算"), value: time(health?.worker?.lastSettlement) },
        { label: t("状态更新时间"), value: time(health?.workerUpdatedAt) }
      ]} columns={[["label", t("项目")], ["value", t("状态")]]}/>{health?.worker?.lastError && <p className="note">{t("最近一次查询遇到连接或处理问题，系统会按间隔重试。")}</p>}</section></>}
      <footer>{t("虚拟资金，全部成交与结算由本系统模拟记录。")}</footer>
    </main>
    {detail && <OrderDetail value={detail} onClose={() => setDetail(null)} money={money} time={time} pnl={pnl} Table={Table}/>}
  </div>;
}

export function LanguageSettings(){useLanguage();return <section className="language-settings"><h2>{t("界面语言")}</h2><LanguageSwitcher /><p className="note">{t("语言选择保存在当前浏览器，不影响跟单任务。")}</p></section>;}

export function walletName(row){if(row.id==="total")return t("总钱包");if(row.id==="shared")return t("公共钱包");return <>{String(row.name||"").replace(/ · 独立钱包$/,"")} · {t("独立钱包")}</>;}
