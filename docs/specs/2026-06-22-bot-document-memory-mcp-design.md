# Bot 文档与记忆 MCP 设计

## 目标

新增一个独立的 `mcp-service`，把 Bot 的文档、记忆、搜索和共享知识能力封装成 MCP 工具，供 `kiro-cli` 以及后续其他 CLI runtime 使用。

这个 MCP 的核心目标不是给 LLM 更多无边界权限，而是给 LLM 一组可审计、可限权、可复用的工作工具。

本项目还未进入正式实现阶段，因此新设计不需要兼容旧 HTTP API 或旧数据结构。现有 `services/memory-service` 和 `docs/specs/2026-06-15-memory-system-design.md` 中已经验证过的长期记忆能力必须完整纳入新设计，包括：

- 向量检索。
- 文本、文件、URL、目录扫描导入。
- Markdown、PDF、Word、Excel、HTML 等文档解析。
- 分块和 chunk metadata。
- namespace / scope 隔离。
- tags。
- tier 生命周期管理。
- 原始文件和 assets 存储。
- 统计和清理能力。

## 非目标

- 不通过 MCP 管理 Bot 控制面配置。
- 不允许普通 Bot 通过 MCP 修改 `soul.md`、`agents.md`、管理员、Channel、企业微信 Secret 或 runtime session。
- 第一版不实现复杂 Web 管理后台、人工审批流、MCP marketplace、跨 Bot 协同 UI。
- 不保留旧 Memory Service API 的兼容层；新项目直接采用 MCP + 内部 service API。

## 边界

### 平台配置面

以下内容继续由 `control-api`、WebUI、初始化流程和 `data-service` 管理：

- Bot 创建、删除、状态。
- 企业微信 Bot ID / Secret。
- 管理员认领、转移、重置。
- 初始化流程状态。
- `soul.md`。
- `agents.md`。
- runtime session。
- Channel 状态。

`soul.md` 和 `agents.md` 是 Bot 配置，不是 Bot 生成的普通文档：

- `soul.md`：机器人是谁，包括身份、性格、沟通风格、价值观和人格边界。
- `agents.md`：机器人如何工作，包括能力范围、行为规则、任务流程、工具与文档规范。

### Bot 工作能力面

以下能力通过 MCP 暴露给 Bot：

- 创建业务文档。
- 更新业务文档。
- 查询业务文档。
- 搜索业务文档。
- 写入长期记忆。
- 检索长期记忆。
- 读取当前上下文。
- 记录工具调用审计事件。

## 推荐架构

```text
企业微信
  -> bot-host
  -> llm-runner
  -> kiro-cli / other CLI
  -> MCP tools
  -> mcp-service
  -> data-service / vector backend / object storage / log-service
```

`mcp-service` 不替代 `data-service`。它是 LLM 工具层，负责权限、参数校验、脱敏、审计和 MCP 协议适配；`data-service` 继续作为事实来源。

`services/memory-service` 中的能力会被并入新平台的存储/检索后端，而不是作为旧服务继续暴露给 Bot。新的结构是：

```text
mcp-service
  - MCP 协议与工具权限
  - 工具参数校验
  - tool event 审计

data-service
  - 文档元数据
  - 文档版本
  - 记忆元数据
  - scope/owner/visibility/tier/tags

vector backend
  - 文档 chunk embedding
  - memory chunk embedding
  - similarity search

object storage
  - 原始上传文件
  - URL 抓取原文快照
  - 解析出的图片和附件
```

第一阶段可以继续用本地 SQLite + ChromaDB + 文件系统落地；接口边界按新平台设计，不做旧 API 兼容。

## 服务职责

### mcp-service

负责：

- 暴露 MCP tools。
- 校验 tool input。
- 校验上下文权限。
- 调用 `data-service` 完成文档和记忆读写。
- 调用搜索后端完成检索。
- 调用 `log-service` 记录 tool events。
- 对错误做结构化归一。

不负责：

