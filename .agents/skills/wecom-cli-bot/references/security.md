# Security

Use these rules as hard requirements.

## Workspace Fence

- Resolve all paths to absolute real paths before use.
- Reject any path outside `bots/<bot-name>/workspace`.
- Run CLI child processes with cwd `workspace/files`.
- Do not pass paths under `workspace/private` to the CLI.
- Do not let user prompts request or reveal `workspace/private` files.
- Put CLI-specific home/config/cache directories under `workspace/cli-home`, not `workspace/private`.
- Do not include `workspace/cli-home` contents in prompts or WeCom replies.

## Secret Handling

Secrets live only in:

```text
workspace/private/.env
```

This includes WeCom Bot ID, WeCom Secret, and any CLI-specific environment variables. The worker may load this file and pass selected values as child process environment variables. It must not put secret values into prompts, instructions, logs intended for users, or WeCom replies.

## Redaction

Before sending any text to WeCom:

- Replace exact values loaded from `.env` with `[REDACTED]`.
- Redact common key/value patterns such as `SECRET=...`, `TOKEN=...`, `API_KEY=...`, `sk-...`, bearer tokens, and long high-entropy strings.
- Refuse direct user requests to show secrets, private config, raw env, or raw private history.
- If a streamed chunk looks like it contains a secret, do not send that chunk; write a private log entry instead.

## CLI Boundary

The worker talks to CLIs, not model APIs. Do not implement OpenAI, Anthropic, Kimi, or Kiro API clients in the worker. If a CLI needs credentials, inject them via the bot's child-process env.

## Git Hygiene

Generate `.env.example`, not real `.env` values. Ensure `.gitignore` excludes:

```text
bots/*/workspace/private/.env
bots/*/workspace/private/history/
bots/*/workspace/private/logs/
bots/*/workspace/cli-home/
```
