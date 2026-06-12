---
name: wecom-cli-bot
description: Create or extend a WeCom/Enterprise WeChat smart bot bridge that uses the official intelligent bot long connection to receive messages and invoke local AI coding CLIs such as Codex CLI, Claude Code, Kimi Code, Kiro CLI, or a custom CLI. Use when the user asks to build an Enterprise WeChat bot, connect WeCom to a CLI, scaffold a persistent multi-bot worker, manage bot-specific workspaces/souls/history, stream CLI output back to WeCom, or enforce CLI workspace isolation and secret redaction.
---

# WeCom CLI Bot

Use this skill to scaffold or modify a `./wecom-cli-bots` project that bridges WeCom intelligent bot messages to local CLI tools. The generated project must treat each bot as an isolated worker with its own workspace, private config, soul, history, and CLI process.

## Skill Interaction Rule

This skill contains its own productized bot-creation wizard. When the user invokes this skill to create or add a bot, do not switch into generic brainstorming, design-doc, or broad creative-discovery workflows just because the bot has a specific role such as market analysis, QA, code review, or operations.

Use the wizard below instead:

- Ask only the next missing operational question.
- Prefer defaults when the user already gave enough information.
- Do not create `docs/specs` design documents.
- Do not require a separate implementation plan before scaffolding.
- After required inputs are collected, create or update the project directly.
- Use other skills only when the user explicitly asks for that skill or the task involves a separate artifact type that cannot be handled here.

## Bot Creation Wizard

Guide the user step by step. Ask one question at a time when information is missing. Do not ask for values that can safely default.

Required inputs:

1. Bot name.
2. CLI provider: `codex`, `claude-code`, `kimi-code`, `kiro`, or `custom`.
3. Bot role and output goal, for example "market analysis", "QA regression planning", or "code review".
4. Deployment mode: Docker-owned or host-local. If the user says "in Docker", default to Docker-owned. If the user says "on this machine/local", default to host-local.
5. Target location. Docker-owned default: create a temporary build context, build an image, and copy/generated files into the image or container. Host-local default: create/use a `./wecom-cli-bots` directory under the current working directory or user-requested root.
6. WeCom credential handling. Default: generate placeholders in `workspace/private/.env.example`. For Docker-owned mode, copy a real `.env` into the container only from a local file path the user provides; do not paste secrets in chat and do not bake real secrets into reusable images. For host-local mode, ask the user to fill `workspace/private/.env` under the host-local project directory.
7. CLI install source. Use built-in defaults for `codex`, `claude-code`, and `kimi-code`. Kimi Code default install command is `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`. For `kiro`, ask for the official Docker install command unless already known in the project.

For `kimi-code`, use Kimi Code CLI mode: `kimi -p "{{prompt}}" --output-format text`, `input_mode: arg`, `KIMI_CODE_HOME` under `workspace/cli-home/kimi`, and runtime `kimi login`. Do not use a Kimi/OpenAI-compatible API provider unless the user explicitly asks for API mode. See `references/cli-adapters.md`.

Optional inputs with defaults:

- CLI command. Defaults: `codex` for Codex CLI, `claude` for Claude Code, `kimi` for Kimi Code. For Kiro, ask if unknown.
- CLI args. Default: none. For Kimi Code default to `["-p", "{{prompt}}", "--output-format", "text"]` and never combine `--auto` with `-p`.
- Session idle TTL. Default: 3 hours.
- Stop keyword. Default: `停止`.
- Workspace files seed. Default: empty `workspace/files`.
- Docker persistence. Default: Docker Compose service with `restart: unless-stopped` and Docker-owned files. Do not bind mount bot workspace in Docker-owned mode unless the user explicitly asks for host persistence.
- Bot "skills" or specialties. If the user only gives a role, infer conservative specialties and write them into `soul.md`.

Do not ask for secret values in chat unless the user explicitly wants to paste them. Prefer generating `workspace/private/.env.example`. In Docker-owned mode, ask for a local `.env` file path only when credentials must be copied into a running container.

### Wizard Output

For each bot, create or update:

- `bots/<bot-name>/workspace/private/.env.example`
- `bots/<bot-name>/workspace/private/bot.config.yaml`
- `bots/<bot-name>/workspace/private/soul.md`
- `bots/<bot-name>/workspace/instructions/AGENTS.md`
- provider-specific instruction file such as `KIMI.md`
- `docker-compose.yml` service for the bot. In Docker-owned mode, do not mount `bots/<bot-name>/workspace` from the host by default.
- Docker build args or comments needed to install the selected CLI

