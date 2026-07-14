# Usage

## Purpose

Turn an Easemob Jira URL or key into:

- scoped raw Jira data
- graph outputs
- readiness assessment
- task completeness summary
- case coverage design
- linked external design document status for Feishu and Easemob Confluence
- Jira reply drafts and confirmed Jira comments after human review
- Chinese testcase drafts returned directly as Markdown for managed Enterprise WeChat review

This skill is the Jira-centered QA analysis entrypoint. It follows Jira references and records linked design-document context. Feishu links are fetched through `lark-cli docs +fetch` when available; Easemob Confluence links are surfaced with guidance to install or use `easemob-confluence-review`.

## Required Environment Variables

- `EASEMOB_JIRA_USERNAME`
- `EASEMOB_JIRA_PASSWORD`
- `EASEMOB_JIRA_REDIRECT_USERNAME`
- `EASEMOB_JIRA_REDIRECT_PASSWORD`

If the internal Jira uses an untrusted enterprise certificate, also set:

- `EASEMOB_JIRA_INSECURE_SSL=1`

## Default Run

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY>
```

This defaults to:

- mode: `family-with-ghosts`
- lang: `zh-CN`

## Readiness Only

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY> --dry-readiness
```

## Jira Reply Flow

Jira comment publishing is explicit and two-step. The default analysis command never posts a comment.

Generate a reply draft:

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY> --draft-reply
```

Inspect or edit these files before publishing:

- `<output-root>/summary/<JIRA-KEY>-reply.md`
- `<output-root>/summary/<JIRA-KEY>-reply-state.json`

Keep HTTP method and endpoint references on one logical line, for example `POST /api/sdk/v1/{org}/{app}/speech/transcriptions`. Do not publish wrapped paths where `/` or `{app}/...` appears on separate lines.

For confirmed Jira comments, API endpoints must be posted with Jira `{noformat}` markup instead of Markdown inline backticks, for example `{noformat}POST /api/sdk/v1/{org}/{app}/speech/transcriptions{noformat}`. Jira's page renderer may visually split inline-code paths that contain `{org}/{app}` even when the stored comment body is one line. Draft saving and publishing normalize obvious wrapped API endpoints and convert inline API endpoint code spans to `{noformat}`, but review the draft before posting.

For confirmed Jira comments, format JSON request/response examples as Jira code blocks instead of Markdown inline backticks, using plain `{code}` followed by pretty-printed JSON and `{code}`. Do not use `{code:json}` because the Easemob Jira renderer may not have a JSON formatter installed. Format short field names, values, and observed codes such as `error_code=5` or `1601` as Jira inline code `{{error_code=5}}` and `{{1601}}`. This keeps execution-result replies readable in Jira and avoids raw backticks appearing in the rendered comment.

Post the reviewed draft:

```bash
./scripts/run.sh reply-issue --issue <JIRA-KEY> --page-dir <TMP-ANALYSIS-DIR>
```

`reply-issue` reads the existing draft and state file, posts the draft to:

```text
/rest/api/2/issue/<JIRA-KEY>/comment
```

Then it updates the state file with `status`, `comment_id`, timestamps, and the draft hash. If the same hash is already marked as posted, publishing is skipped to avoid duplicate comments.

## External Design Documents

The Jira parser recognizes Feishu links in descriptions and comments:

- `https://*.feishu.cn/wiki/...`
- `https://*.feishu.cn/docx/...`
- `https://*.feishu.cn/docs/...`

It also recognizes Easemob Confluence links:

- `https://c1.private.easemob.com/...`

When a Feishu document is found, the skill attempts to read it through `lark-cli docs +fetch`:

```bash
lark-cli docs +fetch --api-version v2 --as user --doc "<FEISHU-URL>" --doc-format markdown --format json
```

If reading succeeds, the case design output shows `读取状态：read` and includes a markdown excerpt. If reading fails, the case design output shows `读取状态：not_read` and the reason.

If Feishu links are found but `lark-cli` or the required Feishu tools are not installed or configured, guide the user to download, install, and configure them from the official Feishu CLI documentation:

```text
https://open.larkoffice.com/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu
```

```markdown
## 外部设计文档
- 类型：feishu-wiki；读取状态：read；URL：...；说明：Read by lark-cli docs +fetch.
```

If the Jira depends on a Feishu design document, treat unread document content as a completeness risk unless the Jira itself contains enough acceptance criteria and business context.

