# Automation Project Contract

This contract applies to the target automation repository where a generated pytest project is created. It does not describe the skill-management repository that stores this reusable skill.

## Directory Layout

Generated projects must use this layout:

```text
auto-test/<JIRA-KEY>/
├── .gitignore
├── README.md
├── docs/
│   ├── cases.md
│   └── context.md
├── fixtures/
│   └── <project-specific-test-assets>
├── prd/
│   └── <jira-derived-title>.md
├── reports/
│   └── README.md
└── tests/
    ├── conftest.py
    └── test_<feature_slug>.py
```

## Managed Bot Bootstrap Root

When the managed Bot receives explicit case approval and the current user's isolated project root does not exist, bootstrap a new local automation repository from `assets/python-pytest-workspace-template/`. Its root must contain the shared files required by this contract, including `env/`, `src/`, `scripts/`, `pytest.ini`, `pyproject.toml`, `.gitignore`, and `AUTO-TEST.md`.

The bootstrap root belongs below the current user's workspace at `projects/easemob-auto-test/`; it must never be created in the Skill repository or another user's workspace. Initialize it as a local Git repository for rollback and traceability. A remote repository, push, pull request, or Jira comment requires a separate explicit user request.

Generated Jira projects must contain only Jira-specific tests, docs, fixtures, reports, request logs, and resource files. Environment files, dependency/build metadata, run scripts, request logging code, runtime state, and shared API clients must live at the target automation repository root.

## Environment Contract

The target automation repository root must define four example files:

```text
env/.env.ebs.example
env/.env.tke.example
env/.env.ngi.example
env/.env.qa.example
```

Each file must use an environment-specific prefix:

```text
TKE_BASE_URL=https://example-tke.easemob.com
TKE_APPKEY=org#app
TKE_CLIENT_ID=replace-with-client-id
TKE_CLIENT_SECRET=replace-with-client-secret

# HIM-22187: 第二通道 WebSocket
TKE_FUSION_WS_URL=wss://example-tke-fusion.easemob.com/ws
```

Supported `TEST_ENV` values are `ebs`, `tke`, `ngi`, and `qa`. Real `env/.env.<env>` files must stay at the target automation repository root and be gitignored.

All environment variables (including project-specific ones) must be placed in the root example files. Use comments to indicate which project requires the variable. The project README must document its required variables and their purpose.

Do not create project-level env directories or env example files. Do not add user IDs, group IDs, chat room IDs, or file IDs to the required env contract unless the user explicitly asks to reuse existing resources. These values should be created by fixtures or test steps and stored in target-repository-root `.runtime/<JIRA-KEY>/state.json` when needed.

## Shared Runtime Resource Modules

The target automation repository root must include shared modules for reusable runtime resources. Generated projects should import shared modules instead of duplicating resource code inside each project.

`src/easemob_accounts.py` creates reusable test contact accounts. The module should call the authorized single-account registration API:

```text
POST /{org}/{app}/users
```

Use App Token authorization through `EasemobClient`, generate usernames with lowercase letters, numbers, `_`, `-`, or `.`, and store generated contact usernames/passwords only in target-repository-root `.runtime/<JIRA-KEY>/state.json`.

`src/easemob_chatfiles.py` uploads local fixture files through:

```text
POST /{org}/{app}/chatfiles
```

It should upload with the runtime user token when the downstream API needs user-context ownership. It should extract file IDs from `entities[].uuid`, direct `fileId` fields, or URL segments after `/chatfiles/`. Do not require pre-filled `SPEECH_*_FILE_ID` variables for generated tests.

Generated tests must not reuse cached chatfile fileIds for fileId flows. Each pytest run should upload the current fixture through `/chatfiles` and use the fileId returned by that upload. Target-repository-root `.runtime/<JIRA-KEY>/state.json` may keep the latest generated fileId only as diagnostic trace data, not as a source for future reuse. This ensures tests always use the current fixture and `auto-test/<JIRA-KEY>/log/<timestamp>/` includes the upload request and response that produced the downstream fileId.

Some APIs require a username associated with the current token/request context. In that case, generated projects should create the user at runtime, log in with `grant_type=password`, and use that user token with the same username. Do not add `CURRENT_USERNAME` or other pre-existing user IDs to the required env contract unless the user explicitly asks to reuse an existing account.

