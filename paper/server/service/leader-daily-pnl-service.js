const {D,str}=require('./accounting-service');
const endpoint='/v2/user-pnl';
function extract(body,wallet,day){
 const data=body&&body.data;
 if(!data||typeof data.proxy_wallet!=='string'||data.proxy_wallet.toLowerCase()!==wallet.toLowerCase()||!Array.isArray(data.points))throw new Error('官方盈亏响应钱包不匹配');
 const start=Date.parse(day+'T00:00:00+08:00')/1000,end=start+86400;
 const a=data.points.find(function(p){return p.timestamp===start;}),b=data.points.find(function(p){return p.timestamp===end;});
 if(!a||!b)throw new Error('官方历史没有北京时间日界线的采样边界');
 ['realized_pnl','wallet_income','settled_pnl'].forEach(function(key){[a,b].forEach(function(p){if(p[key]===null||p[key]===undefined||!['string','number'].includes(typeof p[key])||p[key]===''||!D(p[key]).isFinite())throw new Error('官方已实现盈亏数据不可用');});});
 if(!D(a.realized_pnl).plus(a.wallet_income).minus(a.settled_pnl).abs().lt('0.00001')||!D(b.realized_pnl).plus(b.wallet_income).minus(b.settled_pnl).abs().lt('0.00001'))throw new Error('官方盈亏分项与总额不一致');
 return{leaderStatus:'sampled',leaderTradeProfit:str(D(b.realized_pnl).minus(a.realized_pnl)),leaderIncome:str(D(b.wallet_income).minus(a.wallet_income)),leaderNetProfit:str(D(b.settled_pnl).minus(a.settled_pnl)),leaderTotalProfit:str(b.settled_pnl),leaderEvidence:{endpoint,sourceUrl:'https://data-api.polymarket.com/v2/docs',currency:'USDC',sourceFidelity:data.source_fidelity||'unknown',gridFidelity:data.fidelity||'1h',start:a,end:b},leaderError:'',leaderFetchedAt:new Date()};
}
function create(options){
 options=options||{};const http=options.http||require('../lib/http-client'),base=options.base||require('../../config').paper.dataUrl;
 const cache=new Map();
 function fetch(wallet,day,callback){
  function parse(body){let result;try{result=extract(body,wallet,day);}catch(err){return callback(err);}callback(null,result);}
  if(!/^0x[a-fA-F0-9]{40}$/.test(wallet))return callback(new Error('原主钱包地址不可用'));
  const prior=cache.get(wallet);if(prior&&Date.now()-prior.at<60000)return parse(prior.body);
  http.request(base,endpoint,{user:wallet,interval:'max',fidelity:'1h'},function(err,body){if(err)return callback(err);cache.set(wallet,{at:Date.now(),body});while(cache.size>2)cache.delete(cache.keys().next().value);parse(body);});
 }
 return{fetch};
}
module.exports={create,extract};
