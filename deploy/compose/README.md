# 本地 Compose 部署

这个目录用于在本机 Docker 中模拟平台容器化部署。

默认启动拓扑包含 `control-api`、`bot-api`、`data-service`、`log-service`、`llm-runner`。其中 `bot-api` 只提供平台 HTTP API，不连接真实企业微信长连接。真实企业微信连接由 `wecom-worker` 承担，并放在 `wecom` profile 下，避免本地开发、接口测试或重复启动时抢占线上长连接。

默认 `control-api` 始终把平台请求转发到 `http://bot-api:8400`。`wecom-worker` 只负责企业微信长连接和 runtime sync，不作为 WebUI 的对外 API 入口。

## 启动基础服务

```bash
docker compose -f deploy/compose/docker-compose.yml up -d
```

控制台页面：

```text
http://localhost:8600/
```

健康检查：

```bash
curl http://localhost:8200/health
curl http://localhost:8300/health
curl http://localhost:8400/health
curl http://localhost:8500/health
curl http://localhost:8600/health
```

## 启动真实企业微信 Worker

`wecom-worker` 当前不通过 `deploy/compose/.env.wecom` 读取凭证。它只负责长连接和 runtime sync，真实企业微信 Bot 的运行配置来自平台数据面：Bot 记录、runtime 配置以及数据服务中持久化的企业微信渠道信息。

启动真实长连接：

```bash
docker compose -f deploy/compose/docker-compose.yml --profile wecom up -d wecom-worker
```

检查真实 Worker：

```bash
curl http://localhost:8401/health
```

注意：同一个企业微信 Bot ID 同时只应有一个长连接消费者。启动 `wecom-worker` 前，确认没有其他环境正在使用同一组企业微信凭证，并确认对应 bot 的企业微信配置已经通过平台写入数据服务。
