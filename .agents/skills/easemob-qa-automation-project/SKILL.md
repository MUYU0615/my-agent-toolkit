---
name: easemob-qa-automation-project
description: Create, configure, execute, and report an isolated Easemob Jira-scoped Python pytest project after reviewed testcase approval. Use for a Test-Jira Bot Jira/Confluence flow or an explicitly named automation repository; enforce readiness assessment, user-confirmed cases, per-user/workspace isolation, and runtime secret handling.
---

# Easemob QA Automation Project

Use this skill only after `easemob-jira-testcase` has produced the current Jira's Chinese testcase draft and the same user explicitly confirms it. If Confluence is linked, use the available Confluence review result as source evidence.

## System Flow Auto-execution

This exception applies only when both conditions are true: `MY_AGENT_RUNTIME=system-flow` and `MY_AGENT_SYSTEM_FLOW_AUTO_APPROVE_CASES=1`. The administrator's Flow setting is then the explicit case confirmation for the current Jira Run.

- Keep the readiness gate: if readiness is not `测试准入：通过`, stop after the gap/risk report; do not create test code or claim execution.
- When readiness passes, use the already-created `repository/<JIRA-KEY>/` directory in the current System Flow workspace. Do not create an `auto-test/` parent and do not inspect sibling Jira directories.
- Create `docs/cases.md`, implement tests, validate the exact required environment variables, then run the real test command only when all requirements are present.
- System Flow variables are already injected into the CLI process and materialized as `repository/.env`; never ask for `/env set`, never copy their values into output, and never commit that file.
- A report may call a case passed or failed only from the current Run's actual command output. Jira comments, attachments, and historical reports are evidence only and must be labelled `历史参考`.

## Two Modes

- **Managed Test-Jira Bot (default):** create a clean `<current-conversation-workdir>/<JIRA-KEY>/` project. Do not inspect or reuse parent, sibling, shared-repository, or another-user files. The project is isolated by Bot, WeCom user, conversation, and Jira.
- **Explicit repository mode:** use `<target-git-root>/auto-test/<JIRA-KEY>/` only when the user explicitly names a target repository. Read `references/project-contract.md` before generating or reviewing this mode.

Never create test files in this skill-management repository.

## Required Flow

1. **Evidence and readiness**
   - Use only the current message's Jira/Confluence links and explicitly linked content. Do not infer a repository, SDK, API shape, test environment, account, historical report, or acceptance criteria.
   - Before testcase output, assess: requirement/acceptance criteria, API or interaction definition, exceptions and boundaries, permissions, test data, dependent design documents, and test environment.
   - State exactly one result: `测试准入：通过`, `测试准入：不通过`, or `测试准入：条件通过（假设与待确认项）`.
   - On failure, name the missing minimum information and resulting test risk. Do not present guesses as confirmed coverage. If the user explicitly asks to continue, produce only an assumption-labelled testcase draft; do not claim complete coverage.

2. **Case review gate**
   - Return the complete Chinese testcase draft first. Do not create a project, code, environment file, or execution report until the current user explicitly confirms the current Jira's cases.
   - After confirmation, generate `docs/cases.md` as the case source of truth. Each case must have concrete preconditions, steps, request/interaction, expected result, and execution result. If confirmed cases later change, update the matching code before another run.

3. **Create and implement**
   - In managed mode, create the Jira directory directly under the current conversation working directory. Bootstrap it from `assets/python-pytest-workspace-template/`, then merge the Jira-specific files from `assets/python-pytest-template/` into that same directory; do not create an `auto-test/` parent or scan outside the current working directory.
   - Use Python, pytest, requests, and python-dotenv. Generate runtime users/resources in fixtures; do not require pre-existing user, group, room, or file IDs unless the user explicitly requests reuse.
   - Keep Jira source context, cases, test code, logs, and reports in the Jira directory. Do not use another Jira's code or artifacts.

