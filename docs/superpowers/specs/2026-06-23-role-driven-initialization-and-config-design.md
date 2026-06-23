# 角色驱动初始化与可编辑配置设计

## 目标

把当前写死在代码中的公共背景、角色定义、角色规则和角色引导问题，改造成可配置、可在 WebUI 中管理的系统。系统需要满足以下目标：

- 公共背景规则可在 WebUI 中新增、编辑、删除。
- 角色可在 WebUI 中新增、编辑、删除、启用、停用。
- 角色规则文档可在 WebUI 中编辑。
- 角色引导问题可在 WebUI 中编辑。
- Bot 初始化时，角色列表和角色问题集从数据层动态读取，而不是写死在代码中。
- `soul.md` 和 `agents.md` 都可在 WebUI 中编辑。
- `soul.md` 在 Soul 引导完成后立即生成。
- `agents.md` 在角色问题流完成后再生成。
- 凡是进入耗时文档生成阶段，必须先明确告知用户“正在生成，请稍等”。

## 设计原则

- 公共知识、角色默认规则、Bot 个性化配置、业务文档分层管理，不再混在一份 `agents.md` 中。
- 用户初始化时只回答“这个 Bot 的个性化配置”，不回答角色专业最佳实践。
- 角色专业最佳实践作为“隐藏定义文档”存在，可编辑，但不在初始化中逐条询问。
- 所有角色共享统一公共背景和公共交互规则。
- 逐句引导是一种固定交互模式；一旦选择逐句引导，就默认一次只问一个关键问题、给出候选项、允许用户直接自由回答，并在能够判断时给出推荐项。

## 配置分层

系统配置分为四层，运行中知识另算：

1. 全局公共层
2. 角色层
3. Bot 实例配置层
4. 运行中知识层

### 1. 全局公共层

用于存放所有角色、所有 Bot 都共享的背景和规则。

建议文档类型：

- `playground.md`
- 后续扩展的其他全局规则文档

`playground.md` 典型内容：

- 环信基础背景
- Jira / Confluence / Console / IMM / 官方文档站定义
- SDK / REST API / Webhook / 敏感词审核 / 翻译 / 集群等基础认知
- 所有回复使用中文，文档使用 Markdown
- 一次只问一个关键问题
- 如果采用逐句引导，则每次给候选项并允许用户直接自由回答
- 如果能够判断，应先给出推荐项，再让用户确认或修正
- 输出应结构化、可执行
- 正式 Markdown 文档确认后再沉淀
- 记忆写入规则
- 安全规则

### 2. 角色层

用于定义角色本身、角色默认规则和角色初始化问题。

包含三类对象：

- `roles`
- `role_documents`
- `role_questions`

角色层用于表达“某个角色的专业默认行为”，例如产品经理角色的默认 PRD 最佳实践、环信需求默认检查项等。这些内容不在初始化中逐条询问，而是写在角色规则文档中。

### 3. Bot 实例配置层

用于存放某个具体 Bot 的个性化配置文档。

包含：

- `soul.md`
- `agents.md`

职责划分：

- `soul.md`：Bot 是谁、叫什么、怎么说话
- `agents.md`：这个 Bot 在当前角色下的个性化工作方式、交互偏好、是否沉淀文档、管理员补充规则

### 4. 运行中知识层

用于存放运行过程中生成和沉淀的知识。

包含：

- `business_documents`
- `memory_documents`

例如：

- PRD
- 方案文档
- 纪要
- 测试文档
- 其他长期记忆

## 数据模型

### global_documents

用于存放全局公共规则文档。

建议字段：

- `document_id`
- `title`
- `slug`
- `content`
- `enabled`
- `sort_order`
- `created_at`
- `updated_at`

约束：

- `slug` 唯一
- 初始内置一份 `playground.md`

### roles

用于定义角色。

建议字段：

- `role_id`
- `name`
- `slug`
- `description`
- `enabled`
- `sort_order`
- `created_at`
- `updated_at`

初始角色建议：

- 产品经理助手
- QA 测试助手
- 研发助理
- 技术文档助手
- 项目管理助手
- 市场分析助手

### role_documents

用于存放角色规则文档。

建议字段：

- `role_document_id`
- `role_id`
- `title`
- `content`
- `enabled`
- `created_at`
- `updated_at`

初版约束：

- 每个角色至少一份主规则文档
- 初版可只支持一份主文档，例如 `role.md`

例如 `product-manager` 角色对应一份角色规则文档，内容包括：

