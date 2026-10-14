import React from 'react';
import {formatMoney} from './money-format';
export function deletionBlockReason(task){if(!['paused','stopped'].includes(task.state))return'请先点击“暂停”，等全部持仓结束后再删除。';if(Number(task.pendingBets)>0)return'还有 '+task.pendingBets+' 个未结算持仓，请等待全部结算或卖出。';if(task.fundingMode==='dedicated'&&Number(task.cash)!==0)return'独立账户还有 '+formatMoney(task.cash)+' USDT，请先通过“转入 / 转出”全部转出。';return'';}
export default function TaskDeleteDialog({task,busy=false,error='',onConfirm,onCancel}){
 const blocked=deletionBlockReason(task);
 return <div className="task-delete-overlay"><section role="dialog" aria-modal="true" aria-labelledby="task-delete-title" className="task-delete-dialog"><h2 id="task-delete-title">删除 {task.name||'跟单任务'}</h2><p>将永久删除该任务及其跟单明细、成交、持仓、结算、划转和待重试记录，无法恢复。</p><p className="note">总钱包余额、已发生的盈亏和全局日表保持不变。</p>{blocked&&<p className="error" role="alert">{blocked}</p>}{error&&<p className="error" role="alert">{error}</p>}<div className="task-form-actions"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={busy||!!blocked}>{busy?'正在删除…':'确认永久删除'}</button></div></section></div>;
}
