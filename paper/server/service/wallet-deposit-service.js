const async = require('async');
const { D, str } = require('./accounting-service');
function invalid(message, status) { return Object.assign(new Error(message), {status:status || 400}); }
function validate(body) {
  body = body || {};
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId)) throw invalid('requestId必填，需8至128位字母、数字、下划线或短横线');
  let amount;
  try { if (!['string','number'].includes(typeof body.amount) || String(body.amount).trim()==='') throw Error(); amount=D(body.amount); }
  catch (_) { throw invalid('充值金额必须是有效的正数'); }
  if (!amount.isFinite() || amount.lte(0) || amount.gte('1e20') || amount.decimalPlaces()>18) throw invalid('充值金额必须大于0、少于10的20次方，最多18位小数');
  return {amount:str(amount),requestId:body.requestId};
}
function create(db) {
  function deposit(body,callback) {
    let input;try{input=validate(body);}catch(err){return callback(err);}
    const id='wallet-deposit:'+input.requestId;
    db.transaction(function(tx,done){
      let account,record,publicCash;
      async.waterfall([
        function(next){tx.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE',['paper'],next);},
        function(rows,next){account=rows[0];if(!account)return next(invalid('虚拟钱包尚未初始化',409));tx.one('Ledger',{where:{id}},next);},
        function(existing,next){
          if(existing){
            if(existing.kind!=='DEPOSIT'||existing.details.destination!=='shared'||!D(existing.delta).eq(input.amount))return next(invalid('requestId已用于另一笔充值，请使用新的请求ID',409));
            return done(null,{duplicate:true,deposit:{...existing.details,amount:str(existing.delta),createdAt:existing.createdAt}});
          }
          tx.query(`SELECT COALESCE(SUM(cash),0)::text cash FROM paper_follow_tasks WHERE "fundingMode"='dedicated'`,[],next);
        },
        function(rows,next){
          publicCash=D(account.cash).minus(rows[0].cash);
          if(publicCash.lt(0))return next(invalid('独立现金与总钱包余额不一致，请先核对账本',409));
          const cash=D(account.cash).plus(input.amount),capital=D(account.initialCash).plus(input.amount);
          if(cash.gte('1e20')||capital.gte('1e20'))return next(invalid('充值后的金额超过账户存储上限'));
          record={requestId:input.requestId,destination:'shared',amount:input.amount,publicCashBefore:str(publicCash),publicCashAfter:str(publicCash.plus(input.amount)),cashBefore:str(account.cash),cashAfter:str(cash),principalAfter:str(capital)};
          account.cash=record.cashAfter;account.initialCash=record.principalAfter;
          tx.query('SELECT clock_timestamp() AS at',[],next);
        },
        function(rows,next){record.createdAt=rows[0].at;tx.save('Account',account,function(err){next(err);});},
        function(next){tx.insert('Ledger',{id,reference:'paper',kind:'DEPOSIT',delta:input.amount,balance:record.cashAfter,details:record,createdAt:record.createdAt},function(err){next(err);});}
      ],function(err){done(err,err?undefined:{duplicate:false,deposit:record});});
    },callback);
  }
  function list(filters,callback){
    filters=filters||{};const limit=filters.limit===undefined?20:Number(filters.limit),offset=filters.offset===undefined?0:Number(filters.offset);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000)return callback(invalid('无效的分页参数'));
    db.query(`WITH page AS (SELECT id,delta::text amount,balance::text "cashAfter",details->>'publicCashBefore' "publicCashBefore",details->>'publicCashAfter' "publicCashAfter","createdAt"
      FROM paper_cash_ledger WHERE kind='DEPOSIT' AND details->>'destination'='shared' ORDER BY "createdAt" DESC,id DESC LIMIT $1 OFFSET $2)
      SELECT json_build_object('data',COALESCE((SELECT json_agg(p ORDER BY p."createdAt" DESC,p.id DESC) FROM page p),'[]'::json),
      'total',(SELECT COUNT(*)::int FROM paper_cash_ledger WHERE kind='DEPOSIT' AND details->>'destination'='shared'),'limit',$1::int,'offset',$2::int) result`,[limit,offset],function(err,rows){callback(err,rows&&rows[0]&&rows[0].result);});
  }
  return {deposit,list};
}
module.exports={create,validate};
