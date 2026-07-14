# 更新日志

## 2026-07-14

### 专项测试能力

- 新增 `im-test-hub-qa` Skill，支持识别现有测试能力、复用既有 Case，并辅助生成、修改 SDK 与 REST 自动化测试

### 用户级代码访问

- 新增 `/github bind`、`/github status`、`/github unbind`；用户可绑定个人 fork、目标分支与 GitHub Token，凭证加密保存并按 Bot、企微用户隔离
- `project.inspect`、`project.read`、`project.search` 改为基于当前用户绑定的 fork 读取项目结构、源码与已有测试，不再依赖 WebUI 项目仓库配置
- 新增 `project.ensure`：仅在生成代码或执行测试时，为当前会话准备独立的可写项目副本

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
