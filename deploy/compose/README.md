# 本地 Compose 部署

这个目录用于在本机 Docker 中模拟平台容器化部署。

默认启动拓扑包含 `control-api`、`bot-api`、`data-service`、`log-service`、`llm-runner`、`capability-runner`。其中 `bot-api` 只提供平台 HTTP API，不连接真实企业微信长连接。真实企业微信连接由 `wecom-worker` 承担，并放在 `wecom` profile 下，避免本地开发、接口测试或重复启动时抢占线上长连接。

默认 `control-api` 始终把平台请求转发到 `http://bot-api:8400`。`wecom-worker` 只负责企业微信长连接和 runtime sync，不作为 WebUI 的对外 API 入口。`capability-runner` 负责 bot 私有 workspace 中的 skill / MCP 安装、删除和失败清理；`llm-runner` 只消费已经安装好的能力并在执行时注入 bot 私有 env。

## 启动基础服务

使用开发脚本时，会自动生成仅供本机使用且已被 Git 忽略的
`deploy/compose/.env.credentials`。Kiro Relay 和 Docker 服务必须读取同一份文件：

```bash
npm run dev:relay
npm run dev:up
```

文件包含用户凭证加密主密钥、内部服务 Token、Relay Token 和绑定页公开地址。不要提交或复制其中的真实值到聊天记录。

普通用户在企微中使用：

```text
/jira bind
/jira status
/jira unbind
```

`/jira bind` 返回 10 分钟有效的一次性页面。绑定完成后，用户可直接发送 `HIM-22356` 等 Jira 编号。账号密码以 AES-256-GCM 密文存入 `data-service.db`；运行时仅注入当前 Bot、当前企微用户的 Kiro 子进程。

本机默认绑定地址为 `http://localhost:8600`，适合在同一台电脑的企微客户端中验证。手机或远程用户必须将 `CREDENTIAL_BIND_PUBLIC_URL` 配置为用户可访问的 HTTPS 域名。

服务器部署应复制示例文件并自行生成密钥：

```bash
cp deploy/compose/.env.credentials.example deploy/compose/.env.credentials
chmod 600 deploy/compose/.env.credentials
docker compose --env-file deploy/compose/.env.credentials \
  -f deploy/compose/docker-compose.yml --profile wecom up -d
```

宿主机 Kiro Relay 必须设置与 Compose 相同的 `KIRO_RELAY_AUTH_TOKEN`。`USER_CREDENTIALS_MASTER_KEY` 只提供给 `data-service`，不要提供给 Kiro Relay。

后续直接使用 Compose 命令时也必须始终带上同一个 env 文件，避免服务在缺少主密钥或内部 Token 的情况下启动：

```bash
docker compose --env-file deploy/compose/.env.credentials \
  -f deploy/compose/docker-compose.yml up -d
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
curl http://localhost:8700/health
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

## Bot 私有能力说明

- `capability-runner` 管理每个 bot 独立的 workspace，用于安装和删除该 bot 私有的 `skill` / `MCP`。
- `llm-runner` 不持有这些能力定义，只在真正执行 runtime 进程时读取 bot 私有 env，并把 secret 临时注入子进程环境。
- WebUI 中的环境变量只显示 key、状态和更新时间，真实值始终掩码展示为 `****`。
- bot 私有 env 不会进入 prompt、memory、`soul`、`agents` 或普通文档。
