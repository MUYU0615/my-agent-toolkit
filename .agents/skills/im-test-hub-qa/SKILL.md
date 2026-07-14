---
name: im-test-hub-qa
description: 在 im-test-hub 仓库中设计、生成、修改、执行和分析 Python SDK/Server REST 自动化测试。用户提到 im-test-hub，要求根据自然语言需求、已有Case或已完成的Jira分析生成测试代码，要求新增或修改 tests/e2e、维护 tests/live、执行指定Case/Suite、查看 evidence/Allure 报告，或分析 EBS 与 tke-qa 测试差异时使用。只有Jira编号且尚未完成需求与提测分析时，先使用 easemob-jira-testcase；已有Jira分析或已确认Case时直接使用本Skill，不重复分析Jira。不用于其他测试仓库、纯Jira登录排查或与测试代码无关的普通问答。
---

# IM Test Hub QA

Use this skill as the Bot-facing entrypoint for real `im-test-hub` project work. Keep project rules authoritative and route to the repository's own narrower skills instead of duplicating them here.

## Establish The Project Context

1. Decide whether repository files are actually required. Ordinary questions, Jira readiness analysis, and testcase Markdown review do not require repository access.
2. In a managed WeCom Bot conversation, require the current user to bind a personal GitHub fork with `/github bind` before any repository work. Answer repository overview, existing Case discovery, and test-scope recommendation through the read-only MCP tools `project.inspect`, `project.search`, and `project.read` with `project_key: "im-test-hub"`. These tools query only that user's bound fork and must not create a conversation workspace.
3. Only when code generation, modification, `collect-only`, real execution, or repository-local report analysis requires a writable checkout, call `project.ensure` once with `{"project_key":"im-test-hub"}`. Use the returned relative `path` as `<IM_TEST_HUB_ROOT>`. Do not run `git clone` yourself and do not ask the user for a local path.
4. If a project tool reports that the GitHub fork is not bound, tell the current user to send `/github bind`; do not ask for a Token in chat and do not fall back to another user's checkout. If a required `project.*` tool itself is unavailable, tell the Bot administrator to enable it in WebUI.
5. Outside managed WeCom, locate the real `im-test-hub` checkout. Prefer the current working directory when it contains `AGENTS.md`, `src/`, `tests/`, and `e2e_scripts/`; otherwise use the caller-provided path. Do not guess a developer-specific absolute path.
6. Run the read-only probe:

```bash
python3 <SKILL_DIR>/scripts/inspect_project.py --repo <IM_TEST_HUB_ROOT>
```

7. Change into the verified writable repository root before reading or modifying project files.
8. Read the repository's `AGENTS.md` completely. Then read only the project Skill files selected by the routing table below.
9. Treat the current root `AGENTS.md`, project `.agents/skills/`, current code, and current README as authoritative in that order. Do not rely on `.kiro/agents/im-test-hub-prompt.md` when it conflicts; that file can contain older unittest and documentation conventions.
10. Inspect `git status --short` before editing. Preserve unrelated user changes and never stash, reset, discard, or overwrite them.

Read [references/project-map.md](references/project-map.md) when choosing test families, commands, report artifacts, or documentation updates.

## Normalize The Request

Classify the input without forcing a Jira dependency:

- `direct_requirement`: the user directly describes code or test behavior to add.
- `approved_cases`: the user supplies or confirms testcase content.
- `jira_context`: Jira analysis and cases already exist in the conversation.
- `jira_only`: only a Jira key/URL exists and requirement discovery is still needed; use `easemob-jira-testcase` first when installed, then return here with the resulting readiness and cases.
- `execute_only`: the user asks to run or analyze existing tests without changing code.

Do not rerun Jira analysis when the conversation already contains an approved case version. Do not require a Jira key for direct code generation, case automation, test execution, or report analysis.

If the request lacks a concrete behavior, target side, expected observation, or environment needed to design a valid case, ask only the single most important question. If the user already gave exact cases or explicitly asked to implement the stated behavior, treat that as implementation authorization. For governed `tests/live` behavior changes, still follow the project `im-test-hub-create-case` confirmation rule.

## Route To The Correct Project Skill

Choose the target before writing code:

