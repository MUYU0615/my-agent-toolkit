# 项目 Agent 指南

本仓库维护个人使用的 Agent 技能和服务。

## 当前技能

### wecom-cli-bot

```text
.agents/skills/wecom-cli-bot
```

企业微信 CLI 机器人框架技能。生成的项目将企业微信智能机器人长连接消息桥接到 AI CLI 工具（Kimi Code、Kiro CLI、Codex、Claude Code）。

### bot-memory

```text
.agents/skills/bot-memory
```

Bot 记忆技能。指导 Bot 如何与 Memory Service 交互，实现长期知识存储和自动检索注入。

## 服务

```text
services/memory-service
```

独立部署的记忆服务（FastAPI + ChromaDB + fastembed），为所有 Bot 提供知识库能力。

## 维护规则

- 技能修改仅在 `.agents/skills/` 对应子目录下进行。
- 服务实现代码在 `services/` 目录。
- 不要在仓库中存储真实凭证（Bot ID、Secret、API Key）。
- `.env.example` 文件仅保留占位符。
- 优先使用 Docker 模式验证。

## 验证

wecom-cli-bot 技能验证：

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm install && npm run typecheck
```

Memory Service 验证：

```bash
cd services/memory-service
docker compose up -d
curl http://localhost:8100/health
```
