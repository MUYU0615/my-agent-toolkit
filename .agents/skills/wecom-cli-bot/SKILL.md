---
name: wecom-cli-bot
description: Use when creating or extending an Enterprise WeChat smart bot bridge that receives WeCom long-connection messages and runs Kiro CLI or Claude Code through the managed runtime, with Docker, admin claiming, shared memory, workspace isolation, and secret redaction.
---

# WeCom CLI Bot

Use this skill to scaffold or modify a `./wecom-cli-bots` project that bridges WeCom intelligent bot messages to a CLI runtime. The managed WebUI platform supports Kiro CLI and Claude Code; the standalone scaffold wizard remains Kiro CLI by default.

## Skill Interaction Rule

This skill contains its own productized bot-creation wizard. When the user invokes this skill to create or add a bot, do not switch into generic brainstorming, design-doc, or broad creative-discovery workflows just because the bot has a specific role such as market analysis, QA, code review, or operations.

Use the wizard below instead:

- Ask only the next missing operational question.
- Prefer defaults when the user already gave enough information.
- Do not create `docs/specs` design documents.
- Do not require a separate implementation plan before scaffolding.
- After required inputs are collected, create or update the project directly.
- Use other skills only when the user explicitly asks for that skill or the task involves a separate artifact type that cannot be handled here.

## Current Support

- Managed platform CLI providers: `kiro-cli` and `claude-code`.
- Standalone scaffold provider: `kiro-cli`.
- Default command: `kiro-cli`.
- Default args: `["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]`.
- Default deployment: Docker Compose, with Kiro auth/config mounted read-only from the Docker host.
- Future providers may be added through the adapter/auth strategy, but do not present Codex, Kimi Code, or custom CLI as currently supported choices.

## Bot Creation Wizard

Guide the user step by step. Ask one question at a time when information is missing. Do not ask for values that can safely default.

Required inputs:

1. Bot name.
2. Bot role and output goal, for example "market analysis", "QA regression planning", or "code review".
3. Deployment mode: Docker-owned or host-local. If the user says "in Docker", default to Docker-owned. If the user says "on this machine/local", default to host-local.
4. Target location. Docker-owned default: create or use a Docker build context and keep mutable runtime files in the container/volumes. Host-local default: create/use `./wecom-cli-bots` under the current working directory or requested root.
5. WeCom credential handling. Default: generate placeholders in `workspace/private/.env.example`. Do not ask for secret values in chat.
6. Kiro auth location. For Docker-owned mode, the Docker host must have a Kiro auth/config directory copied from a logged-in `kiro-cli` environment and mounted read-only. For host-local mode, the same machine running the bot must have `kiro-cli` installed and logged in.

Optional inputs with defaults:

- Session idle TTL. Default: 3 hours.
- Stop keyword. Default: `/stop`.
- Workspace files seed. Default: empty `workspace/files`.
- Shared memory namespace. Default: `MEMORY_NAMESPACE=shared`.
- Shared document directory. Docker default: `/shared/docs`.
- Bot "skills" or specialties. If the user only gives a role, infer conservative specialties and write them into `soul.md`.

### Wizard Output

For each bot, create or update:

- `bots/<bot-name>/workspace/private/.env.example`
- `bots/<bot-name>/workspace/private/bot.config.yaml`
- `bots/<bot-name>/workspace/private/soul.md`
- `bots/<bot-name>/workspace/instructions/AGENTS.md`
- `bots/<bot-name>/workspace/instructions/KIRO.md`
- `docker-compose.yml` service for the bot with `restart: unless-stopped`
- Dockerfile Kiro install arg `INSTALL_KIRO_CLI`
- `shared-docs` volume when shared documents are enabled

For a role like market analysis, the generated `soul.md` should explicitly cover target market definition, competitor monitoring, trend synthesis, customer segmentation, channel analysis, pricing/positioning, evidence quality, assumptions, and concise executive summaries.

## Admin Claim Flow

Every deployed bot starts unclaimed. Before initialization, it must be claimed by a WeCom user:

```bash
npm run admin:claim -- --bot <bot-name>
```

The CLI prints:

```text
/claim_admin <code>
```

The deployer sends that exact command to the bot from Enterprise WeChat. If the code matches, that WeCom `userId` becomes administrator and initialization starts immediately. A separate `/init` is not needed for first setup.

If the claim must be restarted:

```bash
npm run admin:claim -- --bot <bot-name> --reset
```

Only this deployment-side CLI should generate claim codes or reset the administrator claim flow. Real admin state is stored in `workspace/private/admin.json`; never include it in prompts, docs, logs intended for users, or WeCom replies.