When a generated project lives under `auto-test/<JIRA-KEY>/`, root `pytest.ini` in the target automation repository must make that repository's `src/` importable. Generated tests should import shared modules directly, for example `import easemob_accounts`, `import easemob_client`, or `import easemob_chatfiles`.

## Reverse-Derived PRD

The PRD filename must be derived from the Jira title. Use a readable Chinese filename.

The PRD content must be written in Chinese, including the title and section headings.

The PRD must include:

- Jira key and source links
- Background / 背景
- Problem statement / 问题说明
- Goals and non-goals / 目标和非目标
- User or system flows / 用户或系统流程
- API/config/permission behavior / API、配置与权限行为
- Acceptance criteria / 验收标准
- Test scope / 测试范围
- Risks, assumptions, and open questions / 风险、假设与待确认问题

If any required section cannot be supported by source context, stop and ask for the missing information before creating runnable tests.

## Source Context Gate

Automation cases must be generated only from actual source context, including Jira descriptions and comments, linked Confluence/resource pages, API documents, field definitions, acceptance criteria, fixture/resource documentation, and explicit user-provided files or instructions.

Before creating `docs/cases.md`, PRD content, README test steps, fixtures, or automation code, verify that the source context contains the required behavior, API paths and methods, request parameters, request body fields, response fields, enum/error codes, permissions, environment scope, fixture definitions, and expected results needed for the planned cases.

If any required source document, parameter, field definition, permission rule, fixture source, or expected result is missing or ambiguous, stop and report the exact missing items to the user. Do not proceed by using mock endpoints, guessed payloads, inferred enum values, placeholder assertions, or assumptions.

## Project README

Generated project `README.md` must be written in Chinese. It must include:

- 项目来源: Jira, local PRD, context document, Confluence/API/resource links.
- 测试范围: what APIs, flows, formats, permissions, or scenarios are covered.
- 测试步骤: concrete business/API flow, not only environment preparation. It must name each API, generated resource, token type, input fixture, and value passed to the next step.
- 预期结果: success expectations, failure/error-code expectations, skip conditions, and known environment dependencies.
- 环境配置: target-repository-root `env/.env.<env>` files, supported `TEST_ENV=ebs|tke|ngi|qa`, and explicit warning not to commit secrets.
- 执行方式: full pytest command, targeted command examples, and collect-only command.
- 运行时资源: users, groups, chatfiles, file IDs, or other generated data and where state is stored.
- 报告: where to write execution summaries and what each summary should contain.
- 请求日志: 每次 pytest 在 Jira 项目目录 `auto-test/<JIRA-KEY>/log/<timestamp>/` 下生成完整请求/响应 JSON 日志，包含完整 URL、请求 header、请求 body、响应 header、响应 body；JSON body 必须格式化输出。

Do not leave template placeholders such as `{{EXPECTED_RESULTS}}` or `{{TEST_SCOPE}}` in a generated project README.

README test steps must be specific enough for a QA engineer to understand the workflow without reading the test code. For example:

- 先调用 `POST /{org}/{app}/users` 注册运行时用户。
- 再用该用户通过 `grant_type=password` 获取 user token。
- 用 user token 调 `POST /{org}/{app}/chatfiles` 上传 `fixtures/audio/direct-mp3-8k.mp3`。
- 从上传响应 `entities[0].uuid` 取 fileId。
- 用同一 user token 调目标接口，并断言响应状态码、业务字段或错误码。

Avoid vague steps such as "run pytest" as the only test procedure. Commands belong in "执行方式"; business/API actions belong in "测试步骤".

## Generated Document Language

All generated project documents must be written in Chinese, including:

- `README.md`
- `docs/cases.md`
- `docs/context.md`
- `prd/*.md`
- `reports/*.md`
- Resource README files under fixtures or project-specific resource directories

English API names, HTTP methods, field names, command examples, code identifiers, source URLs, and literal error codes may remain unchanged. Explanatory prose, headings, test steps, assumptions, gaps, execution summaries, and case descriptions must be Chinese.

## Case Source Of Truth

Generated projects must include `docs/cases.md` before any automation code is written. This file is the authoritative source for all test cases and must be reviewed by the user before code generation starts.