For a role like market analysis, the generated `soul.md` should explicitly cover: target market definition, competitor monitoring, trend synthesis, customer segmentation, channel analysis, pricing/positioning, evidence quality, assumptions, and concise executive summaries.

### Existing Project or Existing Bot

When the target project or `bots/<bot-name>` already exists, treat the task as an idempotent reconcile, not a fresh scaffold.

Before editing, inspect:

```bash
rg --files <target-project>
find <target-project>/bots/<bot-name> -maxdepth 5 -type f -print
find <target-project>/bots/<bot-name> -maxdepth 5 -type d -print
```

Then compare the existing bot against the Wizard Output list and only create or update missing or inconsistent pieces. Preserve user-created files, real `.env` values, history, logs, and CLI home directories. If the bot already exists and satisfies the checklist, do not rewrite it just to match formatting.

For an existing bot, explicitly check:

- `workspace/private/.env.example` exists and contains placeholders only.
- `workspace/private/bot.config.yaml` matches the requested provider, command, stop keyword, TTL, and CLI home.
- `workspace/private/soul.md` covers the requested role and output goal.
- `workspace/instructions/AGENTS.md` states the CLI may work only in `workspace/files/` and must not access `private/` or `cli-home/`.
- The provider-specific instruction file exists.
- `workspace/files/`, `workspace/private/history/`, `workspace/private/logs/`, and `workspace/cli-home/<provider>/` exist.
- `.gitignore` excludes private env, history, logs, and CLI home.
- `docker-compose.yml` has exactly one intended service for the bot, with `restart: unless-stopped` and `command: ["--bot", "<bot-name>"]`.
- In Docker-owned mode, `docker-compose.yml` does not bind mount the bot workspace by default. If host persistence is explicitly requested, document that exception.
- In host-local mode, bind mounts are allowed when Docker is used only as an optional runtime for a host-local project.

For Kimi Code existing bots, additionally check that `bot.config.yaml` uses `input_mode: arg`, `prompt_placeholder: "{{prompt}}"`, `KIMI_CODE_HOME`, and `args: ["-p", "{{prompt}}", "--output-format", "text"]`; that the runtime has completed `kimi login`; and that Kimi session ids are extracted before redaction and reused with `-r`.

## Docker Mode Preflight

When the user says to create, run, or test the bot in Docker, use Docker-owned mode by default. Do not create a host-local project as the runtime home. First run preflight checks and report any blocker.

Docker-owned mode separates ownership clearly:

- Host-owned: only temporary build context files, source templates, and optional user-provided input files used for `docker build` or `docker cp`.
- Image-owned: project source, bot scaffold files, default workspace files, Node runtime, npm dependencies, `@wecom/aibot-node-sdk`, provider CLIs, runtime tools, and compiled app code.
- Container-owned: mutable runtime state, real `.env`, history, logs, CLI home/cache, workspace changes, the running bot process, and command execution.
- Never host-installed in Docker mode: `npm install` for validation, WeCom SDK packages, or global provider CLIs such as Codex CLI, Claude Code, Kimi Code, or Kiro CLI.

Do not bind mount the bot workspace from the host in Docker-owned mode unless the user explicitly asks for host persistence. If the user wants local files as the source of truth, switch to host-local mode and say so.

Run these checks from the user's current workspace:

```bash
pwd
docker --version
docker compose version
docker info
```

If `docker compose version` fails, try `docker-compose --version` and note which command is available. If Docker is missing, Docker Desktop/daemon is not running, or the user lacks permission to access the daemon, stop and ask the user to fix the environment before scaffolding.

After Docker is confirmed, determine the target build context path:

- Docker-owned default: create or use a temporary or explicit build context, then copy files into the image/container. Do not use `./wecom-cli-bots` as the runtime home by default.
- If the user requested an explicit build context path, use that path.
- If the user requested host-local mode, create or use `./wecom-cli-bots` under the current working directory or requested root.

For Docker validation:

