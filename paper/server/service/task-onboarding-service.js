const async=require('async'),crypto=require('node:crypto');
const {D,str}=require('./accounting-service');
const taskService=require('./follow-task-service'),transferService=require('./follow-transfer-service');
function invalid(message,status=400){return Object.assign(new Error(message),{status});}
function create(db){
 function setup(body,callback){
  let input,funding,fingerprint;
  try{input=taskService.validate(body);if(input.fundingMode!=='dedicated')throw invalid('首次划转仅用于新建独立跟单账户');if(typeof body.start!=='boolean')throw invalid('请指定保存后是否启动跟单');if(body.taskVersion===undefined)throw invalid('需要当前创建版本，请刷新任务列表');funding=transferService.validate({direction:'in',amount:body.initialTransferAmount,requestId:body.requestId,taskVersion:body.taskVersion});fingerprint=JSON.stringify({...input,initialTransferAmount:funding.amount,start:body.start,taskVersion:funding.taskVersion});}catch(err){return callback(err);}
  const operationId='task-onboarding:'+input.wallet+':'+funding.id;
  db.transaction(function(tx,done){
   // Reuse the existing callback services on this same transaction/connection.
   const scoped={transaction:function(work,cb){work(tx,cb);}};
   const tasks=taskService.create(scoped),transfers=transferService.create(scoped);
   let saved,result,taskVersion;
   async.waterfall([
    function(next){tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE',['paper'],function(err,rows){if(err)return next(err);if(!rows[0])return next(invalid('虚拟钱包尚未初始化',409));next();});},
    function(next){tx.one('Setting',{where:{id:'retired-transfer:'+crypto.createHash('sha256').update(funding.id).digest('hex')}},next);},
    function(retired,next){if(retired)return next(invalid('这笔首次划转属于已删除的任务，请重新创建请求',409));tx.one('Setting',{where:{id:'task-deletion:'+input.wallet}},next);},
    function(marker,next){const version=marker?String(marker.value.generation):'initial';if(version!==funding.taskVersion)return next(invalid('此任务已被创建和删除，旧创建请求已作废，请刷新后重新填写',409));tx.one('Setting',{where:{id:operationId}},next);},
    function(operation,next){if(operation){if(operation.value.fingerprint!==fingerprint)return next(invalid('此请求已用于另一组创建参数，请先确认原请求',409));return done(null,{...operation.value.result,duplicate:true});}tx.one('FollowTask',{where:{id:input.wallet}},next);},
    function(existing,next){if(existing)return next(invalid(existing.state==='running'?'该地址已有正在跟单的任务，不能重复新建。请修改现有任务。':'该地址已有跟单任务，请修改现有任务或点击“开始跟单”。',409));tx.one('FollowFundTransfer',{where:{id:funding.id}},next);},
    function(existing,next){if(existing)return next(invalid('requestId已用于其他划转，请重新创建请求',409));tasks.save(input,next);},
    function(row,next){saved=row;taskVersion=row.taskVersion;transfers.transfer(input.wallet,{direction:'in',amount:funding.amount,requestId:funding.id,taskVersion},function(err){next(err);});},
    function(next){tx.one('FollowTask',{where:{id:input.wallet}},next);},
    function(task,next){result={...saved,...task,taskVersion,wallet:input.wallet,name:input.name,availableCash:str(D(task.cash).clamp(0,D(task.allocation))),unusedCash:str(D(task.cash).minus(D(task.cash).clamp(0,D(task.allocation))))};if(!body.start)return next();if(D(result.availableCash).lte(0))return next(invalid('独立账户可买入金额为0，请填写大于0的目标额度和转入金额',409));tasks.control(input.wallet,{action:'start'},function(err,row){if(!err)result={...result,...row,taskVersion};next(err);});},
    function(next){tx.save('Setting',{id:operationId,value:{fingerprint,result}},function(err){next(err);});}
   ],function(err){done(err,err?undefined:{...result,duplicate:false});});
  },callback);
 }
 return{setup};
}
module.exports={create};