Administrator-only operations include initialization/reinitialization, soul updates, skill management, and admin transfer. Admin transfer uses `/transfer_admin <userId>`, `/accept_admin`, and `/cancel_transfer_admin`.

## Kiro Host Auth

Kiro authentication is achieved on the host that owns the Docker runtime, not inside a chat and not by giving API keys to the model.

Docker-owned runtime:

1. Install `kiro-cli` and complete `kiro-cli login` on a machine with browser access.
2. Copy the required Kiro auth/config directory to the Docker host when the Docker host is a remote machine.
3. Set `KIRO_HOST_AUTH_DIR` on the Docker host to that copied directory.
4. Compose mounts it read-only at `/host/kiro-auth`.
5. The container uses `KIRO_HOME` under the bot workspace for runtime state.

If the bot runs on a remote Docker host, that remote host must have the Kiro auth/config available. A local laptop login does not help a different remote Docker host unless the required auth/config files are copied there.

Do not mount host `kiro-cli` binaries into the container. Install Kiro CLI in the image with `INSTALL_KIRO_CLI` and verify it in the container.

## Shared Knowledge

Memory service is shared by namespace. Use a shared namespace when multiple bots should cooperate through the same long-term knowledge base:

```env
MEMORY_API_URL=http://memory-service:8100
MEMORY_NAMESPACE=shared
```

The bot reads these values from `workspace/private/.env` through `runtime.env`. The model does not receive the raw `.env` values.

Raw generated documents can also be shared through the configured documents directory:

```yaml
documents:
  shared_dir: /shared/docs
```

Docker Compose should mount a named `shared-docs` volume at `/shared/docs`. Do not point shared docs at Kiro auth, `workspace/private`, or `workspace/cli-home`.

## Existing Project or Existing Bot

When the target project or `bots/<bot-name>` already exists, treat the task as an idempotent reconcile, not a fresh scaffold.

Before editing, inspect:

```bash
rg --files <target-project>
find <target-project>/bots/<bot-name> -maxdepth 5 -type f -print
find <target-project>/bots/<bot-name> -maxdepth 5 -type d -print
```

Then compare the existing bot against the Wizard Output list and only create or update missing or inconsistent pieces. Preserve user-created files, real `.env` values, history, logs, CLI home directories, admin state, and shared documents. If the bot already exists and satisfies the checklist, do not rewrite it just to match formatting.

For an existing bot, explicitly check:

- `workspace/private/.env.example` exists and contains placeholders only.
- `workspace/private/bot.config.yaml` uses `provider: kiro-cli`, command `kiro-cli`, Kiro chat args, `KIRO_HOME`, optional `KIRO_HOST_AUTH_DIR`, memory config, and documents config.
- `workspace/private/soul.md` covers the requested role and output goal.
- `workspace/instructions/AGENTS.md` states the CLI may work only in `workspace/files/` and must not access `private/`, `cli-home/`, Kiro auth mounts, or admin state.
- `workspace/instructions/KIRO.md` exists.
- `workspace/files/`, `workspace/private/history/`, `workspace/private/logs/`, and `workspace/cli-home/kiro/` exist.
- `.gitignore` excludes private env, history, logs, and CLI home.
- `docker-compose.yml` has the intended service with `restart: unless-stopped`, `command: ["--bot", "<bot-name>"]`, read-only Kiro host auth mount, and optional `shared-docs` volume.

## Docker Mode Preflight

When the user says to create, run, or test the bot in Docker, use Docker-owned mode by default. Do not create a host-local project as the runtime home. First run preflight checks and report any blocker:

```bash
pwd
docker --version
docker compose version
docker info
```

If `docker compose version` fails, try `docker-compose --version` and note which command is available. If Docker is missing, Docker Desktop/daemon is not running, or the user lacks permission to access the daemon, stop and ask the user to fix the environment before scaffolding.

Docker-owned mode separates ownership clearly:

- Host-owned: temporary build context files, source templates, and operator-provided Kiro auth/config source directory.
- Image-owned: project source, bot scaffold files, Node runtime, npm dependencies, WeCom SDK, `kiro-cli`, runtime tools, and compiled app code.
- Container/volume-owned: mutable runtime state, real `.env`, history, logs, CLI home/cache, workspace changes, shared docs, and the running bot process.

Do not bind mount the bot workspace from the host in Docker-owned mode unless the user explicitly asks for host persistence. If the user wants local files as the source of truth, switch to host-local mode and say so.

## Docker Verification Levels

Use the narrowest verification that matches the user's request and the current state.

1. Compose syntax:

```bash
docker compose config
```

2. Template build without Kiro CLI installation. Use this for scaffold correctness, TypeScript build, package install, and Dockerfile basics:

```bash
docker compose build --build-arg INSTALL_KIRO_CLI= <service>
```

