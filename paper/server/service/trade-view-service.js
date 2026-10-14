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
 row.copyTime=executed?row.createdAt:null;
 if(row.amount==null&&row.gross!=null)row.amount=str(row.side==='SELL'?D(row.gross).minus(row.fee||0):D(row.gross).plus(row.fee||0));
 return row;
}
module.exports={enrich};