If the Jira depends on an Easemob Confluence page, guide the user to install or use the `easemob-confluence-review` skill to fetch and review that page. The Jira skill records the Confluence link as discovered external content, but it does not fetch Confluence pages itself.

## Jira Context Traversal

The crawler scans full Jira page HTML for Jira references and Feishu links. It recursively follows Jira references up to 2 levels from the root issue.

This is required because testing tasks commonly contain only a development-task link, and the development task may contain the real Feishu PRD or design document.

Example:

```text
HIM-22130 test task -> HIM-21413 development task -> Feishu PRD
```

All fetched Jira nodes are included in:

- `raw/<JIRA-KEY>.json`
- `graph/nodes.json`
- `graph/edges.json`
- `summary/<ROOT>-test-impact.md`
- `summary/<ROOT>-case-design.md`

Referenced Jira edges are marked as:

```json
{"type": "jira_reference", "source": "page_link"}
```

## Temporary Output by Default

Generated raw data, graph files, summaries, and case coverage design drafts are temporary by default:

```text
<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/
```

These files are working artifacts, not persistent skill assets. They may be deleted at any time.

## Managed Conversation Markdown Review

In the managed Enterprise WeChat runtime, a concrete Jira key or URL starts analysis and Markdown testcase drafting unless the user explicitly asks for readiness-only analysis. First run analysis:

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY>
```

Read the generated task completeness summary, case coverage design, and relevant temporary Jira evidence. Then return the complete testcase draft directly in the assistant response as Markdown.

- Do not ask for an output path.
- Do not wrap the whole response in a Markdown code fence.
- Mark the output as a draft that has not been written to a project or submitted to GitHub.
- On revision requests in the same Kiro session, return the complete revised Markdown.
- For `partial`, keep assumptions and gaps visible.
- For `not_ready`, return blocking gaps instead of inventing testcases.

Do not persist a testcase file during conversational review. Only when the user explicitly requests local file export, write a file to a caller-controlled path:

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY> --write-cases --case-output-root <LOCAL-DIR>
```

## Testcase Step Granularity

Generated testcase drafts must be directly executable by a QA engineer. Each testcase must include:

- 前置资源/测试数据: which users, groups, files, configuration, feature flags, permissions, or historical data are needed.
- 操作步骤: exact API/page/event entry, request method, endpoint/path, token type, and key request fields.
- 数据传递: source response field and target request field, for example `entities[0].uuid` -> `fileId`.
- 预期结果/断言点: HTTP status, business error code, response body fields, callback/message/event/database change, UI visible result, or unchanged state.
- 环境依赖: special cluster, FFmpeg, gray release, quota, external service, or unsupported path.

Do not produce generic cases that only say "执行接口并验证成功". If Jira context does not contain enough detail, keep the case assumption-based and list concrete confirmation questions.

## Custom Analysis Output Directory

The temporary analysis output can be overridden when needed:

```bash
./scripts/run.sh --root <JIRA-URL-OR-KEY> --output-root <LOCAL-DIR>
```

Alternatively set the analysis output root:

- `EASEMOB_JIRA_OUTPUT_ROOT`

## Readiness Rule

- If readiness is `ready`, generate a case coverage design and ask whether testcase files should be output.
- If readiness is `partial`, generate an assumption-based case coverage design and ask whether testcase files should be output.
- If readiness is `not_ready`, generate the task completeness summary and blocking gaps, but do not write testcase files.
- Report missing information and targeted confirmation questions.
- If the root Jira and linked Jira issues have only titles/relationships, empty descriptions such as `Click to add description`, no useful comments, and no readable external design document, classify the task as `not_ready`; a relationship alone is not enough to test.

`partial` is intended for common Jira tasks that contain only a short sentence, a simple title, a linked development task, or thin comments. In this case, generate the coverage design quickly, but label the output as assumption-based and keep the gaps visible.

The partial case design output must include:

- `信息完整度` with `状态：partial`
- inferred test scope
- default assumptions
- case coverage design
- confirmation questions
- current gaps and risks

## Output Location

- default temporary output: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/`
- default case design file: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-case-design.md`
- managed Enterprise WeChat testcase draft: returned inline as Markdown and retained by the active Kiro session during review
- reply draft after `--draft-reply`: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-reply.md`
- reply state after `--draft-reply`: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-reply-state.json`
- testcase output after confirmation: `<LOCAL-DIR>/summary/<JIRA-KEY>-test-cases.md`
- subdirectories: `raw/`, `graph/`, `summary/`

Jira session cookies are internal runtime cache files. By default they are stored in the user's system cache directory, not in the skill directory or testcase output directory.