- 保存企业微信 Secret。
- 管理 Bot 初始化。
- 修改 `soul.md` 或 `agents.md`。
- 启停 Bot workload。
- 直接执行任意 shell 命令。

### llm-runner

负责：

- 启动 CLI runtime。
- 给 CLI 注入 MCP 配置。
- 传递可信上下文，如 `bot_id`、`user_id`、`conversation_id`。
- 维护 runtime session。

`llm-runner` 不应让模型自己声明身份上下文。

### data-service

负责：

- 保存业务文档。
- 保存文档版本。
- 保存记忆记录。
- 保存 scope、owner、visibility、metadata。
- 保存 tags、tier、source、asset 引用、chunk 元数据。
- 提供生命周期清理所需的访问时间、命中次数、归档状态。
- 提供受控 API 给 `mcp-service`。

### vector backend

负责：

- 对文档和记忆 chunk 生成 embedding。
- 保存 chunk 向量。
- 支持按 scope、owner、tags、tier、doc_type 粗筛后再做相似度检索。
- 返回 chunk、score、source metadata、asset refs。

默认实现建议延续现有能力：

- Embedding：优先使用现有本地 embedding 能力，支持中英双语。
- 向量库：第一版使用 ChromaDB。
- 后续可替换为 Qdrant、pgvector 或其他后端，但 MCP 工具接口不变。

### object storage

负责：

- 保存上传的原始文件。
- 保存 URL 抓取快照。
- 保存解析出的图片、附件、表格原始片段。
- 为 chunk 提供 asset refs。

第一版可以使用本地文件系统卷；后续迁移到 S3/MinIO/PVC。

### log-service

负责：

- 保存 MCP tool call 事件。
- 保存耗时、状态、错误类型、目标资源 ID。
- 避免保存 Secret、认证码、完整敏感内容。

## Scope 模型

所有文档和记忆都必须有 scope：

```text
system
shared
bot
user
session
```

含义：

- `system`：平台级知识，默认只读。
- `shared`：多 Bot 共享知识，可用于协作。
- `bot`：当前 Bot 私有工作知识。
- `user`：某个企微用户的偏好、身份和长期上下文。
- `session`：当前会话临时上下文和阶段总结。

旧 Memory Service 的 `namespace` 概念在新设计中不继续暴露给 Bot。它被规范化为：

```text
namespace = scope + owner_id
```

例如：

- 旧 `shared` namespace -> `scope=shared, owner_id=platform`
- 旧 `product` namespace -> 某个产品 Bot 的 `scope=bot, owner_id={bot_id}` 或团队共享的 `scope=shared, owner_id={team_id}`
- 用户偏好 -> `scope=user, owner_id={wecom_user_id}`

第一版写权限：

| scope | 读权限 | 写权限 |
| --- | --- | --- |
| system | 所有授权 Bot | 仅平台管理员 |
| shared | 授权 Bot | 管理员或授权 Bot |
| bot | 当前 Bot | 当前 Bot |
| user | 当前用户相关 Bot | 用户确认后写 |
| session | 当前会话 | 当前会话 |

## 可信上下文

MCP 请求必须绑定可信上下文：

```json
{
  "bot_id": "testbot-okurjh",
  "user_id": "woYddk...",
  "conversation_id": "conv_xxx",
  "runtime": "kiro"
}
```

这些字段不能来自模型自然语言输出，也不能让 LLM 通过 tool input 自己伪造。

第一版建议由 `llm-runner` 为每次 CLI 运行生成带上下文的 MCP endpoint：

```text
http://mcp-service:8700/mcp/bots/{bot_id}/sessions/{conversation_id}
```

同时注入内部 header：

```text
x-runner-token: signed-token
```

`mcp-service` 通过 token 校验请求来自可信 `llm-runner`。

## MCP 工具

MCP 工具分为四组：

```text
document.*
memory.*
search.*
context.*
```

`document.*` 负责有标题、有版本、有完整内容的业务文档。

