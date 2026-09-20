# 数据同步服务 data-sync-service

基于 **Node.js + Express + SQLite** 的通用数据同步服务。从可插拔的「数据源连接器」批量拉取记录，经过字段映射转换后写入「目标连接器」，适用于系统间定时/手动数据同步场景。

核心特性：

- **事件驱动解耦**：模块间通过进程内异步事件总线（`src/eventbus/EventBus.js`）通信，事件同时持久化到 SQLite，可观测、可审计。
- **异步非阻塞**：HTTP 请求只负责入库并发布事件后立即返回 `202`；拉取、转换、推送全部在后台流水线中进行；CPU 密集的字段映射跑在 `worker_threads` 线程池里，不阻塞事件循环。
- **失败补偿与重试**：单条记录级别的指数退避 + 全抖动重试（Full Jitter Backoff），超过最大次数进入死信（`dead_lettered`）；支持一键手动重试失败任务；进程崩溃重启后自动恢复中断的任务与记录。

## 技术栈

| 关注点 | 选型 |
| --- | --- |
| 运行时 | Node.js >= 18（推荐 20 LTS） |
| Web 框架 | Express 5 |
| 数据库 | SQLite（`better-sqlite3`，WAL 模式，同步驱动 + 事务） |
| 线程 | `worker_threads`（字段映射线程池） |
| 测试 | Node 内置 test runner（零额外测试依赖） |

## 快速开始

```bash
npm install
npm start
# data-sync-service listening on :3000
```

开发模式（文件改动自动重启）：

```bash
npm run dev
```

运行测试：

```bash
npm test
```

## 30 秒体验

服务内置 `mock` 源与 `mock` 目标，无需任何外部依赖即可体验完整流程（含失败重试）：

```bash
# 创建任务：5 条记录，目标前 1 次推送模拟失败（验证自动重试）
curl -X POST http://localhost:3000/api/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "source": { "type": "mock", "config": { "count": 5 } },
    "target": { "type": "mock", "config": { "failAttempts": 1 } },
    "max_attempts": 3
  }'

# 查看任务列表 / 详情
curl "http://localhost:3000/api/v1/jobs"
curl "http://localhost:3000/api/v1/jobs/<JOB_ID>"

# 查看任务下每条记录的同步状态
curl "http://localhost:3000/api/v1/jobs/<JOB_ID>/items"

# 手动补偿重试失败任务
curl -X POST "http://localhost:3000/api/v1/jobs/<JOB_ID>/retry"

# 查看事件流与审计日志
curl "http://localhost:3000/api/v1/events"
curl "http://localhost:3000/api/v1/audit"
```

## HTTP API

所有接口前缀：`/api/v1`，请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回引擎/线程池实时状态 |
| POST | `/jobs` | 创建同步任务，返回 `202` 后由后台异步执行 |
| GET | `/jobs?status=&limit=&offset=` | 任务列表（含各项计数） |
| GET | `/jobs/:id` | 任务详情 |
| GET | `/jobs/:id/items` | 任务下记录明细与状态计数 |
| POST | `/jobs/:id/cancel` | 取消 pending/running/failed 任务 |
| POST | `/jobs/:id/retry` | 手动重试 failed/completed 任务（重置死信记录） |
| GET | `/events?event=&limit=&offset=` | 事件流水（可按事件名过滤） |
| GET | `/audit?action=&job_id=` | 操作审计日志 |

### 创建任务请求体

```json
{
  "source": {
    "type": "http",
    "config": { "url": "https://example.com/users", "dataPath": "data.records" }
  },
  "target": {
    "type": "http",
    "config": { "url": "https://crm.example.com/api/import", "method": "POST" }
  },
  "mapping": {
    "keepUnmapped": false,
    "fields": { "externalId": "id", "fullName": "profile.name" },
    "defaults": { "source": "example" }
  },
  "max_attempts": 5
}
```

- `mapping.fields`：`目标字段: 源字段点路径`，转换在 worker 线程中执行。
- `mapping.defaults`：源字段缺失时使用的默认值。
- `mapping.keepUnmapped`：是否保留未映射字段（默认保留）。

### 任务与记录状态机

