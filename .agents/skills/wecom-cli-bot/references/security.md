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
- Treat `workspace/private/admin.json` as governance state. Never include it in prompts, user-visible logs, or WeCom replies.
- Treat host-mounted Kiro auth/config paths such as `/host/kiro-auth` and `/run/cli-auth` as credentials. Never inspect, summarize, copy, or expose their contents through the model.

## Secret Handling

Secrets live only in:

```text
workspace/private/.env
```

This includes WeCom Bot ID, WeCom Secret, and any CLI-specific environment variables. The worker may load this file and pass selected values as child process environment variables. It must not put secret values into prompts, instructions, logs intended for users, or WeCom replies.

Kiro authentication is not an API key flow. Operators authenticate with `kiro-cli login` on the machine that owns the runtime, then mount the required Kiro auth/config directory read-only into Docker. If Docker runs on a remote host, that remote host must receive the auth/config files; a local login on a different machine is not enough.

## Shared Knowledge

Memory service configuration lives in `workspace/private/.env` and is read into `runtime.env`. The model sees retrieved memory snippets, not raw memory env values.

Shared generated documents may be saved to `documents.shared_dir`, for example `/shared/docs`. Reject shared document paths that point into `workspace/private`, `workspace/cli-home`, Kiro auth mounts, or symlinks resolving to those locations.

## Redaction

Before sending any text to WeCom:

- Replace exact values loaded from `.env` with `[REDACTED]`.
- Redact common key/value patterns such as `SECRET=...`, `TOKEN=...`, `API_KEY=...`, `sk-...`, bearer tokens, and long high-entropy strings.
- Refuse direct user requests to show secrets, private config, raw env, or raw private history.
- If a streamed chunk looks like it contains a secret, do not send that chunk; write a private log entry instead.

## CLI Boundary

The worker talks to `kiro-cli`, not model APIs. Do not implement OpenAI, Anthropic, Kimi, Kiro, or other model API clients in the worker. Future providers require explicit adapter, auth, runtime-check, and redaction work before being documented as supported.

## Git Hygiene

Generate `.env.example`, not real `.env` values. Ensure `.gitignore` excludes:

```text
bots/*/workspace/private/.env
bots/*/workspace/private/history/
bots/*/workspace/private/logs/
bots/*/workspace/cli-home/
```