- Run build and verification for one Compose project/service serially. Do not start multiple `docker compose run` checks in parallel for the same project; Compose may race on network creation or image state.
- Build without installing provider CLIs when testing the scaffold itself by clearing `INSTALL_*` build args.
- If the user selected a CLI provider and asks to create a usable Docker bot, build with that provider's install arg before finishing. A scaffold-only build is allowed only when explicitly doing template/scaffold validation.
- Build with the selected provider install arg when the user asks for a real runnable image.
- After a real provider build, verify the provider CLI command exists inside the image/container. Do not mark the bot complete until this check passes or you report the concrete install failure.
- Do not install Node packages, WeCom SDK packages, or CLI tools on the host for Docker-mode work.
- Prefer `docker compose build <service>` and `docker compose up -d <service>` for real bot deployment.
- Use `docker cp` or image build context copies to move generated files into Docker-owned containers/images. Do not rely on host bind mounts unless explicitly requested.

### Docker Verification Levels

Use the narrowest verification that matches the user's request and the current state.

1. Compose syntax:

```bash
docker compose config
```

2. Template build, without provider CLI installation. Use this when validating scaffold correctness, TypeScript build, package install, and Dockerfile basics:

```bash
docker compose build \
  --build-arg INSTALL_CODEX_CLI= \
  --build-arg INSTALL_CLAUDE_CODE= \
  --build-arg INSTALL_KIMI_CODE= \
  --build-arg INSTALL_KIRO_CLI= \
  <service>
```

3. Real runnable image. Use this only when the user wants deployment or runtime validation. Keep CLI installation inside Docker:

```bash
docker compose build <service>
```

When the provider install arg is not already in `docker-compose.yml`, pass it explicitly, for example:

```bash
docker compose build --build-arg INSTALL_KIMI_CODE='curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash' <service>
```

This level is required before completion when the user has selected a provider CLI and expects a usable Docker bot.

After build, identify the produced image name before using `docker run`:

```bash
docker compose images <service>
docker image ls <expected-image-name>
```

4. Runtime check. Use after the real provider CLI has been installed in the image or runtime:

```bash
docker compose run --rm <service> ./scripts/check-runtime.sh <bot-name>
```

If the service has an `ENTRYPOINT`, override it for shell checks and script checks. Otherwise Compose may pass the shell command to the bot entrypoint instead of executing it. Prefer `docker run` against the built image for provider CLI checks because it cannot accidentally rebuild the service:

```bash
docker run --rm --entrypoint sh <image-name> -c 'command -v <cli-command> && <cli-command> --version'
docker run --rm --entrypoint ./scripts/check-runtime.sh <image-name> <bot-name>
```

If using `docker compose run`, do not pass `--build` during verification unless you also pass the provider install args; otherwise the check may rebuild with default empty install args.

Use `sh -c`, not `sh -lc`, for direct CLI checks. Login shell startup may reset `PATH` and hide Dockerfile `ENV PATH` entries such as `/root/.kimi-code/bin`.

Do not append `|| true` to provider CLI verification commands. A missing CLI must fail the verification visibly.

5. Long-running deployment:

```bash
docker compose up -d <service>
docker compose ps
```

If local `npm run typecheck` fails because `node_modules/` is absent, do not treat that as a scaffold failure and do not run host-local dependency installation for Docker-mode work. Verify through Docker build where dependencies are installed inside the image. Install host dependencies only if the user explicitly asks for local development outside Docker.

If Docker access fails because of sandbox or daemon permissions, report the blocker and retry with the platform's approved escalation mechanism when available. Do not edit files until Docker preflight has passed for Docker-mode requests.

### Delivery Checklist

Before saying the bot is ready, report the actual state, not just the intended state:

- Target path.
- Bot name and Compose service name.
- Selected provider, CLI command, and whether the provider CLI is installed in the verified image.
- Evidence used to verify the provider CLI install, such as `check-runtime.sh` or `command -v <cli-command>` output.
- Files created or reconciled.
- Verification commands run and their result.
- Whether a real `workspace/private/.env` exists. Do not print its contents.
- Where the real runtime files live: Docker image/container, Docker volume, or host-local directory.
- Whether the container was started.
- Exact next command for the user, if credentials or real CLI installation are still pending.

If only a template build was performed with provider CLI installation disabled, say that clearly. Do not imply the bot is runnable until credentials exist and the provider CLI is installed and verified in the Docker image or runtime.

### WeCom Stream Output

WeCom stream replies refresh the current content for a stream id; they are not append-only token deltas. Generated runtimes must accumulate CLI output and send accumulated current content, throttled, then send one final `finish=true` frame. See `references/wecom-smart-bot.md`.

## Default Architecture

