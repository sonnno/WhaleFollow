# 部署与运维

[English](deployment.md) · [项目首页](../README.zh-CN.md)

独立的Polymarket虚拟跟单系统。Node.js后台和Worker、React管理页面、PostgreSQL账本、Redis缓存；没有真钱下单功能，不需要私钥、API密钥或钱包授权。

## Debian一条命令启动

使用Debian12/13，安装Docker Engine和Compose插件。建议2核2GB起步，只运行这一套；同时部署其他应用建议4GB。服务器不需要另装Node、PostgreSQL或Redis。

仓库公开，无需GitHub登录。

```bash
git clone https://github.com/sonnno/WhaleFollow.git
cd WhaleFollow
docker compose up -d
```

首次运行会自动构建镜像、生成并保存密码、启动数据库和Redis、执行TypeORM建表、启动后台和Worker。初始虚拟本金350美元，没有自动开始的跟单任务。第一次需要下载镜像和npm包，耗时取决于网络。

打开`http://服务器IP:3000`。查看管理员登录信息：

```bash
docker compose exec api node deploy/show-login.js
```

默认用户名`admin`，密码首次随机生成；重启不会更换密码。后台新建任务、转入资金和点击“开始跟单”后才跟新交易。所有金额只是模拟记账。

在Lightsail防火墙放行TCP3000，来源限制为你的IP。长期通过公网访问时配置域名和HTTPS反向代理。PostgreSQL和Redis没有映射到服务器外部端口。

## 查看运行情况

```bash
docker compose ps -a
docker compose logs --tail=100 api worker migrate
docker stats --no-stream
```

`bootstrap`和`migrate`显示`Exited (0)`是正常的；postgres、redis、api、worker应该运行并逐步变为healthy。Worker就绪后仍需在后台检查Polymarket连接状态；本地启动成功不代表外部API永远可用。日志自动轮转，防止占满硬盘。

## 停止、重启、更新

```bash
# 停止程序，保留全部数据
docker compose down
# 再次启动，沿用数据和密码
docker compose up -d
```

更新代码时先停止旧进程，避免旧API/Worker占用数据库迁移锁：

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
```

不要使用`docker compose down -v`：它会删除数据库、Redis和密码卷。不要单独删除runtime卷：数据库已有密码会与新密码不匹配。服务器重启后数据库、Redis、API和Worker自动恢复；首次建表服务不用重复常驻。

## 可选配置

无需复制.env即可默认启动。如果要改端口或初始本金，可在首次启动前：

```bash
cp .env.example .env
chmod 600 .env
nano .env
docker compose up -d
```

`PORT`是服务器访问端口，容器后台固定3000。`INITIAL_CASH`仅影响全新数据库，不会修改已有余额。想使用自己设定的管理员用户名/密码，可在第一次启动前填写；留空则随机生成。`SESSION_SECRET`如自行设置至少32字符。生成后改凭据环境变量会明确报错，避免静默改密码导致数据库连接失败。现阶段密码持久化后需要保留，不提供在线改密码功能。

默认采用共享Compose项目名whalefollow。不要在同一台服务器重复启动同一个项目；要开第二个独立测试实例须显式使用不同的`-p`项目名和PORT。所有卷均按项目名隔离。

PostgreSQL预设共享内存128MB和低内存参数，后台256MB、Worker640MB、数据库512MB、Redis128MB上限。预算是起步配置，任务和数据增长后应查看docker stats；不要依靠频繁交换内存维持跟单。

## 备份和恢复

数据库和密码都需要备份，备份文件不要提交Git：

```bash
mkdir -p backups
chmod 700 backups
docker compose exec -T postgres pg_dump -U whalefollow -d whalefollow_paper -Fc > backups/paper.dump
docker compose exec -T api tar -C /var/lib/whalefollow -czf - . > backups/runtime.tar.gz
chmod 600 backups/*
```

恢复请先在隔离环境验证，不要直接覆盖当前跟单账户。Redis数据持久化在redis-data卷；上面的数据库备份不包含Redis缓存，完整灾备还需在停止服务后保存该卷。runtime备份包含登录和数据库密码，应妥善保管。

## 成交时间和耗时

页面只显示原主成交时间、我们的成交时间和两者差值。Worker启动时及每分钟通过官方CLOB `/time`校准应用内时钟，取三次请求中往返最快的样本，再用单调时钟生成成交时间；不修改操作系统时间。原主时间保留Polymarket官方记录。官方接口只精确到秒，校准还受网络往返误差影响，因此页面差值不能视为毫秒级精密测量。校准失败会保留上次成功结果；首次校准失败会记录警告并使用本机时间，交易继续。

完整WebSocket成交通知会在源单入库时并行准备报价。源单提交后直接进入原有按资产排序的执行队列，跳过Redis投递往返；持久化outbox和Redis仍负责重启及失败恢复。资金、暂停、重复成交和已结算状态继续在记账事务内检查。

已取得完整快照、保持同一连接且消息/PONG存活的盘口直接用于模拟成交，不因超过2秒而每单等待REST。实际成交前重新读取本地最新价格和剩余深度。市场参数在后台每10秒检查、超过30秒按近期使用的市场刷新；缓存失效、首次市场缺少数据或盘口流断线时，仍需REST取得可靠数据。不得用原主成交价冒充我们当前能成交的价格。只有REST快照时仍采用原2秒有效期。盘口30秒无消息/PONG会失效并重连，重连必须重新验证完整快照。

内部单调耗时、直接投递模式、盘口来源和校准状态仅保留在后台诊断，不显示在订单页面。

Worker内存缓存任务和暂停设置；控制台修改后通过Redis通知更新，每秒后台刷新作为兜底。WebSocket已知跟单人使用缓存，任务版本变化时立即重新处理原消息。余额与独立资金在记账事务内锁定一次，随后用一次SQL领取唯一订单号并读取一致的金融上下文；不逐字段查询。成交后的余额、任务资金、持仓、订单、成交分笔和流水用一次SQL原子写入，任一环节失败整笔回滚。重复单号由主键领取结果阻止再次扣款。并发手动划转和暂停仍以拿到账户锁后的最新数据库状态为准。

源单入库同样采用锁后一次合并读取，再一次合并写入源单与跟单人库存状态，避免多笔通知争用账户锁时因逐对象查询和ORM保存放大排队。WS下界、REST完整成交量、增量跟买和SELL库存确认规则沿用。

有接收时间及已保存单调耗时的历史WebSocket订单可以还原成交时间；缺少记录的旧单显示“暂无准确时间”和“暂无数据”，不伪造差值。数据库createdAt仍是记账时间，已有账本、余额和结算记录不会因显示修复而重写。

## 开发与验证

```bash
cd paper
npm ci
npm test
npm run check
npm run web:build
```

Docker仅复制源码和构建所需文件，排除.env、config/local.json、node_modules、日志、运行报告和本地数据。默认示例中的本地数据库配置用于开发；Docker部署用独立随机密码。

官方安装文档：[Debian Docker Engine](https://docs.docker.com/engine/install/debian/)。
