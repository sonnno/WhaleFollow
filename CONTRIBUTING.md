# Contributing / 参与贡献

Thank you for helping improve WhaleFollow. Issues and pull requests in English or Chinese are welcome.

欢迎使用中文或英文提交问题和 PR。

## Start here / 从这里开始

- Search existing issues before opening another one. For bugs, describe the expected result, actual result and reproduction steps.
- Include the release/commit, Node or Docker version, deployment method and relevant **redacted** logs.
- Do not attach `.env`, runtime credentials, database dumps, private keys, tokens or your full financial history.
- Larger changes are easier to review when the intended behavior is discussed in an issue first.

- 提交前先搜索现有问题；说明预期行为、实际行为和复现步骤。
- 附上版本、Node/Docker版本、部署方式和已脱敏日志。
- 不要上传环境文件、凭据、数据库备份、私钥或完整个人账务记录。
- 较大的改动建议先开 Issue 讨论目标。

## Local checks / 本地检查

Use Node.js 24. From the repository root:

```bash
cd paper
npm ci
npm test
npm run check
npm run web:build
```

Keep business logic in services, use `async.waterfall` and error-first callbacks, and leave Promise conversion at the database adapter boundary. Financial changes should include tests for funds, fees, idempotency and failure behavior. Use disposable databases for integration checks, never an active wallet database.

业务放在 service，使用 `async.waterfall` 和 error-first callback。财务变更应验证资金、费用、幂等性和失败处理。集成测试只用一次性数据库，不使用正在跟单的数据库。

Keep pull requests focused. Explain the user-visible change and the checks performed. Documentation or translations do not need artificial unit tests, but links and example commands should be checked.

PR 尽量聚焦，说明实际行为变化及验证方式。文档和翻译不用凑单元测试，但应检查链接与示例命令。

Contributions are submitted under the project's [MIT license](LICENSE). Report sensitive issues through [SECURITY.md](SECURITY.md), not a public issue.
