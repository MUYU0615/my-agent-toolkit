# My Agent Toolkit

个人 AI Agent 技能与服务集合，用于扩展 AI 编程助手和企业微信机器人的能力。

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
