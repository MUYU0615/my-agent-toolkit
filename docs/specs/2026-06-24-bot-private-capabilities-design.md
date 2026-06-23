# Bot 私有能力隔离设计

## 目标

为每个 Bot 增加独立的能力空间，使其拥有各自私有的：

- 环境变量
- Skills
- MCP
- 运行策略
- 审计记录

该能力模型必须独立于具体 LLM/runtime 存在。无论底层使用 Kiro、Codex、Claude 还是后续其他 runtime，Bot 的能力归属、权限策略、隔离边界和审计规则都保持一致。

系统需要满足以下目标：

- 每个 Bot 的能力面完全独立，不影响其他 Bot。
- 环境变量是 Bot 私有 secret，不允许在对话、文档、记忆、日志中泄漏明文。
- Bot 可以通过对话和 WebUI 管理自己的能力配置。
- 默认只允许管理员安装或删除 Skill、管理 MCP；管理员可在后续对话中放开权限。
- Skill 和 MCP 的日常使用默认对所有用户开放。
- Skill 和 MCP 可从 GitHub 或其他安装地址直接安装，并立即对当前 Bot 生效。
- WebUI 必须为每个 Bot 提供独立的能力管理区域。

## 非目标

- 不支持 Bot 之间复制、导出、模板继承或共享 env / skill / mcp。
- 不将 env / skill / mcp 配置并入 `soul.md`、`agents.md`、角色文档或长期记忆。
- 不让 LLM 自由拼装高权限 shell 命令直接管理能力。
- 第一版不实现复杂审批流、能力市场、跨 Bot 依赖复用、共享安装缓存可视化。

## 设计原则

- 能力归属在 Bot，不归属于具体 LLM。
- 执行与管理分离：对话只负责识别意图和授权，实际安装/删除由平台执行器完成。
- 数据库保存结构化真值，文件系统保存 Bot 私有运行产物。
- Secret 只在执行层临时注入，不进入 prompt。
- 默认安全优先：安装和配置管理默认仅管理员可执行。
- 删除立即生效，失败必须可审计且尽量回滚。

## 总体架构

推荐架构如下：

```text
企业微信 / WebUI
  -> bot-host / control-api
  -> data-service
  -> capability-runner
  -> llm-runner
  -> bot private workspace
```

职责分工：

- `bot-host`
  - 识别对话中的能力管理意图
  - 做权限判断
  - 调用能力执行器
  - 返回摘要结果
- `control-api`
  - 提供 WebUI 能力管理页
  - 展示 env / skills / mcp 状态
  - 提交管理动作
- `data-service`
  - 保存结构化配置和审计真值
- `capability-runner`
  - 执行 skill / mcp 安装、删除、配置落地
  - 管理 Bot 私有 workspace
  - 负责失败清理和状态回写
- `llm-runner`
  - 在实际执行工具、skill、mcp 时读取 Bot 能力上下文
  - 临时注入 env
  - 不负责平台配置管理

`capability-runner` 是新增服务。它不属于 `llm-runner`，因为能力安装与管理是平台运维动作，不是模型推理动作。

## 配置分层

Bot 私有能力配置不属于现有角色、文档、记忆体系，应单独建模。

层次如下：

1. Bot 运行策略
2. Bot 私有 secret
3. Bot 已安装 skill 清单
4. Bot 已安装 MCP 清单
5. Bot 能力审计日志
6. Bot 私有运行目录

## 数据模型

### bot_runtime_policies

保存 Bot 的能力管理策略。

建议字段：

- `bot_id`
- `skill_install_policy`
  - `admin_only | open`
- `mcp_manage_policy`
  - `admin_only | open`
- `created_at`
- `updated_at`

默认值：

- `skill_install_policy = admin_only`
- `mcp_manage_policy = admin_only`

说明：

- 管理员可在后续对话中随时修改。
- 修改后持续生效，直到再次变更。
- `agents.md` 可描述当前策略，但结构化配置才是执行真值。

### bot_env_vars

保存 Bot 私有环境变量。

建议字段：

- `bot_id`
- `key`
- `secret_ref` 或 `value_ciphertext`
- `is_set`
- `updated_at`
- `updated_by_wecom_user_id`

约束：

- 不记录明文到日志。
- 不进入 prompt。
- 不进入 memory。
- 不进入 Markdown 文档。

展示规则：

- 只返回 `key`、`is_set`、`updated_at`
- 不返回真实值

### bot_skills

保存 Bot 已安装 Skill 清单。

建议字段：

- `bot_id`
- `skill_id`
- `name`
- `source_type`
  - `builtin | github | url | local`
- `source_ref`
- `status`
  - `installing | installed | failed`