`memory.*` 负责较短、可检索、可生命周期管理的长期知识片段。

`search.*` 提供跨文档和记忆的统一检索。

`context.*` 提供当前会话可用上下文摘要。

### document.create

创建业务文档，例如 PRD、竞品分析、评审纪要、接口设计。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh",
  "title": "语音转文字 API PRD",
  "doc_type": "prd",
  "content": "...",
  "tags": ["prd", "asr", "api"],
  "visibility": "bot"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "title": "语音转文字 API PRD",
  "version": 1,
  "created_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 不允许创建标题为 `soul`、`soul.md`、`agents`、`agents.md`、`AGENTS.md` 的文档。
- `content` 必须是 Bot 产出的业务内容，不是平台配置。
- 创建成功后记录 `tool_event`。
- 创建成功后写入文档元数据和 `document_versions`。
- 文档内容按统一 chunk 策略写入 vector backend。

### document.update

更新已有业务文档，并创建新版本。

输入：

```json
{
  "document_id": "doc_xxx",
  "content": "...",
  "change_summary": "补充计量计费和 Console 影响"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "version": 2,
  "updated_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 必须校验当前 Bot 是否有权限更新目标文档。
- 更新业务文档可以版本化。
- 不支持更新 `soul.md` 或 `agents.md`。
- 更新后重新生成该版本对应的 chunks 和 embeddings。

### document.get

读取业务文档。

输入：

```json
{
  "document_id": "doc_xxx",
  "version": "latest"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "title": "语音转文字 API PRD",
  "doc_type": "prd",
  "version": 2,
  "content": "...",
  "scope": "bot",
  "owner_id": "testbot-okurjh"
}
```

### document.list

列出业务文档。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh",
  "doc_type": "prd",
  "limit": 20
}
```

输出：

```json
{
  "documents": [
    {
      "document_id": "doc_xxx",
      "title": "语音转文字 API PRD",
      "doc_type": "prd",
      "version": 2,
      "updated_at": "2026-06-22T00:00:00.000Z"
    }
  ]
}
```

### document.search

搜索业务文档。

输入：

```json
{
  "query": "语音转文字 计量计费 console",
  "scopes": ["shared", "bot"],
  "owner_ids": ["platform", "testbot-okurjh"],
  "limit": 10
}
```

输出：

```json
{
  "results": [
    {
      "document_id": "doc_xxx",
      "title": "语音转文字 API PRD",
      "snippet": "...",
      "score": 0.82
    }
  ]
}
```

搜索必须支持向量检索。第一版可以同时支持：

- 向量召回。
- title/tags/doc_type/scope 过滤。
- 简单关键词 fallback。

### document.ingest_file

