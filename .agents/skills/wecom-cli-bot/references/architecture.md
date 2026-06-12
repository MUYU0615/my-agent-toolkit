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
    bot.config.yaml
    soul.md
    history/
    logs/
  cli-home/
    codex/
    claude/
    kimi/
    kiro/
  instructions/
    AGENTS.md
    CODEX.md
    CLAUDE.md
    KIMI.md
    KIRO.md
  files/
```

`private/` is worker-only. `cli-home/` is for CLI-specific home/config/cache directories. `files/` is the CLI working directory. `instructions/` contains secret-free CLI instructions.

## Message Flow

1. Start a single bot process with `--bot <bot-name>`.
2. Load `workspace/private/.env` and `workspace/private/bot.config.yaml`.
3. Connect to WeCom intelligent bot long connection.
4. On incoming message, identify the WeCom sender.
5. If message text is `停止`, stop the active task for that sender.
6. If another task is already running for the sender, reject the new message.
7. Send immediate acknowledgement: `正在思考，发送【停止】将终止。`.
8. Resolve or create the user's current 3-hour idle-timeout session.
9. Append user message to JSONL history.
10. Build a sanitized CLI prompt.
11. Spawn the configured CLI in `workspace/files/`, with any CLI home variables pointing under `workspace/cli-home/`.
12. Accumulate stdout/stderr and stream current full content to WeCom after redaction, throttled to avoid excessive message repainting.
13. Append final assistant output or stop/error status to JSONL history.

## Session Semantics

Session TTL is idle-based. If a user sends messages continuously, reuse the same session. If no message arrives for 3 hours, the next message creates a new session.

History path:

```text
workspace/private/history/<user-id>/<session-id>.jsonl
```

Use JSONL entries with at least: `timestamp`, `role`, `content`, `event`, and optional `metadata`.

Provider CLIs may have their own session identifiers. Store those on the bot session object when needed. For Kimi Code, parse `session_...` from `kimi -p` output before redaction and pass it back as `kimi -r <session-id> -p ...` for the same WeCom user while this bot session remains active.
