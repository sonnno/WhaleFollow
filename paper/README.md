# WhaleFollow paper edition / 虛擬跟單版

[English project guide](../README.md) · [中文專案說明](../README.zh-Hant.md)

[Deployment](../docs/deployment.md) · [部署說明](../docs/deployment.zh-Hant.md)

This directory contains the standalone Node.js API/Worker, React dashboard and PostgreSQL accounting implementation. It sends no real trading orders.

本目錄包含獨立的 Node.js 後台與 Worker、React管理頁面和PostgreSQL賬本，不傳送真錢訂單。請從倉庫首頁檢視完整功能與啟動步驟。

Feature details / 功能說明：

- [Smart pause / 智能暫停](docs/smart-pause.md)
- [Virtual deposits / 虛擬充值](docs/wallet-deposits.md)
- [Position-based sales / 按原主持倉比例跟賣](docs/position-sales.md)
- [Realistic short-sports simulation](docs/short-sports.md)

Development / 開發驗證：

```bash
npm ci
npm test
npm run check
npm run web:build
```
