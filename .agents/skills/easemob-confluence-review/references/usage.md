# Usage

## Purpose

Run the Easemob Confluence review workflow for `https://c1.private.easemob.com`:

- fetch a specified single page
- classify the page into a managed review route
- generate checklist, summary, and reply draft artifacts
- post a confirmed single-page Confluence reply

## Required Environment Variables

Managed Bot sessions reuse the current user's Jira binding. Do not ask users to send credentials in chat. Standalone use retains the `CONFLUENCE_*` compatibility variables.

Managed Bot runtime variables:

- `EASEMOB_JIRA_USERNAME`
- `EASEMOB_JIRA_PASSWORD`

Standalone compatibility variables:

- `CONFLUENCE_BASIC_USER`
- `CONFLUENCE_BASIC_PASS`
- `CONFLUENCE_APP_USER`
- `CONFLUENCE_APP_PASS`

Optional output override:

- `OUTPUT_DIR`

## Commands

All commands should be run through the wrapper from the skill directory:

```bash
./scripts/run.sh doctor
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>'
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>' --output <LOCAL-DIR>
./scripts/run.sh analyze-urls --url '<CONFLUENCE-URL-1>' --url '<CONFLUENCE-URL-2>'
./scripts/run.sh reply-page --page-dir <TMP-PAGE-DIR>
```

The wrapper creates or reuses `scripts/.venv`, installs `scripts/requirements.txt`, and runs the Python CLI package from `scripts/confluence_review/`. `analyze-urls` writes a machine-readable aggregate `jira-context.json`, while each successfully read page writes `qa-context.json` beside its source `index.md`.

Use `doctor` first when local Python, venv, Python packages, required system environment variables, or optional OCR tooling may be missing. The command reports availability without printing secret values. If Python itself is missing, `scripts/run.sh` prints a local install suggestion before exiting.

Quote Confluence URLs in shell commands. URLs that contain `?pageId=` can be interpreted as a shell glob in zsh if they are unquoted.

## Confirmed Actions

Inspect the generated `index.md`, `summary.md`, `reply.md`, and `reply-state.json` before any reply action.

Use the existing page directory when the draft has been checked or manually corrected:

```bash
./scripts/run.sh reply-page --page-dir <TMP-PAGE-DIR>
```

Use `analyze-url --confirm-reply` only when the newly generated draft is already correct and does not need manual edits:

```bash
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>' --confirm-reply
```

Before any confirmed reply, inspect:

- `<output-root>/<date>/<doc>/reply.md`
- `<output-root>/<date>/<doc>/reply-state.json`

Do not rerun `analyze-url --confirm-reply` after editing `reply.md`; it fetches the page and regenerates artifacts before replying. Use `reply-page --page-dir <TMP-PAGE-DIR>` to publish the reviewed draft.

For pressure benchmark pages, OCR or local image analysis can be incomplete. If generated performance conclusions conflict with `index.md` or manually reviewed screenshots, base the reply on page text and manual review.

## Managed Routes

Official review routes:

- `pressure-design-review`
- `pressure-benchmark-review`
- `client-hld-review`
- `frontend-hld-review`
- `backend-hld-review`
- `prd-review`
- `generic-review`
- `skip-weekly-report`

Weekly reports must stay skipped. HLD pages use `client-hld-review`, `frontend-hld-review`, or `backend-hld-review`. Client HLD covers iOS, Android, SDK, mobile/client-side storage, offline, weak network, push notification, and compatibility design. Frontend HLD covers Web UI, page routing, component state, external API contracts, API parameters, failure handling, and retry strategy. If an HLD is not clearly client or Web frontend, use backend HLD.

## Route Governance

When adding or changing review routes, checklist rules, or reply templates:

1. Define the new route boundary and adjacent-route non-goals.
2. Update classification, checklist, analysis, summary, and reply behavior together.
3. Add route hit tests and non-hit tests.
4. Update the Python modules, tests, this skill, this usage reference, and root `CHANGELOG.md`.

Only promote a route, command, output, or workflow to the official contract after code, tests, and generated artifacts confirm the behavior. If the behavior is still uncertain, keep it described as candidate or experimental behavior near the implementation and do not add it to stable interfaces, managed routes, README capability lists, or changelog entries that imply release.

Expected files usually include:

- `scripts/confluence_review/doc_type.py`
- `scripts/confluence_review/checklist.py`
- `scripts/confluence_review/analyze.py`
- `scripts/confluence_review/reply.py`
- relevant tests in `scripts/tests/`

## Validation

```bash
./scripts/run.sh doctor
./scripts/run.sh test
./scripts/run.sh analyze-url --url '<CONFLUENCE-URL>'
```

For live validation, confirm:

- `doc-type.json` was generated
- `review-checklist.json` was generated
- `summary.md` and `reply.md` are usable
- weekly reports are skipped
- evidence-limited performance reviews state that information is insufficient

## Optional OCR Tooling

Performance pages with screenshot-only evidence can use `tesseract` for local OCR. It is optional; missing `tesseract` should not block normal Confluence page review.

macOS install suggestion:

```bash
brew install tesseract
```

## Output Location

Default output is under the system tmp directory:

- macOS/Linux example: `/tmp/qa-ai-tool/easemob-confluence-review/`

For temporary review, use the default output. Do not pass `--output` and do not write generated artifacts into this repository.

Use `--output <LOCAL-DIR>` or `OUTPUT_DIR` only when the user explicitly asks to export artifacts to a chosen location.

Runtime output must not be treated as source. If examples need to be committed, create separate sanitized fixtures.
