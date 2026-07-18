---
name: easemob-jira-testcase
description: Analyze Easemob Jira issues for QA readiness, linked context, coverage, and testcase design. Use when an Easemob Jira URL, Jira key, or `https://j1.private.easemob.com` appears in a QA request; in managed WeCom conversations, return the complete Chinese testcase draft directly as Markdown for human review.
---

# Easemob Jira Testcase

## Overview

Use this skill when an Easemob Jira issue should be transformed into QA-oriented analysis outputs. It crawls the root Jira, follows nearby Jira references, detects linked external design documents, and generates readiness, graph, impact, and case coverage artifacts.

This skill does not replace document-specific readers. Feishu links are read through `lark-cli docs +fetch` when available. Easemob Confluence links are recorded as discovered external context and should hand off to `easemob-confluence-review` for page fetching and review. The default mode is `family-with-ghosts`, which keeps scope bounded while preserving comment references as visible graph context.

## When to Use

- User gives a Jira URL or Jira key and wants testcase generation
- User mentions the Easemob Jira base URL `https://j1.private.easemob.com`
- User wants a Jira readiness check before testcase generation
- User wants graph outputs or impact summaries from Easemob Jira
- User wants the skill to inspect Jira-linked Feishu or Easemob Confluence design documents as part of task completeness analysis
- User wants a reviewed readiness or "无法测试" conclusion posted back to the Jira issue as a comment

## When Not to Use

- User only needs Jira login troubleshooting or account access help
- Request is about non-Easemob Jira systems
- User wants generic requirement discussion without a concrete Jira URL or Jira key
- User only wants a standalone Confluence page review without Jira context; use `easemob-confluence-review`

## Default Run

When this Skill is loaded, treat the directory containing this `SKILL.md` as `<SKILL_DIR>`. Resolve every relative path in this Skill from `<SKILL_DIR>`, not from the Bot workspace or the process working directory.

Always run through the wrapper from `<SKILL_DIR>` so Python execution stays isolated from the user's global environment:

```bash
cd <SKILL_DIR> && ./scripts/run.sh --root <JIRA-URL-OR-KEY>
```

For Easemob private Jira analysis, do not use anonymous `web_fetch` as a substitute for the wrapper. The managed Bot runtime supplies the current user's bound credentials only to the wrapper process. If the wrapper cannot authenticate, follow the managed credential instructions below.

Generated raw data, graph files, summaries, and case coverage design drafts are temporary by default. The wrapper writes them to the system tmp directory under `qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/`; these files are not persistent skill assets and may be deleted at any time.

## Managed WeCom Markdown Review

When `MY_AGENT_RUNTIME=wecom`, treat a concrete Jira key or URL as a request to analyze the Jira and produce a testcase draft unless the user explicitly requests readiness-only analysis.

For the short administrator-controlled Test-Jira Bot prompt rules, use `assets/test-jira-bot-rules.md` as the canonical template. Keep operational detail in Skills, not in that prompt document.

Run the default wrapper without `--write-cases`, then read the generated case design and the relevant temporary Jira summaries/raw evidence. Use that evidence to write the complete testcase draft directly in the assistant response as Markdown.

- Do not ask the user for an output path.
- Do not persist a testcase file while the draft is under conversational review.
- Do not wrap the whole response in a fenced code block; return Markdown headings, lists, and case sections directly so the Enterprise WeChat client can display them.
- Mark the response as an AI-generated draft that has not been written to a project or submitted to GitHub.
- For `ready`, start with `测试准入：通过` and output the normal testcase draft.
- For `partial` or `not_ready`, start with `测试准入：不通过`; list missing minimum information, test risks, and targeted questions. Do not output guessed cases by default.
- Only when the user explicitly asks to continue despite the gaps, use `测试准入：条件通过（假设与待确认项）` and output an assumption-labelled draft. Do not claim complete coverage or use speculative details as assertions.
- When the user requests revisions in the same Kiro session, revise the prior draft and return the complete updated Markdown, not only a change acknowledgement.

Only write testcase files when the user explicitly requests a local file export. In that case, require a caller-controlled directory and pass it explicitly:

```bash
cd <SKILL_DIR> && ./scripts/run.sh --root <JIRA-URL-OR-KEY> --write-cases --case-output-root <LOCAL-DIR>
```

## Readiness Only

```bash
cd <SKILL_DIR> && ./scripts/run.sh --root <JIRA-URL-OR-KEY> --dry-readiness
```

## Visual Attachment Review Package

When Jira context is carried by screenshots or other image attachments, download visual attachments and generate a multimodal LLM review prompt:

```bash
cd <SKILL_DIR> && ./scripts/run.sh --root <JIRA-URL-OR-KEY> --download-attachments
```

