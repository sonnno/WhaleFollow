# Changelog / 更新記錄

## Unreleased — 2026-10-26

### English

- Lock each event's copy percentage at its first executed buy; later task changes apply to new events. Add smart pause for existing unsettled events and retain full buy pause.
- Add virtual deposits to shared cash, realistic order minimum/precision checks and configurable single-game start horizons. Do not accumulate tiny requests, resize them to exchange minimums or backfill historical buys.
- Add optional source-position-fraction selling with background inventory synchronization and an explicit ratio fallback when source data is unreliable. Preserve market minimums and actual residual shares. See [position-based sales](paper/docs/position-sales.md).
- Continue the same current notification after a cold sports-policy lookup, and replace silent feeds through overlapping connections. Retain executed receipts for bookkeeping without buying again.
- Improve dashboard query/index/cache performance, saved daily-profit breakdowns, settlement filters and profit colors. Add compatible request IDs, compressed web assets and stronger session/worker health handling.
- Fix Docker build inclusion of the web compression script. Existing task ratios and wallet balances remain database settings, not repository defaults.

### 繁體中文

- 首次成交時鎖定該比賽的跟單比例，後續調整只套用於新比賽。新增智能暫停，保留已有未結算比賽的買入，並保留全部暫停功能。
- 新增公共錢包虛擬充值、真實下單門檻及精度模擬、單場比賽開賽時間篩選。不累積小額請求、不強制放大至最低金額，也不補買歷史漏單。
- 新增可選的原主持倉比例跟賣：背景同步持倉，資料不可靠時明確退回原有比例算法；保留最低份數限制與實際餘倉。詳見[按原主持倉比例跟賣](paper/docs/position-sales.md)。
- 賽事政策快取缺失時，取得資料後繼續處理同一筆即時訊號；推送斷流以重疊連線替換。已成交回執只重寫帳務，不重複買入。
- 改善首頁查詢、索引與快取、已儲存日盈虧拆分、結算篩選及盈虧顏色。補齊請求識別碼相容性、靜態檔案壓縮與工作程序健康檢查。
- 修正Docker建置未包含網頁壓縮腳本的問題。現有任務比例與錢包餘額仍儲存在資料庫，不作為倉庫預設值。

## 1.1.0 — 2026-10-15

The dashboard now supports Traditional Chinese and English. Flag and language-name buttons appear on the login screen and in System settings, switch immediately, and remember the choice in the current browser. Application labels, forms, reports, statuses and dates follow the selected language; trader names and official market titles retain their original text.

後台介面新增繁體中文及英文。登入頁與系統設定提供國旗及語言名稱按鈕，切換立即生效，並儲存目前瀏覽器的選擇。表單、查詢、報表、狀態與日期依語言顯示；交易員名稱及官方市場標題保留原文。跟單執行、資金及日結邏輯維持不變。


## 1.0.1 — 2026-10-15

Documentation and GitHub presentation now use English and Traditional Chinese. Chinese guides use the `zh-Hant` filenames, and links, community templates and release notes are updated. Application execution and accounting behavior are unchanged.

公開文件與 GitHub 專案介紹統一使用繁體中文與英文。中文指南改用 `zh-Hant` 檔名，同步更新連結、社群範本與發佈說明。跟單執行及帳務邏輯維持不變。

## 1.0.0 — 2026-10-15

First public paper-trading release of WhaleFollow.

### Included

- Official leaderboard browsing with supported period/category filters and pagination.
- Multiple follow tasks with copy ratios, exposure budgets and optional per-order limits.
- Shared virtual funds and dedicated per-trader accounts with manual transfers.
- Direct WebSocket-driven simulated execution; no delayed buy backfill.
- Source/copied prices and times, market metadata and official market links.
- Positions, settlements, fees, realized-profit statistics and daily task reports.
- Docker Compose deployment with generated persistent credentials, migrations and health checks.
- English and Traditional Chinese project/deployment documentation, MIT licensing and contribution guidance.

### Fixed

- The overview's daily profit table now reads saved daily reports instead of grouping today's live settlements. Reports close at 10:00 Asia/Shanghai for the previous calendar day.

### 繁體中文

首個公開發布的虛擬跟單版本，包含排行榜、多人任務、比例與金額設定、公共/獨立資金、手動劃轉、WebSocket即時虛擬成交、訂單價格與時間對比、持倉結算及費用、盈虧統計和任務日表。

支援 Docker Compose 部署，自動生成並儲存憑據、執行遷移和健康檢查。補齊中英文專案與部署文件、MIT 授權條款和參與貢獻說明。

修復總覽每日盈虧表錯誤使用即時彙總的問題，改為讀取每天北京時間10點生成的前一天固定日報。本版本不包含真錢交易功能。
