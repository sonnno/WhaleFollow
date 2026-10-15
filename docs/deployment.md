# Deployment and operations

[繁體中文](deployment.zh-Hant.md) · [Project overview](../README.md)

## Start on Debian

Install Git, [Docker Engine](https://docs.docker.com/engine/install/debian/) and its Compose plugin. A single small instance can start with 2 vCPUs and 2 GB RAM; use `docker stats` and the provider's metrics to size for your workload. The host does not need separate Node.js, PostgreSQL or Redis installations.

```bash
git clone https://github.com/sonnno/WhaleFollow.git
cd WhaleFollow
docker compose up -d
docker compose exec api node deploy/show-login.js
```

Visit port 3000. On cloud hosts, allow that port only from trusted source IPs. For public access, use a domain and an HTTPS reverse proxy. The application is a single-administrator dashboard, not a public multi-tenant service.

`bootstrap` and `migrate` exiting with status 0 is normal. The long-running services are `postgres`, `redis`, `api` and `worker`; their health checks should become healthy. Successful local startup does not establish that upstream Polymarket APIs are reachable: check Worker connection status and logs too.

## Optional first-boot configuration

No `.env` file is required for the defaults. To change them before the first boot:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env, then:
docker compose up -d
```

| Variable | Meaning |
| --- | --- |
| `PORT` | Host dashboard port, default 3000. Internal API port remains 3000. |
| `BIND_ADDRESS` | Host binding, default `0.0.0.0`; use `127.0.0.1` behind a local proxy. |
| `INITIAL_CASH` | Starting paper balance for an empty database, default 350. Does not reset an existing wallet. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Optional initial login. Blank means generated defaults. |
| `SESSION_SECRET` | Optional initial session key, at least 32 characters. |
| `POSTGRES_PASSWORD` | Optional initial database password. Blank means randomly generated. |
| `POLYMARKET_PROXY_URL` | Optional outbound proxy configuration. |

Credentials are generated once in the runtime volume and reused. Changing the credential environment variables after initialization is rejected rather than silently replacing existing credentials. Keep the runtime volume: deleting it can make the retained database password inaccessible. There is currently no online password-change flow.

## Storage and resource limits

The Compose project defaults to `whalefollow`. PostgreSQL, Redis and runtime credentials use separate named volumes. Running another independent instance requires a distinct `-p` project name **and** another host port; do not run duplicate Workers for the same database.

The default Compose configuration sets limits for the API (256 MB), Worker (640 MB), PostgreSQL (512 MB) and Redis (128 MB). PostgreSQL has 128 MB shared memory and conservative query settings. These are limits, not measured usage or a capacity guarantee. Monitor historical CPU/memory in your cloud provider's console or your own monitoring system; the app does not collect server resource history.

```bash
docker compose ps -a
docker compose logs --tail=100 api worker migrate
docker stats --no-stream
```

## Stop, restart and update

```bash
# Stop while retaining named volumes
docker compose down
# Start again
docker compose up -d
```

For an upgrade, back up first, then stop the existing processes before migrations:

```bash
docker compose down
git pull --ff-only
docker compose up -d --build
```

**`docker compose down -v` deletes the named volumes. Do not use it for routine updates.** No old buy orders are replayed when the Worker resumes.

## Backups

Back up the database and the runtime credentials. Never commit backup archives to Git.

```bash
mkdir -p backups
chmod 700 backups
docker compose exec -T postgres pg_dump -U whalefollow -d whalefollow_paper -Fc > backups/paper.dump
docker compose exec -T api tar -C /var/lib/whalefollow -czf - . > backups/runtime.tar.gz
chmod 600 backups/*
```

The runtime archive contains login and database secrets. These commands do not back up the Redis volume. For full recovery, stop services and preserve Redis data as well. Test restoration in an isolated deployment before replacing active data; a database-only restore with unrelated runtime credentials is insufficient.

## Common issues

| Symptom | Check |
| --- | --- |
| Cannot open the dashboard | API health, port mapping, host/cloud firewall and bind address. |
| No copied trades | Task is started, new source trades exist, Worker feed is connected, and funds/budgets permit the buy. |
| Dedicated account has no funds | Transfer paper cash manually; an exposure budget is not a deposit. |
| Database lease is held | Stop the other API/Worker or migration process using the same database. |
| TLS disconnections / upstream backoff | Outbound connectivity and proxy settings; inspect Worker logs. Do not reset financial data to fix networking. |
| Today's daily result is absent | Expected: the prior calendar day is published at 10:00 Asia/Shanghai. Check the daily-report task if that time has passed. |
| Credentials mismatch | Retain the original runtime volume and original first-boot configuration. |

Pause stops new buys; existing positions continue through copied sales and settlement. A stopped server cannot observe trades while offline, and missed buys are not backfilled. Missing historical daily reports can be generated after restart for eligible completed reporting days.
