export function marketFields(order={}){
 const title=String(order.title||order.details?.signal?.title||'').trim(),category=order.category||'';
 const parts=title.split(/:\s*/),tail=parts.at(-1)||title;
 const ou=/\bO\s*\/\s*U\s*([+-]?\d+(?:\.\d+)?)(?=\s|$)/i.exec(tail);
 const spread=/让分|让球|spread|handicap/i.test((order.marketType||'')+' '+title);
 const signed=spread?/\(([+-]\d+(?:\.\d+)?)\)/.exec(tail):null;
 const official=order.marketLine==null?'':String(order.marketLine).trim();
 const number=/^[+-]?\d+(?:\.\d+)?$/.test(official)?official:ou?.[1]||signed?.[1]||null;
 const subject=order.marketSubject||((ou||signed)&&parts.length>1?tail.slice(0,(ou||signed).index).trim():null);
 const event=order.eventTitle||(parts.length>1&&!/^(spread|handicap|totals?|moneyline)$/i.test(parts[0])?parts[0]:title)||'暂未取得';
 const corner=/\bcorners?\b|角球/i.test(title+' '+(order.marketType||'')),cards=/\bcards?\b|罚牌|黄牌|红牌/i.test(title+' '+(order.marketType||''));
 const unit=category==='足球'?(corner?'个':cards?'张':'球'):category==='篮球'?'分':'';
 const shown=number==null?null:number+(unit?' '+unit:'');
 let play=order.marketType||'按市场规则';
 if(ou&&(!order.marketType||order.marketType==='其他体育玩法'))play=category==='足球'?(subject?'球队进球大小球':'进球大小球'):category==='篮球'?(subject?'球队得分大小分':'得分大小分'):'大小盘';
 if(ou&&category==='足球'&&corner)play='角球大小盘';
 if(ou&&category==='足球'&&cards)play='罚牌大小盘';
 if(spread&&category==='足球')play='让球';
 const needsLine=!!ou||spread||/大小|总进球|总局数|球队总得分/.test(play);
 let direction=order.outcome||'方向暂未取得';
 if(/^Under$/i.test(direction))direction=shown?'小于 '+shown+'（Under）':'小（Under）';
 if(/^Over$/i.test(direction))direction=shown?'大于 '+shown+'（Over）':'大（Over）';
 if(/^Yes$/i.test(direction))direction='是（Yes）';
 if(/^No$/i.test(direction))direction='否（No）';
 return{event,play,subject,line:shown||(needsLine?'暂未取得':'不适用'),direction};
}
