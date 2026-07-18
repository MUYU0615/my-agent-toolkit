# 更新日志

## 2026-07-18

### AgentLattice Foundation MVP

- 新增 AgentLattice Foundation Spec 与分阶段实施计划，平台流程不绑定 Jira 或固定部门
- Data Service 新增 User、Personal Agent、一对一用户绑定、Agent-Bot 绑定、Work、Stage 和 Work Event 模型及 SQLite 迁移
- 新增 Work/Stage 状态机、分配关系校验和结构化事件记录，为后续独立 CLI Session、Workspace、Handoff 与 Gate 奠定基础
- Control API 新增 AgentLattice 受控 API 与写操作审计
- WebUI 新增 `/agent-lattice` 工作台和独立 Work 页面，支持导入用户、创建 Personal Agent、复用现有 Bot 消息入口、创建 Work、拆分 Stage 和推进状态
- 保持现有 Bot、Channel、Skill/MCP、Env 和普通聊天入口兼容；MVP 当前采用管理员导入用户模式
- 每个 Work Stage 现在由服务端生成独立 Conversation 与 Workspace 引用，禁止客户端指定或跨 Stage 复用运行目录
- 新增 Artifact 与不可变 Artifact Version，记录类型、可见范围、Stage 内内容引用、SHA-256、摘要和创建者
- Artifact 路径拒绝绝对路径、空路径及 `.`/`..` 目录穿越，并在 Work 页面展示版本历史
- 新增 Work Runtime Session 归属记录，绑定确定的 Work、Stage、Conversation、Agent、Runtime 与 Workspace
- Runtime Session 内部接口使用独立 `DATA_SERVICE_INTERNAL_TOKEN`，开发环境凭据初始化脚本自动生成并补齐该令牌
- 新增持久化 Execution Queue 与 Execution Run；Stage 只有显式入队后才进入 `queued`，避免队列与页面状态不一致
- 新增 `work-dispatcher` 服务，复用现有 LLM Runner 启动 Claude Code/Kiro，并将真实输出或失败原因回写 Work
- 每个 Personal Agent 同时只租用一个执行槽；多个 Work 按入队顺序串行执行，过期租约可自动恢复
- AgentLattice Work 页面新增自动入队、队列状态和执行结果；新 Stage 默认创建后自动开始，也可取消自动执行
- 新增 Gate Definition 与不可变 Gate Result，门禁结论绑定确定的 Artifact Version，旧版本批准不会授权新版本转交
- `revision_required` 强制记录证据、阻断规则、责任人和最小修改要求，模糊退回无法写入
- 新增最小 Handoff Package，仅携带工作目标、已批准产物元数据、验收、约束、风险和证据引用，不复制上游聊天或 CLI 原始输出
- Gate 通过后可由来源负责人或 Work 创建者选择下一用户及其 Personal Agent；系统创建独立 Stage 并直接自动入队，无需接收方 Accept
- Work 页面新增 Quality Gates、待转交和 Handoff 历史视图

## 2026-07-17

### Jira 自动化项目发布

- 新增 `jira.project.publish`，按 Bot、用户、会话和 Jira Key 定位独立项目，并直接提交到用户绑定的 GitHub fork
- Jira 项目发布现在包含 `reports/` 报告目录；继续排除 `.env`、运行时目录、凭证、Cookie、私钥及原始日志等敏感文件
- 增加项目发布结果校验，只有拿到实际分支、完整 commit、变更路径和 GitHub 地址才报告成功

### Jira 测试报告

- 优化 Jira 与自动化 Skill，支持在用户明确授权后上传脱敏测试报告 ZIP 并发布 Jira 评论
- Jira 评论包含执行时间、环境、测试范围、通过/失败/跳过统计、失败原因、风险建议和附件链接
- 报告发布与 GitHub 提交解耦，测试完成后不会自动评论或推送

### Bot 技能与稳定性

- 同步更新 Test-Jira Bot 的 Jira 和自动化 Skill，强化测试准入、当前会话项目隔离和敏感信息保护
- WebUI 支持从本地目录安装 Bot Skill：校验 `SKILL.md`、Skill 名称、文件数量、大小和相对路径后，原子安装到当前 Bot 的隔离目录
- 修复本地 Skill 安装状态与数据服务来源枚举不兼容导致的 400；本地上传在内部以受控上传流程处理，在状态记录中标记为 `local`
- 优化 CLI 长任务流式响应：Host relay 立即发送响应头，并每 25 秒发送内部 heartbeat，避免 Claude Code 无可见输出时触发 5 分钟首响应超时
- relay-cli 使用 Undici 并将响应头与流 body 超时设为 16 分钟；CLI 总执行上限保持 15 分钟
- 流客户端断开时自动终止对应 CLI 子进程并回滚本次项目改动，避免机器人已报错但后台继续执行
- 标准化本地启动流程：`dev:up` 与 `dev:relay` 自动注入 relay 认证凭证，避免单独重建服务后出现未授权请求

## 2026-07-16

### 项目发布

- 新增 `project.publish` 明确用户授权校验，只有用户明确要求提交或推送时才允许发布代码
- 新增提交意图门控与 Git 命令保护，CLI 不再直接提交或推送，统一由 MCP 完成分支提交与 Push
- GitHub 凭据仅在受控发布服务中临时使用，不再传入 Kiro CLI 或 Claude Code 运行环境

## 2026-07-15