- `installed_at`
- `installed_by_wecom_user_id`
- `last_error`

说明：

- 这是平台结构化状态，不是 skill 文件内容本身。
- `failed` 状态仅用于展示和审计，不应让用户看到半安装的可用能力。

### bot_mcps

保存 Bot 已挂载 MCP 清单。

建议字段：

- `bot_id`
- `mcp_id`
- `name`
- `mode`
  - `config | package`
- `source_ref`
- `status`
  - `installing | installed | failed`
- `installed_at`
- `installed_by_wecom_user_id`
- `last_error`

说明：

- `config` 模式表示直接登记 server 命令、URL 或参数配置。
- `package` 模式表示先安装，再生成本地 MCP 配置。

### bot_capability_audit_logs

记录 Bot 能力变更审计。

建议字段：

- `log_id`
- `bot_id`
- `wecom_user_id`
- `display_name` 可选
- `action_type`
  - `env_set`
  - `env_delete`
  - `skill_install`
  - `skill_delete`
  - `mcp_install`
  - `mcp_delete`
  - `policy_update`
- `target_name`
- `source_ref`
- `result`
  - `success | failed`
- `error_message`
- `created_at`

约束：

- 必须记录 `wecom_user_id`
- 不记录 secret 明文
- 错误信息需要脱敏

## Bot 私有目录布局

每个 Bot 拥有独立的运行目录：

```text
runtime/bots/<bot_id>/
  env/
  skills/
  mcp/
  cache/
  logs/
  tmp/
```

目录职责：

- `env/`
  - 运行时注入辅助文件
- `skills/`
  - 当前 Bot 安装的 skill 本体或适配内容
- `mcp/`
  - 当前 Bot 的 MCP 配置、本地包或启动脚本
- `cache/`
  - 下载缓存、依赖缓存
- `logs/`
  - Bot 私有运行日志片段
- `tmp/`
  - 安装过程的临时目录，失败后清理

原则：

- Bot 之间目录绝对隔离
- 新依赖优先安装到 Bot 私有目录
- 宿主机已有全局工具可复用，但不作为 Bot 私有状态
- 删除 Bot 时可以整目录清理

## 权限模型

### 环境变量

- 查看：仅管理员
- 新增 / 更新 / 删除：仅管理员

管理员查看时仅能看到：

- `key`
- `is_set`
- `updated_at`

### Skill

- 查看：
  - 普通用户：简版
  - 管理员：完整版
- 安装 / 删除：
  - 默认 `admin_only`
  - 管理员可切到 `open`

普通用户简版只展示：

- 名称
- 基本状态

管理员完整版可展示：

- 名称
- 类型
- 当前状态
- 来源地址
- 安装时间

### MCP

- 查看：
  - 普通用户：简版
  - 管理员：完整版
- 安装 / 删除 / 配置变更：
  - 默认 `admin_only`
  - 管理员可切到 `open`

### 已安装能力的使用

- 已安装的 skill / mcp 默认所有用户都可触发使用
- 仅安装、删除、配置管理动作受策略限制

## 对话交互模型

能力管理既支持命令式，也支持自然语言。

### 命令式

示例：

- `/env`
- `/env set OPENAI_API_KEY`
- `/env delete OPENAI_API_KEY`
- `/skill`
- `/skill install <github-or-url>`
- `/skill delete <name>`
- `/mcp`
- `/mcp add <config-or-url>`
- `/mcp delete <name>`
- `/policy skill open`
- `/policy skill admin_only`
- `/policy mcp open`
- `/policy mcp admin_only`
- `/capability`

### 自然语言

示例：

- `给这个 bot 设置环境变量 OPENAI_API_KEY`
- `删除这个 bot 的 SENTRY_DSN`
- `安装这个 skill：https://github.com/...`
- `给这个 bot 加一个 mcp`
- `开放 skill 安装权限`
- `只允许管理员安装 mcp`

自然语言最终必须归一化成结构化动作，再进入执行器。权限判断和安装逻辑不能交给 prompt 自由发挥。

### 能力总览

建议增加统一入口：

- `/capability`

管理员可查看：

- env 已设置数量
- skills 安装数量和失败数量
- mcp 安装数量和失败数量
- skill policy
- mcp policy

## WebUI 结构

在 Bot 详情页增加独立的 `能力管理` 区域，分为三块：

### 环境变量

展示字段：

- `key`
- `是否已设置`
- `最近更新时间`

动作：

- 新增
- 更新
- 删除

要求：

- 不显示真实值
- 不支持复制真实值

### Skills

展示字段：

- `name`
- `status`
- `source_ref`
- `installed_at`

动作：

- 安装
- 删除
- 刷新状态

