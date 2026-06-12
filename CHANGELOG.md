# 更新日志

## 2026-06-12

### wecom-cli-bot

- 新增 Kiro CLI Provider 完整支持（安装、session resume、输出解析）
- 新增斜杠指令系统：`/stop` `/history` `/new` `/open N` `/name`
- 新增用户会话隔离（per-user cwd）
- 新增历史会话管理（列表、恢复、命名）
- 新增首条消息记录，`/history` 显示用户提问摘要
- 新增 ANSI 转义码和框架噪音（All tools trusted 等）自动清理
- 更新 Dockerfile：添加 `/root/.local/bin` 到 PATH，支持 python3、unzip
- 更新 bot.config.yaml 模板：统一使用 `/stop`，thinking_message 包含指令提示
- 更新 redact.ts：ANSI strip + kiro-cli 框架输出过滤
- 更新 cli-adapters.md 和 runtime-installation.md 参考文档
