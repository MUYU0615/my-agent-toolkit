# My Agent Toolkit

个人 AI Agent 技能与服务集合，用于扩展 AI 编程助手和企业微信机器人的能力。

## 平台架构

当前项目已经从单体 `bot-host` 收敛成职责清晰的多服务结构，核心目标是把：

- 控制面
- 企业微信长连接消费
- LLM 运行
- 状态持久化
- 审计日志

分到独立服务中，并通过 `data-service` 统一共享关键状态。

当前角色配置也由 `data-service` 持久化管理。`playground`、`roles`、`role documents`、`role questions` 通过 WebUI / control-api 编辑，不再写死在 `bot-host` 代码里。

### 服务分层

#### 接入与控制层

- `control-api`
  - 提供 WebUI 和平台管理接口
  - 负责创建 bot、管理 channel、重置引导、管理员认领、能力配置
  - 默认只调用 `bot-api`
- `bot-api`
  - 提供平台侧 bot HTTP API
  - 承接 WebUI / 控制面的 bot 请求
  - 不负责真实企业微信长连接
- `wecom-worker`
  - 只负责企业微信长连接 worker
  - 负责 runtime supervisor 和真实消息消费
  - 只暴露最小内部接口：`/health`、`/internal/wecom-runtime/sync`

#### 运行与状态层

- `llm-runner`
  - 统一封装 LLM runtime
  - 当前支持 `mock`、`kiro`
  - 屏蔽上层对具体 CLI/provider 的感知
- `data-service`
  - 核心状态中心
  - 保存 bot、admin、channel、初始化 session、runtime 配置、soul、agents、普通文档、pending 文档、memory 文档与统计等
- `log-service`
  - 审计和日志事件服务

#### 外部系统

- 企业微信长连接
- 浏览器中的 WebUI 用户
- 宿主机上的 Kiro relay / CLI 环境

### 当前容器关系

基础启动拓扑：

- `control-api`
- `bot-api`
- `data-service`
- `log-service`
- `llm-runner`

真实企业微信长连接通过 `wecom` profile 单独启动：

- `wecom-worker`

### 两条主链路

#### 1. 平台/API 链路

```text
浏览器 / WebUI
  -> control-api
  -> bot-api
  -> messageHandler
  -> data-service / llm-runner / log-service
```

用于：

- 控制台管理
- 平台模拟消息
- 初始化重置
- 平台主动触发 bot 行为

#### 2. 企业微信真实消息链路

```text
企业微信长连接
  -> wecom-worker
  -> messageHandler
  -> data-service / llm-runner / log-service
```

用于：

- 真实企微消息接收
- 真实企微回复
- runtime supervisor 驱动的 worker 生命周期

### 共享处理与状态归属

共享消息处理位于：

- `services/bot-host/src/messageHandler.ts`

当前共享逻辑包括：

- 消息上下文解析
- 初始化引导逻辑
- memory 注入
- prompt 构建
- 调用 `llm-runner`
- 文档与 pending 输出处理
- 相关状态写回 `data-service`

入口层与共享处理已经拆开：

- `bot-api` 和 `wecom-worker` 共享 `messageHandler.ts`
- 不再共享进程内内存状态
- 关键状态统一进入 `data-service`

### 当前关键状态所在层

现在的关键状态已经集中到 `data-service`：

- bot 基础信息
- 管理员认领状态
- channel 信息
- 初始化引导 session
- runtime 配置
- `soul` / `agents`
- 普通业务文档
- memory 文档与统计
- pending generated documents

这意味着：

- `bot-api` 和 `wecom-worker` 可以独立重启
- 状态不再绑定在某个进程内存中
- 后续扩展到多实例或 k8s 时不会先被状态层卡住

### Soul 与 Agents 的定位

- `soul`
  - 机器人是谁
  - 身份、性格、沟通风格、人格边界
- `agents`
  - 机器人如何工作
  - 能力范围、行为规则、任务流程、工具与文档规范

### 当前启动顺序

建议按这个顺序启动：

1. `data-service`
2. `log-service`
3. `llm-runner`
4. `bot-api`
5. `control-api`
6. `wecom-worker`，仅在真实企业微信场景下启动

原因：

- `bot-api` 和 `wecom-worker` 都依赖 `data-service`
- `bot-api` 依赖 `llm-runner`
- `control-api` 依赖 `bot-api`、`data-service`、`log-service`
- `wecom-worker` 是真实消息消费端，最后启动更稳