### 新增功能

- 新增 Bot 测试环境配置，支持直接查看和编辑 `.env` 与 Python 解释器
- 新增基于用户 GitHub fork 的项目查看、修改、测试执行和分支提交能力
- 新增企业微信测试结果报告
- 新增任务超时与 `/stop` 自动回滚，丢弃本次代码改动
- 新增 Claude Code 运行时，可在 WebUI 为 Bot 选择并复用现有测试、MCP 与项目能力


## 2026-07-14

### 专项测试能力

- 新增 `im-test-hub-qa` Skill，支持识别现有测试能力、复用既有 Case，并辅助生成、修改 SDK 与 REST 自动化测试

### 用户级代码访问

- 新增 `/github bind`、`/github status`、`/github unbind`；用户可绑定个人 fork、目标分支与 GitHub Token，凭证加密保存并按 Bot、企微用户隔离


### MCP 工具编排

- MCP Runner 支持受控的多轮工具调用与结果回灌，同一 Kiro 会话可完成“检索项目 → 读取源码 → 分析总结”等连续任务
- 补充工具调用协议、参数字段说明与调用上限；过滤内部工具标记和调用轨迹，企微仅展示最终回复
- 新增 `mcp_tool_executions` 审计记录，保存工具名、调用用户与会话、状态、耗时和错误码，不保存工具参数、结果或凭证

### Kiro 会话恢复

- 修复 Kiro 自动压缩后仍恢复旧 Session ID 的问题；优先持久化 Kiro 实际返回的 successor session
- 旧 Session 恢复为空输出时，自动识别同工作目录下的 successor session 并重试一次，不清空企微会话或聊天记录

### 任务中断

- 修复 `/stop` 被误送入 Kiro 的路由问题；按当前 Bot、企微用户和会话即时取消正在执行的 Kiro 任务
- Kiro Host Relay 持有活动子进程并发送终止信号；已停止的流式任务静默收尾，不再追加运行器异常提示

### 审计与时间展示

- 日志列表默认按最新优先返回，支持 `order=asc` 读取正序聊天回放
- WebUI 时间统一按北京时间展示；数据库继续以 UTC ISO 时间存储，保证筛选与部署一致性



## 2026-07-13

### Jira 测试能力

- 新增 `/jira bind`、`/jira status`、`/jira unbind`，Jira 凭证加密保存并按 Bot、企微用户隔离
- Jira 登录会话按用户隔离和复用，重新绑定时不复用旧账号状态
- 新增 `easemob-jira-testcase` Skill，支持分析 Jira 并直接返回可人工审核的 Markdown 测试用例草稿
- 清理 Kiro 命令、Tool、Traceback 和批量文件读取轨迹，企微仅展示助手正文

### Bot 能力管理

- WebUI 新增 Bot 的 Env、Skill 和 MCP 管理入口
- 支持从内置目录安装、删除 Skill，并在 `/skill` 中查看当前 Bot 已安装技能
- Skill、运行环境和工作目录按 Bot 隔离，首个内置 Skill 为 `easemob-jira-testcase`

### Kiro 会话与开发体验

- 持久化 Kiro 真实 Session ID，并使用 `--resume-id` 按 Bot、用户和会话精确恢复
- 修复 `/new`、`/history`、`/open N` 的会话编号和切换逻辑
- 完善本地 Docker 热更新、Relay 凭证配置和 Jira 长任务超时设置

## 2026-06-15

### memory-service（新增）

- 新增 Memory Service 独立服务
- FastAPI + ChromaDB + SQLite 存储层
- fastembed（bge-small-zh-v1.5）本地 embedding，无需 GPU
- 文本存入、语义检索、删除、统计 API
- 文件上传解析（Markdown/TXT/PDF/Word/HTML）
- URL 抓取存入
- 目录扫描增量索引
- 知识分层：core（永久）/ reference（90天归档）/ temp（7天清理）
- 命名空间隔离 + shared 共享检索
- 生命周期定时任务（每日自动清理/归档）
- Docker 部署，镜像约 1GB

### bot-memory（新增技能）

- 新增 Bot 记忆技能（轻量 markdown）
- SKILL.md 描述触发条件和配置方式
- references/api-spec.md 完整 API 文档
- references/commands.md 用户指令说明

### wecom-cli-bot

- 新增完整指令体系：`/help` `/stop` `/history` `/new` `/open N` `/name`
- 新增记忆指令：`/remember` `/fetch` `/scan` `/memory` `/forget`
- 新增技能管理指令：`/skill_list` `/skill_add` `/skill_remove`
- 新增 memoryClient.ts（Memory Service HTTP 客户端）
- promptBuilder.ts 改为异步，支持记忆检索自动注入 prompt
- types.ts 新增 MemoryConfig 类型
- thinking_message 精简为 `/stop 终止 /help 帮助`

## 2026-06-12

### wecom-cli-bot

- 新增 Kiro CLI Provider 完整支持（安装、session resume、输出解析）
- 新增用户会话隔离（per-user cwd）
- 新增历史会话管理（列表、恢复、命名、首条消息记录）
- 新增 ANSI 转义码和框架噪音自动清理
- 更新 Dockerfile：添加 `/root/.local/bin` 到 PATH，支持 python3、unzip
- 更新 redact.ts：ANSI strip + kiro-cli 框架输出过滤
- 更新 cli-adapters.md 和 runtime-installation.md 参考文档
