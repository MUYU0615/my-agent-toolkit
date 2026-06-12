FROM node:22-bookworm-slim

WORKDIR /app

ENV PATH="/root/.kimi-code/bin:/root/.local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Install required local CLIs here. Keep credentials in each bot workspace/private/.env.
# Codex CLI. Set to "npm install -g @openai/codex" when building a Codex bot image.
ARG INSTALL_CODEX_CLI=""
RUN if [ -n "$INSTALL_CODEX_CLI" ]; then sh -lc "$INSTALL_CODEX_CLI"; fi
#
# Claude Code. Set to "npm install -g @anthropic-ai/claude-code" when building a Claude Code bot image.
ARG INSTALL_CLAUDE_CODE=""
RUN if [ -n "$INSTALL_CLAUDE_CODE" ]; then sh -lc "$INSTALL_CLAUDE_CODE"; fi
#
# Kimi Code. Set to "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" when building a Kimi bot image.
ARG INSTALL_KIMI_CODE=""
RUN if [ -n "$INSTALL_KIMI_CODE" ]; then sh -lc "$INSTALL_KIMI_CODE"; fi
#
# Kiro CLI. Set to "curl -fsSL https://cli.kiro.dev/install | bash" when building a Kiro bot image.
# Installs to /root/.local/bin/kiro-cli by default.
ARG INSTALL_KIRO_CLI=""
RUN if [ -n "$INSTALL_KIRO_CLI" ]; then sh -lc "$INSTALL_KIRO_CLI"; fi

COPY . .
RUN npm run build

ENTRYPOINT ["node", "dist/main.js"]
