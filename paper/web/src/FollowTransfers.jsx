import React, { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { formatBalance as money } from './money-format';
export function transferIntent(wallet,direction,amount,previous,generate=()=>crypto.randomUUID(),taskVersion='initial'){
 const payload={direction,amount:String(amount).trim(),taskVersion};
 if(!['in','out'].includes(direction)||!Number.isFinite(Number(payload.amount))||Number(payload.amount)<=0)throw new Error('请输入大于0的划转金额');
 const fingerprint=JSON.stringify([wallet,direction,payload.amount,taskVersion]);
 if(previous?.fingerprint===fingerprint)return previous;
 return{fingerprint,payload:{...payload,requestId:generate()}};
}
const intentKey=wallet=>'paper:pending-fund-transfer:'+wallet;
export function readTransferIntent(wallet,storage){
 const text=storage.getItem(intentKey(wallet));if(!text)return null;
 let value;try{value=JSON.parse(text);}catch(_){return null;}
 if(!value||!value.payload||typeof value.payload.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(value.payload.requestId))return null;
 if(value.payload.taskVersion===undefined&&value.fingerprint===JSON.stringify([wallet,value.payload.direction,value.payload.amount])){value.payload.taskVersion='initial';value.fingerprint=JSON.stringify([wallet,value.payload.direction,value.payload.amount,'initial']);}
 if(value.fingerprint!==JSON.stringify([wallet,value.payload.direction,value.payload.amount,value.payload.taskVersion]))return null;
 return value;
}
export function storeTransferIntent(wallet,direction,amount,storage,generate,taskVersion='initial'){const pending=transferIntent(wallet,direction,amount,readTransferIntent(wallet,storage),generate,taskVersion);storage.setItem(intentKey(wallet),JSON.stringify(pending));return pending;}
export function acknowledgeTransferIntent(wallet,pending,storage){if(readTransferIntent(wallet,storage)?.payload.requestId===pending.payload.requestId)storage.removeItem(intentKey(wallet));}
export default function FollowTransfers({task,publicCash,onClose,onChanged}){
 const [direction,setDirection]=useState('in'),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState(null),[offset,setOffset]=useState(0),[loading,setLoading]=useState(false);
 const alive=useRef(true),inFlight=useRef(false),version=useRef(0),historyVersion=useRef(0);
 function load(page=0){const current=version.current,sequence=++historyVersion.current;setLoading(true);request('/follow-tasks/'+encodeURIComponent(task.wallet)+'/transfers?limit=20&offset='+page,null,(err,value)=>{if(!alive.current||current!==version.current||sequence!==historyVersion.current)return;setLoading(false);if(err)return setError(err.message);setHistory(value);setOffset(page);});}
 useEffect(()=>{alive.current=true;version.current++;setAmount('');setDirection('in');setError('');setNotice('');setHistory(null);setOffset(0);try{const pending=readTransferIntent(task.wallet,sessionStorage);if(pending){if(pending.payload.taskVersion!==(task.taskVersion||'initial')){acknowledgeTransferIntent(task.wallet,pending,sessionStorage);setNotice('任务已重新创建，旧划转请求已作废，请填写新的金额。');}else{setAmount(pending.payload.amount);setDirection(pending.payload.direction);setNotice('上次划转尚未确认，已恢复原金额和方向；重试不会重复扣款。');}}}catch(_){setError('浏览器无法保存划转请求，请启用当前页面的会话存储后操作。');}load(0);document.getElementById('follow-transfer-panel')?.scrollIntoView({behavior:'smooth',block:'start'});return()=>{alive.current=false;version.current++;};},[task.wallet,task.taskVersion]);
 function submit(event){event.preventDefault();if(inFlight.current)return;let pending;try{pending=storeTransferIntent(task.wallet,direction,amount,sessionStorage,undefined,task.taskVersion||'initial');}catch(err){setError('未提交划转：'+err.message);return;}
   inFlight.current=true;setBusy(true);setError('');setNotice('');const current=version.current;
   request('/follow-tasks/'+encodeURIComponent(task.wallet)+'/transfers',pending.payload,(err,result)=>{inFlight.current=false;if(!alive.current||current!==version.current)return;setBusy(false);if(err){setError(err.message+'。重试相同划转会使用同一请求ID。');return;}try{acknowledgeTransferIntent(task.wallet,pending,sessionStorage);}catch(_){/* Confirmed intent can safely be replayed if local storage could not be cleared. */}setAmount('');setNotice((result.duplicate?'这笔划转已处理，不会重复扣款。':'已'+(direction==='in'?'转入独立账户 ':'转出至公共钱包 ')+money(result.transfer.amount)+' USDT。')+'投入上限没有改变。');onChanged?.();load(0);});
 }
 return <section className="follow-task-editor transfer-panel" id="follow-transfer-panel"><div className="board-result-heading"><h2>{task.name} · 独立账户划转</h2><button type="button" className="secondary" onClick={onClose} disabled={busy}>关闭</button></div>
   <div className="transfer-balances"><span>账户资金合计 · 按成本 <strong title={task.accountFunds}>{task.accountFunds==null?'待读取':money(task.accountFunds)}</strong></span><span>账户现金 · 尚未投入 <strong title={task.cash}>{money(task.cash)}</strong></span><span>未结算投入 · 含费 <strong title={task.positionCost}>{money(task.positionCost)}</strong></span><span>公共钱包可转入现金 <strong title={publicCash}>{money(publicCash)}</strong></span></div>
   <p className="note">已记录转入 {task.recordedTransferredIn==null?'流水待补':money(task.recordedTransferredIn)} · 已记录转出 {task.recordedTransferredOut==null?'流水待补':money(task.recordedTransferredOut)} USDT。投入上限 {money(task.allocation)} USDT，修改上限不会增加账户资金。划转统计按已保留的流水累计。</p>
   {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="positive" role="status">{notice}</p>}
   <form onSubmit={submit} className="transfer-form"><label>划转方向<select value={direction} disabled={busy} onChange={event=>{setDirection(event.target.value);setNotice('');}}><option value="in">公共钱包 → 独立账户</option><option value="out">独立账户 → 公共钱包</option></select></label><label>划转金额 · USDT<input type="number" min="0.000000000000000001" step="any" value={amount} onChange={event=>{setAmount(event.target.value);setNotice('');}} disabled={busy} required placeholder="填写本次划转金额"/></label><button disabled={busy}>{busy?'正在划转…':direction==='in'?'转入独立账户':'转出到公共钱包'}</button><button type="button" className="secondary" disabled={busy||Number(task.cash)<=0} onClick={()=>{setDirection('out');setAmount(String(task.cash));setNotice('已填写全部闲置现金，点击“转出到公共钱包”提交。');}}>填写全部转出金额</button></form>
   <p className="note">转入才会增加此账户现金；转出只能使用尚未投入的现金。账户资金合计按现金＋未结算投入成本计算，不是市价估值。划转不改变投入上限、不算盈亏。</p>
   <h3>划转记录</h3><div className="table-scroll"><table><thead><tr><th>时间</th><th>方向</th><th>金额 · USDT</th><th>独立现金：划转前 → 后</th><th>公共现金：划转前 → 后</th></tr></thead><tbody>{history?.data.length?history.data.map(row=><tr key={row.id}><td>{new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</td><td>{row.direction==='in'?'转入独立账户':'转出至公共钱包'}</td><td title={row.amount}>{money(row.amount)}</td><td title={row.cashBefore+' → '+row.cashAfter}>{money(row.cashBefore)} → {money(row.cashAfter)}</td><td title={row.publicCashBefore+' → '+row.publicCashAfter}>{money(row.publicCashBefore)} → {money(row.publicCashAfter)}</td></tr>):<tr><td colSpan={5} className="empty">{loading?'正在读取流水…':'暂无划转记录'}</td></tr>}</tbody></table></div>
   <div className="board-pagination"><button type="button" className="secondary" disabled={loading||offset===0} onClick={()=>load(Math.max(0,offset-20))}>上一页流水</button><span>共 {history?.total||0} 笔 · 第 {Math.floor(offset/20)+1} 页</span><button type="button" className="secondary" disabled={loading||!history||offset+20>=history.total} onClick={()=>load(offset+20)}>下一页流水</button></div>
 </section>;
}
