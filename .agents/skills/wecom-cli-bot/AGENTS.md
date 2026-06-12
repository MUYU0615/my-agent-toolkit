# WeCom CLI Bot Skill

This directory contains the project-local `wecom-cli-bot` skill. It is the only maintained copy of the skill in this repository.

## Purpose

Use this skill to create or extend `./wecom-cli-bots`, a Docker-first Enterprise WeChat/WeCom intelligent bot bridge. The generated project connects WeCom smart bot long-connection messages to local AI CLI tools such as Codex CLI, Claude Code, Kimi Code, Kiro CLI, or a custom CLI.

The skill guides the agent through a productized bot creation wizard. It should not hand off normal bot creation to broad brainstorming or design-document workflows.

## What This Skill Generates

The bundled template creates a Node.js + TypeScript worker using `@wecom/aibot-node-sdk`. Each bot runs as a separate process and owns its own workspace:

```text
bots/<bot-name>/workspace/
  private/       # worker-only: .env, config, soul, history, logs
  cli-home/      # CLI-specific home/config/cache
  instructions/  # secret-free CLI instructions
  files/         # CLI working directory
```

The generated runtime supports:

- WeCom long connection and streamed replies.
- One active task per bot/user.
- `停止` cancellation.
- 3-hour idle session TTL.
- JSONL history per user/session.
- Secret redaction before WeCom replies.
- Docker Compose persistence with one service per bot.

## Maintenance Rules

- Modify only this project-local skill path: `.agents/skills/wecom-cli-bot`.
- Do not recreate or maintain an outer `wecom-cli-bot/` copy at the repository root.
- Keep `SKILL.md` concise enough to guide the workflow; put details in `references/`.
- Keep runtime scaffold files under `assets/wecom-cli-bots-template/`.
- Do not put real WeCom Bot IDs, secrets, API keys, or user credentials anywhere in the skill.
- Keep `.env.example` placeholder-only.
- Prefer Docker-mode verification. Do not install Codex, Claude Code, Kimi Code, or Kiro CLI globally on the host unless the user explicitly asks.
- For Docker-mode creation, run Docker preflight before writing `./wecom-cli-bots`.
- If a bot or project already exists, reconcile missing pieces instead of overwriting user files.

## Important Defaults

- Default project path: `./wecom-cli-bots`.
- Default Kimi Code install command: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`.
- Default Kimi command: `kimi`.
- Default stop keyword: `停止`.
- Default session idle TTL: 3 hours.
- Default deployment: Docker Compose with `restart: unless-stopped`.

## Validation

After editing the skill, run:

```bash
python3 /Users/dujiepeng/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/dujiepeng/Project/AI/my-agent-toolkit/.agents/skills/wecom-cli-bot
```

For template validation, copy `assets/wecom-cli-bots-template/` to a temporary directory and build through Docker with provider CLI install args cleared unless testing a real provider image.
