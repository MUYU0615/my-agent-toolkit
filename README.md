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

当前标准角色集固定为 5 个：

- 产品经理
- 测试工程师
- 研发工程师
- 市场人员
- 运营人员

这些标准角色包含两层配置：

- `role.md`
  - 角色隐藏规则
  - 默认专业工作方式
- `role questions`
  - 初始化时逐题询问管理员的问题

如果需要把本地环境重置回标准角色集并清空旧 bot / channel / 角色相关数据，可调用：

```bash
curl -X POST http://localhost:8300/internal/reset-standard-role-config
```

这个重置动作会：

- 清空 bot、channel、初始化、运行时和角色相关数据
- 保留单例 `playground.md`
- 重新写入 5 个标准角色种子数据

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
  - 只消费已安装能力，并在执行时临时注入 bot 私有 env
- `capability-runner`
  - 管理 bot 私有 workspace
  - 负责 skill / MCP 的安装、删除、失败回滚与清理
  - 不参与 prompt 生成，也不承担模型推理
- `data-service`
  - 核心状态中心
  - 保存 bot、admin、channel、初始化 session、runtime 配置、soul、agents、普通文档、pending 文档、memory 文档与统计等
  - 同时保存 bot 私有 env metadata、runtime policy、skills、mcps 和 capability audit logs
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
- `capability-runner`

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

bot 私有能力链路则拆成另一条：

- `bot-host` 识别 `/env`、`/skill`、`/mcp`、`/policy`、`/capability`
- `data-service` 保存结构化能力状态
- `capability-runner` 负责 bot 私有 workspace 安装和删除
- `llm-runner` 只在运行时消费这些能力

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
- bot 私有 env metadata
- bot 私有 runtime policy
- bot 私有 skills / mcps
- capability 审计日志

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
4. `capability-runner`
5. `bot-api`
6. `control-api`
7. `wecom-worker`，仅在真实企业微信场景下启动

原因：

- `bot-api` 和 `wecom-worker` 都依赖 `data-service`
- `bot-api` 和 `wecom-worker` 的能力管理请求依赖 `capability-runner`
- `bot-api` 依赖 `llm-runner`
- `control-api` 依赖 `bot-api`、`data-service`、`log-service`
- `wecom-worker` 是真实消息消费端，最后启动更稳

### Compose 启动方式

日常本地开发使用热更新模式。第一次启动会构建开发镜像，之后修改各服务的 `src/` 会自动重启对应进程：

```bash
# 终端 1：宿主机 Kiro relay（修改 relay 源码也会自动重启）
npm run dev:relay

# 终端 2：Docker 中的全部 Node 服务（默认包含企业微信 worker）
npm run dev:up

# 终端 3：查看所有开发服务日志
npm run dev:logs
```

宿主机 Relay 默认把每个 Bot 的 Kiro 工作目录放在：

```text
~/Documents/KiroBotWorkspaces/<bot_id>/
```

其中只保存本机 Kiro 必须直接访问的工作区内容，例如
`.kiro/agents/`、`.kiro/skills/` 和后续由 Kiro 操作的项目文件。SQLite、
日志和其他平台状态继续保存在 Docker named volume 中。可以在启动 Relay
时覆盖默认位置：

```bash
KIRO_WORKSPACE_ROOT="$HOME/Documents/KiroBotWorkspaces" npm run dev:relay
```

Relay 会校验 `bot_id`，并在对应 Bot 目录内同时执行聊天命令和
`--list-sessions`，不会再从 `my-agent-toolkit` 项目根目录启动 Kiro。

常用命令：

```bash
npm run dev:status
npm run dev:down

# 不连接企业微信，只启动 HTTP/API 服务
DEV_WECOM=0 npm run dev:up
```

热更新覆盖 `control-api`、`bot-api`、`wecom-worker`、`data-service`、`log-service`、`llm-runner`、`capability-runner` 和共享 `contracts`。修改依赖、`package-lock.json`、Dockerfile 或 Compose 后仍需重新执行 `npm run dev:up` 构建镜像。SQLite 和 Capability Runner 的内部数据继续保存在 Docker named volume 中，停止开发环境时不要添加 `-v`。

生产式完整重建仍使用：

基础服务：

```bash
./scripts/dev-redeploy.sh
```

额外启动真实企业微信 worker：

```bash
docker compose -f deploy/compose/docker-compose.yml --profile wecom up -d wecom-worker
```

部署校验原则：

- 不再直接依赖裸 `docker compose up -d` 作为本地重建入口。
- 统一通过 `scripts/dev-redeploy.sh` 构建并强制重建容器。
- 脚本会把当前 `git sha` 和 `build time` 注入镜像，并在启动后逐个检查 `/health` 返回的 `git_sha` 是否等于当前 `HEAD`。
- 如果镜像构建失败，或服务虽然存活但版本不是当前代码，脚本会直接失败，避免旧容器继续对外提供服务。

更具体的本地容器部署说明见：

- [deploy/compose/README.md](deploy/compose/README.md)

## Bot 私有能力

当前平台支持每个 bot 独立维护自己的：

- 环境变量
- Skills
- MCP
- runtime policy

这些能力不属于某个特定 LLM，而属于 bot 本身。

关键约束：

- bot 私有 env 不进入 prompt，不进入 memory，不进入 `soul` / `agents`。
- env 只在运行时由 `llm-runner` 临时注入到实际执行进程。
- WebUI 中 env 只展示 key、是否已设置、更新时间，真实值始终掩码为 `****`。
- skill / MCP 的安装和删除只影响当前 bot 的独立 workspace，不影响其他 bot。

当前 Skill 安装流程：

1. 将可分发的 Skill 包放在项目 `.agents/skills/<skill-name>/`，包内必须有带 `name` 和 `description` frontmatter 的 `SKILL.md`。
2. 打开 WebUI 的 Bot 能力页，在 Skills 区域选择内置 Skill 并安装。
3. `capability-runner` 把 Skill 原子复制到 `~/Documents/KiroBotWorkspaces/<bot_id>/.kiro/skills/<skill-name>/` 和 `.claude/skills/<skill-name>/`。
4. 安装状态同步写入 `data-service.db` 的 `bot_skills`；页面会展示状态和失败原因。
5. 在企业微信中发送 `/skill`，只会看到当前 Bot 已成功安装的技能。

Compose 使用 `${HOME}/Documents/KiroBotWorkspaces` 作为宿主机挂载源，因此本机和服务器无需修改项目代码；服务器只需确保运行 Docker 的用户有对应的 `HOME/Documents/KiroBotWorkspaces` 目录及读写权限。

## 技能列表

### wecom-cli-bot

企业微信 CLI 机器人框架。托管平台已接入 Kiro CLI 和 Claude Code，WebUI 可按 Bot 选择运行时。

**核心功能：**

- 当前支持 Kiro CLI 与 Claude Code
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