This writes image files under:

- `<output-root>/attachments/visual/`

And writes a visual review task package to:

- `<output-root>/summary/<JIRA-KEY>-visual-review.md`

Use the generated markdown as the handoff prompt for the current multimodal LLM session. The script does not run OCR and does not call an external model API; it only prepares local image paths, source Jira metadata, and the review questions. Treat extracted visual conclusions as screenshot-based evidence unless the Jira description or linked documents also state the same acceptance criteria.

## Jira Reply Draft and Confirmed Reply

Jira replies are a two-step flow. Never post a Jira comment during the default analysis run.

First generate a reply draft and state file:

```bash
cd <SKILL_DIR> && ./scripts/run.sh --root <JIRA-URL-OR-KEY> --draft-reply
```

This writes:

- `<output-root>/summary/<JIRA-KEY>-reply.md`
- `<output-root>/summary/<JIRA-KEY>-reply-state.json`

Inspect and edit `<JIRA-KEY>-reply.md` before publishing. If the Jira and linked Jira issues only have titles, empty descriptions such as `Click to add description`, no useful comments, and no readable external design documents, the draft should conclude that information is insufficient and the task cannot be tested yet.

When a reply mentions an API, keep the request method and endpoint on one logical line. For example, write `POST /api/sdk/v1/{org}/{app}/speech/transcriptions`; do not split the endpoint across lines such as `POST /api/sdk/v1/{org}` followed by `/` and `{app}/speech/transcriptions`.

For confirmed Jira comments, API endpoints must be posted with Jira `{noformat}` markup instead of Markdown inline backticks, for example `{noformat}POST /api/sdk/v1/{org}/{app}/speech/transcriptions{noformat}`. Jira's page renderer may visually split inline-code paths that contain `{org}/{app}` even when the stored comment body is one line. The draft writer and `reply-issue` command normalize obvious wrapped API endpoints and convert inline API endpoint code spans to `{noformat}` before saving or posting, but still inspect the draft for readable one-line API paths.

For confirmed Jira comments, format JSON request/response examples as Jira code blocks instead of Markdown inline backticks, using plain `{code}` followed by pretty-printed JSON and `{code}`. Do not use `{code:json}` because the Easemob Jira renderer may not have a JSON formatter installed. Format short field names, values, and observed codes such as `error_code=5` or `1601` as Jira inline code `{{error_code=5}}` and `{{1601}}`. This keeps execution-result replies readable in Jira and avoids raw backticks appearing in the rendered comment.

After the draft is checked or manually corrected, post it with:

```bash
cd <SKILL_DIR> && ./scripts/run.sh reply-issue --issue <JIRA-KEY> --page-dir <TMP-ANALYSIS-DIR>
```

Use `reply-issue` only after checking the draft. The command reads the existing draft and state file, posts the draft through Jira's issue comment API, and updates `<JIRA-KEY>-reply-state.json`. If the same draft hash was already posted, the command skips duplicate publishing.

## Attach File to Jira Issue

Upload a file as an attachment to a Jira issue:

```bash
cd <SKILL_DIR> && ./scripts/run.sh attach-file --issue <JIRA-KEY> --file <LOCAL-FILE-PATH>
```

The command uploads the file and prints the attachment URL:

```text
Attached: HIM-22187-log-20260611-183034.zip
ID: 72754
URL: http://j1.private.easemob.com/secure/attachment/72754/HIM-22187-log-20260611-183034.zip
```

When posting a Jira comment that references an attached file, use the actual attachment URL so reviewers can click to download. Format as a Jira link:

```text
*日志附件：* [HIM-22187-log-20260611-183034.zip|http://j1.private.easemob.com/secure/attachment/72754/HIM-22187-log-20260611-183034.zip]
```

Workflow: always upload the attachment first (`attach-file`), capture the printed URL, then include it in the prepared comment before posting with `reply-issue`.

## Publish a Real Test Report to Jira

Use this flow only when the current user explicitly asks to post, comment, upload, or attach the current Jira's test report to Jira. It is a write operation; completing a run or generating a report is not permission to post it.

This flow is for a report produced by `easemob-qa-automation-project` after a real execution. Do not publish a fabricated pass/fail summary, a template report, or a report from another user, conversation, or Jira.