3. Real runnable image. Use this when the user wants deployment or runtime validation:

```bash
docker compose build <service>
docker compose images <service>
docker run --rm --entrypoint sh <image-name> -c 'command -v kiro-cli && kiro-cli --version'
docker run --rm --entrypoint ./scripts/check-runtime.sh <image-name> <bot-name>
```

Do not append `|| true` to Kiro verification commands. A missing CLI must fail visibly. Use `sh -c`, not `sh -lc`, because login shells may reset `PATH`.

4. Long-running deployment:

```bash
docker compose up -d <service>
docker compose ps
```

If only a template build was performed with Kiro CLI installation disabled, say that clearly. Do not imply the bot is runnable until WeCom credentials, Kiro CLI, and Kiro host auth are present and verified in the runtime.

## Delivery Checklist

Before saying the bot is ready, report:

- Target path.
- Bot name and Compose service name.
- CLI command and whether `kiro-cli` is installed in the verified image/runtime.
- Evidence used to verify Kiro, such as `check-runtime.sh` or `command -v kiro-cli` output.
- Whether a real `workspace/private/.env` exists. Do not print its contents.
- Whether admin claim code has been generated and whether the bot has been claimed.
- Where Kiro host auth/config is mounted. Do not list contents.
- Shared memory namespace and shared docs path, if enabled.
- Files created or reconciled.
- Verification commands run and their result.
- Whether the container was started.
- Exact next command for the user, if credentials, Kiro auth, or admin claim are still pending.

## Default Architecture

Use Node.js + TypeScript with `@wecom/aibot-node-sdk`. Default to Docker/Linux deployment while keeping macOS local development support. Run one OS process per bot.

Expected project layout:

```text
wecom-cli-bots/
  Dockerfile
  docker-compose.yml
  package.json
  tsconfig.json
  scripts/
    admin-claim.ts
    check-runtime.sh
  src/
  bots/
    <bot-name>/
      workspace/
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
  supervisor/
    systemd/
    launchd/
```

## Workflow

1. Read `references/architecture.md` before creating or changing the scaffold.
2. Read `references/security.md` before handling workspace, env, auth, logging, or response streaming.
3. Read `references/cli-adapters.md` before changing Kiro invocation behavior.
4. Read `references/wecom-smart-bot.md` before implementing or updating WeCom long-connection logic.
5. Read `references/runtime-installation.md` before editing Dockerfile, runtime checks, or Kiro install/auth instructions.
6. If Docker mode is requested, complete Docker Mode Preflight before creating or editing the Docker build context or target container.
7. Determine deployment mode: Docker-owned or host-local.
8. For Docker-owned mode, prepare a build context, copy `assets/wecom-cli-bots-template/` into that context if needed, customize files there, build the image, and copy runtime-only files into the container with `docker cp` when needed.
9. For host-local mode, copy or reconcile `assets/wecom-cli-bots-template/` under `./wecom-cli-bots` or the requested root.
10. For an existing project or bot, run the Existing Project or Existing Bot reconciliation checklist instead of overwriting files.
11. Customize `bot.config.yaml`, `soul.md`, and `instructions/AGENTS.md` for each bot.
12. Keep all real secrets out of images and generated markdown instructions. In Docker-owned mode, inject `.env` into the specific runtime container/volume or use Docker secrets/env injection. In host-local mode, keep real secrets in `workspace/private/.env`.
13. Run `npm run admin:claim -- --bot <bot-name>` and instruct the admin to send `/claim_admin <code>` in WeCom.
14. Verify with Docker whenever possible using Docker Verification Levels. Do not install npm dependencies, WeCom SDK packages, or `kiro-cli` on the host for Docker-owned work except when preparing host auth with `kiro-cli login`.
15. Finish with the Delivery Checklist.

## Non-Negotiable Runtime Rules

- Treat `workspace/private/` as worker-only.
- Treat `workspace/private/admin.json` as governance state; never prompt it into the model or send it to WeCom.
- Treat `workspace/cli-home/` and Kiro host auth mounts as credential/config storage. Do not include their contents in prompts or WeCom replies.
- Run Kiro with current working directory `workspace/files/`, except initialization may run in the workspace to generate controlled config document blocks.
- Pass only sanitized prompt context to Kiro: user message, safe session summary, `soul.md`, allowed instructions, and retrieved memory snippets.
- Store JSONL history under `workspace/private/history/<user-id>/<session-id>.jsonl`.
- Isolate sessions by bot and WeCom user.
- Reuse a session while the same user keeps sending messages within the configured TTL.
- Stream CLI output back to WeCom as it arrives, after redaction.
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

Do not mount host CLI binaries into Docker. Install `kiro-cli` in the image and mount only the host Kiro auth/config directory read-only.
