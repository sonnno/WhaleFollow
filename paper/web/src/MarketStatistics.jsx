/* explicit-ui-i18n */
import { t, translateHumanMessage, getIntlLocale, useLanguage } from './i18n';
import React,{useState,useEffect,useCallback,useRef} from 'react';
import {request} from './api';
import {marketFields} from './market-fields-view';
const initialFilter={wallet:'',keyword:'',category:'',profit:'',from:'',to:''};
const query=(filter,offset)=>'?'+new URLSearchParams({...filter,limit:20,offset});
const money=value=>Number(value||0).toLocaleString(getIntlLocale(),{minimumFractionDigits:2,maximumFractionDigits:4});
const profit=value=><span className={Number(value)>0?'positive':Number(value)<0?'negative':''}>{t(Number(value)>0?'+':'')}{t(money(value))}</span>;
const time=value=>value?new Date(value).toLocaleString(getIntlLocale(),{timeZone:'Asia/Shanghai',hour12:false}):'—';
export default function MarketStatistics({refreshVersion=0}){
 const [filter,setFilter]=useState(initialFilter),[offset,setOffset]=useState(0),[result,setResult]=useState(null),[traders,setTraders]=useState([]),[error,setError]=useState('');
 const version=useRef(0),pending=useRef(new Set()),errors=useRef(new Map());
 const key=query(filter,offset);
 const load=useCallback(()=>{
  const current=version.current;
  [['/market-statistics',query(filter,offset)],['/leaders','?limit=500']].forEach(([route,selection])=>{
   if(pending.current.has(route))return;pending.current.add(route);
   request(route+selection,null,(err,value)=>{
    if(current!==version.current)return;pending.current.delete(route);
    if(err)errors.current.set(route,err.message);else{errors.current.delete(route);if(route==='/leaders')setTraders(value.data||[]);else setResult({...value,queryKey:selection});}
    setError(Array.from(errors.current.values()).join('；'));
   });
  });
 },[filter,offset]);
 useEffect(()=>{version.current++;pending.current.clear();errors.current.clear();setError('');load();const timer=setInterval(load,10000);return()=>{version.current++;pending.current.clear();clearInterval(timer);};},[load,refreshVersion]);
 const ready=result?.queryKey===key,listing=ready?result:{data:[],total:0,summary:{profit:0,records:0}};
 const categories=Array.from(new Set([...(result?.categories||[]),...(filter.category?[filter.category]:[])]));
 return <section>
  <div className="section-title"><h2>{t("按市场统计 · 已结算")}</h2><small>{t("每页20个市场 · 每10秒刷新")}</small></div>
  <form className="filters market-statistics-filters" onSubmit={event=>{event.preventDefault();setFilter(Object.fromEntries(new FormData(event.currentTarget)));setOffset(0);}}>
   <label>{t("跟单人")}<select name="wallet" className="trader-filter" defaultValue={filter.wallet}><option value="">{t("全部跟单人")}</option>{filter.wallet&&!traders.some(row=>row.id===filter.wallet)&&<option value={filter.wallet}>{filter.wallet}</option>}{traders.map(row=><option key={row.id} value={row.id}>{row.name||t("未命名")}</option>)}</select></label>
   <label>{t("市场名称")}<input name="keyword" placeholder={t("输入赛事或市场名称")} defaultValue={filter.keyword}/></label>
   <label>{t("类型")}<select name="category" defaultValue={filter.category}><option value="">{t("全部类型")}</option>{categories.map(name=><option key={name} value={name}>{t(name)}</option>)}</select></label>
   <label>{t("盈亏")}<select name="profit" defaultValue={filter.profit}><option value="">{t("全部盈亏")}</option><option value="positive">{t("盈利")}</option><option value="negative">{t("亏损")}</option><option value="zero">{t("持平")}</option></select></label>
   <label>{t("结算开始日期")}<input name="from" type="date" defaultValue={filter.from}/></label><label>{t("结算结束日期")}<input name="to" type="date" defaultValue={filter.to}/></label>
   <button>{t("筛选")}</button>
  </form>
  <p className="note">{t("按市场合并最终结算记录，净盈亏已扣对应手续费；不包含未结算浮盈和提前卖出盈亏。日期按北京时间实际结算日期筛选，包含首尾两天。选择跟单人后只汇总该人的结算。")}</p>
  {error&&<div className="error" role="alert">{translateHumanMessage(error)}</div>}
  {ready&&<div className="market-statistics-summary"><span>{t("共")}<strong>{t(listing.total)}</strong>{t("个市场 ·")}<strong>{t(listing.summary.records)}</strong>{t("条结算记录")}</span><span>{t("筛选结果净盈亏 · USDT")}<strong>{t(profit(listing.summary.profit))}</strong></span></div>}
  {!ready?<p className="note">{translateHumanMessage(error?t("当前查询未成功，请重新筛选或刷新。"):t("正在查询市场统计…"))}</p>:<div className="table-scroll"><table><thead><tr><th>{t("市场")}</th><th>{t("类型 / 玩法 / 盘口 / 官网")}</th><th>{t("结算记录数")}</th><th>{t("投入成本 · 含费")}</th><th>{t("结算收入")}</th><th>{t("结算净盈亏")}</th><th>{t("最近结算时间 · 北京时间")}</th></tr></thead><tbody>{listing.data.length?listing.data.map(row=>{const fields=marketFields(row);return <tr key={row.condition}><td className="bet-market" title={row.title}>{row.title}</td><td><div className="market-info"><strong>{t(row.category)}</strong><span>{t("玩法：")}{t(fields.play)}</span><span>{t("盘口：")}{t(fields.line)}</span>{fields.subject&&<span>{t("投注对象：")}{fields.subject}</span>}{row.officialUrl?<a className="official-link" href={row.officialUrl} target="_blank" rel="noreferrer">{t("查看官网 ↗")}</a>:<span>{t("官网链接待更新")}</span>}</div></td><td>{t(row.count)}</td><td>{t(money(row.cost))}</td><td>{t(money(row.revenue))}</td><td>{t(profit(row.profit))}</td><td>{t(time(row.lastSettledAt))}</td></tr>;}):<tr><td colSpan={7} className="empty">{t("暂无符合筛选条件的已结算市场。")}</td></tr>}</tbody></table></div>}
  <div className="pagination"><span>{t(ready?t("共 ")+listing.total+t(" 个市场 · "):'')}{t("第")}{t(Math.floor(offset/20)+1)}{t("页")}</span><button className="secondary" disabled={!ready||!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>{t("上一页")}</button><button className="secondary" disabled={!ready||offset+listing.data.length>=listing.total} onClick={()=>setOffset(offset+20)}>{t("下一页")}</button></div>
 </section>;
}
