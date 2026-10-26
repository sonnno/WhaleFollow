# Position-based sales / 按原主持倉比例跟賣

This optional paper mode sells the same fraction of your available token holdings as the source trader sells of theirs. A source reduction of 30% requests 30% of your own position; a confirmed full source exit requests all sellable own shares. Opposite tokens remain separate, and buying an opposing outcome never automatically closes another position.

此選項按原主的減倉比例，賣出自己在相同代幣的可用持倉。原主賣出30%，便請求賣出自己的30%；確認原主全部退出時，請求賣出自己的全部可賣份數。不同方向分開處理，買入反方向不會自動清空原持倉。

## Configuration / 設定

The administrator can opt public trader wallets in using the PostgreSQL `paper_settings` row with ID `position-sell-wallets`. Its JSON value has this shape; replace the placeholder with the trader's lowercase public wallet address:

管理員可透過PostgreSQL `paper_settings`中ID為`position-sell-wallets`的設定，指定使用此模式的公開交易員錢包。JSON格式如下，請將範例文字替換為交易員的小寫公開地址：

```json
{"wallets":["<lowercase-public-trader-wallet>"]}
```

There is currently no dashboard toggle for this option. No wallets are opted in on a fresh installation. This setting neither creates nor starts a follow task, allocates funds, nor changes its buy percentage. Non-opted-in wallets retain source-shares × the event's locked copy ratio sale sizing.

目前介面尚無此選項的切換按鈕，全新安裝預設不啟用任何錢包。此設定不建立或啟動跟單任務、不劃轉資金，也不改變買入比例。未啟用的錢包保留「原主賣出份數乘以該比賽鎖定比例」的跟賣方式。

## Execution and limitations / 執行與限制

- A background position refresh runs every60 seconds. Live source observations update the in-memory balance even when your buys are skipped or paused; order execution never waits for this position query.
- Missing, stale, late, out-of-order or otherwise ambiguous source data uses the former ratio calculation, with a recorded fallback reason. Public indexed data cannot guarantee detection of every delayed update or transfer.
- Minimum shares, supported precision and available depth still apply. Tiny residual holdings remain real positions; the application does not fabricate an exit or replay historical skipped sales.
- This mode changes sale sizing only. Simulation remains local and sends no real exchange order.

- 每60秒在背景更新原主持倉。即使自己的買入被跳過或暫停，原主新成交仍會更新記憶體持倉；下單不等待這次查詢。
- 持倉缺失、過期、成交延遲或順序不明時，退回原有比例計算並記錄原因。公開索引資料無法保證偵測所有延遲更新或轉帳。
- 最低份數、精度與市場深度仍然有效。零碎餘倉會如實保留，不虛構清倉，也不重放歷史未成交賣單。
- 此模式只改變賣出份數計算，所有成交仍為本地模擬，不向交易所傳送真實訂單。
