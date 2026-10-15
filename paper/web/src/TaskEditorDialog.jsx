/* explicit-ui-i18n */
import { t, translateHumanMessage, getIntlLocale, useLanguage } from './i18n';
import React, {useEffect,useRef} from 'react';

export default function TaskEditorDialog({title,busy,onClose,children}){
 const panel=useRef(null);
 const latest=useRef({busy,onClose});latest.current={busy,onClose};
 useEffect(()=>{
  const previous=document.activeElement,overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  const controls=()=>Array.from(panel.current?.querySelectorAll('input:not(:disabled),select:not(:disabled),button:not(:disabled),[tabindex="0"]')||[]).filter(node=>node.getClientRects().length>0);
  (panel.current?.querySelector('input')||panel.current)?.focus();
  function key(event){if(event.key==='Escape'){event.preventDefault();if(!latest.current.busy)latest.current.onClose();}if(event.key==='Tab'){const items=controls(),first=items[0],last=items[items.length-1];if(!first){event.preventDefault();panel.current?.focus();}else if(event.shiftKey&&(document.activeElement===first||!panel.current.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!panel.current.contains(document.activeElement))){event.preventDefault();first.focus();}}}
  document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus();};
 },[]);
 return <div className="task-editor-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section ref={panel} className="task-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" tabIndex={-1}><div className="board-result-heading"><h2 id="task-editor-title">{t(title)}</h2><button type="button" className="secondary" disabled={busy} onClick={onClose} aria-label={t("关闭任务设置")}>{t("关闭")}</button></div>{t(children)}</section></div>;
}