Do not create `docs/cases.md` until the Source Context Gate is satisfied. Case content must be traceable to real Jira/Confluence/API/resource/user-provided context. Missing API parameters, field definitions, fixture sources, or expected results must be reported as blockers instead of being mocked, guessed, or marked as placeholders.

`docs/cases.md` must include:

- 中文状态说明，至少包含 `待评审`, `待实现`, `已实现`, `已通过`, `未通过`, and `跳过`.
- 覆盖所有计划用例的 Markdown prose sections. Tables are forbidden because they hide detail and make review harder.
- Each case must use a one-line Markdown heading containing checkbox execution result, Case ID, status, priority, and scenario name, for example `### [ ] HIM-22206-TC-001 | 待评审 | P0 | 场景名称`.
- Use `[ ]` before cases that have not passed. Use `[x]` only after a real execution has passed that case.
- Under each case heading, describe `前置条件`、`操作步骤`、`请求内容`、`预期结果`、`执行结果` separately. Steps must be concrete API/resource-level actions.
- For every case involving HTTP/API calls, `请求内容` must clearly document method, path, token type, path parameters, query parameters, headers, request body, fixtures, and values passed from earlier steps.
- Request examples must be written in fenced code blocks, preferably `http` or `json`, so reviewers can inspect the exact request shape before code generation.
- `预期结果` must be explicit enough to translate directly into pytest assertions, including status code, response JSON shape, required fields, important values, and expected error codes.
- Expected result examples must be written in fenced code blocks, preferably `json` or `text`.
- Do not include an `自动化位置` field.
- 中文 Review 记录，说明用户是否已批准用例清单。
- 可在 pytest 执行后更新的中文执行汇总。

Required workflow:

1. Generate `docs/cases.md` from Jira/PRD/context before writing tests.
2. HARD GATE: stop immediately and ask the user to review `docs/cases.md`. Do not create, edit, or scaffold pytest test code in the same turn unless the user has already explicitly approved the current file content.
3. Do not create or modify pytest test code until the user approves `docs/cases.md` in the conversation.
4. If the user later modifies `docs/cases.md`, treat existing automation code as stale. Re-read the changed cases and regenerate or update the corresponding code before any new execution.
5. After implementing each case, update its status to `已实现`.
6. After executing tests, update each case heading and execution-result section: passed cases become `[x] ... | 已通过 | ...`, failed cases remain `[ ] ... | 未通过 | ...`, skipped cases remain `[ ] ... | 跳过 | ...`. Failed cases must include the failure reason or observed error.
7. Any report under `reports/` must summarize results from `docs/cases.md`; do not maintain a second independent case list.

## Target Repository AUTO-TEST.md Index

Update the target automation repository root `AUTO-TEST.md` with an automation project index. Create the file if it does not exist. Use this table shape:

```markdown
## Automation Projects

| Jira | Project | PRD | 测试内容 | Source Links | Run |
| --- | --- | --- | --- | --- | --- |
| HIM-22206 | [HIM-22206](auto-test/HIM-22206/) | [HIM-22206 示例功能 PRD](auto-test/HIM-22206/prd/example.md) | 示例功能主链路、异常路径和回归影响面。 | [Jira](https://j1.private.easemob.com/browse/HIM-22206) | `TEST_ENV=tke sh scripts/run_pytest.sh auto-test/HIM-22206` |
```

If the section already exists, update or append the Jira row. Do not duplicate an existing Jira row.

The `PRD` column must use the concrete PRD document title as the link text. Do not use a generic link label such as `PRD`.

The `测试内容` column must briefly summarize what the project tests, including the primary APIs or workflows and major scenario categories. Keep it concise but specific enough to distinguish the project from other automation projects.

## Execution Summary

After running tests, write a concise report under `reports/`, for example `reports/2026-06-10-execution.md`, containing:

- command
- environment target without secrets
- passed/failed/skipped count
- created runtime resources
- failure analysis and next steps

## Request/Response Logs

Generated pytest projects must create `auto-test/<JIRA-KEY>/log/<timestamp>/` during each real test run. Each HTTP request must be written as a formatted JSON file containing:

- full request URL
- request method
- request headers
- request body, including multipart form fields and uploaded file names
- response status code
- response headers
- response body with JSON pretty printed when possible

Do not write real secrets into logs. Redact at least `Authorization`, `access_token`, `client_secret`, `password`, and token-like fields while preserving enough structure to debug whether the header/body field was present.
