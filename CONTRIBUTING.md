# Contributing / 參與貢獻

Thank you for helping improve WhaleFollow. Issues and pull requests in English or Chinese are welcome.

歡迎使用中文或英文提交問題和 PR。

## Start here / 從這裡開始

- Search existing issues before opening another one. For bugs, describe the expected result, actual result and reproduction steps.
- Include the release/commit, Node or Docker version, deployment method and relevant **redacted** logs.
- Do not attach `.env`, runtime credentials, database dumps, private keys, tokens or your full financial history.
- Larger changes are easier to review when the intended behavior is discussed in an issue first.

- 提交前先搜尋現有問題；說明預期行為、實際行為和復現步驟。
- 附上版本、Node/Docker版本、部署方式和已脫敏日誌。
- 不要上傳環境檔案、憑據、資料庫備份、私鑰或完整個人賬務記錄。
- 較大的改動建議先開 Issue 討論目標。

## Local checks / 本地檢查

Use Node.js 24. From the repository root:

```bash
cd paper
npm ci
npm test
npm run check
npm run web:build
```

Keep business logic in services, use `async.waterfall` and error-first callbacks, and leave Promise conversion at the database adapter boundary. Financial changes should include tests for funds, fees, idempotency and failure behavior. Use disposable databases for integration checks, never an active wallet database.

業務放在 service，使用 `async.waterfall` 和 error-first callback。財務變更應驗證資金、費用、冪等性和失敗處理。整合測試只用一次性資料庫，不使用正在跟單的資料庫。

Keep pull requests focused. Explain the user-visible change and the checks performed. Documentation or translations do not need artificial unit tests, but links and example commands should be checked.

PR 儘量聚焦，說明實際行為變化及驗證方式。文件和翻譯不用湊單元測試，但應檢查連結與示例命令。

Contributions are submitted under the project's [MIT license](LICENSE). Report sensitive issues through [SECURITY.md](SECURITY.md), not a public issue.
