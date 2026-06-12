# Project Agents Guide

This repository maintains project-local agent skills.

## Current Scope

The active skill in this project is:

```text
.agents/skills/wecom-cli-bot
```

It creates or extends a Docker-first Enterprise WeChat/WeCom intelligent bot bridge. The generated bot project connects WeCom smart bot long-connection messages to local AI CLI tools such as Codex CLI, Claude Code, Kimi Code, Kiro CLI, or a custom CLI.

## Maintenance Rules

- Modify the skill only under `.agents/skills/wecom-cli-bot`.
- Do not recreate a root-level `wecom-cli-bot/` copy.
- Do not store real WeCom Bot IDs, secrets, API keys, or user credentials in this repository.
- Keep `.env.example` files placeholder-only.
- Prefer Docker-mode validation for generated bot templates.
- Do not install Codex CLI, Claude Code, Kimi Code, or Kiro CLI globally on the host unless explicitly requested.

## Validation

After changing the skill, run:

```bash
python3 /Users/dujiepeng/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/dujiepeng/Project/AI/my-agent-toolkit/.agents/skills/wecom-cli-bot
```

For template checks, copy `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/` to a temporary directory and validate through Docker. Clear provider CLI install build args when testing only the scaffold.
