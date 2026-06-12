# Runtime Installation

Use this reference when generating or modifying the bot project environment.

## Docker Preflight

When the user asks to create or run a bot in Docker, check the environment before scaffolding:

```bash
pwd
docker --version
docker compose version
docker info
```

If `docker compose version` is unavailable, try:

```bash
docker-compose --version
```

Stop before creating project files if:

- Docker is not installed.
- Docker daemon/Desktop is not running.
- The current user cannot access the Docker daemon.
- No Compose command is available and the requested workflow depends on Compose.

Only after preflight passes should the agent create or update a Docker build context, Docker image, container, or the user-specified target path.

## Base Runtime

Require Node.js 22 or newer in Docker/Linux and macOS local development.

For Docker-mode work, default to Docker-owned files and separate host, image, and container ownership:

- Host-owned: temporary build context files, source templates, and optional user-provided input files for `docker build` or `docker cp`.
- Image-owned: project source, Compose files when needed, bot scaffold files, default workspace files, Node runtime, npm dependencies, `@wecom/aibot-node-sdk`, provider CLIs, runtime tools, and compiled app code.
- Container-owned: mutable runtime state, real `.env`, history, logs, CLI home/cache, workspace changes, the running bot process, and command execution.

Do not install runtime dependencies on the host for Docker-mode work. Do not bind mount the bot workspace from the host by default. If the user wants local files as the source of truth, switch to host-local mode.

Default Docker base image:

```dockerfile
FROM node:22-bookworm-slim
```

When using installer scripts such as Kimi Code's `curl ... | bash`, ensure the Docker image has `curl` available. If the base image does not include it, add:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

Install project dependencies:

```bash
npm install
```

In Docker mode, run this from the Dockerfile or inside the container. Do not run host-local `npm install` just to validate a Docker bot.

Verify:

```bash
npm run typecheck
```

In Docker mode, prefer Docker build or container execution for this verification.

## WeCom SDK

The template depends on:

```bash
npm install @wecom/aibot-node-sdk
```

The package is already listed in `package.json`.

## CLI Installation Defaults

Install the selected CLI inside the Docker image by default. Do not install these CLIs globally on the host unless the user explicitly asks. Do not mount host CLI binaries into the container unless the user explicitly asks.

### Codex CLI

Default npm install command:

```bash
npm install -g @openai/codex
```

Default command:

```bash
codex
```

Use a bot-specific home when supported:

```yaml
cli:
  env:
    CODEX_HOME: "./bots/<bot-name>/workspace/cli-home/codex"
```

### Claude Code

Default npm install command:

```bash
npm install -g @anthropic-ai/claude-code
```

Default command:

```bash
claude
```

Use a bot-specific home/config directory only if the installed Claude Code version supports it. If not, isolate by container and environment variables.

### Kimi Code

Default Docker/Linux install command:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

Default command:

```bash
kimi
```

Keep the Docker base image on Node 22.19 or newer for compatibility with Kimi Code's Node distribution.

Docker build arg:

```dockerfile
ENV PATH="/root/.kimi-code/bin:${PATH}"
ARG INSTALL_KIMI_CODE="curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
RUN if [ -n "$INSTALL_KIMI_CODE" ]; then sh -lc "$INSTALL_KIMI_CODE"; fi
```

Kimi Code currently installs to `/root/.kimi-code/bin/kimi` in Docker/Linux. Add that directory to Dockerfile `PATH`; the installer may add it only to `/root/.bashrc`, which is not enough for non-interactive container commands.

When creating a Kimi bot, use this default and do not ask the user for the install command unless they want a different distribution.

### Kiro CLI

Default Docker/Linux install command (macOS and Linux):

```bash
curl -fsSL https://cli.kiro.dev/install | bash
```

This installs to `~/.local/bin/kiro-cli`. For Docker images based on Debian/Ubuntu, you can also use the zip method for aarch64:

```bash
curl --proto '=https' --tlsv1.2 -sSf 'https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-aarch64-linux.zip' -o 'kirocli.zip' \
  && unzip kirocli.zip && ./kirocli/install.sh && rm -rf kirocli kirocli.zip
```

For x86_64:

```bash
curl --proto '=https' --tlsv1.2 -sSf 'https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-x86_64-linux.zip' -o 'kirocli.zip' \
  && unzip kirocli.zip && ./kirocli/install.sh && rm -rf kirocli kirocli.zip
```

Default command:

```bash
kiro-cli
```

Docker build arg:

```dockerfile
ENV PATH="/root/.local/bin:${PATH}"
ARG INSTALL_KIRO_CLI="curl -fsSL https://cli.kiro.dev/install | bash"
RUN if [ -n "$INSTALL_KIRO_CLI" ]; then sh -lc "$INSTALL_KIRO_CLI"; fi
```

Kiro CLI installs to `/root/.local/bin/kiro-cli` in Docker/Linux. Add that directory to Dockerfile `PATH`; the installer may add it only to shell profile files which are not sourced in non-interactive container commands.

Authentication requires `kiro-cli login` which opens a browser. For headless/Docker environments, authenticate on a machine with a browser and copy the credential files to the container's cli-home directory.

## Verification

After installing dependencies and the selected CLI, run:

```bash
./scripts/check-runtime.sh <bot-name>
npm run typecheck
```

If `check-runtime.sh` reports a missing CLI command, update the Dockerfile install section or the bot's `cli.command`.

When the user selected a provider CLI and expects a usable Docker bot, a scaffold-only build is not enough. Build with the provider install arg and verify the CLI command inside Docker before completion:

```bash
docker compose build --build-arg INSTALL_KIMI_CODE='curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash' <service>
docker compose images <service>
docker run --rm --entrypoint sh <image-name> -c 'command -v kimi && kimi --version'
docker run --rm --entrypoint ./scripts/check-runtime.sh <image-name> <bot-name>
```

Use the matching install arg and command for the selected provider. Prefer `docker run` against the built image for verification so the check cannot accidentally rebuild with default empty install args. Override `ENTRYPOINT` because the template's default entrypoint runs the bot process. Use `sh -c`, not `sh -lc`, because login shells may reset `PATH` and hide Dockerfile `ENV PATH` entries. Do not append `|| true`; missing CLI commands must fail visibly. Do not run multiple checks for the same Compose project/service in parallel. Do not claim the Docker bot is complete until the provider CLI command is present, or report the exact install failure.

## Docker Verification Without Installing CLIs

When validating the template itself, it is acceptable to skip real CLI installation by clearing install build args:

```bash
docker build \
  --build-arg INSTALL_CODEX_CLI= \
  --build-arg INSTALL_CLAUDE_CODE= \
  --build-arg INSTALL_KIMI_CODE= \
  --build-arg INSTALL_KIRO_CLI= \
  -t wecom-cli-bots-template-check .
```

This verifies the Node.js project build and WeCom SDK integration without installing provider CLIs. A real bot image should set the install arg for the selected CLI.