### Compose 启动方式

基础服务：

```bash
docker compose -f deploy/compose/docker-compose.yml up -d
```

额外启动真实企业微信 worker：

```bash
docker compose -f deploy/compose/docker-compose.yml --profile wecom up -d wecom-worker
```

更具体的本地容器部署说明见：

- [deploy/compose/README.md](deploy/compose/README.md)

## 技能列表

### wecom-cli-bot

企业微信 CLI 机器人框架。当前实现将 Kiro CLI 接入企业微信智能机器人；代码保留 provider 边界，后续可扩展其他 CLI。

**核心功能：**

- 当前支持 Kiro CLI：`kiro-cli chat --no-interactive --trust-all-tools`
- Docker 容器化部署，docker-compose 多 Bot 管理
- 会话管理：自动 resume、3 小时空闲过期、用户隔离
- 完整指令体系：`/stop` `/help` `/history` `/new` `/open N` `/name`
- 管理员认领与初始化：部署后生成认领码，企业微信内 `/claim_admin <code>` 认领
- 记忆集成：共享 namespace 自动检索注入、手动存取
- 共享文档：多个 Bot 可通过 `/shared/docs` 卷共享已确认文档
- 技能管理：`/skill_list` `/skill_add` `/skill_remove`
- 安全：ANSI 码清理、密钥脱敏、路径沙箱
- 流式输出到企业微信

### bot-memory

Bot 长期记忆技能。为企业微信机器人提供持久化知识库能力。

**核心功能：**

- 对话时自动检索相关历史知识注入 prompt
- 多来源输入：文本、文件上传、URL 抓取、目录扫描
- 知识分层：core（永久）/ reference（90天）/ temp（7天）
- 命名空间隔离 + shared 共享
- 标签粗筛 + 语义精排混合检索

## 服务

### memory-service

独立部署的记忆服务，为所有 Bot 提供知识存储和检索能力。

- 技术栈：FastAPI + ChromaDB + SQLite + fastembed
- Embedding：bge-small-zh-v1.5（ONNX，无需 GPU）
- 镜像大小：~1GB
- 支持格式：Markdown、TXT、PDF、Word、HTML

## 快速开始

### 部署 Memory Service

```bash
cd services/memory-service
docker compose up -d
```

服务启动在 `http://localhost:8100`。

### Bot 配置记忆

在 Bot 的 `docker-compose.yml` 中添加环境变量：

```yaml
environment:
  - MEMORY_API_URL=http://host.docker.internal:8100
  - MEMORY_NAMESPACE=shared
```

在 `bot.config.yaml` 中启用：

```yaml
memory:
  enabled: true
  api_url_env: MEMORY_API_URL
  namespace_env: MEMORY_NAMESPACE
  auto_retrieve: true
  auto_store: true
  retrieve_limit: 5
```

### Kiro Bot 部署要点

1. 在 Docker 宿主机准备 Kiro auth/config：先在有浏览器的环境完成 `kiro-cli login`，如果 Docker 在远程机器上运行，把所需 auth/config 复制到远程宿主机。
2. 设置 `KIRO_HOST_AUTH_DIR`，Compose 会把它只读挂载到容器的 `/host/kiro-auth`。
3. 构建包含 Kiro CLI 的镜像并验证：

```bash
docker compose build <service>
docker run --rm --entrypoint ./scripts/check-runtime.sh <image-name> <bot-name>
```

4. 生成管理员认领码：

```bash
npm run admin:claim -- --bot <bot-name>
```

5. 管理员在企业微信向 bot 发送 `/claim_admin <code>`。认领成功后会自动进入初始化引导，不需要额外执行 `/init`。

## 目录结构

```
my-agent-toolkit/
├── .agents/skills/
│   ├── wecom-cli-bot/          # 企业微信 Bot 框架技能
│   │   ├── SKILL.md
│   │   ├── assets/             # 项目模板源码
│   │   └── references/         # 参考文档
│   └── bot-memory/             # Bot 记忆技能
│       ├── SKILL.md
│       └── references/         # API 规范和指令文档
├── services/
│   └── memory-service/         # 记忆服务实现
│       ├── Dockerfile
│       ├── docker-compose.yml
│       └── src/
├── docs/
│   ├── specs/                  # 设计文档
│   └── plans/                  # 实现计划
├── README.md
├── CHANGELOG.md
└── AGENTS.md
```

## 许可证

私有项目，仅供个人使用。
