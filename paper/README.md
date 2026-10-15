# WhaleFollow paper edition / 虚拟跟单版

[English project guide](../README.md) · [中文项目说明](../README.zh-CN.md)

[Deployment](../docs/deployment.md) · [部署说明](../docs/deployment.zh-CN.md)

This directory contains the standalone Node.js API/Worker, React dashboard and PostgreSQL accounting implementation. It sends no real trading orders.

本目录包含独立的 Node.js 后台与 Worker、React管理页面和PostgreSQL账本，不发送真钱订单。请从仓库首页查看完整功能与启动步骤。

Development / 开发验证：

```bash
npm ci
npm test
npm run check
npm run web:build
```