```
任务: pending -> running -> completed
                        └-> failed ──(POST /retry)──> pending
           pending/running/failed ──cancel──> cancelled

记录: pending -> processing -> succeeded
                      ├-> retrying (退避到期后再次 processing)
                      └-> dead_lettered (超过 max_attempts 或不可重试错误)
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `data/sync.db` | SQLite 文件路径，`:memory:` 为内存库 |
| `SYNC_CONCURRENCY` | `4` | 同步引擎全局并发处理数 |
| `SYNC_SCAN_INTERVAL_MS` | `5000` | 扫描到期重试记录的间隔 |
| `SYNC_DEFAULT_MAX_ATTEMPTS` | `5` | 任务默认最大尝试次数 |
| `SYNC_BACKOFF_BASE_MS` | `1000` | 退避初始基数 |
| `SYNC_BACKOFF_FACTOR` | `2` | 退避乘数 |
| `SYNC_BACKOFF_MAX_MS` | `300000` | 单次退避上限（5 分钟） |
| `TRANSFORM_WORKERS` | `2` | 映射转换 worker 线程数，`0` 表示主线程执行 |
| `HTTP_CONNECTOR_TIMEOUT_MS` | `15000` | HTTP 连接器请求超时 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 项目结构

```
server.js                    入口：HTTP 服务 + 优雅停机
src/
  config.js                  环境变量配置
  container.js               组合根：装配所有模块（依赖注入）
  db/                        SQLite 连接与 schema
  eventbus/                  事件总线与事件常量
  repositories/              jobs / items / events / audit 数据访问
  connectors/                mock 与 http 源/目标连接器 + 注册表
  transform/                 字段映射纯函数 + worker_threads 线程池
  sync/SyncEngine.js         事件驱动同步引擎（调度、重试、死信、恢复）
  api/                       Express 应用与路由
  utils/                     JSON 日志、异步工具
test/sync.test.js            端到端测试
docs/DEPLOYMENT.md           部署说明
Dockerfile / docker-compose.yml / ecosystem.config.cjs
```

## 架构说明

```
                 POST /jobs
   HTTP API ───────────────────► SQLite(jobs/items)
      │                              │
      └──publish job.created────────► EventBus (异步、有序、错误隔离)
                                     │
                              SyncEngine ◄── 定时扫描到期重试
                              ├─ 拉取(source.fetch)并拆分入库
                              ├─ 并发领取 items（状态原子抢占）
                              ├─ TransformPool(worker_threads) 映射
                              ├─ target.push 推送
                              └─ 失败：指数退避重试 / 死信
                                     │
                          所有事件 ► event_log + 审计 ► audit_log
```

- **事件列表**：`job.created/started/completed/failed/cancelled/retry.requested`，`item.processing/succeeded/failed/retry.scheduled/dead_lettered`。
- **为什么用 SQLite**：同步编排需要原子的「抢占 + 计数 + 状态结算」，`better-sqlite3` 的同步事务天然规避异步竞态；WAL 模式保证读写并发。
- **扩展连接器**：实现 `{ type, fetch(config) }`（源）或 `{ type, push(record, config, ctx) }`（目标），调用 `registerSource/registerTarget` 注册即可，引擎与 API 无需改动。推送错误可挂 `error.retryable = false` 标记不可重试，直接进入死信。
- **替换为外部消息队列**：业务只依赖 `EventBus.on/publish`，可将其替换为 Redis Stream / RabbitMQ 实现，引擎订阅相应事件即可水平拆分。

## 可靠性设计

- **至少一次投递**：记录领取是 `pending/retrying → processing` 的原子 UPDATE，崩溃后重启把残留 `processing` 重置为 `retrying`，不丢数据（目标端需保证幂等）。
- **指数退避 + 全抖动**：`delay = random(0, min(base * factor^(attempt-1), max))`，避免失败风暴。
- **死信与人工补偿**：超过 `max_attempts` 或连接器声明不可重试的记录进入死信，任务标记 `failed`；`POST /jobs/:id/retry` 重置死信记录并重新入队。
- **优雅停机**：收到 `SIGTERM/SIGINT` 后停止接收新连接，15 秒内释放线程池与数据库句柄。

更多运维细节见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