上传并解析文件，生成业务文档或知识文档。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh",
  "file_ref": "upload_xxx",
  "filename": "asr-prd.md",
  "doc_type": "prd",
  "title": "语音转文字 API PRD",
  "tags": ["prd", "asr"],
  "tier": "core"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "version": 1,
  "chunks": 12,
  "assets": []
}
```

解析能力必须覆盖现有 Memory Service 已具备的格式：

| 格式 | 处理方式 |
| --- | --- |
| Markdown / TXT | 按标题和段落解析 |
| PDF | 提取文本，保留页码 metadata，图片作为 assets |
| Word `.docx` | 提取段落、标题、表格 |
| Excel `.xlsx` | 按 sheet 提取 |
| HTML | 提取正文 |
| 图片 | 第一版保存为 asset；后续可接 OCR |

### document.ingest_url

抓取 URL 并生成业务文档或参考文档。

输入：

```json
{
  "scope": "shared",
  "owner_id": "platform",
  "url": "https://example.com/asr-api",
  "doc_type": "reference",
  "tags": ["reference", "asr"],
  "tier": "reference"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "version": 1,
  "chunks": 8,
  "source_url": "https://example.com/asr-api"
}
```

规则：

- 保存抓取快照。
- 记录 source URL。
- 抓取失败返回 `fetch_failed`。

### document.scan

扫描授权目录并批量导入文档。

输入：

```json
{
  "scope": "shared",
  "owner_id": "platform",
  "directory_ref": "docs/prd",
  "tags": ["prd"],
  "tier": "core",
  "incremental": true
}
```

输出：

```json
{
  "scanned": 12,
  "created": 3,
  "updated": 2,
  "skipped": 7
}
```

规则：

- Bot 不能传任意宿主机路径。
- `directory_ref` 必须是平台预先授权的目录别名。
- 支持增量扫描。
- 记录文件 hash，避免重复导入。

### memory.write

写入长期记忆。

输入：

```json
{
  "scope": "user",
  "owner_id": "woYddk...",
  "content": "用户叫杜洁鹏，关注环信 IM 产品和 PRD 质量。",
  "tier": "core",
  "source": {
    "conversation_id": "conv_xxx",
    "message_id": "msg_xxx"
  },
  "tags": ["user-profile"]
}
```

输出：

```json
{
  "memory_id": "mem_xxx",
  "created_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 用户级长期记忆必须来自用户明确确认，或来自管理员配置。
- 临时推测不能写入长期记忆。
- 不允许写入 Secret、API Key、管理员认领码、认证文件路径。
- 写入后按统一 chunk 策略生成 embeddings。
- 支持 tags、tier、source metadata。

### memory.search

检索长期记忆。

输入：

```json
{
  "query": "用户身份和偏好",
  "scopes": ["user", "bot", "shared"],
  "owner_ids": ["woYddk...", "testbot-okurjh", "platform"],
  "limit": 5
}
```

输出：

```json
{
  "results": [
    {
      "memory_id": "mem_xxx",
      "content": "用户叫杜洁鹏...",
      "scope": "user",
      "owner_id": "woYddk...",
      "score": 0.91
    }
  ]
}
```

搜索必须支持：

- 当前 scope 精确过滤。
- include shared。
- tags 粗筛。
- tier 过滤。
- 向量相似度排序。

### memory.ingest_file

把文件内容作为长期知识导入 memory，而不是作为业务文档管理。

适用场景：

- 规范手册。
- 常见问题。
- 长期背景材料。
- 非文档交付物的参考资料。

输入：

```json
{
  "scope": "shared",
  "owner_id": "platform",
  "file_ref": "upload_xxx",
  "filename": "billing-rules.pdf",
  "tags": ["billing", "reference"],
  "tier": "core"
}
```

输出：

```json
{
  "memory_id": "mem_xxx",
  "chunks": 18,
  "assets": ["asset_xxx"]
}
```

### memory.ingest_url

抓取 URL 并作为长期知识导入。

输入：

```json
{
  "scope": "shared",
  "owner_id": "platform",
  "url": "https://example.com/billing-policy",
  "tags": ["billing"],
  "tier": "reference"
}
```

### memory.scan

扫描授权目录并批量导入长期知识。

输入：

```json
{
  "scope": "shared",
  "owner_id": "platform",
  "directory_ref": "knowledge-base",
  "tags": ["kb"],
  "tier": "core",
  "incremental": true
}
```

### memory.delete

删除或归档记忆。

输入：

```json
{
  "memory_id": "mem_xxx",
  "mode": "archive"
}
```

规则：

- 默认优先归档，不物理删除。
- 物理删除需要管理员权限。

### memory.stats

获取记忆统计。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh"
}
```

输出：

```json
{
  "total_memories": 42,
  "total_chunks": 358,
  "by_tier": {
    "core": 30,
    "reference": 10,
    "temp": 2
  },
  "disk_usage_mb": 125
}
```

### search.query

跨文档和记忆统一搜索。

输入：

```json
{
  "query": "语音转文字 API 计量计费",
  "sources": ["documents", "memories"],
  "scopes": ["shared", "bot", "user"],
  "owner_ids": ["platform", "testbot-okurjh", "woYddk..."],
  "tags": ["prd", "billing"],
  "limit": 10
}
```

输出：

```json
{
  "results": [
    {
      "source": "document",
      "id": "doc_xxx",
      "title": "语音转文字 API PRD",
      "snippet": "...",
      "score": 0.91,
      "metadata": {
        "doc_type": "prd",
        "version": 2
      }
    },
    {
      "source": "memory",
      "id": "mem_xxx",
      "snippet": "...",
      "score": 0.86,
      "metadata": {
        "tier": "core"
      }
    }
  ]
}
```

### context.get

读取当前可用上下文摘要。

输入：

```json
{
  "include": ["session", "user", "bot", "shared"],
  "limit": 20
}
```

输出：

```json
{
  "session_summary": "...",
  "memories": [],
  "documents": [],
  "shared_context": []
}
```

规则：

- 不返回 `soul.md` 和 `agents.md`，它们由 `llm-runner` 直接注入 prompt。
- 只返回当前可信上下文允许访问的数据。
- 默认执行一次轻量相关性检索，返回和当前会话相关的文档片段、记忆片段和 session summary。

## 分块与 Embedding

文档和记忆统一使用 chunk pipeline：

```text
raw content
  -> parser
  -> normalized text
  -> chunker
  -> embedding
  -> vector index
  -> metadata store
