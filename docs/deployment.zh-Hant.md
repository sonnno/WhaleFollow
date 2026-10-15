# 部署與維護

[English](deployment.md) · [專案首頁](../README.zh-Hant.md)

獨立的Polymarket虛擬跟單系統。Node.js後台和Worker、React管理頁面、PostgreSQL賬本、Redis快取；沒有真錢下單功能，不需要私鑰、API金鑰或錢包授權。

## Debian一條命令啟動

使用Debian12/13，安裝Docker Engine和Compose外掛。建議2核2GB起步，只執行這一套；同時部署其他應用建議4GB。伺服器不需要另裝Node、PostgreSQL或Redis。

倉庫公開，無需GitHub登入。

```bash
git clone https://github.com/sonnno/WhaleFollow.git
cd WhaleFollow
docker compose up -d
```

首次執行會自動建置映象、生成並儲存密碼、啟動資料庫和Redis、執行TypeORM建表、啟動後台和Worker。初始虛擬本金350美元，沒有自動開始的跟單任務。第一次需要下載映象和npm包，耗時取決於網路。

開啟`http://伺服器IP:3000`。檢視管理員登入資訊：

```bash
docker compose exec api node deploy/show-login.js
```

預設使用者名稱`admin`，密碼首次隨機生成；重啟不會更換密碼。後台新建任務、轉入資金和點選“開始跟單”後才跟新交易。所有金額只是模擬記賬。

在Lightsail防火牆放行TCP3000，來源限制為你的IP。長期通過公網訪問時設定域名和HTTPS反向代理。PostgreSQL和Redis沒有對映到伺服器外部埠。

## 檢視執行情況

```bash
docker compose ps -a
docker compose logs --tail=100 api worker migrate
docker stats --no-stream
```

`bootstrap`和`migrate`顯示`Exited (0)`是正常的；postgres、redis、api、worker應該執行並逐步變為healthy。Worker就緒後仍需在後台檢查Polymarket連線狀態；本地啟動成功不代表外部API永遠可用。日誌自動輪轉，防止佔滿硬碟。

## 停止、重啟、更新

```bash
# 停止程式，保留全部資料
docker compose down
# 再次啟動，沿用資料和密碼
docker compose up -d
```

更新程式碼時先停止舊程序，避免舊API/Worker佔用資料庫遷移鎖：

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
```

不要使用`docker compose down -v`：它會刪除資料庫、Redis和密碼卷。不要單獨刪除runtime卷：資料庫已有密碼會與新密碼不匹配。伺服器重啟後資料庫、Redis、API和Worker自動恢復；首次建表服務不用重複常駐。

## 可選設定

無需複製.env即可預設啟動。如果要改埠或初始本金，可在首次啟動前：

```bash
cp .env.example .env
chmod 600 .env
nano .env
docker compose up -d
```

`PORT`是伺服器訪問埠，容器後台固定3000。`INITIAL_CASH`僅影響全新資料庫，不會修改已有餘額。想使用自己設定的管理員使用者名稱/密碼，可在第一次啟動前填寫；留空則隨機生成。`SESSION_SECRET`如自行設定至少32字元。生成後改憑據環境變數會明確報錯，避免靜默改密碼導致資料庫連線失敗。現階段密碼持久化後需要保留，不提供線上改密碼功能。

預設採用共享Compose專案名whalefollow。不要在同一臺伺服器重複啟動同一個專案；要開第二個獨立測試例項須顯式使用不同的`-p`專案名和PORT。所有卷均按專案名隔離。

PostgreSQL預設共享記憶體128MB和低記憶體引數，後台256MB、Worker640MB、資料庫512MB、Redis128MB上限。預算是起步設定，任務和資料增長後應檢視docker stats；不要依靠頻繁交換記憶體維持跟單。

## 備份和恢復

資料庫和密碼都需要備份，備份檔案不要提交Git：

```bash
mkdir -p backups
chmod 700 backups
docker compose exec -T postgres pg_dump -U whalefollow -d whalefollow_paper -Fc > backups/paper.dump
docker compose exec -T api tar -C /var/lib/whalefollow -czf - . > backups/runtime.tar.gz
chmod 600 backups/*
```

恢復請先在隔離環境驗證，不要直接覆蓋當前跟單賬戶。Redis資料持久化在redis-data卷；上面的資料庫備份不包含Redis快取，完整災備還需在停止服務後儲存該卷。runtime備份包含登入和資料庫密碼，應妥善保管。

## 成交時間和耗時

頁面只顯示原主成交時間、我們的成交時間和兩者差值。Worker啟動時及每分鐘通過官方CLOB `/time`校準應用內時鐘，取三次請求中往返最快的樣本，再用單調時鐘生成成交時間；不修改作業系統時間。原主時間保留Polymarket官方記錄。官方介面只精確到秒，校準還受網路往返誤差影響，因此頁面差值不能視為毫秒級精密測量。校準失敗會保留上次成功結果；首次校準失敗會記錄警告並使用本機時間，交易繼續。

完整WebSocket成交通知會在源單入庫時並行準備報價。源單提交後直接進入原有按資產排序的執行佇列，跳過Redis投遞往返；持久化outbox和Redis仍負責重啟及失敗恢復。資金、暫停、重複成交和已結算狀態繼續在記賬事務內檢查。

已取得完整快照、保持同一連線且訊息/PONG存活的盤口直接用於模擬成交，不因超過2秒而每單等待REST。實際成交前重新讀取本地最新價格和剩餘深度。市場引數在後台每10秒檢查、超過30秒按近期使用的市場重新整理；快取失效、首次市場缺少資料或盤口流斷線時，仍需REST取得可靠資料。不得用原主成交價冒充我們當前能成交的價格。只有REST快照時仍採用原2秒有效期。盤口30秒無訊息/PONG會失效並重連，重連必須重新驗證完整快照。

內部單調耗時、直接投遞模式、盤口來源和校準狀態僅保留在後台診斷，不顯示在訂單頁面。

Worker記憶體快取任務和暫停設定；控制台修改後通過Redis通知更新，每秒後台重新整理作為兜底。WebSocket已知跟單人使用快取，任務版本變化時立即重新處理原訊息。餘額與獨立資金在記賬事務內鎖定一次，隨後用一次SQL領取唯一訂單號並讀取一致的金融上下文；不逐欄位查詢。成交後的餘額、任務資金、持倉、訂單、成交分筆和流水用一次SQL原子寫入，任一環節失敗整筆回滾。重複單號由主鍵領取結果阻止再次扣款。併發手動劃轉和暫停仍以拿到賬戶鎖後的最新資料庫狀態為準。

源單入庫同樣採用鎖後一次合併讀取，再一次合併寫入源單與跟單人庫存狀態，避免多筆通知爭用賬戶鎖時因逐物件查詢和ORM儲存放大排隊。WS下界、REST完整成交量、增量跟買和SELL庫存確認規則沿用。

有接收時間及已儲存單調耗時的歷史WebSocket訂單可以還原成交時間；缺少記錄的舊單顯示“暫無準確時間”和“暫無資料”，不偽造差值。資料庫createdAt仍是記賬時間，已有賬本、餘額和結算記錄不會因顯示修復而重寫。

## 開發與驗證

```bash
cd paper
npm ci
npm test
npm run check
npm run web:build
```

Docker僅複製原始碼和建置所需檔案，排除.env、config/local.json、node_modules、日誌、執行報告和本地資料。預設示例中的本地資料庫設定用於開發；Docker部署用獨立隨機密碼。

官方安裝文件：[Debian Docker Engine](https://docs.docker.com/engine/install/debian/)。