4. **Configure and execute**
   - Before the first `pytest` run, inspect the generated environment templates, configuration code, and environment-contract tests. List every missing required variable by its exact name; do not use a generic “是否配置环境” question.
   - If any required value is missing, reply that code validation is complete and request the values before running tests. Non-secret values may be supplied in chat and are written only after user confirmation to `env/.env.<env>`; do not run `pytest`, create a test report, or claim skipped results at this stage.
   - For a token, password, cookie, or secret, tell the user the exact variable name and request `/env set <KEY> <VALUE>`. Use `os.environ["<KEY>"]` in tests; never write the value into `.env`, code, docs, logs, or reports. `/env status` lists names and `/env unset <KEY>` removes a key.
   - Run tests automatically after all required configuration exists. Create a `跳过` report only when the user explicitly asks to defer execution or explicitly asks for a skipped report; state the exact unmet prerequisite.

5. **Verify and report**
   - Run compilation and the relevant pytest command. Do not claim pass/fail without an actual run.
   - Update `docs/cases.md` from real results, then write a Chinese report with execution time, environment (without secrets), scope, passed/failed/skipped counts, failure reasons, evidence/log paths, risks, and recommendations.
   - Reply in WeCom with the conclusion and artifact paths first; summarize or split long cases/logs/reports.

6. **Publish the current Jira project (only on explicit request)**
   - Publish is a separate final action. Never publish merely because code was created, tests ran, or a report exists. Require the current user to explicitly ask to `提交`、`推送`、`发布` the current Jira project.
   - Managed Test-Jira Bot publishes the current conversation's `<JIRA-KEY>/` directory only. It never uses `/sync`, `project.publish`, a shared repository workspace, a user-supplied local path, native Git commands, or a GitHub Token from chat.
   - Include the Jira project's `reports/` directory in the GitHub submission so the report is versioned with its tests. Reports and evidence must already be redacted; never include runtime secrets, environment files, cookies, raw authorization headers, or unredacted request/response logs.
   - Use exactly one `jira.project.publish` MCP call with `jira_key`, any valid `bot/<meaningful-suffix>` branch hint, and a one-line commit message. The trusted backend resolves the current Bot/user/conversation path, bound fork, and a stable per-conversation branch itself. Repeated submissions append commits to that same returned branch; never create a new branch merely because this Jira was submitted before.
   - If a trusted GitHub binding status is available and unbound, reply exactly: `还不能提交当前 Jira 项目：你尚未绑定 GitHub fork。请先发送 /github bind；绑定完成后再发送“提交当前 <JIRA-KEY> 项目”。` Do not call another publish tool.
   - If binding status is unavailable to the CLI, still call `jira.project.publish`; if it reports an unbound fork, return the same Chinese guidance. Never fall back to `project.publish` or claim that a commit exists.
   - Only report success when the tool result contains a verified branch, 40-character commit, changed paths, and GitHub URL. Otherwise report the returned failure and keep the local Jira project unchanged.

7. **Post real execution results to Jira (only on explicit request)**
   - This is independent of GitHub publishing. Require the current user to explicitly ask to post, comment, upload, or attach the current Jira's test report to Jira. Never do it after a run by default.
   - Use the `easemob-jira-testcase` Skill's `attach-file` and `reply-issue` flow with the current user's `/jira bind` credentials; do not call Jira REST APIs directly and do not ask for Jira credentials in chat.
   - Publish only a report produced by an actual run in the current conversation's `<JIRA-KEY>/reports/` directory. A skipped report may state that tests were not run and why, but must never imply a pass result.
   - Before uploading, create `<JIRA-KEY>/reports/<JIRA-KEY>-evidence-<timestamp>.zip` containing the report and selected redacted evidence only. Exclude `.env*`, `env/`, `.runtime/`, virtual environments, cookies, tokens, passwords, authorization headers, source files, and raw logs unless they have been specifically redacted. When in doubt, attach the report only.
   - Upload the ZIP first, then post one concise Chinese comment that includes execution time, sanitized environment, scope, passed/failed/skipped counts, failure reasons, risks/recommendations, and the returned Jira attachment link. Return the actual attachment URL and Jira comment ID only after both operations succeed.

## Safety

- Never expose a secret in a reply, prompt, committed file, request log, or report. Redact authorization and token-like fields in evidence.
- Do not push code, create a remote repository, open a pull request, or comment on Jira unless the user explicitly asks.
- Do not replace missing API definitions, error codes, permissions, or expected results with mock values or speculative assertions.
