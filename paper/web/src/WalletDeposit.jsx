/* explicit-ui-i18n */
import React, { useEffect, useRef, useState } from 'react';
import { t, translateHumanMessage, getIntlLocale } from './i18n';
import { request } from './api';
import { requestId } from './request-id';
import { formatBalance as money } from './money-format';
const pendingKey='paper:pending-wallet-deposit';
function canonical(value){const match=/^(\d+)(?:\.(\d*))?$/.exec(String(value).trim());if(!match)throw Error(t('请输入大于0的充值金额'));const whole=match[1].replace(/^0+(?=\d)/,''),fraction=(match[2]||'').replace(/0+$/,'');if(whole==='0'&&!fraction)throw Error(t('请输入大于0的充值金额'));return whole+(fraction?'.'+fraction:'');}
export function readDeposit(storage){const raw=storage.getItem(pendingKey);if(!raw)return null;const value=JSON.parse(raw);if(!/^[a-zA-Z0-9_-]{8,128}$/.test(value.requestId)||canonical(value.amount)!==value.amount)throw Error(t('充值请求记录损坏，请先核对充值记录'));return value;}
export function depositIntent(amount,storage,generate=requestId){const value=canonical(amount),previous=readDeposit(storage);if(previous){if(previous.amount!==value)throw Error(t('上次充值尚未确认，请先重试确认'));return previous;}const result={amount:value,requestId:generate()};storage.setItem(pendingKey,JSON.stringify(result));return result;}
export function acknowledgeDeposit(intent,storage){if(readDeposit(storage)?.requestId===intent.requestId)storage.removeItem(pendingKey);}
export default function WalletDeposit({onClose,onChanged}){
  const [amount,setAmount]=useState(''),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState(null),[offset,setOffset]=useState(0),[loading,setLoading]=useState(false);
  const alive=useRef(true),sending=useRef(false),sequence=useRef(0);
  function load(page=0){const version=++sequence.current;setLoading(true);request('/wallet/deposits?limit=20&offset='+page,null,(err,value)=>{if(!alive.current||sequence.current!==version)return;setLoading(false);if(err)return setError(err.message);setHistory(value);setOffset(page);});}
  useEffect(()=>{alive.current=true;try{const value=readDeposit(sessionStorage);if(value){setPending(value);setAmount(value.amount);}}catch(_){setError(t('浏览器无法保存充值请求，请检查会话存储'));}load();return()=>{alive.current=false;};},[]);
  function submit(event){event.preventDefault();if(sending.current)return;let intent;try{intent=depositIntent(amount,sessionStorage);}catch(err){setError(err.message);return;}sending.current=true;setBusy(true);setPending(intent);setError('');setNotice('');
    request('/wallet/deposits',intent,(err,result)=>{sending.current=false;if(!alive.current)return;setBusy(false);if(err){if(err.status===400){try{acknowledgeDeposit(intent,sessionStorage);setPending(null);}catch(_){}}setError(err.message);return;}
      try{acknowledgeDeposit(intent,sessionStorage);}catch(_){setError(t('浏览器无法保存充值请求，请检查会话存储'));}
      setPending(null);setAmount('');setNotice(t(result.duplicate?'这笔充值已入账，不会重复增加余额':'虚拟充值成功')+' · '+t('公共钱包余额')+' '+money(result.deposit.publicCashAfter)+' USDT');onChanged?.(result);load();
    });
  }
  return <div className="modal-backdrop" onClick={()=>{if(!busy)onClose();}}><section className="modal transfer-panel" role="dialog" aria-modal="true" aria-label={t('虚拟充值')} onClick={event=>event.stopPropagation()}>
    <div className="section-title"><h2>{t('虚拟充值')}</h2><button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('关闭')}</button></div>
    <p className="note">{t('充值进入公共钱包，不计入盈利，不自动划入独立账户。')}</p>
    {pending&&<p className="note">{t('上次充值尚未确认，请先重试确认')}</p>}
    {error&&<p className="error" role="alert">{translateHumanMessage(error)}</p>}{notice&&<p className="positive" role="status">{notice}</p>}
    <form className="transfer-form" onSubmit={submit}><label>{t('充值金额 · USDT')}<input type="number" min="0.000000000000000001" step="any" value={amount} disabled={busy||!!pending} onChange={event=>setAmount(event.target.value)} required/></label><button disabled={busy}>{t(busy?'正在充值…':pending?'重试确认充值':'充值到公共钱包')}</button></form>
    <h3>{t('充值记录')}</h3><div className="table-scroll"><table><thead><tr><th>{t('时间')}</th><th>{t('金额 · USDT')}</th><th>{t('公共钱包充值前')}</th><th>{t('公共钱包充值后')}</th></tr></thead><tbody>{history?.data.length?history.data.map(row=><tr key={row.id}><td>{new Date(row.createdAt).toLocaleString(getIntlLocale(),{timeZone:'Asia/Shanghai'})}</td><td>{money(row.amount)}</td><td>{money(row.publicCashBefore)}</td><td>{money(row.publicCashAfter)}</td></tr>):<tr><td colSpan={4} className="empty">{t(loading?'正在读取流水…':'暂无充值记录')}</td></tr>}</tbody></table></div>
    <div className="board-pagination"><button type="button" className="secondary" disabled={loading||offset===0} onClick={()=>load(Math.max(0,offset-20))}>{t('上一页')}</button><span>{t('共')}{history?.total||0}{t('笔')}</span><button type="button" className="secondary" disabled={loading||!history||offset+20>=history.total} onClick={()=>load(offset+20)}>{t('下一页')}</button></div>
  </section></div>;
}