For Docker-owned mode, create a Docker build context and put the runtime project files into the image/container. For host-local mode, create the project at `./wecom-cli-bots` under the current working directory or user-requested root.

Use Node.js + TypeScript with `@wecom/aibot-node-sdk`. Default to Docker/Linux deployment while keeping macOS local development support. Run one OS process per bot.

Expected project layout:

```text
wecom-cli-bots/
  Dockerfile
  docker-compose.yml
  package.json
  tsconfig.json
  src/
  bots/
    <bot-name>/
      workspace/
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
  supervisor/
    systemd/
    launchd/
```

## Workflow

1. Read `references/architecture.md` before creating or changing the scaffold.
2. Read `references/security.md` before handling workspace, env, logging, or response streaming.
3. Read `references/cli-adapters.md` before adding or changing CLI adapters.
4. Read `references/wecom-smart-bot.md` before implementing or updating WeCom long-connection logic.
5. Read `references/runtime-installation.md` before editing Dockerfile, runtime checks, or CLI install instructions.
6. If Docker mode is requested, complete Docker Mode Preflight before creating or editing the Docker build context or target container.
7. Determine deployment mode: Docker-owned or host-local.
8. For Docker-owned mode, prepare a build context, copy `assets/wecom-cli-bots-template/` into that context if needed, customize files there, build the image, and copy any runtime-only files into the container with `docker cp` when needed.
9. For host-local mode, copy or reconcile `assets/wecom-cli-bots-template/` under `./wecom-cli-bots` or the user-requested root.
10. For an existing project or bot, run the Existing Project or Existing Bot reconciliation checklist instead of overwriting files.
11. Customize `bots/<bot-name>/workspace/private/bot.config.yaml`, `soul.md`, and `instructions/AGENTS.md` for each bot.
12. Keep all real secrets out of images and generated markdown instructions. In Docker-owned mode, copy `.env` into the specific running container or use Docker secrets/env injection. In host-local mode, keep real secrets in `bots/<bot-name>/workspace/private/.env`.
13. Verify with Docker whenever possible using Docker Verification Levels. Do not install npm dependencies, WeCom SDK packages, Codex CLI, Claude Code, Kimi Code, or Kiro CLI on the host unless the user explicitly asks for host-local development. Keep runtime install commands in Dockerfile/build args and use `./scripts/check-runtime.sh <bot-name>` inside the target runtime when the selected CLI is installed.
14. Finish with the Delivery Checklist.

## Non-Negotiable Runtime Rules

- Treat `workspace/private/` as worker-only.
- Treat `workspace/cli-home/` as CLI-specific home/config/cache storage. It is not user-facing and must not be included in prompts or WeCom replies.
- Run the selected CLI with current working directory `workspace/files/`.
- Do not let the CLI read `workspace/private/` or raw history files.
- Pass only sanitized prompt context to the CLI: user message, safe session summary, `soul.md` intent, and allowed instructions.
- Store JSONL history under `workspace/private/history/<user-id>/<session-id>.jsonl`.
- Isolate sessions by bot and WeCom user.
- Reuse a session while the same user keeps sending messages within 3 hours; expire after 3 hours with no new message.
- On message receipt, immediately send `正在思考，发送【停止】将终止。`.
- Stream CLI output back to WeCom as it arrives.
- If the same user sends `停止` while a task is running, terminate that user's CLI child process and reply `已停止当前任务。`.
- If the same user sends another normal message while a task is running, reply `当前任务仍在运行，请发送【停止】终止后再发送新问题。`.
- Redact secrets before any text is sent to WeCom.

## WeCom Integration

Use `@wecom/aibot-node-sdk` for the WeCom long connection and streaming replies. The official long-connection document is:

`https://developer.work.weixin.qq.com/document/path/101463`

The page title is "智能机器人长连接". Because WeCom API details and SDK versions can change, verify the installed SDK types and current official fields before changing `src/wecom/wecomClient.ts`. Keep the template's WeCom client interface narrow so updated SDK or protocol details can be patched in one module.

## Deployment

Default to Docker Compose with `restart: unless-stopped`. Generate one service per bot when concrete bot names are known, or provide a parameterized service command when creating a generic scaffold.

Also include optional:

- Linux `systemd` template for non-Docker deployment.
- macOS `launchd` template for local persistent runs.

Do not mount host CLI binaries into Docker by default. Prefer installing required CLI tools in the image or leaving explicit Dockerfile installation placeholders for the user to fill.