1. Read the current Jira project's latest `reports/*.md` and confirm it contains a real execution time, non-secret environment, scope, passed/failed/skipped counts, failures, and evidence paths.
2. Create an evidence ZIP in the same Jira project's `reports/` directory. Include the report and only selected, already-redacted evidence needed to investigate failures. Never include `.env*`, `env/`, `.runtime/`, virtual environments, source project files, cookies, tokens, passwords, raw authorization headers, or unredacted request/response logs. If safe evidence is unavailable, attach a ZIP containing the report only.
3. Upload the ZIP first with `attach-file`; retain the returned attachment URL. Do not guess an attachment URL or report success if upload fails.
4. Generate a concise Chinese Jira comment in `<page-dir>/summary/<JIRA-KEY>-reply.md` and use the existing reply state in the same summary directory. The comment must include: execution time, environment without secrets, scope, passed/failed/skipped counts, concise failure reasons or `无`, risks/recommendations, and a Jira-format link to the uploaded ZIP. It must not contain tokens, credentials, full request headers, or private local paths.
5. Call `reply-issue` exactly once for that prepared draft. It applies Jira formatting and records the comment ID to prevent duplicate publication of the same content. On success, reply to the WeCom user with the Jira key, comment ID, attachment URL, and the local report path. On failure, report the returned error without claiming publication.

Use the normal `--draft-reply` run first when a reply state does not yet exist. The report comment may replace the generated draft body before `reply-issue`; the command recalculates the content hash and only deduplicates an already-posted identical comment.

## Python Environment Guardrails

Before running Jira analysis, the wrapper performs these checks and setup steps:

- verifies `python3` is available in `PATH`
- creates a local virtual environment at `scripts/.venv` when missing
- fails with an actionable error if Python cannot create a venv
- installs dependencies from `requirements.txt` into `scripts/.venv` when the file declares dependencies
- runs `jira_issue_network.py` with `scripts/.venv/bin/python`

Do not run `python3 scripts/jira_issue_network.py` directly during normal skill use. If the local venv becomes corrupt, remove `scripts/.venv` and rerun `./scripts/run.sh`.

## Environment Variables

When this Skill runs through the managed Enterprise WeChat Bot runtime, Jira credentials are bound per Bot and WeCom user. If the wrapper reports that managed credentials are missing, stop the Jira workflow and reply directly: `Jira 账号尚未绑定，请先发送 /jira bind，绑定完成后重新发送 Jira 编号。`

In that managed-runtime case:

- Do not ask whether the user is using Enterprise WeChat or a local CLI.
- Do not explain environment-variable setup or ask the user to run `export EASEMOB_JIRA_*`.
- Do not ask for a Jira username or password in chat.
- Do not attempt anonymous `web_fetch` as a fallback for the private Jira page.

For normal usage, set only:

- `EASEMOB_JIRA_USERNAME`
- `EASEMOB_JIRA_PASSWORD`
- `EASEMOB_JIRA_REDIRECT_USERNAME`
- `EASEMOB_JIRA_REDIRECT_PASSWORD`

Optional compatibility flag:

- `EASEMOB_JIRA_INSECURE_SSL=1`

Optional analysis output override:

- `EASEMOB_JIRA_OUTPUT_ROOT`

Debug-only cookie override:

- `EASEMOB_JIRA_COOKIE_FILE`

By default, Jira session cookies are stored in the user's system cache directory and are not part of the generated testcase outputs.

When `EASEMOB_JIRA_COOKIE_FILE` points to an existing cookie file, the skill loads and verifies that session first. It performs a full username/password login only when the cookie is missing, invalid, or expired, and persists the refreshed cookie with owner-only file permissions.

## External Design Documents

The skill recognizes Feishu document links in Jira descriptions and comments, including:

- `https://*.feishu.cn/wiki/...`
- `https://*.feishu.cn/docx/...`
- `https://*.feishu.cn/docs/...`

The skill also recognizes Easemob Confluence links:

- `https://c1.private.easemob.com/...`

When a Feishu link is found, the skill attempts to read it with:

```bash
lark-cli docs +fetch --api-version v2 --as user --doc <FEISHU-URL> --doc-format markdown --format json
```

If reading succeeds, the raw node data and case coverage design record `read_status: read` and include the fetched markdown content excerpt. If reading fails because `lark-cli` is not configured, Keychain is unavailable, user auth is missing, the document is inaccessible, or the caller lacks permission, keep `read_status: not_read` and record the error reason.

When Feishu links are discovered but `lark-cli` or the required Feishu tools are not installed or configured, tell the user to install and set them up from the official Feishu CLI documentation:

```text
https://open.larkoffice.com/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu
```

Do not write Feishu credentials, tokens, cookies, or document content into persistent skill files. Feishu-derived analysis remains part of the temporary output unless the user explicitly exports testcase files.

If a Jira points to a Feishu design doc but the document cannot be read, mention that the design document was discovered but not read, and treat missing design content as a task completeness risk unless the Jira itself has enough acceptance criteria.

When a Jira points to one or more Easemob Confluence pages (`https://c1.private.easemob.com/...`), the skill must attempt to fetch all discovered pages with the `easemob-confluence-review` skill in one batch:

```bash
cd <repo-root>/.agents/skills/easemob-confluence-review && ./scripts/run.sh analyze-urls --url '<CONFLUENCE-URL-1>' --url '<CONFLUENCE-URL-2>'
```

In the managed Enterprise WeChat runtime, `easemob-confluence-review` reuses the current user's `/jira bind` credentials. Do not ask users to bind or send separate Confluence credentials.

For every `read_status: read` page in the generated `jira-context.json`, read the page's `qa-context.json` and its referenced `index.md`. Treat `index.md` as source evidence, and use the QA context only for traceability, page readiness, and gaps. The fetched content informs readiness, case coverage design, and task completeness judgments.

If one or more pages are unreadable, record each `read_status: not_read` with its error reason. Keep successfully read pages in the analysis, but treat missing Confluence content as a task completeness risk unless the Jira itself has enough acceptance criteria. Do not invent API paths, request bodies, field definitions, permissions, error codes, or expected results from an unreadable page.

## Jira Context Traversal

The skill must inspect more than the root Jira. Jira test tasks often point to development tasks, requirement tasks, or design documents indirectly.

Default traversal behavior:

- Scan the full Jira HTML page, not only the visible description and comments.
- Detect Jira references from both plain Jira keys and Jira URLs.
- Recursively fetch referenced Jira issues up to 2 levels from the root task.
- Include referenced Jira nodes in raw output, graph output, impact summary, and case coverage design.
- Detect Feishu links on any fetched Jira node and attempt to read them through `lark-cli docs +fetch`.

This supports common chains such as:

```text
test Jira -> development Jira -> Feishu PRD/design document
```

Do not mark the task context complete only because the root Jira title is readable. Use recursively fetched Jira nodes and external design document read status to judge completeness.

## Readiness Behavior

- If readiness is `ready`, continue and generate normal testcase output.
- If readiness is `partial` or `not_ready`, report the blocking gaps, test risks, and minimum targeted questions; do not write testcase files or present a final testcase set.
- Generate an assumption-based draft for `partial` only after the user explicitly requests that it continue with incomplete information. Mark it `测试准入：条件通过（假设与待确认项）` and keep all unsupported details visibly unconfirmed.
- If the root Jira and linked Jira issues have only titles/relationships but no description, useful comments, or readable external design document, treat it as `not_ready`, even if a Jira relationship exists.
- Report missing information and targeted confirmation questions.
- Do not ask the user to "补充测试范围" generically. Ask concrete questions about the changed module, acceptance criteria, API fields, permissions, configuration, gray release, compatibility, historical data, or explicit out-of-scope behavior.

Use `partial` when the Jira has an identifiable topic, title, linked development task, parent/child relation, or comment reference, but lacks enough acceptance criteria for a final testcase set. The analysis must clearly mark:

- `信息完整度：partial`
- external design documents and read status, when found
- supported test scope
- unsupported assumptions (only used if the user later requests a conditional draft)
- confirmation questions
- current gaps and risks

In the managed WeCom runtime, present the generated testcase draft directly as Markdown after the analysis. Do not ask for an output path. Keep local file export as a separate, explicit operation.

## Testcase Step Granularity

Generated testcase drafts must use executable, API/resource-level steps. Do not output vague steps such as "验证接口成功" or "执行相关测试".

Each testcase or testcase template must clearly state:

- 前置资源/测试数据: users, groups, chat rooms, files, configuration, feature flags, permissions, historical data, or fixtures.
- 操作入口: concrete API/page/event, request method, endpoint/path, token type, and key request fields.
- 数据传递: if a response value is reused, name the source field and target field, for example `entities[0].uuid` -> `fileId`.
- 预期结果/断言点: HTTP status, business code, response fields, callback/message/event/database changes, visible UI state, or unchanged state.
- 环境依赖和不测范围: FFmpeg, gray release, special cluster, quota, external service, or unsupported path.

When source context is insufficient to fill those details, mark the case as assumption-based and ask targeted confirmation questions instead of writing generic steps.

## Outputs

- default temporary analysis output: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/`
- default case design file: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-case-design.md`
- managed WeCom testcase draft: returned directly as Markdown in the assistant response and retained by the active Kiro session during review
- reply draft file after `--draft-reply`: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-reply.md`
- reply state file after `--draft-reply`: `<system-tmp>/qa-ai-tool/easemob-jira-testcase/<JIRA-KEY>/summary/<JIRA-KEY>-reply-state.json`
- testcase files are written only with `--write-cases --case-output-root <LOCAL-DIR>`
- subdirectories: `raw/`, `graph/`, `summary/`

Read `references/usage.md` for usage details.