```

默认策略：

- chunk size：约 512 tokens。
- overlap：约 128 tokens。
- 优先按标题、段落、表格边界切分。
- 不在句子中间切断，除非单句过长。
- 每个 chunk 携带 source id、chunk index、原始位置、tags、tier、scope、owner。

Chunk metadata：

```text
chunk_id
source_type
source_id
scope
owner_id
content
embedding_ref
chunk_index
heading_path
page_number
sheet_name
row_range
asset_refs
tags
tier
created_at
last_hit_at
hit_count
```

## 生命周期管理

保留现有 Memory Service 的 tier 设计，并扩展到文档和记忆：

| tier | 用途 | 生命周期 |
| --- | --- | --- |
| core | 长期核心知识、正式文档、规则 | 默认永久保留 |
| reference | 参考资料、会议纪要、URL 抓取资料 | 长期未命中后归档 |
| temp | 会话摘要、临时上下文 | 定期清理 |

默认策略：

- `temp`：7 天后自动清理或归档。
- `reference`：90 天未命中后标记 archived，不参与默认检索。
- `core`：不自动删除。
- assets：当所有引用都删除或归档后再清理。

生命周期任务由 `data-service` 或独立 worker 执行，MCP 只暴露触发和统计工具：

```text
memory.stats
memory.delete
document.list
```

管理端可以后续增加 lifecycle UI。

## 数据模型

### documents

```text
document_id
scope
owner_id
title
doc_type
visibility
tier
source_type
source_uri
content_hash
created_by_bot_id
created_by_user_id
created_at
updated_at
last_hit_at
hit_count
status
```

### document_versions

```text
document_id
version
content
change_summary
created_at
chunk_count
```

### document_tags

```text
document_id
tag
```

### memories

```text
memory_id
scope
owner_id
content
tier
source_type
source_conversation_id
source_message_id
created_by_bot_id
created_by_user_id
created_at
updated_at
last_hit_at
hit_count
status
```

### memory_tags

```text
memory_id
tag
```

### chunks

```text
chunk_id
source_type
source_id
scope
owner_id
content
chunk_index
heading_path
location
tier
created_at
last_hit_at
hit_count
```

### assets

```text
asset_id
source_type
source_id
filename
content_type
storage_uri
size_bytes
content_hash
created_at
```

### chunk_assets

```text
chunk_id
asset_id
```

### tool_events

可在 `log-service` 中维护：

```text
event_id
bot_id
user_id
conversation_id
tool_name
input_summary
output_summary
target_type
target_id
status
error_code
duration_ms
created_at
```

## 错误模型

MCP 工具错误使用结构化错误码：

```text
permission_denied
not_found
validation_error
storage_unavailable
search_unavailable
rate_limited
unsafe_content
unsupported_file_type
fetch_failed
parse_failed
embedding_failed
```

错误不直接暴露底层堆栈。Bot 可以据此回复用户：

```text
文档保存失败，我可以先把内容发给你，稍后再保存。
```

## Kiro CLI 集成

`llm-runner` 为每次运行生成 MCP 配置。

如果 Kiro 支持 HTTP MCP：

```json
{
  "mcpServers": {
    "bot-workspace": {
      "url": "http://mcp-service:8700/mcp/bots/testbot-okurjh/sessions/conv_xxx",
      "headers": {
        "x-runner-token": "signed-token"
      }
    }
  }
}
```

如果 Kiro 只支持 stdio MCP：

```text
kiro-cli
  -> stdio mcp adapter
  -> http mcp-service
