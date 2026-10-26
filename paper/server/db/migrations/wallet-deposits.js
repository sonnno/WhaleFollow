class WalletDeposits1792900000000 {
  name='WalletDeposits1792900000000';
  transaction=false;
  up(runner){return runner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS paper_cash_ledger_deposits ON paper_cash_ledger("createdAt" DESC,id DESC) WHERE kind='DEPOSIT'`);}
  down(runner){return runner.query('DROP INDEX CONCURRENTLY IF EXISTS paper_cash_ledger_deposits');}
}
module.exports=WalletDeposits1792900000000;
