# Bot Capability Install Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bot-private skill/mcp installation trustworthy without affecting host `kiro-cli` login state: add form validation, `installing/installed/failed` states, and force natural-language skill queries to return only bot-private registered capabilities.

**Architecture:** Keep the current host runtime model unchanged. Strengthen the `control-api -> capability-runner -> data-service` install path so status transitions are explicit and durable, and tighten `bot-host` capability query routing so free-form “what skills do you have” requests resolve to bot-private summaries instead of model improvisation.

**Tech Stack:** TypeScript, Vitest, Node.js fetch/http, existing control-api/data-service/capability-runner/bot-host services

---

## File Map

- Modify: `services/control-api/src/server.ts`
  - Add server-rendered validation feedback and install-state UX in the bot capability page
- Modify: `services/control-api/src/server.test.ts`
  - Verify capability page UI and form submission behavior
- Modify: `services/capability-runner/src/server.ts`
  - Keep accepted/result response model stable for install state transitions
- Modify: `services/capability-runner/src/executor.ts`
  - Write `installing`, then `installed`/`failed`, including error summaries
- Modify: `services/capability-runner/src/server.test.ts`
  - Verify dispatch result behavior stays stable
- Modify: `services/data-service/src/server.ts`
  - Persist skill/mcp status transitions and expose error fields in existing list responses
- Modify: `services/data-service/src/server.test.ts`
  - Verify create/update status transitions and failed records
- Modify: `services/bot-host/src/messageHandler.ts`
  - Route natural-language skill/mcp summary prompts to structured bot-private summaries
- Modify: `services/bot-host/src/server.test.ts`
  - Verify free-form skill questions no longer fall through to LLM behavior

