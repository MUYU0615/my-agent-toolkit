# CLI Adapters

Adapters describe local CLI invocation only. They do not call model APIs.

The managed platform supports `kiro-cli` and `claude-code`. The standalone scaffold remains Kiro-only until its own provider validation and image installation flow are extended.

## Managed Claude Code Adapter

Claude Code runs on the Docker host through the existing authenticated host relay. New conversations receive an explicit UUID with `--session-id`; later turns resume the exact UUID with `--resume`. The runner uses print mode and text output:

```text
claude -p --output-format text --permission-mode bypassPermissions --setting-sources project,local --session-id <UUID>
claude -p --output-format text --permission-mode bypassPermissions --setting-sources project,local --resume <UUID>
```

The WebUI stores only `runtime: claude-code`. Workspace isolation, bot environment variables, MCP calls, cancellation, timeout rollback, and report delivery stay in the common runner path. Installed bot skills are copied to both `.kiro/skills` and `.claude/skills`.

## Current Config

```yaml
cli:
  provider: kiro-cli
  command: kiro-cli
  args: ["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]
  input_mode: arg
  prompt_placeholder: "{{prompt}}"
  stream_output: stdout
  stop_signal: SIGTERM
  kill_after_ms: 10000
  timeout_seconds: 10800
  env:
    KIRO_HOME: "./bots/<bot-name>/workspace/cli-home/kiro"
    KIRO_HOST_AUTH_DIR: "/host/kiro-auth"
```

`assertSupportedProvider()` must reject any provider other than `kiro-cli` until another adapter is implemented and tested.

## Prompt Input

Kiro uses argument mode. Build a prompt from the user message, safe session context, `soul.md`, instruction text, and memory snippets, then replace the configured `{{prompt}}` placeholder in `args`.

Never pass paths under `workspace/private`, `workspace/cli-home`, Kiro host auth mounts, or `admin.json` to Kiro.

## Streaming Output

Read stdout/stderr incrementally. Treat stderr as streamable diagnostic text only after redaction. WeCom stream replies are replace/update style, not append-only deltas, so the runtime must accumulate current content and send throttled updates.

## Stop Behavior

On the configured stop keyword, send the configured stop signal to the child process. If it does not exit within `kill_after_ms`, force kill it. Write a stopped event to history.

## Kiro CLI Runtime Rules

Kiro CLI uses the `kiro-cli chat` subcommand for non-interactive execution.

Important behavior:

- Bare `kiro-cli` without `chat` opens an interactive TUI; always use `kiro-cli chat`.
- `--no-interactive` prevents the CLI from waiting for terminal input.
- `--trust-all-tools` or `-a` allows the agent to execute tools without confirmation prompts.
- A selected session uses `--resume-id <SESSION_ID>`.
- Ongoing sessions persist the real Kiro UUID and resume only with `--resume-id <SESSION_ID>`.
- Never use bare `--resume`; it resumes the most recent session for the working directory and is not safe for multiple users or conversations.
- `kiro-cli chat --list-sessions` is used for `/history`, `/open N`, and naming helpers.
- Keep bot runtime state under `workspace/cli-home/kiro` through `KIRO_HOME`.
- Host auth/config is mounted read-only separately, usually at `/host/kiro-auth`; it is not user content and must not be inspected by the model.

## Authentication Boundary

Kiro authentication is completed outside the bot:

```bash
kiro-cli login
```

For Docker-owned deployment, complete login on a machine with browser access, copy the required Kiro auth/config directory to the Docker host if needed, set `KIRO_HOST_AUTH_DIR` on that host, and mount it read-only into the container. A login on a different laptop does not authenticate a remote Docker host unless the required auth/config files are copied to that host.

The bot should never ask the user to paste Kiro API keys or auth files in chat. The LLM receives only prompt text, not auth material.

## Future Providers

Future providers may be added by implementing a new adapter path, tests, install/auth documentation, runtime checks, and secret handling.