```

第一版优先选择当前 Kiro CLI 实际支持的方式。如果二者都可行，优先 HTTP MCP，减少本地 adapter 复杂度。

## agents.md 工具规则

初始化生成的 `agents.md` 应包含 MCP 使用规则：

- 需要保存业务文档时使用 `document.create` 或 `document.update`。
- 需要导入文件、URL 或目录资料时使用 `document.ingest_*` 或 `memory.ingest_*`。
- 需要查询已有文档时使用 `document.get`、`document.list` 或 `document.search`。
- 只有确认过的长期事实才写入 `memory.write`。
- 需要查找长期知识时使用 `memory.search` 或 `search.query`。
- 不要通过文档工具写入 `soul.md` 或 `agents.md`。
- 工具失败时先向用户说明，不伪造保存成功。

## WebUI 影响

WebUI 需要继续区分：

- 机器人配置：`soul.md`、`agents.md`。
- Bot 生成文档：来自 `document.*` MCP 工具。
- 记忆：来自 `memory.*` MCP 工具。
- 工具调用日志：来自 `tool_events`。

文档列表不展示 `soul.md` 和 `agents.md`。

## 第一版范围

第一版实现：

- 新增 `services/mcp-service`。
- MCP tools：
  - `document.create`
  - `document.update`
  - `document.get`
  - `document.list`
  - `document.search`
  - `document.ingest_file`
  - `document.ingest_url`
  - `document.scan`
  - `memory.write`
  - `memory.search`
  - `memory.ingest_file`
  - `memory.ingest_url`
  - `memory.scan`
  - `memory.delete`
  - `memory.stats`
  - `search.query`
  - `context.get`
- `data-service` 增加业务文档、文档版本、记忆、chunk、asset、tags、tier、lifecycle API。
- 新增或整合 vector backend，第一版可使用 ChromaDB。
- 新增 object storage，本地开发可用文件系统卷。
- `log-service` 增加 `tool_events`。
- `llm-runner` 为 Kiro 注入 MCP。
- WebUI 展示业务文档列表、记忆统计、导入结果和工具事件摘要。

第一版不实现：

- 文档 diff 页面。
- 复杂权限 UI。
- 人工审批流。
- MCP marketplace。

## 验收标准

- Bot 不能通过 MCP 创建或更新 `soul.md`、`agents.md`。
- Bot 可以通过 MCP 创建一份 PRD 文档。
- Bot 可以通过 MCP 导入 Markdown/PDF/Word/Excel/HTML 文件并完成检索。
- Bot 可以通过 MCP 抓取 URL 并完成检索。
- Bot 可以通过 MCP 扫描授权目录并增量导入。
- WebUI 可以看到该 PRD 文档，但不会把它和机器人配置混在一起。
- Bot 可以通过 MCP 写入一条确认过的 user memory。
- 后续对话可以通过 `memory.search` 找回该 memory。
- `memory.stats` 能返回 scope 维度的记忆数量、chunk 数、tier 分布和存储占用。
- `log-service` 能看到工具调用事件。
- Kiro runtime 可以真实调用 MCP 工具，而不是 mock。
- 权限越界时返回 `permission_denied`。
