const async=require('async');
const {D,str}=require('./accounting-service');
const config=require('../../config').paper;
const settingId='position-sell-wallets';
function taskKey(task){return task?String(task.createdAt)+':'+Number(task.generation||0):'';}

// The public position reader only establishes a baseline. All live observations,
// including source BUYs skipped by our own strategy, advance that baseline.
function create(db,options){
 options=options||{};
 const http=options.http||require('../lib/http-client'),now=options.now||Date.now,controls=options.controls;
 const states=new Map(),enabled=new Set(),maxTokens=10000,maxAgeMs=180000;
 let stopped=false,busy=false,epoch=0;
 const health={version:1,wallets:[],refreshes:0,fractionSales:0,fallbackSales:0};
 function invalidateState(state,reason){state.trusted=false;state.reason=reason;for(const value of state.tokens.values()){value.valid=false;value.reason=reason;}}
 function invalidate(reason){epoch++;for(const state of states.values())invalidateState(state,reason||'SOURCE_INVENTORY_INVALID');status();}
 function current(wallet,task){
  let state=states.get(wallet);const key=taskKey(task);
  if(!state){state={key,tokens:new Map(),trusted:false,reason:'SOURCE_INVENTORY_UNAVAILABLE',snapshotAt:0,syncedAt:0};states.set(wallet,state);}
  else if(state.key!==key){invalidateState(state,'SOURCE_TASK_CHANGED');state.tokens.clear();state.key=key;}
  return state;
 }
 function status(){health.wallets=[...enabled].map(wallet=>{const s=states.get(wallet);return{wallet,ready:!!s?.trusted,tokens:s?.tokens.size||0,untrustedTokens:s?[...s.tokens.values()].filter(v=>!v.valid).length:0,syncedAt:s?.syncedAt?new Date(s.syncedAt).toISOString():null,reason:s?.reason||null};});}
 function refresh(callback){
  if(stopped||busy)return callback();busy=true;
  db.one('Setting',{where:{id:settingId}},function(error,row){
   if(error){busy=false;invalidate('SOURCE_SETTINGS_UNAVAILABLE');health.lastError=error.message;return callback(error);}
   if(stopped){busy=false;return callback();}
   const wallets=row?.value?.wallets||[];
   if(!Array.isArray(wallets)||wallets.some(w=>typeof w!=='string'||!/^0x[a-f0-9]{40}$/.test(w))){busy=false;invalidate('SOURCE_SETTINGS_INVALID');return callback(new Error('Invalid position-sell-wallets setting'));}
   enabled.clear();wallets.forEach(w=>enabled.add(w));for(const w of states.keys())if(!enabled.has(w))states.delete(w);
   async.eachLimit([...enabled],2,function(wallet,done){
    const task=controls?.peek(wallet)?.task;
    if(!task){states.delete(wallet);return done();}
    const state=current(wallet,task),began=now(),version=epoch,key=state.key;
    const revisions=new Map([...state.tokens].map(([token,v])=>[token,v.revision]));
    http.pages(config.dataUrl,'/v2/positions',{user:wallet,status:'OPEN',filter_amount:0,limit:1000},function(err,rows){
     if(stopped)return done();
     if(err){invalidateState(state,'SOURCE_SNAPSHOT_FAILED');return done(err);}
     // A feed gap or replacement task while HTTP was pending invalidates the read.
     if(version!==epoch||states.get(wallet)!==state||state.key!==key||taskKey(controls?.peek(wallet)?.task)!==key)return done();
     try{
      const balances=new Map();if(!Array.isArray(rows))throw new Error('Invalid source positions response');
      for(const row of rows){const token=String(row.token_id||row.asset||''),rawQuantity=row.current_size===undefined?row.size:row.current_size;
       if(!['number','string'].includes(typeof rawQuantity)||String(rawQuantity).trim()==='')throw new Error('Invalid source position quantity');
       const quantity=D(rawQuantity);
       if(!/^\d+$/.test(token)||!quantity.isFinite()||quantity.lt(0)||balances.has(token)||row.proxy_wallet&&row.proxy_wallet.toLowerCase()!==wallet)throw new Error('Invalid source position row');
       balances.set(token,str(quantity));
      }
      const tokens=new Set([...balances.keys(),...state.tokens.keys()]);if(tokens.size>maxTokens)throw new Error('Source position cache limit exceeded');
      const ended=now(),cutoff=Math.ceil(ended/1000);
      for(const token of tokens){const previous=state.tokens.get(token);
       if(previous&&(previous.revision!==(revisions.get(token)||0)||previous.lastTimestamp>=Math.floor(began/1000))){previous.valid=false;previous.reason='SOURCE_SNAPSHOT_RACE';continue;}
       state.tokens.set(token,{quantity:balances.get(token)||'0',valid:true,revision:previous?.revision||0,lastTimestamp:cutoff,lastSide:null,snapshotAt:cutoff,syncedAt:ended});
      }
      state.snapshotAt=cutoff;state.syncedAt=ended;state.trusted=true;state.reason=null;
     }catch(failure){invalidateState(state,'SOURCE_SNAPSHOT_INVALID');return done(failure);}
     done();
    });
   },function(err){busy=false;health.refreshes++;health.lastError=err?err.message:null;status();callback(err);});
  });
 }
 function observe(signal,task){
  if(stopped||!enabled.has(signal.wallet))return null;
  const state=current(signal.wallet,task);let value=state.tokens.get(signal.token);
  if(!value){
   if(state.tokens.size>=maxTokens){invalidateState(state,'SOURCE_CACHE_LIMIT');return signal.side==='SELL'?fallback('SOURCE_CACHE_LIMIT'):null;}
   value={quantity:'0',valid:state.trusted,reason:state.reason,revision:0,lastTimestamp:state.snapshotAt,lastSide:null,snapshotAt:state.snapshotAt,syncedAt:state.syncedAt};state.tokens.set(signal.token,value);
  }
  const before=D(value.quantity),sold=D(signal.size),timestamp=Number(signal.timestamp);
  let reason=value.reason||state.reason;
  if(!value.valid||!state.trusted)reason=reason||'SOURCE_INVENTORY_UNAVAILABLE';
  else if(now()-value.syncedAt>maxAgeMs)reason='SOURCE_SNAPSHOT_STALE';
  else if(timestamp<=value.snapshotAt)reason='SOURCE_TRADE_BEFORE_SNAPSHOT';
  else if(timestamp<value.lastTimestamp||timestamp===value.lastTimestamp&&value.lastSide!==signal.side)reason='SOURCE_SEQUENCE_AMBIGUOUS';
  else if(signal.side==='SELL'&&(before.lte(0)||sold.gt(before)))reason='SOURCE_BALANCE_TOO_SMALL';
  else reason=null;
  value.revision++;value.lastTimestamp=Math.max(value.lastTimestamp,timestamp);value.lastSide=signal.side;
  value.quantity=str(signal.side==='BUY'?before.plus(sold):before.minus(sold).clamp(0,Infinity));
  if(reason){value.valid=false;value.reason=reason;return signal.side==='SELL'?fallback(reason):null;}
  if(signal.side!=='SELL')return null;
  const evidence={mode:'leader_fraction',wallet:signal.wallet,token:signal.token,before:str(before),sold:str(sold),after:value.quantity,fraction:str(sold.div(before)),snapshotAt:value.snapshotAt};
  health.fractionSales++;health.lastSale={...evidence,at:new Date(now()).toISOString()};return evidence;
  function fallback(reason){const evidence={mode:'fixed_ratio_fallback',reason,wallet:signal.wallet,token:signal.token};health.fallbackSales++;health.lastFallback={...evidence,at:new Date(now()).toISOString()};return evidence;}
 }
 function stop(){stopped=true;epoch++;states.clear();enabled.clear();}
 return{refresh,observe,invalidate,stop,health};
}
function size(signal,own,ratio){
 const evidence=signal.saleSizing,available=D(own||0).clamp(0,Infinity);
 if(evidence?.mode==='leader_fraction')try{
  const before=D(evidence.before),sold=D(evidence.sold),fraction=D(evidence.fraction);
  if(evidence.wallet===signal.wallet&&evidence.token===signal.token&&before.isFinite()&&before.gt(0)&&sold.isFinite()&&sold.eq(signal.size)&&sold.gt(0)&&sold.lte(before)&&fraction.isFinite()&&fraction.gt(0)&&fraction.lte(1)&&fraction.minus(sold.div(before)).abs().lt('0.000000000000000001'))return{...evidence,quantity:str(available.mul(sold).div(before).clamp(0,available))};
 }catch(_){}
 return{...(evidence||{}),mode:evidence?'fixed_ratio_fallback':'fixed_ratio',reason:evidence?.mode==='leader_fraction'?'INVALID_SOURCE_SALE_EVIDENCE':evidence?.reason,quantity:str(D(signal.size).mul(ratio||1).clamp(0,available))};
}
module.exports={create,size,settingId};
