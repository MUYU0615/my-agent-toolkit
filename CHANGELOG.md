# 更新日志

## 2026-07-13

### llm-runner / Kiro 会话隔离

- 保留平台 `runner_session_id` 作为 bot、企微用户和 conversation 的业务会话键
- 从 Kiro CLI 获取真实 UUID，并持久化到 `runtime_sessions.provider_session_id`
- 兼容 Kiro CLI 2.12.1 非交互模式不输出 session 提示的行为：新会话在全局创建锁内通过 `--list-sessions --format json` 前后差分识别 UUID
- 后续请求统一使用 `kiro-cli chat --resume-id <SESSION_ID>` 精确恢复会话
- runner 和宿主机 relay 双层拒绝裸 `--resume`，避免同工作目录下恢复到其他用户的最近会话
- 普通与流式 relay 协议新增内部 session 元数据传递，不向企微回复暴露运行时标记
- 新增相同 `runner_session_id` 的执行锁，防止并发首轮请求创建多个 Kiro 会话
- 已有但缺少 `provider_session_id` 的记录按新会话处理，并在首次成功调用后补齐映射，无需 SQLite 迁移

### Bot 会话稳定编号

- `conversations` 新增 scope 内稳定递增的 `sequence_no`，现有数据按创建时间自动回填
- `/new` 返回实际新会话编号，不再固定显示“会话 1”
- `/history` 按稳定编号倒序展示，当前状态切换后编号不再变化
- `/open N` 按 `sequence_no=N` 精确选择会话，不再依赖动态列表下标
- 切换或创建会话时不再批量覆盖其他会话的 `updated_at`

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
