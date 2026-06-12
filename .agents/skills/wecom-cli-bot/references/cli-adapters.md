# CLI Adapters

Adapters describe local CLI invocation only. They do not call model APIs.

## Common Config

```yaml
cli:
  provider: codex
  command: codex
  args: []
  input_mode: stdin
  stream_output: stdout
  stop_signal: SIGTERM
  kill_after_ms: 10000
  timeout_seconds: 10800
  env:
    CODEX_HOME: "./bots/example-bot/workspace/cli-home/codex"
```

Keep provider-specific assumptions minimal. Users can override command and args.

## Prompt Input

Default to `stdin`:

1. Build a prompt from the user message, safe session context, `soul.md`, and instruction text.
2. Write it to CLI stdin.
3. Close stdin unless the CLI requires an interactive session.

For CLIs that need arguments, support `input_mode: arg` with a prompt placeholder in `args`, for example:

```yaml
args: ["-p", "{{prompt}}", "--output-format", "text"]
input_mode: arg
prompt_placeholder: "{{prompt}}"
```

## Streaming Output

Read stdout incrementally. Treat stderr as either streamable diagnostic text or private logs depending on bot config. Always redact before sending to WeCom.

## Stop Behavior

On `停止`, send the configured stop signal to the child process. If it does not exit within `kill_after_ms`, force kill it. Write a stopped event to history.

## Provider Notes

- `codex`: default command `codex`; prefer a bot-specific `CODEX_HOME` under `workspace/cli-home/codex` when supported by the user's CLI setup.
- `claude-code`: default command `claude`; use a bot-specific home/config env under `workspace/cli-home/claude` if available in the user's environment.
- `kimi-code`: default Docker/Linux install `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`; default command `kimi`; keep Node.js `>=22.19.0`; use Kimi Code CLI login state, not a model API client.
- `kiro`: default command `kiro-cli`; install via `curl -fsSL https://cli.kiro.dev/install | bash`; binary installs to `~/.local/bin/kiro-cli`; requires authentication via `kiro-cli login`.
- `custom`: require command, args, input mode, and output mode.

Read `runtime-installation.md` before writing install commands or Docker build args.

## Kimi Code Runtime Rules

Kimi Code is a CLI integration. Do not configure the bot bridge as an OpenAI-compatible API provider unless the user explicitly rejects Kimi CLI login and asks for API mode.

Default Kimi bot config:

```yaml
cli:
  provider: kimi-code
  command: kimi
  args: ["-p", "{{prompt}}", "--output-format", "text"]
  input_mode: arg
  prompt_placeholder: "{{prompt}}"
  stream_output: stdout
  env:
    KIMI_CODE_HOME: "./bots/<bot-name>/workspace/cli-home/kimi"
```

Important behavior:

- Bare `kimi` starts an interactive TUI and can hang a bot; use `kimi -p`.
- Do not combine `--auto` with `-p`; Kimi Code rejects it.
- Authenticate in the real runtime with `KIMI_CODE_HOME=<bot-cli-home> kimi login`.
- Keep Kimi credentials, config, sessions, and logs under `workspace/cli-home/kimi` by setting `KIMI_CODE_HOME`.
- `default_thinking` in `KIMI_CODE_HOME/config.toml` controls whether thinking text appears in `kimi -p` output.
- `kimi -p` prints `To resume this session: kimi -r session_...`; parse the real session id before redaction, hide that line from WeCom, and pass `-r <session>` on later messages from the same WeCom user while the bot session TTL is active.
- Kimi session ids may be secret-like and can be redacted by generic redaction; keep raw process output internally until after session extraction.

## Kiro CLI Runtime Rules

Kiro CLI is a terminal AI agent by AWS. It uses `kiro-cli chat` subcommand for non-interactive execution.

Default Kiro bot config:

```yaml
cli:
  provider: kiro-cli
  command: kiro-cli
  args: ["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]
  input_mode: arg
  prompt_placeholder: "{{prompt}}"
  stream_output: stdout
  env:
    KIRO_HOME: "./bots/<bot-name>/workspace/cli-home/kiro"
```

Important behavior:

- Bare `kiro-cli` without `chat` subcommand opens an interactive TUI; always use `kiro-cli chat`.
- `--no-interactive` prevents the CLI from waiting for user input in the terminal.
- `--trust-all-tools` or `-a` allows the agent to execute tools without confirmation prompts.
- Session resume uses `--resume-id <SESSION_ID>` flag before the `chat` subcommand args.
- Authenticate in the real runtime with `kiro-cli login`.
- Keep Kiro config and session data under `workspace/cli-home/kiro` by setting a home directory environment variable.
- Kiro CLI outputs session IDs that can be used for `--resume-id` on subsequent messages from the same WeCom user.
- Kiro CLI session IDs are UUIDs; parse them from output before redaction.