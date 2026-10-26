# 虛擬充值 / Virtual deposits

僅適用 paper。充值直接進入公共錢包，不自動劃入獨立帳戶，不清除訂單或持倉，不計入盈虧。帳戶累計本金與現金同步增加。

Paper only. Deposits increase public cash and contributed capital. Dedicated balances, trades, positions and realized PnL remain unchanged. No external payment or blockchain transaction is performed.

介面入口 / Dashboard: Overview → Wallet balances and alerts → Virtual deposit.

## POST /api/wallet/deposits

Requires an authenticated administrator session and `X-Requested-With: XMLHttpRequest`.

```json
{"amount":"100","requestId":"deposit-unique-request-0001"}
```

`amount` must be positive and below 10^20, with at most 18 decimal places; total cash and capital must also remain below 10^20. Currency: virtual USDT. Use a fresh request ID for a new deposit, and reuse the exact same ID and amount when retrying an unconfirmed request. Replaying a committed ID returns `duplicate: true` without another credit; conflicting reuse returns HTTP 409.

Response:

```json
{"duplicate":false,"deposit":{"requestId":"deposit-unique-request-0001","destination":"shared","amount":"100","publicCashBefore":"50","publicCashAfter":"150","cashBefore":"350","cashAfter":"450","principalAfter":"450","createdAt":"2026-10-19T05:00:00.000Z"}}
```

## GET /api/wallet/deposits?limit=20&offset=0

Lists deposits made through this interface, newest first. `limit`: 1–100; `offset`: 0–1000000. Returns `data`, `total`, `limit`, `offset`. Account initialization and legacy capital adjustments remain in the full ledger rather than this list.

充值成功會通知 worker 重新讀取公共餘額；不重啟 worker、不提高任務投入上限，也不重試舊買單。餘額預警維持原規則：下次成功下單才解除。

A successful deposit refreshes worker controls and dashboard balance cache. It does not restart workers, change task limits, or replay failed historical orders. Existing insufficient-balance warnings clear on a successful execution.