- 生成 PRD 前默认补齐背景、目标用户、核心问题
- 默认补齐范围、非范围、限制条件、依赖、风险
- 默认检查 Console、IMM、计量计费、集群、开关、灰度、兼容性
- 输出偏好和禁止行为

### role_questions

用于存放角色初始化问题集。

建议字段：

- `question_id`
- `role_id`
- `key`
- `title`
- `description`
- `question_type`
- `options_json`
- `required`
- `enabled`
- `sort_order`
- `depends_on_json`
- `created_at`
- `updated_at`

题型：

- `single_choice`
- `multi_choice`
- `free_text`

条件逻辑：

- 使用 `depends_on_json` 表达条件显示
- 例如某问题仅在前一题选择“逐句引导”时出现

### bot_config_documents

继续沿用现有模型，保存 Bot 实例级文档。

包含：

- `soul.md`
- `agents.md`

### business_documents / memory_documents

继续沿用现有业务文档和长期记忆能力。

## 文档职责边界

### playground.md

职责：

- 全局公共背景
- 全局通用交互规则
- 全局安全规则
- 全局文档和记忆规则

不应放入：

- 某个角色专属最佳实践
- 某个 Bot 专属个性化规则

### role/<role>.md

职责：

- 某个角色的隐藏定义文档
- 某个角色必须遵守的默认专业规则

例如产品经理角色：

- PRD 工作规则
- 环信需求默认检查项
- 产出偏好
- 禁止行为

不应放入：

- 公共背景定义
- Bot 名字和身份称呼
- 某个具体 Bot 的管理员额外规则

### soul.md

职责：

- Bot 的名字或身份称呼
- Bot 的沟通风格

不应放入：

- 角色专业规则
- 环信背景定义
- 文档和记忆策略

### agents.md

职责：

- 当前 Bot 在当前角色下的个性化工作方式
- 当前 Bot 的交互偏好
- 是否长期沉淀规则和文档
- 管理员额外补充规则

不应重复：

- `playground.md` 的整段公共背景
- `role/<role>.md` 的整段默认专业规则
- `soul.md` 的身份和语气描述

## 初始化流程

初始化拆为两个阶段产出，而不是一次同时生成 `soul.md` 和 `agents.md`。

### 阶段 1：管理员认领

- 无管理员时，只允许认领
- 认领成功后自动进入初始化

### 阶段 2：Soul 引导

固定两题：

- `我是谁？`
- `你希望我的沟通风格是什么？`

### 阶段 3：生成 soul.md

Soul 两题完成后：

1. 先回复用户：`Soul 正在生成，请稍等。`
2. 生成 `soul.md`
3. 写入 `bot_config_documents`
4. 回复用户：`Soul 已生成。`

### 阶段 4：角色选择

从 `roles` 中动态读取当前启用的角色。

提问：

- `你希望我默认作为哪类助手工作？`

角色一旦新增并启用，就应自动出现在这里，不需要额外改代码。

### 阶段 5：角色问题流

根据所选角色动态读取 `role_questions`：

- 每次只出当前一题
- 根据 `depends_on_json` 决定是否跳过某题
- 支持单选、多选、自由输入

### 阶段 6：生成 agents.md

角色问题流完成后：

1. 先回复用户：`工作方式正在生成，请稍等。`
2. 基于以下输入生成 `agents.md`：
   - `global_documents`
   - 所选角色的 `role_documents`
   - `soul` 回答
   - 角色问题回答
3. 写入 `bot_config_documents`
4. 回复用户：`初始化完成，可以开始工作。`
5. Bot 状态切换为 `ready`

## 文档生成等待反馈规则

这是一条公共交互规则，不只用于初始化。

规则：

- 当系统进入文档生成阶段，且用户需要明显等待时，必须先告知“正在生成，请稍等”。
- 文档生成完成后，再输出正式结果或下一步提示。

至少适用于：

- `soul.md`
- `agents.md`
- PRD
- 方案文档
- 纪要
- 测试文档
- 技术文档
- 其他正式 Markdown 文档

建议文案：

- `Soul 正在生成，请稍等。`
- `工作方式正在生成，请稍等。`
- `PRD 正在生成，请稍等。`
- `方案文档正在生成，请稍等。`
- `文档正在生成，请稍等。`

## 逐句引导的固定规则

以下规则属于公共交互规则，不属于某个角色私有规则：

- 一次只问一个关键问题
- 如果采用逐句引导，则每次给出候选项
- 用户可以直接自由回答，不强制只能回复编号
- 如果能够判断，应先给推荐项，再让用户确认或修正

