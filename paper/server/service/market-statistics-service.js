const {describe,categorySql}=require('./market-view-service');
function invalid(message){return Object.assign(new Error(message),{status:400});}
function day(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function integer(value,fallback,min,max){if(value===undefined||value==='')return fallback;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw invalid('分页参数无效');return Number(value);}
function filters(input){
 const value=input||{};
 ['wallet','keyword','category','profit','from','to'].forEach(function(key){if(value[key]!==undefined&&typeof value[key]!=='string')throw invalid('筛选参数无效');});
 if(value.wallet&&!/^0x[a-fA-F0-9]{40}$/.test(value.wallet))throw invalid('请选择有效跟单人');
 ['from','to'].forEach(function(key){if(value[key]&&!day(value[key]))throw invalid('请输入有效结算日期');});
 if(value.from&&value.to&&value.from>value.to)throw invalid('开始日期不能晚于结束日期');
 if(value.profit&&!['positive','negative','zero'].includes(value.profit))throw invalid('请选择有效盈亏状态');
 if((value.keyword||'').length>200||(value.category||'').length>100)throw invalid('筛选文字过长');
 return{wallet:(value.wallet||'').toLowerCase(),keyword:(value.keyword||'').trim(),category:value.category||'',profit:value.profit||'',from:value.from||'',to:value.to||'',limit:integer(value.limit,20,1,100),offset:integer(value.offset,0,0,10000000)};
}
function create(db){
 function list(input,callback){
  let selection;try{selection=filters(input);}catch(err){return callback(err);}
  const params=[],source=[],markets=[];
  function bind(value){params.push(value);return'$'+params.length;}
  if(selection.wallet)source.push('s.wallet='+bind(selection.wallet));
  if(selection.from)source.push('s."createdAt">='+bind(selection.from)+"::date::timestamp AT TIME ZONE 'Asia/Shanghai'");
  if(selection.to)source.push('s."createdAt"<('+bind(selection.to)+"::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'");
  if(selection.keyword)markets.push('strpos(lower(title),lower('+bind(selection.keyword)+'))>0');
  if(selection.category)markets.push('category='+bind(selection.category));
  if(selection.profit)markets.push('profit'+{positive:'>0',negative:'<0',zero:'=0'}[selection.profit]);
  const limit=bind(selection.limit),offset=bind(selection.offset);
  const sql=`WITH grouped AS (
    SELECT s.condition,COUNT(*)::int count,SUM(s.profit) profit,SUM(s.cost) cost,SUM(s.revenue) revenue,MAX(s."createdAt") "lastSettledAt"
    FROM paper_settlements s ${source.length?'WHERE '+source.join(' AND '):''} GROUP BY s.condition
   ),enriched AS (
    SELECT g.*,COALESCE(NULLIF(m.raw->'gamma'->>'question',''),(SELECT MAX(NULLIF(p.title,'')) FROM paper_positions p WHERE p.condition=g.condition),g.condition) title,
    m.raw->'gamma' gamma,${categorySql("m.raw->'gamma'")} category FROM grouped g LEFT JOIN paper_markets m ON m.id=g.condition
   ),filtered AS (SELECT * FROM enriched ${markets.length?'WHERE '+markets.join(' AND '):''}),page AS (
    SELECT condition,title,gamma,category,count,profit::text profit,cost::text cost,revenue::text revenue,"lastSettledAt" FROM filtered ORDER BY filtered.profit DESC,filtered.condition LIMIT ${limit} OFFSET ${offset}
   ) SELECT (SELECT COUNT(*)::int FROM filtered) total,
   COALESCE((SELECT jsonb_agg(row_to_json(p) ORDER BY p.profit::numeric DESC,p.condition) FROM page p),'[]'::jsonb) data,
   (SELECT jsonb_build_object('records',COALESCE(SUM(count),0),'profit',COALESCE(SUM(profit),0)::text,'cost',COALESCE(SUM(cost),0)::text,'revenue',COALESCE(SUM(revenue),0)::text) FROM filtered) summary,
   COALESCE((SELECT jsonb_agg(category ORDER BY category) FROM (SELECT DISTINCT category FROM enriched) c),'[]'::jsonb) categories`;
  db.query(sql,params,function(err,rows){if(err)return callback(err);const result=rows[0];result.data.forEach(function(row){Object.assign(row,describe(row.gamma));delete row.gamma;});callback(null,{...result,limit:selection.limit,offset:selection.offset,filters:selection});});
 }
 return{list};
}
module.exports={create,filters};
