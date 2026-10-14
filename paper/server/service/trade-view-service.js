const {D,str}=require('./accounting-service');
function enrich(row){
 const details=row.details||{},signal=details.signal||{};
 row.title=row.title||signal.title;
 row.sourcePrice=row.sourcePrice??signal.price??null;
 row.sourceAmount=row.sourceAmount??details.sourceAmount??signal.sourceAmount??null;
 if(row.sourceAmount==null&&signal.size!=null&&signal.price!=null){try{row.sourceAmount=str(D(signal.size).mul(signal.price));}catch(_){row.sourceAmount=null;}}
 const source=row.sourceTimestamp??signal.timestamp;
 const milliseconds=source==null?NaN:Number(source)*1000;
 row.sourceTime=Number.isFinite(milliseconds)&&Number.isFinite(new Date(milliseconds).getTime())?new Date(milliseconds).toISOString():null;
 const executed=['FILLED','PARTIAL','pending','settled','sold'].includes(row.status);
 row.averagePrice=executed&&D(row.quantity||0).gt(0)?row.buyPrice??str(D(row.gross).div(row.quantity)):null;
 const timings=row.executionTimings||details.timings||{},receivedAt=row.receivedAt??signal.receivedAt;
 const duration=typeof timings.receivedToExecutionMs==='number'&&Number.isFinite(timings.receivedToExecutionMs)&&timings.receivedToExecutionMs>=0?timings.receivedToExecutionMs:null;
 const received=Date.parse(receivedAt),recorded=Date.parse(timings.executedAt);
 row.receivedAt=Number.isFinite(received)?new Date(received).toISOString():null;
 row.receivedToExecutionMs=executed?duration:null;
 row.copyClock=null;row.copyTime=null;row.executionDelayMs=null;
 if(executed){
  if(['worker-monotonic','worker-utc'].includes(timings.clockBasis)&&Number.isFinite(recorded)){row.copyTime=new Date(recorded).toISOString();row.copyClock=timings.clockBasis;}
  else if(Number.isFinite(received)&&duration!==null&&Number.isFinite(received+duration)){row.copyTime=new Date(received+duration).toISOString();row.copyClock='reconstructed-worker';}
  else{row.copyTime=row.createdAt;row.copyClock='legacy-database';}
  const gap=Date.parse(row.copyTime)-milliseconds;
  if(row.copyClock!=='legacy-database'&&Number.isFinite(gap)&&gap>=0)row.executionDelayMs=gap;
 }
 if(row.amount==null&&row.gross!=null)row.amount=str(row.side==='SELL'?D(row.gross).minus(row.fee||0):D(row.gross).plus(row.fee||0));
 return row;
}
module.exports={enrich};
