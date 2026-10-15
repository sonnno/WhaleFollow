# Changelog / 更新记录

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
- English and Chinese project/deployment documentation, MIT licensing and contribution guidance.

### Fixed

- The overview's daily profit table now reads saved daily reports instead of grouping today's live settlements. Reports close at 10:00 Asia/Shanghai for the previous calendar day.

### 中文

首个公开发布的虚拟跟单版本，包含排行榜、多人任务、比例与金额配置、公共/独立资金、手动划转、WebSocket实时虚拟成交、订单价格与时间对比、持仓结算及费用、盈亏统计和任务日表。

支持 Docker Compose 部署，自动生成并保存凭据、执行迁移和健康检查。补齐中英文项目与部署文档、MIT许可证和参与贡献说明。

修复总览每日盈亏表错误使用实时汇总的问题，改为读取每天北京时间10点生成的前一天固定日报。本版本不包含真钱交易功能。
