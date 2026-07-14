# IM Test Hub Project Map

This is a compact navigation snapshot for the Bot-facing Skill. The live repository's root `AGENTS.md`, project `.agents/skills/`, code, and README override this file when they change.

## Authority And Boundaries

- The project is a Python SDK behavior and Server REST API test reference repository.
- In this repository, `sdk` means Python SDK behavior under `src/sdk/`, not every client platform.
- New pytest-native automation belongs to `tests/e2e/` by default.
- `tests/live/` is an older but governed live suite with strict case-document and coverage synchronization rules.
- Do not add new tests under `tests/client_test/`.
- `src/sdk/pb/` contains generated protobuf code and is not a normal manual-edit target.
- Prefer root `AGENTS.md` and `.agents/skills/` over `.kiro/agents/im-test-hub-prompt.md` if they conflict.

## Main Directories

| Path | Responsibility |
| --- | --- |
| `src/sdk/` | Python imitation of SDK behavior, including SDK REST and MSYNC paths |
| `src/server/` | Server REST API tools and resource orchestration |
| `src/callback/` | Pre/post callback receiver, tunnel, orchestration, and attribution |
| `tests/e2e/sdk/` | New pytest-native SDK E2E by domain |
| `tests/e2e/server/` | New pytest-native Server E2E by domain |
| `tests/e2e/support/` | New E2E fixtures, resources, assertions, steps, and evidence helpers |
| `tests/live/sdk/` | Governed legacy SDK live cases |
| `tests/live/server/` | Governed legacy Server live cases |
| `tests/live/callback/` | Callback live subsystem |
| `tests/live/imm/` | IMM switch cases, isolated from ordinary regression |
| `tests/unit/` | Local unit and guard tests |
| `e2e_scripts/` | New E2E runner, report generation, ledger, and config template |
| `script/` | Legacy live runner, coverage generation, and operational scripts |
| `docs/live_cases/` | Legacy live case documents and generated parameter coverage |
| `docs/sdk功能列表/` | SDK feature baselines and final coverage |
| `docs/rest功能列表/` | REST feature baselines and final coverage |

## Project Skill Routing

Read these files from the checked-out project only when their scope applies:

- `.agents/skills/im-test-hub-e2e-case-baseline/SKILL.md`: new/changed `tests/e2e`, EBS baseline, tke-qa comparison, evidence and Allure.
- `.agents/skills/im-test-hub-create-case/SKILL.md`: any `tests/live` case creation/change/review and matching case docs.
- `.agents/skills/im-test-hub-server-api/SKILL.md`: Server REST wrapper ownership, canonical directories, tests, and official-doc lookup.
- `.agents/skills/im-test-hub-port-sdk-api/SKILL.md`: one confirmed missing SDK API.
- `.agents/skills/im-test-hub-sdk-upgrade/SKILL.md`: broad Linux SDK baseline upgrade and API inventory.
- `.agents/skills/im-test-hub-live-runner/SKILL.md`: old live runner, CI workflow, MSYNC endpoint and logging behavior.
- `.agents/skills/im-test-hub-coverage-stats/SKILL.md`: static SDK/REST feature and parameter coverage.
- `.agents/skills/im-test-hub-live-coverage-run-report/SKILL.md`: old live multi-environment Markdown/Excel execution reports.
- `.agents/skills/im-test-hub-release-flow/SKILL.md`: `CHANGELOG.md` and `VERSION` policy.

## New E2E Verification And Artifacts

Use the public runner:

```bash
./e2e_scripts/run_e2e.sh --config <yaml> --case '<nodeid>' --run-id <run-id> --report allure --no-serve
```

Do not put `suite`, `case`, `jobs`, `report`, or `run_id` into the app config YAML. They are command arguments.

Generated run artifacts live under:

```text
output/e2e-run/<run-id>/
```

Important outputs:

- `e2e-run-case-summary.json` / `.html`: case-level result summary.
- `e2e-run-report.json` / `.html`: request, response, expected, actual, and evidence details.
- `e2e-case-structure.json` / `.html`: primary, dependency, and observation API relationships.
- `evidence/*.jsonl`: machine-readable evidence.
- `allure-results/`: Allure input.
- `allure-report/`: generated Allure HTML when the CLI is available.

Report regeneration from existing evidence is not a real test execution:

```bash
.venv/bin/python e2e_scripts/src/run_tests.py report --run-id <run-id>
```

The runtime ledger also reads existing artifacts and does not execute tests:

```bash
./e2e_scripts/ledger_e2e.sh
```

## Legacy Live Verification And Documents

SDK/Server live execution goes through:

```bash
.venv/bin/python script/run_github_actions_live_cases.py
```

Do not substitute raw unittest commands for normal live execution. Callback and other specialized live areas have separate entries defined by root `AGENTS.md` and project Skills.

Every governed `tests/live` case has a matching document:

- SDK: `docs/live_cases/sdk_live_cases.md`
- Server: `docs/live_cases/server_live_cases/<test_file>.md`
- Callback: `docs/live_cases/callback_live_cases.md`
- DLQ: `docs/live_cases/dlq_live_cases.md`
- IMM: `docs/live_cases/imm_live_cases/`

Live changes can also require coverage source updates and regeneration through `script/generate_parameter_coverage.py --repo-root .`.

## Completion Rules

- Any repository content change requires a concise `CHANGELOG.md` `Unreleased` entry.
- Do not update `VERSION` during normal editing.
- `collect-only` proves discovery only, not live behavior.
- EBS is the expected-good baseline for project flows that explicitly require environment comparison.
- Do not weaken assertions to make tke-qa match when EBS and tke-qa differ.
- Never expose configuration or credentials in prompts, logs, reports, commits, or chat.

