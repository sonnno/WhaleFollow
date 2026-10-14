import React,{useState,useEffect,useCallback,useRef} from 'react';
import {request} from './api';
const money=value=>Number(value||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4});
const profit=value=><span className={Number(value)>0?'positive':Number(value)<0?'negative':''}>{Number(value)>0?'+':''}{money(value)}</span>;
const original=value=>value==null?'待补充':profit(value);
const totalQuery=(filter,offset)=>'?'+new URLSearchParams({from:filter.from,to:filter.to,limit:20,offset});
const taskQuery=(filter,offset)=>'?'+new URLSearchParams({...filter,limit:20,offset});
function ReportTable({rows=[],columns}){return <div className="table-scroll"><table><thead><tr>{columns.map(([key,label])=><th key={key}>{label}</th>)}</tr></thead><tbody>{rows.length?rows.map(row=><tr key={row.id}>{columns.map(([key,,render])=><td key={key}>{render?render(row[key],row):String(row[key]??'—')}</td>)}</tr>):<tr><td colSpan={columns.length} className="empty">暂无符合条件的日表。每天上午10点记录前一天，停机漏报会在恢复后补写。</td></tr>}</tbody></table></div>;}
function Pager({listing,offset,onPage}){return <div className="pagination"><span>共 {listing.total||0} 条 · 第 {Math.floor(offset/20)+1} 页</span><button className="secondary" disabled={!offset} onClick={()=>onPage(Math.max(0,offset-20))}>上一页</button><button className="secondary" disabled={offset+listing.data.length>=(listing.total||0)} onClick={()=>onPage(offset+20)}>下一页</button></div>;}
const ownColumns=[['day','日期'],['netProfit','当天净盈亏 · 含手续费',profit],['totalProfitEnd','截至日末累计净盈亏',profit],['buyCount','买入笔数'],['buyAmount','买入投入 · 含手续费',money],['saleCount','卖出笔数'],['settlementCount','结算记录数'],['fees','当天发生手续费',money]];
export default function DailyReports(){
 const [filter,setFilter]=useState({from:'',to:'',wallet:''}),[totalOffset,setTotalOffset]=useState(0),[taskOffset,setTaskOffset]=useState(0),[data,setData]=useState({}),[error,setError]=useState('');
 const version=useRef(0),pending=useRef(new Set()),errors=useRef(new Map());
 const load=useCallback(()=>{
  const current=version.current;
  const routes=[['/daily-reports',totalQuery(filter,totalOffset)],['/daily-task-reports',taskQuery(filter,taskOffset)],['/daily-report-traders','']];
  routes.forEach(([route,query])=>{
   if(pending.current.has(route))return;pending.current.add(route);
   request(route+query,null,(err,value)=>{
    if(current!==version.current)return;pending.current.delete(route);
    if(err)errors.current.set(route,err.message);else{errors.current.delete(route);setData(prior=>({...prior,[route]:{...value,queryKey:query}}));}
    setError(Array.from(errors.current.values()).join('；'));
   });
  });
 },[filter,totalOffset,taskOffset]);
 useEffect(()=>{version.current++;pending.current.clear();errors.current.clear();setError('');load();const timer=setInterval(load,10000);return()=>{version.current++;pending.current.clear();clearInterval(timer);};},[load]);
 const totals=data['/daily-reports']?.queryKey===totalQuery(filter,totalOffset)?data['/daily-reports']:{data:[],total:0},tasks=data['/daily-task-reports']?.queryKey===taskQuery(filter,taskOffset)?data['/daily-task-reports']:{data:[],total:0},traders=data['/daily-report-traders']?.data||[];
 return <>
  <p className="note">每天北京时间上午10点统计昨天00:00–24:00。我们的净盈亏计已卖出及最终结算，已扣对应买入和卖出手续费，不含未结算浮盈。充值和账户划转不算盈利。</p>
  <form className="filters daily-report-filters" onSubmit={event=>{event.preventDefault();setFilter(Object.fromEntries(new FormData(event.currentTarget)));setTotalOffset(0);setTaskOffset(0);}}>
   <label>开始日期<input name="from" type="date" defaultValue={filter.from}/></label><label>结束日期<input name="to" type="date" defaultValue={filter.to}/></label>
   <label>跟单人<select name="wallet" className="trader-filter" defaultValue={filter.wallet} key={filter.wallet}><option value="">全部跟单人</option>{filter.wallet&&!traders.some(row=>row.wallet===filter.wallet)&&<option value={filter.wallet}>{filter.wallet}</option>}{traders.map(row=><option key={row.wallet} value={row.wallet}>{row.name}</option>)}</select></label>
   <button>查询</button><button type="button" className="secondary" onClick={load}>刷新日表</button>
  </form>
  {error&&<div className="error" role="alert">{error}</div>}
  <section><div className="section-title"><h2>每日总账</h2><small>全钱包汇总 · 按日期查询</small></div><ReportTable rows={totals.data} columns={[...ownColumns,['cashEnd','日末剩余现金',money],['positionCostEnd','日末未结算投入',money]]}/><Pager listing={totals} offset={totalOffset} onPage={setTotalOffset}/></section>
  <section><div className="section-title"><h2>各跟单任务 · 每日盈亏</h2><small>按日期和跟单人查询 · 每10秒刷新</small></div>
   <ReportTable rows={tasks.data} columns={[
    ['day','日期'],['traderName','跟单人 / 任务'],...ownColumns.slice(1),
    ['leaderTradeProfit','原主当天已实现交易盈亏 · USDC',original],['leaderIncome','原主当天返利等收入 · USDC',original],
    ['leaderNetProfit','原主当天合计已实现盈亏 · USDC',original],['leaderTotalProfit','原主历史累计已实现盈亏 · USDC',original],
    ['leaderStatus','原主数据',(_,row)=>row.leaderStatus==='sampled'?<span>官方历史采样<small className="cell-note">原始间隔：{row.leaderEvidence?.sourceFidelity||'未知'}<br/>查询于 {new Date(row.leaderFetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></span>:<span>待补充<small className="cell-note">{row.leaderError?'官方数据暂不可用，后台自动重试':'后台正在查询'}</small></span>]
   ]}/><Pager listing={tasks} offset={taskOffset} onPage={setTaskOffset}/>
   <p className="note">原主数据来自 <a href="https://data-api.polymarket.com/v2/docs" target="_blank" rel="noreferrer">Polymarket 官方盈亏接口</a>，按北京时间两端的累计已实现数据相减；返利等收入单列，不含未结算估值。官方可能把每日历史采样铺到小时网格，金额只能代表其采样口径，不能当作逐笔精确结算账本。原主累计是其钱包历史总额，我们累计从本任务开始统计。当天手续费仅展示，已包含在对应净盈亏中，请勿再次扣减。</p>
  </section>
 </>;
}
