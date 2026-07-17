---
name: easemob-confluence-review
description: Use when an Easemob Confluence URL, Confluence page review, Jira-linked Confluence batch context, or confirmed single-page Confluence reply is requested for `https://c1.private.easemob.com`.
---

# Easemob Confluence Review

## Overview

Use this skill to fetch a specified Easemob internal Confluence page, classify the document, generate review artifacts, and post a confirmed single-page reply.

Managed HLD routes include backend, Web frontend, and client HLD. Client HLD covers iOS, Android, SDK, mobile/client-side storage, offline, weak-network recovery, push notification, and compatibility design. Frontend HLD covers Web UI plus external API contracts, API parameters, failure handling, and retry strategy.

The runnable Python workflow lives under `scripts/`. Use `scripts/run.sh` as the normal entrypoint so execution stays relative to this skill and uses the managed `scripts/.venv`.

## When to Use

- User gives a `https://c1.private.easemob.com` page URL and wants review output
- User asks to post a confirmed review reply back to that Confluence page
- User asks to update Confluence review routes, checklist rules, or reply templates

## When Not to Use

- Request is about non-Easemob Confluence systems
- User only needs generic document review without a Confluence page URL
- User wants Jira testcase generation; use `easemob-jira-testcase`

## Default Runs

Temporary review output must be written automatically to the system tmp directory. Do not ask the user for an output directory and do not write review artifacts into the repository unless the user explicitly asks to export or preserve them.

Environment diagnosis:

```bash
./scripts/run.sh doctor
```

Use `doctor` when local Python, venv, dependencies, required system environment variables, or optional OCR tooling may be missing. The wrapper creates `scripts/.venv` and installs `scripts/requirements.txt`; if Python or dependency installation is unavailable, follow the install guidance printed by the command.

Single page review:

```bash
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>'
```

Jira-linked batch context:

```bash
./scripts/run.sh analyze-urls --url '<CONFLUENCE-URL-1>' --url '<CONFLUENCE-URL-2>'
```

This writes each page's `qa-context.json` and one aggregate `jira-context.json`. The Jira testcase workflow must use the original `index.md` as source evidence, use the QA context only for traceability/readiness, and never infer missing API contracts.

For pages with screenshot or image attachments, the same command also prepares a multimodal visual review package. It downloads image attachments to the page `assets/` directory and writes:

```text
<TMP-PAGE-DIR>/visual-review.md
```

Use `visual-review.md` as the handoff prompt for the current multimodal LLM session. The workflow does not run OCR and does not call an external model API for this generic visual review package; it only prepares local image paths, source URLs, and the review questions.

Export artifacts to a chosen directory only when the user asks:

```bash
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>' --output <LOCAL-DIR>
```

Reply from an already reviewed page directory:

```bash
./scripts/run.sh reply-page --page-dir <TMP-PAGE-DIR>
```

Use `reply-page` after checking or editing `reply.md`. Do not rerun `analyze-url --confirm-reply` when `reply.md` has been manually corrected, because `analyze-url` fetches and regenerates artifacts before replying.

## Environment Variables

In the managed Enterprise WeChat Bot runtime, this skill reuses the current user's Jira binding. The runtime injects `EASEMOB_JIRA_USERNAME` and `EASEMOB_JIRA_PASSWORD` only into that Bot-and-user's CLI process; do not ask users to provide credentials in chat.

For standalone usage, credentials may be set in the system environment using the legacy `CONFLUENCE_*` variables.

Managed Bot credentials (preferred):

- `EASEMOB_JIRA_USERNAME`
- `EASEMOB_JIRA_PASSWORD`

Standalone compatibility credentials:

- `CONFLUENCE_BASIC_USER`
- `CONFLUENCE_BASIC_PASS`
- `CONFLUENCE_APP_USER`
- `CONFLUENCE_APP_PASS`

Optional:

- `OUTPUT_DIR`

The Confluence base URL is fixed to `https://c1.private.easemob.com`; do not add a configurable `CONFLUENCE_BASE_URL`.

Optional local tool:

- `tesseract`: used only for OCR on screenshot-heavy performance review pages. If missing, the skill should continue text-based review and return install guidance instead of failing the whole analysis. Generic visual attachment review packages do not use OCR.

Environment variable details:

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `EASEMOB_JIRA_USERNAME` | Managed Bot required | Reused as Confluence Basic and application login username | `dujiepeng` |
| `EASEMOB_JIRA_PASSWORD` | Managed Bot required | Reused as Confluence Basic and application login password | `******` |
| `CONFLUENCE_BASIC_USER` | Standalone fallback | Basic auth username for `c1.private.easemob.com` | `dujiepeng` |
| `CONFLUENCE_BASIC_PASS` | Standalone fallback | Basic auth password | `******` |
| `CONFLUENCE_APP_USER` | Standalone fallback | Confluence application-layer login username | `dujiepeng` |
| `CONFLUENCE_APP_PASS` | Standalone fallback | Confluence application-layer login password | `******` |
| `OUTPUT_DIR` | No | Export directory for preserved review artifacts; default flow still uses system tmp | `/tmp/confluence-review-export` |

## Review Flow

1. Run `./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>'`, or use `analyze-urls` for all Confluence links discovered from one Jira.
2. Read `doc-type.json` and `review-checklist.json` before interpreting the page output.
3. Inspect `index.md`, `summary.md`, and `reply.md`. If OCR or image analysis is weak, prefer page text and manual image review over generated performance conclusions.
4. If image attachments exist, inspect `visual-review.md` and use its local image paths with the current multimodal LLM session before finalizing screenshot-dependent conclusions.
5. If `reply.md` needs correction, edit the temporary `reply.md` in the generated page directory.
6. Run `./scripts/run.sh reply-page --page-dir <TMP-PAGE-DIR>` only after the reply draft is checked.

## Governance

Treat a capability as official only after its behavior is confirmed by code, tests, and real output.

When a capability is not yet confirmed:

- Do not list it as a stable command, route, output contract, or supported workflow.
- Keep it as candidate behavior in implementation notes, route governance, or tests until verified.
- Prefer wording such as "candidate", "experimental", or "not yet official" instead of implying support.
- Update `SKILL.md`, `references/usage.md`, relevant Python files under `scripts/`, and root `CHANGELOG.md` only when the official boundary changes.

Official review routes:

- `pressure-design-review`
- `pressure-benchmark-review`
- `client-hld-review`
- `frontend-hld-review`
- `backend-hld-review`
- `prd-review`
- `generic-review`
- `skip-weekly-report`

## Outputs

- default root: system tmp directory `qa-ai-tool/easemob-confluence-review/`
- default behavior: automatically use the default root for temporary reviews
- export root: directory passed by `--output` or `OUTPUT_DIR`
- page type: `<output-root>/<date>/<doc>/doc-type.json`
- checklist: `<output-root>/<date>/<doc>/review-checklist.json`
- page summary: `<output-root>/<date>/<doc>/summary.md`
- visual review package: `<output-root>/<date>/<doc>/visual-review.md`
- downloaded image assets: `<output-root>/<date>/<doc>/assets/`
- reply draft: `<output-root>/<date>/<doc>/reply.md`
- reply state: `<output-root>/<date>/<doc>/reply-state.json`
- QA handoff: `<output-root>/<date>/<doc>/qa-context.json`
- Jira batch handoff: `<output-root>/batches/<url-hash>/jira-context.json`

Read `references/usage.md` for command details, route governance, and validation.