| Task | Default location | Required project guidance |
| --- | --- | --- |
| New SDK/Server pytest E2E automation | `tests/e2e/` | `.agents/skills/im-test-hub-e2e-case-baseline/SKILL.md` |
| Existing pytest E2E update or EBS/tke-qa baseline | `tests/e2e/` | `im-test-hub-e2e-case-baseline` |
| Existing or explicitly requested legacy live case | `tests/live/` | `im-test-hub-create-case` |
| Server REST wrapper addition/fix/move | `src/server/` | `im-test-hub-server-api` |
| SDK API behavior implementation | `src/sdk/` | `im-test-hub-port-sdk-api` or `im-test-hub-sdk-upgrade` as directed by root `AGENTS.md` |
| Live runner, GitHub Actions, MSYNC/log policy | runner/workflow files | `im-test-hub-live-runner` |
| Static SDK/REST coverage outputs | coverage sources/generated outputs | `im-test-hub-coverage-stats` |
| Cross-environment old-live execution report | `output/live-run-report/` | `im-test-hub-live-coverage-run-report` |
| Any repository content change | `CHANGELOG.md` | `im-test-hub-release-flow` |

Default new automation to `tests/e2e/`. Do not add new work to `tests/live/` merely because an old similar case exists; use live only when the user explicitly requests live maintenance or the target behavior belongs to an existing governed live suite.

## Design And Implement

1. Search the matching source, tests, helpers, docs, coverage maps, and nearby cases with `rg`.
2. Reuse existing clients, fixtures, evidence helpers, naming, priorities, cleanup, and report conventions.
3. State the planned case chain when requirements leave room for interpretation: setup, operation, cross-side observation, assertions, cleanup, and environment dependency.
4. Keep each case focused on one primary behavior. Use unique resources and avoid test-order dependencies.
5. For new `tests/e2e` cases:
   - Add `@pytest.mark.priority("P0"|"P1"|"P2")`.
   - Write executable Chinese steps in the docstring with side markers.
   - Capture real request/response evidence with existing project helpers.
   - Do not invent a success/error contract when the real EBS behavior is unknown; baseline it using the repository's compatibility evidence pattern.
6. For `tests/live`, follow the exact case document, logging, coverage, and cross-side rules in `im-test-hub-create-case`.
7. If a Server REST wrapper is missing or inconsistent, use `im-test-hub-server-api` before placing code. Do not invent endpoints or payloads.
8. Keep edits surgical. Do not opportunistically migrate old live tests, regenerate unrelated reports, or refactor adjacent modules.
9. Update every project-owned document and generated output required by the selected project Skills.
10. Add a concise Chinese entry under root `CHANGELOG.md` → `Unreleased` for any repository content change. Do not bump `VERSION` during normal editing.

## Verify

Run the narrowest useful checks first.

For a new or changed pytest E2E case:

```bash
.venv/bin/python -m pytest <TEST_NODE_OR_FILE> --collect-only -q
```

When a caller-authorized real config is available, execute one case at a time:

```bash
./e2e_scripts/run_e2e.sh \
  --config <CONFIG_YAML> \
  --case '<PYTEST_NODEID>' \
  --run-id <RUN_ID> \
  --report allure \
  --no-serve
```

For old SDK/Server live cases, use `script/run_github_actions_live_cases.py` according to the project live Skills. Do not use raw `python -m unittest` as the normal live verification entry.

Rules:

- Never read or print real `.env`, YAML secrets, client secrets, tokens, cookies, or passwords.
- Do not claim a real behavior passed from `--collect-only`, unit tests, static coverage, or report regeneration.
- If credentials/config are unavailable, run safe local checks and state exactly which real verification was skipped.
- Treat runner exit status and generated evidence as truth. Use the LLM only to summarize them.
- Auto-repair syntax, import, collection, and test-code errors at most twice when authorized. Do not change a business assertion merely to turn a product failure into a pass.
- Run `git diff --check` and inspect `git diff --stat` plus changed paths before completion.

## Report Results

Return a concise Chinese result suitable for Enterprise WeChat:

```markdown
## 执行结果

- 任务来源：直接需求 / 已确认Case / Jira上下文
- 修改范围：...
- Case：...
- 验证状态：通过 / 失败 / 部分验证 / 未执行真实环境
- 通过/失败/跳过：...
- 报告：仓库相对路径

### 失败或风险

- 预期：...
- 实际：...
- 证据：...
- 判断：测试代码问题 / 产品行为差异 / 环境阻塞 / 待确认

### Git状态

- 尚未Push，尚未创建PR。
```

Do not expose tool traces, absolute private paths, raw logs containing secrets, or environment values. Prefer repository-relative report paths. Include the exact focused verification that ran, and distinguish generated code from verified behavior.

## Git Safety

- Local code generation and focused tests are allowed only when requested by the user.
- Do not commit, push, force-push, open a PR, or trigger GitHub Actions without explicit authorization for that action.
- Before a requested commit or PR, show changed paths, test results, skipped real verification, and known failures.
- Never make Kiro or a report-generation prompt handle GitHub credentials.
