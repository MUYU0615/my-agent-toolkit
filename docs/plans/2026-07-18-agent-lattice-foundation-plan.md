# AgentLattice Foundation MVP 实施计划

## 目标

在不破坏现有 Bot、Channel、Skill/MCP、Env 与普通聊天流程的前提下，把平台从“一个聊天窗口对应一段持续上下文”扩展为“用户拥有 Personal Agent，工作按 Work/Stage 隔离”的通用工作平台。

## 实施顺序

### Slice 1：Identity 与 Work 骨架

- 在 `data-service` 增加 User、Personal Agent、一对一绑定、Work、Stage 和 Work Event。
- 保留现有 Bot/Channel，把它作为 Personal Agent 的消息入口，而不是 Agent 本体。
- 在 `control-api` 增加 `/agent-lattice` 管理工作台和独立 Work 页面。
- 提供受控 API 代理和写操作审计。
- MVP 先由管理员导入用户，不新增平台密码。

验收：可以完成“导入用户 → 创建 Agent → 绑定现有 Bot → 创建 Work → 拆分 Stage → 推进 Stage 状态”。

### Slice 2：Artifact 与隔离上下文

- 增加 Artifact、Artifact Version、Work Conversation 和 Runtime Session。
- Stage 创建时由服务端生成独立 conversation/workspace 标识。
- 增加目录归属校验，禁止父目录、兄弟 Work 和其他用户目录访问。
- WebUI 支持查看 Stage 产物版本与可见范围。

验收：同一用户的两个 Work 不复用 CLI Session 或 Workspace。

### Slice 3：自动执行队列

- [x] 增加持久化 Execution Queue 与 Execution Run。
- [x] 每个 Personal Agent 提供一个执行槽；排队任务按入队时间串行。
- [x] 新增独立 Dispatcher，Stage 入队后复用现有 LLM Runner 启动对应 Runtime。
- [x] 将 Runtime 输出或失败原因写回 Execution、Stage 与 Work，并在 WebUI 展示。
- [x] 租约过期后恢复为可重试队列项；总执行时限沿用现有 15 分钟 Runtime 上限。

验收：同一 Agent 收到多个任务时各自排队，用户在 Work 页面可以明确看到正在执行哪一个 Stage。

### Slice 4：Handoff 与 Gate

- [x] 增加最小 Handoff Package、Gate Definition 和绑定 Artifact Version 的 Gate Result。
- [x] 用户显式指定下一负责人，接收方无需 Accept。
- [x] Gate 通过后创建并排队独立下一 Stage；退回时强制证据、阻断规则、责任人和最小修改清单。
- [x] Handoff Prompt 只注入授权的结构化最小上下文，不复制上游聊天或 CLI 原始输出。
- [ ] Reviewer Agent 只读执行与结构化 Gate Result 自动回写；当前 WebUI 仅开放人工/规则门禁。

验收：两名用户可完成一次跨阶段自动转交，且下游不获得上游完整聊天记录。

### Slice 5：通知与可配置流程

- 增加 Notification Outbox、幂等投递和失败重试。
- 复用现有企业微信 Channel，由接收方绑定的 Bot 发送带 Work 深链接的关键通知。
- 增加版本化 Workflow Definition、组织节点和 Capability 路由建议。

验收：产品、研发、测试、市场和运营可以配置不同流程，不在代码中固化部门或 Jira 类型。

## 当前状态

- Slice 1 的数据模型、SQLite 迁移、Data Service API、Control API 代理和 WebUI 基础操作已实现。
- Slice 2 已实现 Artifact/Artifact Version、Work Conversation 和 Runtime Session 归属模型。
- 每个新 Stage 由服务端生成独立 conversation 与 `workspaces/<work>/<stage>/files`；客户端不能指定或复用该边界。
- Artifact 内容引用只能使用 Stage 内相对路径，并记录版本、SHA-256、摘要、创建者与可见范围。
- Runtime Session 与 Execution Queue 内部 API 使用独立服务令牌保护。
- Slice 3 已实现持久化队列、Personal Agent 单执行槽、Dispatcher 调用现有 LLM Runner 和执行结果回写。
- Work 页面可查看 queued/leased/completed/failed 队列状态及每次 Execution 结果。
- Slice 4 已完成 Gate、旧批准失效、最小 Handoff Package、跨用户转交和下一 Stage 自动入队的人工闭环。
- Reviewer Agent 的只读 Runtime 仍待实现，不能复用普通可写 Stage Runtime 冒充只读评审。
- Slice 1 暂未包含用户登录鉴权；当前页面是管理员工作台。
- 下一步实现 Reviewer Agent 只读执行，再进入 Slice 5 Notification Outbox。

## 验证策略

- 每个 Slice 增加 in-memory、SQLite、HTTP 和 Control API 定向测试。
- SQLite 原生模块统一在 Docker Node 22 环境验证。
- 每次完成 Slice 后运行 TypeScript 全量 typecheck。
- 完整回归需区分本分支新增失败与仓库已有的陈旧测试断言。
