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

Stop before creating project files if Docker is missing, the daemon is not running, the current user cannot access the daemon, or no Compose command is available for a Compose workflow.

## Base Runtime

Require Node.js 22 or newer in Docker/Linux and macOS local development.

For Docker-mode work, default to Docker-owned files and separate host, image, and container ownership:

- Host-owned: build context files and operator-provided Kiro auth/config source directory.
- Image-owned: project source, bot scaffold files, Node runtime, npm dependencies, WeCom SDK, `kiro-cli`, runtime tools, and compiled app code.
- Container/volume-owned: mutable runtime state, real `.env`, admin state, history, logs, CLI home/cache, workspace changes, shared docs, and the running bot process.

Do not install runtime dependencies on the host for Docker-owned work. Do not bind mount the bot workspace from the host by default. If the user wants local files as the source of truth, switch to host-local mode.

Default Docker base image:

```dockerfile
FROM node:22-bookworm-slim
```

The image needs `curl` and certificates for the Kiro installer:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

Install project dependencies in Dockerfile or inside the container:

```bash
npm install
```

In Docker mode, do not run host-local `npm install` just to validate a Docker bot.

## Kiro CLI Installation

Current runtime support is Kiro-only.

Default Docker/Linux install command:

```bash
curl -fsSL https://cli.kiro.dev/install | bash
```

This installs to `~/.local/bin/kiro-cli`. Add `/root/.local/bin` to Docker `PATH`:

```dockerfile
ENV PATH="/root/.local/bin:${PATH}"
ARG INSTALL_KIRO_CLI="curl -fsSL https://cli.kiro.dev/install | bash"
RUN if [ -n "$INSTALL_KIRO_CLI" ]; then sh -lc "$INSTALL_KIRO_CLI"; fi
```

The template Dockerfile may default `INSTALL_KIRO_CLI` to empty for scaffold-only validation. A real runnable image must build with the install arg set.

## Kiro Host Auth

Kiro authentication requires `kiro-cli login`, which opens a browser. For Docker or headless environments:

1. Install `kiro-cli` and complete `kiro-cli login` on a machine with browser access.
2. If Docker runs on a remote host, copy the required Kiro auth/config directory to that remote Docker host.
3. Set `KIRO_HOST_AUTH_DIR` on the Docker host to that directory.
4. Mount it read-only into the container, usually at `/host/kiro-auth`.
5. Keep container runtime state in `KIRO_HOME=./bots/<bot-name>/workspace/cli-home/kiro`.

Do not bake Kiro auth/config into the image. Do not mount host `kiro-cli` binaries into the container. Do not print auth paths or list auth directory contents in user-facing output.

## Runtime Check

After installing dependencies and Kiro CLI, run:

```bash
./scripts/check-runtime.sh <bot-name>
npm run typecheck
```

`check-runtime.sh` must:

- accept only `provider: kiro-cli`;
- verify the configured command exists;
- run `kiro-cli --version` without masking failure;
- check configured host auth directory existence without printing contents;
- avoid printing secret values.

## Docker Verification

Compose syntax:

```bash
docker compose config
```

Template build without Kiro CLI installation:

```bash
docker compose build --build-arg INSTALL_KIRO_CLI= <service>
```

Real runnable image:

```bash
docker compose build <service>
docker compose images <service>
docker run --rm --entrypoint sh <image-name> -c 'command -v kiro-cli && kiro-cli --version'
docker run --rm --entrypoint ./scripts/check-runtime.sh <image-name> <bot-name>
```

Prefer `docker run` against the built image for verification so the check cannot accidentally rebuild with different build args. Override `ENTRYPOINT` because the template's default entrypoint runs the bot process. Use `sh -c`, not `sh -lc`, because login shells may reset `PATH`. Do not append `|| true`; missing Kiro commands must fail visibly.

Long-running deployment:

```bash
docker compose up -d <service>
docker compose ps
```

Do not claim the Docker bot is complete until Kiro CLI exists in the runtime, WeCom credentials exist, host Kiro auth is mounted, and `check-runtime.sh` passes or you report the exact blocker.

## Admin Claim Check

After deployment files exist, generate the first admin claim code:

```bash
npm run admin:claim -- --bot <bot-name>
```

The first Enterprise WeChat user who sends the matching `/claim_admin <code>` becomes administrator and initialization starts immediately. Use `--reset` only when intentionally restarting the claim flow.
