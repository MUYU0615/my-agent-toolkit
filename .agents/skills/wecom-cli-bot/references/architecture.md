# Architecture

Use this architecture when scaffolding `./wecom-cli-bots`.

## Process Model

- Run one process per bot.
- Address a running task by `(bot_name, wecom_user_id)`.
- Allow only one active task for a given `(bot_name, wecom_user_id)`.
- Keep bots isolated by directory, env, process, logs, history, and CLI working directory.

## Bot Workspace

Each bot owns exactly one workspace:

```text
bots/<bot-name>/workspace/
  private/
    .env
    .env.example
    admin.json
    bot.config.yaml
    soul.md
    history/
    logs/
  cli-home/
    kiro/
  instructions/
    AGENTS.md
    KIRO.md
  files/
```

`private/` is worker-only and includes governance state. `cli-home/` is for Kiro runtime home/config/cache. `files/` is the CLI working directory. `instructions/` contains secret-free CLI instructions.

## Message Flow

1. Start a single bot process with `--bot <bot-name>`.
2. Load `workspace/private/.env` and `workspace/private/bot.config.yaml`.
3. Connect to WeCom intelligent bot long connection.
4. On incoming message, identify the WeCom sender.
5. Gate the message through admin state. If unclaimed, accept only `/claim_admin <code>`. If initializing, accept only the administrator and transfer acceptance flow.
6. If message text is the configured stop keyword, stop the active task for that sender after governance allows it.
7. If another task is already running for the sender, reject the new message.
8. Send immediate acknowledgement.
9. Resolve or create the user's current idle-timeout session.
10. Append user message to JSONL history.
11. Build a sanitized Kiro prompt.
12. Spawn `kiro-cli` in `workspace/files/`, with `KIRO_HOME` under `workspace/cli-home/kiro`.
13. Accumulate stdout/stderr and stream current full content to WeCom after redaction, throttled to avoid excessive message repainting.
14. Append final assistant output or stop/error status to JSONL history.

## Session Semantics

Session TTL is idle-based. If a user sends messages continuously, reuse the same session. If no message arrives for 3 hours, the next message creates a new session.

History path:

```text
workspace/private/history/<user-id>/<session-id>.jsonl
```

Use JSONL entries with at least: `timestamp`, `role`, `content`, `event`, and optional `metadata`.

Kiro session identifiers are tracked per WeCom user. `/history` lists Kiro sessions, `/open N` stores a selected Kiro session id, and subsequent Kiro runs resume with `--resume-id` or `--resume` when appropriate.
