import React, { useEffect, useRef, useState } from 'react';
import { request } from './api';
const defaults = { type: 'traders', version: 'v2', timePeriod: 'month', category: 'overall', orderBy: 'PNL', limit: 20, user: '', userName: '', bucketLimit: 30 };
const money = value => value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
export function followable(row) { return row.canFollow === true && /^0x[a-fA-F0-9]{40}$/.test(row.wallet || ''); }
export function boardParams(filters, navigation) {
  const params = { ...filters }; const index = navigation.index || 0;
  if (filters.version === 'v2' && filters.type !== 'builder-volume') { if (index && navigation.history[index]) params.cursor = navigation.history[index]; }
  else params.offset = index * Number(filters.limit);
  if (filters.type === 'builders' || filters.type === 'builder-volume') { delete params.category; delete params.orderBy; delete params.user; delete params.userName; }
  if (filters.type === 'wins') { delete params.orderBy; delete params.user; delete params.userName; }
  if (filters.version === 'v2') delete params.userName;
  if (filters.type !== 'builder-volume') delete params.bucketLimit;
  if (!params.user) delete params.user; if (!params.userName) delete params.userName;
  return params;
}
export function nextPage(navigation, result) {
  if (!result.hasMore) return navigation;
  const index = navigation.index + 1, history = navigation.history.slice(0, index);
  if (result.paginationKind === 'cursor') { if (!result.nextCursor) return navigation; history[index] = result.nextCursor; }
  return { index, history };
}
function safeLink(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'polymarket.com' ? url.href : null; } catch (_) { return null; } }
export default function Leaderboards({ onFollow }) {
  const [catalog, setCatalog] = useState(null), [draft, setDraft] = useState(defaults), [filters, setFilters] = useState(defaults);
  const [navigation, setNavigation] = useState({ index: 0, history: [''] }), [result, setResult] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), navigationBusy = useRef(false);
  useEffect(() => { let active = true; const abort = request('/leaderboards/catalog', null, (err, value) => { if (!active) return; if (err) setError(err.message); else setCatalog(value); }); return () => { active = false; if (abort) abort(); }; }, []);
  useEffect(() => {
    const current = ++generation.current; navigationBusy.current = true; setBusy(true); setError('');
    const params = boardParams(filters, navigation);
    if (refresh && navigation.index === 0) params.force = 'true';
    const abort = request('/leaderboards?' + new URLSearchParams(params), null, (err, value) => {
      if (current !== generation.current) return; navigationBusy.current = false; setBusy(false);
      if (err) return setError(err.message); setResult(value);
    });
    return () => { generation.current += 1; if (abort) abort(); };
  }, [filters, navigation, refresh]);
  const types = catalog?.types || [{ id: 'traders', label: '交易员排行榜', versions: ['v2', 'v1'] }, { id: 'wins', label: '单笔大额盈利榜', versions: ['v2'] }, { id: 'builders', label: '建设者排行榜', versions: ['v2', 'v1'] }, { id: 'builder-volume', label: '建设者成交趋势', versions: ['v2', 'v1'] }];
  const categories = catalog?.categories || [{ id: 'overall', label: '综合' }, { id: 'sports', label: '体育' }];
  const periods = catalog?.periods || [{ id: 'day', label: '日榜' }, { id: 'week', label: '周榜' }, { id: 'month', label: '月榜' }, { id: 'all', label: '总榜' }];
  const trader = draft.type === 'traders', categorized = trader || draft.type === 'wins';
  function change(key, value) { setDraft(old => { const next = { ...old, [key]: value }; if (key === 'type' && !types.find(item => item.id === value)?.versions.includes(next.version)) next.version = 'v2'; if (key === 'version' && value === 'v1' && next.category === 'combos') next.category = 'overall'; return next; }); }
  function submit(event) { event.preventDefault(); if(navigationBusy.current)return; navigationBusy.current=true; setBusy(true); setResult(null); setNavigation({ index: 0, history: [''] }); setFilters({ ...draft }); }
  function refreshBoard() { if(navigationBusy.current)return; navigationBusy.current=true; setBusy(true); setResult(null); setNavigation({ index: 0, history: [''] }); setRefresh(value => value + 1); }
  function navigate(forward){if(navigationBusy.current||!result)return;navigationBusy.current=true;setBusy(true);setResult(null);setNavigation(old=>forward?nextPage(old,result):({...old,index:old.index-1}));}
  const rows = result?.data || [], kind = filters.type;
  return <div className="boards-workspace">
    <form className="board-query" onSubmit={submit}>
      <label>榜单<select value={draft.type} onChange={event => change('type', event.target.value)}>{types.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>数据接口<select value={draft.version} onChange={event => change('version', event.target.value)}>{(types.find(item => item.id === draft.type)?.versions || ['v2']).map(version => <option key={version} value={version}>{version === 'v2' ? '新版官方接口' : '旧版官方接口'}</option>)}</select></label>
      <label>{draft.type === 'builder-volume' ? '时间粒度' : '时间范围'}<select value={draft.timePeriod} onChange={event => change('timePeriod', event.target.value)}>{periods.map(item => <option key={item.id} value={item.id}>{draft.type === 'builder-volume' ? ({day:'按日',week:'按周',month:'按月',all:'按年（新版）'})[item.id] : item.label}</option>)}</select></label>
      {categorized && <label>交易方向分类<select value={draft.category} onChange={event => change('category', event.target.value)}>{categories.filter(item => draft.version === 'v2' || item.id !== 'combos').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      {trader && <label>排序<select value={draft.orderBy} onChange={event => change('orderBy', event.target.value)}><option value="PNL">收益从高到低</option><option value="VOLUME">成交量从高到低</option></select></label>}
      <label>每页条数<select value={draft.limit} onChange={event => change('limit', Number(event.target.value))}><option value={20}>20</option><option value={50}>50</option></select></label>
      {trader && <label className="board-wallet-input">查询某个人的钱包<input value={draft.user} onChange={event => change('user', event.target.value.trim())} placeholder="可选，0x开头的公开地址"/></label>}
      {trader && draft.version === 'v1' && <label>查询用户名<input value={draft.userName} onChange={event => change('userName', event.target.value)} placeholder="可选"/></label>}
      {draft.type === 'builder-volume' && <label>最近时间桶数<input type="number" min="1" max="90" value={draft.bucketLimit} onChange={event => change('bucketLimit', Number(event.target.value))}/></label>}
      <div className="board-actions"><button type="submit" disabled={busy}>查询榜单</button><button type="button" className="secondary" disabled={busy} onClick={refreshBoard}>刷新当前榜单</button></div>
    </form>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="board-results"><div className="board-result-heading"><h2>{types.find(item => item.id === kind)?.label}</h2><span>{busy ? '正在查询…' : `第 ${navigation.index + 1} 页 · 本页 ${rows.length} 条`}</span></div>
      <p className="note">{kind === 'traders' ? '这里是 Polymarket 官方排名。选择交易员后，可以配置虚拟跟单；日、周、月榜收益可能含未结算估值变化。' : kind === 'wins' ? '每行是一笔获胜持仓，同一个人可能出现多次。选择的是该交易员，跟单从启用后新交易开始。' : '建设者是交易应用或渠道，不能作为交易员直接跟单。'}</p>
      {result && <p className="note">{result.volumeUnit === 'shares' ? '官方成交量单位：份数，不是投注金额。' : '成交量单位以当前官方接口为准。'} {result.paginationKind === 'local' ? '本页来自接口已返回数据的本地分页。' : result.paginationKind === 'standing' ? '当前展示此钱包的官方名次，无需翻页。' : '按官方接口返回结果翻页。'}</p>}
      <div className="table-scroll"><table><thead><tr><th>名次</th><th>{kind.startsWith('builder') ? '建设者' : '交易员'}</th>{kind === 'wins' ? <><th>获胜市场</th><th>投入金额</th><th>结算价值</th><th>盈利</th></> : <>{kind === 'traders' && <th>官方收益</th>}<th>官方成交量</th>{kind.startsWith('builder') && <th>活跃用户</th>}{kind === 'builder-volume' && <th>日期</th>}</>}<th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row,index) => <tr key={`${row.wallet || row.builderCode || row.id || index}:${index}`}>
        <td>{row.rank ?? '—'}</td><td><strong>{row.name || row.builderCode || '名称待取得'}</strong>{row.wallet && <small className="board-wallet" title={row.wallet}>{row.wallet.slice(0,8)}…{row.wallet.slice(-6)}</small>}</td>
        {kind === 'wins' ? <><td>{row.eventTitle || (row.kind === 'combo' ? '组合持仓' : '市场信息待取得')}{safeLink(row.officialUrl) && <a href={safeLink(row.officialUrl)} target="_blank" rel="noreferrer">查看市场 ↗</a>}</td><td>{money(row.initialValue)}</td><td>{money(row.finalValue)}</td><td className={Number(row.pnl)>0?'positive':'negative'}>{money(row.pnl)}</td></> : <>{kind === 'traders' && <td className={Number(row.pnl)>0?'positive':Number(row.pnl)<0?'negative':''}>{money(row.pnl)}</td>}<td>{money(row.volume)}</td>{kind.startsWith('builder') && <td>{money(row.activeUsers)}</td>}{kind === 'builder-volume' && <td>{row.date || '—'}</td>}</>}
        <td><div className="board-row-actions">{safeLink(row.profileUrl) && <a href={safeLink(row.profileUrl)} target="_blank" rel="noreferrer">官网资料 ↗</a>}{followable(row) && <button type="button" className="secondary" disabled={busy || !onFollow} onClick={() => {if(!navigationBusy.current)onFollow(row);}}>配置跟单</button>}</div></td>
      </tr>) : <tr><td colSpan={8} className="empty">{busy?'正在查询官方榜单…':error?'查询失败，请稍后重试':'当前筛选暂无记录'}</td></tr>}</tbody></table></div>
      <div className="pagination"><button className="secondary" disabled={busy || navigation.index===0} onClick={() => navigate(false)}>上一页</button><span>第 {navigation.index+1} 页{result?.total != null ? ` · 当前返回数据共 ${result.total} 条` : ''}</span><button className="secondary" disabled={busy || !result?.hasMore} onClick={() => navigate(true)}>下一页</button></div>
      {result?.endpoint && <p className="note">数据来源：{result.endpoint} · {result.fetchedAt ? new Date(result.fetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : ''}</p>}
    </section>
  </div>;
}
