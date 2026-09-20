# 部署说明

本文档介绍数据同步服务在裸机 / systemd、Docker、Docker Compose、PM2 四种方式下的部署方法，以及备份、监控与故障处置。

## 1. 环境要求

- Node.js **18+**（推荐 20 LTS）、npm 9+
- 磁盘可写目录用于 SQLite 文件（默认 `./data/`）
- 容器方式需要 Docker 20.10+ 或 Docker Compose v2

> `better-sqlite3` 为原生模块，npm 安装时需要匹配目标环境的预编译二进制；如离线或 glibc 版本特殊，安装时会回退源码编译，需具备 Python3 与 make/g++（Debian: `apt install -y python3 make g++`）。

## 2. 裸机 / systemd 部署

```bash
# 1. 准备目录与依赖（建议使用专用用户）
sudo useradd -r -s /usr/sbin/nologin datasync
sudo mkdir -p /opt/data-sync-service /var/lib/datasync
sudo chown -R datasync:datasync /opt/data-sync-service /var/lib/datasync

# 2. 发布代码并安装生产依赖
cd /opt/data-sync-service
npm ci --omit=dev

# 3. 通过环境变量指定配置
sudo -u datasync env \
  PORT=3000 \
  DB_PATH=/var/lib/datasync/sync.db \
  SYNC_CONCURRENCY=8 \
  node server.js
```

systemd 单元 `/etc/systemd/system/data-sync-service.service`：

```ini
[Unit]
Description=Data Sync Service
After=network.target

[Service]
Type=simple
User=datasync
WorkingDirectory=/opt/data-sync-service
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/var/lib/datasync/sync.db
Environment=SYNC_CONCURRENCY=8
EnvironmentFile=-/etc/data-sync-service/env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# 优雅停机：先发 SIGTERM，15 秒后才 SIGKILL（应用内部有 15s 宽限）
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now data-sync-service
sudo systemctl status data-sync-service
journalctl -u data-sync-service -f
```

前置 Nginx 反向代理示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 3. Docker 部署

仓库根目录已提供多阶段 `Dockerfile`（构建层负责编译原生模块，运行层为精简镜像）。

```bash
docker build -t data-sync-service:1.0.0 .

docker run -d \
  --name data-sync \
  --restart unless-stopped \
  -p 3000:3000 \
  -e SYNC_CONCURRENCY=8 \
  -v datasync-data:/app/data \
  data-sync-service:1.0.0

docker logs -f data-sync
curl http://localhost:3000/api/v1/health
```

升级版本时停旧容器、用新镜像启动即可；数据位于命名卷 `datasync-data`，不受镜像替换影响。

## 4. Docker Compose 部署

```bash
# 可按需先复制并修改 .env
cp .env.example .env
docker compose up -d
docker compose logs -f app
```

`docker-compose.yml` 关键点：

- `./data` 挂载到容器 `/app/data`，SQLite 数据持久化在宿主机。
- 内置健康检查调用 `/api/v1/health`，编排器可据此重启异常实例。
- 时区通过 `TZ` 环境变量控制（默认 `Asia/Shanghai`）。

## 5. PM2 部署

```bash
npm ci --omit=dev
npm i -g pm2
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup        # 按提示执行生成的命令，实现开机自启
pm2 logs data-sync-service
pm2 reload data-sync-service   # 0 停机重启（本服务为无状态 API，安全）
```

> PM2 下请保持 `instances: 1`。SQLite 文件库由单进程独占；多实例横向扩展时需改用共享/外部存储（见第 8 节）。

## 6. 数据备份与恢复

SQLite 处于 WAL 模式，安全备份有两种方式：

```bash
# 方式一：使用 sqlite3 在线热备份（推荐，服务无需停机）
sqlite3 /var/lib/datasync/sync.db ".backup '/backup/sync-$(date +%F).db'"

# 方式二：在停机窗口复制全部数据库文件
systemctl stop data-sync-service
cp /var/lib/datasync/sync.db* /backup/
systemctl start data-sync-service
```

恢复：停服 → 用备份文件替换 `sync.db` 并删除旧的 `sync.db-wal`、`sync.db-shm` → 启动。启动后引擎会自动把残留的 `running/processing` 状态恢复为可重试状态。

建议在 cron 中每日执行一次热备份并保留 7~14 份：

```cron
17 3 * * * sqlite3 /var/lib/datasync/sync.db ".backup '/backup/sync-$(date +\%F).db'" && find /backup -name 'sync-*.db' -mtime +14 -delete
```

## 7. 监控、日志与故障处置

**健康检查**

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health
# {"status":"ok","engine":{"activeJobs":0,"inflight":0}, ...}
```

**日志**：标准输出为 JSON Lines（每行一条），可直接被 journalctl / Docker / PM2 / Filebeat 采集；用 `LOG_LEVEL=debug` 输出 HTTP 访问日志。

**观测任务**

```bash
# 失败任务
curl "http://127.0.0.1:3000/api/v1/jobs?status=failed"
# 死信记录事件
curl "http://127.0.0.1:3000/api/v1/events?event=item.dead_lettered"
# 任务失败事件
curl "http://127.0.0.1:3000/api/v1/events?event=job.failed"
```

**故障处置流程**

1. 目标系统短暂不可用：记录自动进入指数退避重试，无需人工介入，关注 `item.retry.scheduled` 事件。
2. 数据本身错误导致不可重试：记录进入死信（`dead_lettered`），任务标记 `failed`；修复数据/连接器后调用 `POST /api/v1/jobs/:id/retry` 补偿。
3. 进程崩溃/宿主机重启：systemd/Docker/PM2 自动拉起；引擎启动时自动恢复未完成的任务与记录（尝试次数保留）。
4. 需要终止同步：`POST /api/v1/jobs/:id/cancel`，已成功的记录保持 `succeeded`，处理中的记录在重启或取消结算后可再次重试。

**容量建议**

- 单进程适合每分钟数千~数万条记录的量级；吞吐瓶颈多为目标端 API，调大 `SYNC_CONCURRENCY`（建议不超过目标端限流允许值）。
- CPU 映射较重时调大 `TRANSFORM_WORKERS`（约等于 vCPU 数）；映射很轻时设为 `0`，省去线程通信开销。
- 定期归档：`event_log` / `audit_log` 只增不减，可按时间导出后清理旧数据。

## 8. 横向扩展（可选演进）

当前进程内事件总线适合单实例部署。多实例时按以下方向演进，业务代码无需改动：

- 把 `EventBus` 替换为 Redis Stream / RabbitMQ 实现（接口仅 `on/publish`）。
- 把 SQLite 替换为 PostgreSQL，并在领取记录时使用 `SELECT ... FOR UPDATE SKIP LOCKED`，即可多实例竞争消费。
- 连接器已注册表化，新增鉴权、批处理、自定义协议的源/目标连接器不影响同步引擎。