### MCP

展示字段：

- `name`
- `mode`
- `status`
- `source_ref`
- `installed_at`

动作：

- 安装
- 删除
- 编辑配置型 MCP
- 刷新状态

这三个区域与 `soul`、`agents`、角色文档、普通业务文档完全分离。

## 执行链路

### 通用链路

1. 用户发消息或在 WebUI 提交动作
2. `bot-host` 或 `control-api` 识别结构化能力动作
3. 做权限判断
4. 写入审计开始记录
5. 调用 `capability-runner`
6. 在当前 Bot 私有目录中执行安装 / 删除 / 配置变更
7. 成功后写回 `data-service`
8. 失败则清理并写入失败状态
9. 返回摘要结果

关键要求：

- 不能让 LLM 直接执行不受控 shell
- 结构化动作与执行器必须解耦

### Skill 安装

支持来源：

- 平台已有 skill
- GitHub 地址
- 其他安装地址
- 本地目录

流程：

1. 解析来源
2. 在 `tmp/` 拉取资源
3. 识别 skill 结构
4. 安装到 `skills/<skill_name>/`
5. 安装依赖
6. 做最小健康检查
7. 标记 `installed`
8. 清理临时目录

删除流程：

- 删除 `skills/<skill_name>/`
- 删除数据库记录
- 写审计
- 立即失效

### MCP 安装

支持两种模式：

- `config`
- `package`

`config` 模式流程：

- 规范化 server 命令、URL 或参数
- 写入 `mcp/<mcp_name>/`
- 更新结构化状态

`package` 模式流程：

- 下载 / 拉取
- 安装到 Bot 私有目录
- 生成运行配置
- 更新结构化状态

删除立即生效。

### 环境变量

设置流程：

1. 识别目标 key
2. 进入安全输入流程
3. 安全写入 `bot_env_vars`
4. 回复设置成功摘要

读取流程：

- 仅返回元信息，不返回值

删除流程：

- 删除 key
- 后续请求立即不再注入

## 运行时注入模型

`llm-runner` 接收 `bot_id` 后：

1. 查询当前 Bot 的 policy、env、skills、mcps
2. 定位 Bot 私有目录
3. 在执行 skill / mcp / 工具子进程时临时注入 env
4. 执行结束后销毁进程上下文

安全要求：

- env 不进入 prompt
- env 不进入对话上下文
- Bot 不能通过普通对话读取 secret

## 安全边界

### Secret 保护

以下位置禁止出现 env 明文：

- `soul.md`
- `agents.md`
- `playground.md`
- 角色文档
- memory
- 正式业务文档
- 普通对话 prompt
- 审计日志
- 错误日志

### 访问控制

- 普通用户默认不能管理 env
- 普通用户默认不能安装 / 删除 skill 和 mcp
- 管理员可显式放开 skill / mcp 管理权限
- 放开后持续生效，直到管理员关闭

### 隔离

- Bot A 的 env / skill / mcp 不能被 Bot B 读取
- 安装目录不能共用
- 删除必须只影响当前 Bot

## 失败与回滚

统一状态流：

- `installing`
- `installed`
- `failed`

规则：

- 成功前不标记为 `installed`
- 失败写入 `failed`
- 能回滚的立即回滚
- 不保留用户可见的半安装能力
- 错误信息写入审计和结构化状态，但需要脱敏

## 回复规则

管理动作完成后，Bot 只返回摘要级结果。

例如：

- `已为当前 bot 新增环境变量 OPENAI_API_KEY。`
- `已删除环境变量 SENTRY_DSN。`
- `已安装 skill：repo-analyzer。`
- `安装 skill 失败：缺少可执行安装脚本。`
- `已将 skill 安装权限切换为仅管理员。`

不返回：

- secret 明文
- 长日志
- 原始安装脚本输出

长日志和详细错误应留在：

- 审计记录
- WebUI 状态页
- Bot 私有日志

## 推荐实现路径

推荐采用“数据库真值 + Bot 私有目录 + 独立能力执行器”的实现路径。

原因：

- 能同时满足 Bot 级独立隔离、运行时安全和跨 runtime 通用性。
- 比纯文件方案更适合 WebUI、审计和权限管理。
- 比共享执行目录方案更容易保证“只影响当前 Bot”。

## 与现有系统的关系

- `soul.md`、`agents.md` 继续保留，职责不变。
- 角色、角色规则、角色问题继续由现有配置体系管理。
- Bot 私有能力模型是新增的并行配置面，不替代角色初始化体系。
- 第一版不要求改动角色文档结构，只需要在 Bot 详情页新增能力管理面，并在对话侧补能力管理动作识别。
