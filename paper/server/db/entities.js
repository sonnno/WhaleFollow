const { EntitySchema } = require('typeorm');
const text = { type: 'text' };
const money = { type: 'numeric', precision: 38, scale: 18, default: '0' };
const json = { type: 'jsonb', default: {} };
const date = { type: 'timestamptz', default: function () { return 'CURRENT_TIMESTAMP'; } };
const definitions = {
  Account: { table: 'paper_accounts', columns: { cash: money, initialCash: money, realized: money, fees: money } },
  FollowTask: { table: 'paper_follow_tasks', columns: { realisticExecution: { type: 'boolean', default: false }, shortSportsHours: { type: 'integer', nullable: true, default: null }, smartPause: { type: 'jsonb', nullable: true, default: null }, state: { ...text, default: 'paused' }, fundingMode: { ...text, default: 'shared' }, allocation: money, fundedCapital: money, cash: money, realized: money, fees: money, copyPercent: { ...money, default: '100' }, maxOrderAmount: { ...money, nullable: true, default: null }, generation: { type: 'integer', default: 0 }, startedAt: date } },
  FollowFundTransfer: { table: 'paper_follow_fund_transfers', columns: { wallet: text, direction: text, amount: money, cashBefore: money, cashAfter: money, publicCashBefore: money, publicCashAfter: money } },
  MatchRatio: { table: 'paper_match_ratios', columns: { wallet: text, taskCreatedAt: date, eventKey: text, copyPercent: money, firstOrderId: text, lockedAt: date } },
  Leader: { table: 'paper_leaders', columns: { name: text, rank: { type: 'integer' }, pnl: money, active: { type: 'boolean', default: true }, joinedAt: date, inventory: json, inventoryValid: { type: 'boolean', default: false }, raw: json } },
  Source: { table: 'paper_source_trades', columns: { wallet: text, token: text, condition: text, side: text, timestamp: { type: 'bigint' }, quantities: json, processed: json, budget: money, raw: json } },
  Order: { table: 'paper_orders', columns: { sourceId: text, wallet: text, token: text, condition: text, side: text, status: text, reason: { ...text, default: '' }, quantity: money, gross: money, fee: money, details: json } },
  Fill: { table: 'paper_fills', columns: { orderId: text, wallet: text, token: text, side: text, quantity: money, price: money, fee: money } },
  Position: { table: 'paper_positions', columns: { openedAt: { ...date, nullable: true, default: null }, wallet: text, token: text, condition: text, title: { ...text, default: '' }, outcomeIndex: { type: 'integer' }, quantity: money, cost: money, realized: money, cycleRealized: money, cycle: { type: 'integer', default: 1 }, fundingMode: { ...text, default: 'shared' }, mark: { ...money, nullable: true, default: null }, markedAt: { ...date, nullable: true, default: null } } },
  Settlement: { table: 'paper_settlements', columns: { wallet: text, token: text, condition: text, quantity: money, payout: money, revenue: money, cost: money, profit: money, evidence: json } },
  Ledger: { table: 'paper_cash_ledger', columns: { reference: text, kind: text, delta: money, balance: money, details: json } },
  Market: { table: 'paper_markets', columns: { raw: json, resolution: json } },
  Snapshot: { table: 'paper_equity_snapshots', columns: { cash: money, equity: money, realized: money, unrealized: money, fees: money, stale: { type: 'boolean', default: false }, leaders: json } },
  Checkpoint: { table: 'paper_sync_checkpoints', columns: { timestamp: { type: 'bigint' }, details: json } },
  Outbox: { table: 'paper_outbox', columns: { kind: text, payload: json, status: { ...text, default: 'pending' }, attempts: { type: 'integer', default: 0 }, error: { ...text, default: '' } } },
  Setting: { table: 'paper_settings', columns: { value: json } },
  Board: { table: 'paper_leaderboard_snapshots', columns: { rows: json } },
  Cycle: { table: 'paper_closed_cycles', columns: { wallet: text, token: text, profit: money, reason: text } },
  DailyReport: { table: 'paper_daily_reports', columns: { day: { type: 'date', unique: true }, timezone: { ...text, default: 'Asia/Shanghai' }, currency: { ...text, default: 'USDT' }, periodStart: date, periodEnd: date, buyCount: { type: 'integer', default: 0 }, buyAmount: money, fees: money, saleCount: { type: 'integer', default: 0 }, saleProfit: money, settlementCount: { type: 'integer', default: 0 }, settlementProfit: money, netProfit: money, cashEnd: money, positionCostEnd: money,totalProfitEnd:money,breakdownVersion:{type:'integer',default:0} } },
  DailyTaskReport:{table:'paper_daily_task_reports',columns:{day:{type:'date'},wallet:text,traderName:text,taskCreatedAt:date,buyCount:{type:'integer',default:0},saleCount:{type:'integer',default:0},settlementCount:{type:'integer',default:0},buyAmount:money,fees:money,saleProfit:money,settlementProfit:money,netProfit:money,totalProfitEnd:money,leaderStatus:{...text,default:'pending'},leaderTradeProfit:{...money,nullable:true,default:null},leaderIncome:{...money,nullable:true,default:null},leaderNetProfit:{...money,nullable:true,default:null},leaderTotalProfit:{...money,nullable:true,default:null},leaderEvidence:json,leaderError:{...text,default:''},leaderFetchedAt:{...date,nullable:true,default:null},leaderRetryAt:date}}
};
const entities = Object.entries(definitions).map(function ([name, def]) {
  return new EntitySchema({ name, tableName: def.table, columns: { id: { type: 'text', primary: true }, ...def.columns, createdAt: date, updatedAt: { ...date, updateDate: true } } });
});
module.exports = { entities, definitions };
