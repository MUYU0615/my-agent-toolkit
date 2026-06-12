# My Agent Toolkit

个人 AI Agent 技能集合，用于扩展 AI 编程助手的能力。

## 技能列表

### wecom-cli-bot

企业微信 CLI 机器人框架。将 AI CLI 工具（Kimi Code、Kiro CLI、Codex、Claude Code）接入企业微信智能机器人，支持多 Bot 多 Provider 部署。

**核心功能：**

- 支持多种 AI CLI Provider（Kimi Code、Kiro CLI、Codex、Claude Code）
- Docker 容器化部署，docker-compose 多 Bot 管理
- 会话管理：自动 resume、3 小时空闲过期、用户隔离
- 斜杠指令：`/stop` `/history` `/new` `/open N` `/name`
- 安全：ANSI 码清理、密钥脱敏、路径沙箱
- 流式输出到企业微信

## 使用方式

将本仓库中的 skill 安装到你的 AI 编程助手（Kiro CLI、Codex 等）中即可使用。

## 目录结构

```
.agents/skills/
└── wecom-cli-bot/          # 企业微信 CLI 机器人技能
    ├── SKILL.md            # 技能描述与触发条件
    ├── AGENTS.md           # Agent 使用说明
    ├── assets/             # 项目模板源码
    └── references/         # 参考文档
```

## 许可证

私有项目，仅供个人使用。