这意味着这些规则不需要作为初始化问题让用户选择；它们属于交互模式的内建行为。

## WebUI 结构

建议新增两个一级管理区，并增强 Bot 详情页。

### 1. 全局配置

管理 `global_documents`

能力：

- 列表
- 新增文档
- 编辑 Markdown
- 删除
- 启用 / 停用
- 排序

### 2. 角色管理

管理 `roles`

能力：

- 新增角色
- 编辑角色名称和描述
- 删除角色
- 启用 / 停用
- 排序

角色详情页应包含：

- 角色基础信息
- 角色规则文档编辑区
- 角色问题列表编辑区

### 3. 角色问题编辑器

每个角色的问题管理页应支持：

- 新增问题
- 编辑问题标题
- 编辑问题描述
- 配置题型
- 配置选项
- 配置必答
- 配置条件显示逻辑
- 排序
- 启用 / 停用
- 删除

### 4. Bot 详情页

在现有 Bot 详情页基础上增强：

- Channel 管理
- 管理员信息
- `Soul`
- `Agents`
- 文档列表

新增能力：

- 直接编辑 `soul.md`
- 直接编辑 `agents.md`
- 查看当前绑定角色
- 重新进入角色引导
- 切换角色并重置引导

## API 设计

### global documents

- `GET /v1/global-documents`
- `POST /v1/global-documents`
- `PUT /v1/global-documents/:id`
- `DELETE /v1/global-documents/:id`

### roles

- `GET /v1/roles`
- `POST /v1/roles`
- `PUT /v1/roles/:id`
- `DELETE /v1/roles/:id`

### role documents

- `GET /v1/roles/:id/documents`
- `POST /v1/roles/:id/documents`
- `PUT /v1/roles/:id/documents/:docId`
- `DELETE /v1/roles/:id/documents/:docId`

### role questions

- `GET /v1/roles/:id/questions`
- `POST /v1/roles/:id/questions`
- `PUT /v1/roles/:id/questions/:questionId`
- `DELETE /v1/roles/:id/questions/:questionId`

### bot config documents

沿用现有接口，并可补充更新接口：

- `GET /v1/bots/:id/config-documents`
- `POST /v1/bot-config-documents`
- `PUT /v1/bots/:id/config-documents/:title`

## Prompt 注入顺序

运行时建议按以下顺序注入：

1. `global_documents`
2. `role_documents`
3. `soul.md`
4. `agents.md`
5. `memory_documents`
6. 当前会话上下文

这样职责清晰：

- `global_documents` 负责世界背景和通用规则
- `role_documents` 负责角色默认专业规则
- `soul.md` 负责 Bot 身份和语气
- `agents.md` 负责当前 Bot 个性化工作方式

## 第一阶段实现范围

为了控制范围，第一阶段只做：

- `global_documents`
- `roles`
- `role_documents`
- `role_questions`
- WebUI 管理上述四类配置
- 初始化流程改成动态读取角色与问题
- `soul.md` 与 `agents.md` 分阶段生成
- 文档生成等待提示
- 先迁移 `product-manager` 角色

第一阶段不做：

- 复杂角色继承
- 多角色组合
- 角色规则版本回滚
- 多模板市场化能力

## 风险与约束

### 风险 1：问题系统过早做成复杂流程引擎

控制方式：

- 第一阶段只支持线性问题 + 简单条件显示
- 不支持复杂分支图

### 风险 2：角色规则与公共规则重复

控制方式：

- 强制公共规则上移到 `playground.md`
- 角色规则只保留专业默认行为

### 风险 3：Bot 个性化规则与角色模板混淆

控制方式：

- `role_documents` 表达角色共性
- `agents.md` 表达 Bot 个性化差异

## 结论

当前系统应从“固定问卷 + 写死角色”升级为“公共背景 + 角色模板 + 角色问题 + Bot 个性化配置”的动态配置系统。

最终形成以下稳定结构：

- `playground.md`
- `role/<role>.md`
- `soul.md`
- `agents.md`

并通过 WebUI 支持：

- 公共背景新增、编辑、删除
- 角色新增、编辑、删除
- 角色规则编辑
- 角色引导问题编辑
- Bot 的 `soul.md` 与 `agents.md` 编辑

初始化则变成：

1. 认领管理员
2. Soul 引导
3. 生成 `soul.md`
4. 选择角色
5. 角色问题流
6. 生成 `agents.md`
7. 初始化完成
