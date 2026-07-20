# AgentLattice 运行说明

## 已实现的可运行闭环

1. 管理员在 WebUI 创建用户、Personal Agent、Bot 绑定和 Work/Stage。
2. Stage 进入持久执行队列；同一 Agent 同时只会执行一个任务，执行空间按用户、会话隔离。
3. Dispatcher 调用 Kiro CLI 或 Claude Code。成功输出自动归档为不可变 Artifact，并附 SHA-256 内容快照。
4. Gate 通过后 Handoff 只携带已审核 Artifact 的快照和最小上下文；下游不会读取上游工作区。
5. Dispatcher 将完成或失败通知通过接收方绑定的 WeCom Bot 主动发送给对应用户。
6. WebUI/API 可取消 queued/running Stage；取消后可重新入队。

## 启动

```bash
cp deploy/compose/.env.example deploy/compose/.env.credentials
# 填写 DATA_SERVICE_INTERNAL_TOKEN、Kiro relay 与各 Bot 的凭证
docker compose --env-file deploy/compose/.env.credentials \
  -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.dev.yml up -d
```

打开 `http://localhost:8600/agent-lattice`。企业微信主动消息依赖目标 Personal Agent 已绑定一个已连接的 WeCom Bot。

## 运维约束

- Artifact 文本快照最大 1 MB；内容和 SHA-256 不一致会被拒绝。
- Token、密码只通过已有 `/env` 运行时秘密能力保存；不要放入 Artifact 或 Handoff。
- 本机完整 SQLite 测试要求 `better-sqlite3` 与当前 Node ABI 一致；发生 ABI 不匹配时以 Docker 镜像内的 Node 版本运行验证。
- 取消运行中任务会立即撤销队列租约和记录状态；当前 Runtime 请求会在本轮结束后被忽略。后续可增强为 relay 级硬中断。

## 尚未作为“生产完整工作流”交付的功能

- Agent Gate 的自动执行与结构化判定；目前 Gate 结论由用户记录。
- 企业 SSO、角色权限和个人工作台登录；当前 WebUI 仍是受网络边界保护的管理工作台。
- 组织/能力目录和可版本化 Workflow 模板。
