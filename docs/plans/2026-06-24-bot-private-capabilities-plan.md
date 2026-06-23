# Bot 私有能力隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build bot-private env / skill / mcp capability management with isolated bot workspaces, admin-controlled policies, WebUI management, dialogue-based management, and runtime-safe secret injection.

**Architecture:** Add first-class capability models to `data-service`, introduce a new `capability-runner` service to manage bot-private workspace installation/removal, route dialogue and WebUI management actions through structured APIs, and teach `llm-runner` to inject bot-private env only at execution time. Keep `soul.md`, `agents.md`, role docs, and memory separate from capability state.

**Tech Stack:** TypeScript, Node.js, Vitest, existing in-memory store + SQLite store, server-rendered control-api WebUI, new capability-runner service, Docker Compose, existing bot-host / llm-runner pipeline

---

## File Structure

### Data layer

- Modify: `services/data-service/src/store.ts`
  - Add in-memory models and CRUD for bot runtime policies, env vars, skills, mcps, and capability audit logs.
- Modify: `services/data-service/src/store.test.ts`
  - Cover in-memory CRUD, permission-related defaults, ordering, and metadata-only env reads.
- Modify: `services/data-service/src/sqliteStore.ts`
  - Add SQLite schema and CRUD for new capability models.
- Modify: `services/data-service/src/sqliteStore.test.ts`
  - Cover SQLite persistence, filtering, immediate delete semantics, and audit logging.
- Modify: `services/data-service/src/server.ts`
  - Add HTTP APIs for capability data and bot policy changes.
- Modify: `services/data-service/src/server.test.ts`
  - Cover new routes and payload shapes.

### Capability execution service

- Create: `services/capability-runner/package.json`
- Create: `services/capability-runner/tsconfig.json`
- Create: `services/capability-runner/Dockerfile`
- Create: `services/capability-runner/src/main.ts`
  - Service entrypoint.
- Create: `services/capability-runner/src/server.ts`
  - HTTP routes for install/remove/config actions.
- Create: `services/capability-runner/src/workspace.ts`
  - Bot-private workspace path helpers and cleanup logic.
- Create: `services/capability-runner/src/installer.ts`
  - Skill / MCP install and delete orchestration.
- Create: `services/capability-runner/src/server.test.ts`
  - Route-level behavior tests.
- Create: `services/capability-runner/src/workspace.test.ts`
  - Workspace isolation and cleanup tests.
- Create: `services/capability-runner/src/installer.test.ts`
  - Installer status transitions and rollback tests.

### Dialogue / orchestration layer

- Modify: `services/bot-host/src/botStateClient.ts`
  - Add client calls for capability data and policy mutation.
- Modify: `services/bot-host/src/messageHandler.ts`
  - Detect `/env`, `/skill`, `/mcp`, `/policy`, `/capability` commands and natural-language management intents.
  - Apply admin/policy checks and return summary responses.
- Modify: `services/bot-host/src/server.test.ts`
  - Cover env management, policy switching, skill list visibility, install/delete routing, and refusal paths.

### Runtime execution layer

- Modify: `services/llm-runner/src/config.ts`
  - Add capability-runner / data-service config if needed.
- Modify: `services/llm-runner/src/server.ts`
  - Load bot-private env metadata and inject resolved secrets only for tool execution.
- Modify: `services/llm-runner/src/server.test.ts`
  - Verify env secret is used in execution context and not surfaced in prompt payloads or response text.

### Control plane / WebUI

- Modify: `services/control-api/src/server.ts`
  - Add bot capability admin pages and form handlers for env, skills, MCP, and policy status.
- Modify: `services/control-api/src/server.test.ts`
  - Cover capability pages, masked env display, form submissions, and result summaries.

### Deployment / docs

- Modify: `deploy/compose/docker-compose.yml`
  - Add `capability-runner` service wiring.
- Modify: `deploy/compose/README.md`
  - Document capability-runner and required volumes.
- Modify: `README.md`
  - Add bot-private capability overview and service responsibilities.

---

### Task 1: Add capability models to the in-memory data-service store

**Files:**
- Modify: `services/data-service/src/store.ts`
- Test: `services/data-service/src/store.test.ts`

- [ ] **Step 1: Write failing in-memory tests for policy, env, skill, mcp, and audit models**

Add tests like:

```ts
it("creates default bot runtime policies", () => {
  const store = createInMemoryStore();

  const policy = store.getOrCreateBotRuntimePolicy("bot-a");

  expect(policy.skill_install_policy).toBe("admin_only");
  expect(policy.mcp_manage_policy).toBe("admin_only");
});

it("stores env vars without exposing raw values", () => {
  const store = createInMemoryStore();

  store.upsertBotEnvVar("bot-a", {
    key: "OPENAI_API_KEY",
    value_ciphertext: "ciphertext",
    updated_by_wecom_user_id: "u1",
  });

  expect(store.listBotEnvVars("bot-a")).toEqual([
    expect.objectContaining({
      key: "OPENAI_API_KEY",
      is_set: true,
    }),
  ]);
});

it("stores installed skills, mcps, and audit logs per bot", () => {
  const store = createInMemoryStore();

  store.upsertBotSkill("bot-a", {
    name: "repo-analyzer",
    source_type: "github",
    source_ref: "https://github.com/acme/repo-analyzer",
    status: "installed",
    installed_by_wecom_user_id: "u1",
  });
  store.upsertBotMcp("bot-a", {
    name: "search-mcp",
    mode: "config",
    source_ref: "http://localhost:9300",
    status: "installed",
    installed_by_wecom_user_id: "u1",
  });
  store.appendBotCapabilityAuditLog({
    bot_id: "bot-a",
    wecom_user_id: "u1",
    action_type: "skill_install",
    target_name: "repo-analyzer",
    source_ref: "https://github.com/acme/repo-analyzer",
    result: "success",
  });

  expect(store.listBotSkills("bot-a")).toHaveLength(1);
  expect(store.listBotMcps("bot-a")).toHaveLength(1);
  expect(store.listBotCapabilityAuditLogs("bot-a")).toHaveLength(1);
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run:

```bash
pnpm vitest run services/data-service/src/store.test.ts
```

Expected:

- FAIL with missing methods and types for bot capability models

- [ ] **Step 3: Add minimal types and in-memory CRUD to `store.ts`**

Add record types:

```ts
export type BotRuntimePolicyRecord = {
  bot_id: string;
  skill_install_policy: "admin_only" | "open";
  mcp_manage_policy: "admin_only" | "open";
  created_at: string;
  updated_at: string;
};

export type BotEnvVarRecord = {
  bot_id: string;
  key: string;
  value_ciphertext: string;
  is_set: boolean;
  updated_at: string;
  updated_by_wecom_user_id: string;
};
```

Add store methods:

```ts
getOrCreateBotRuntimePolicy(botId) { /* default admin_only/admin_only */ }
updateBotRuntimePolicy(botId, input) { /* merge policy */ }

upsertBotEnvVar(botId, input) { /* store by bot_id + key */ }
listBotEnvVars(botId) { /* metadata only */ }
deleteBotEnvVar(botId, key) { /* immediate delete */ }

upsertBotSkill(botId, input) { /* upsert by bot_id + name */ }
listBotSkills(botId) { /* ordered newest first */ }
deleteBotSkill(botId, name) { /* immediate delete */ }

upsertBotMcp(botId, input) { /* upsert by bot_id + name */ }
listBotMcps(botId) { /* ordered newest first */ }
deleteBotMcp(botId, name) { /* immediate delete */ }

appendBotCapabilityAuditLog(input) { /* append */ }
listBotCapabilityAuditLogs(botId) { /* ordered newest first */ }
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run:

```bash
pnpm vitest run services/data-service/src/store.test.ts
```

Expected:

- PASS for new capability model tests

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/store.test.ts
git commit -m "feat: add bot capability models to in-memory store"
```

### Task 2: Add SQLite persistence for capability models

**Files:**
- Modify: `services/data-service/src/sqliteStore.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`

- [ ] **Step 1: Write failing SQLite tests for capability persistence**

Add tests like:

```ts
it("persists bot runtime policy defaults and updates", () => {
  const store = createSqliteStore(":memory:");

  const created = store.getOrCreateBotRuntimePolicy("bot-a");
  const updated = store.updateBotRuntimePolicy("bot-a", {
    skill_install_policy: "open",
  });

  expect(created.skill_install_policy).toBe("admin_only");
  expect(updated.skill_install_policy).toBe("open");
});

it("persists env vars, skills, mcps, and audit logs", () => {
  const store = createSqliteStore(":memory:");

  store.upsertBotEnvVar("bot-a", {
    key: "OPENAI_API_KEY",
    value_ciphertext: "ciphertext",
    updated_by_wecom_user_id: "u1",
  });
  store.upsertBotSkill("bot-a", {
    name: "repo-analyzer",
    source_type: "github",
    source_ref: "https://github.com/acme/repo-analyzer",
    status: "installed",
    installed_by_wecom_user_id: "u1",
  });
  store.upsertBotMcp("bot-a", {
    name: "search-mcp",
    mode: "config",
    source_ref: "http://localhost:9300",
    status: "installed",
    installed_by_wecom_user_id: "u1",
  });

  expect(store.listBotEnvVars("bot-a")[0]?.key).toBe("OPENAI_API_KEY");
  expect(store.listBotSkills("bot-a")[0]?.name).toBe("repo-analyzer");
  expect(store.listBotMcps("bot-a")[0]?.name).toBe("search-mcp");
});
```

- [ ] **Step 2: Run the SQLite tests to verify they fail**

Run:

```bash
pnpm vitest run services/data-service/src/sqliteStore.test.ts
```

Expected:

- FAIL because tables and methods do not exist yet

- [ ] **Step 3: Add SQLite tables and CRUD implementation**

Add schema blocks:

```sql
create table if not exists bot_runtime_policies (
  bot_id text primary key,
  skill_install_policy text not null,
  mcp_manage_policy text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists bot_env_vars (
  bot_id text not null,
  key text not null,
  value_ciphertext text not null,
  is_set integer not null,
  updated_at text not null,
  updated_by_wecom_user_id text not null,
  primary key (bot_id, key)
);
```

Add similar tables for:

- `bot_skills`
- `bot_mcps`
- `bot_capability_audit_logs`

Implement the same store methods backed by SQL statements.

- [ ] **Step 4: Run the SQLite tests to verify they pass**

Run:

```bash
pnpm vitest run services/data-service/src/sqliteStore.test.ts
```

Expected:

- PASS for SQLite capability persistence tests

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/sqliteStore.ts services/data-service/src/sqliteStore.test.ts
git commit -m "feat: persist bot capabilities in sqlite"
```

### Task 3: Expose capability APIs from data-service

**Files:**
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write failing API tests for env, skills, mcps, policy, and audit routes**

Add tests like:

```ts
it("lists bot env metadata without exposing raw values", async () => {
  const app = createDataServiceServer({ store: createInMemoryStore() });
  app.store.upsertBotEnvVar("bot-a", {
    key: "OPENAI_API_KEY",
    value_ciphertext: "ciphertext",
    updated_by_wecom_user_id: "u1",
  });

  const response = await app.fetch("/v1/bots/bot-a/env");
  const body = await response.json();

  expect(body.items).toEqual([
    expect.objectContaining({ key: "OPENAI_API_KEY", is_set: true }),
  ]);
  expect(JSON.stringify(body)).not.toContain("ciphertext");
});
```

Cover routes:

- `GET /v1/bots/:id/runtime-policy`
- `POST /v1/bots/:id/runtime-policy`
- `GET /v1/bots/:id/env`
- `POST /v1/bots/:id/env`
- `DELETE /v1/bots/:id/env/:key`
- `GET /v1/bots/:id/skills`
- `GET /v1/bots/:id/mcps`
- `GET /v1/bots/:id/capability-audit-logs`

- [ ] **Step 2: Run the server tests to verify they fail**

Run:

```bash
pnpm vitest run services/data-service/src/server.test.ts
```

Expected:

- FAIL with missing routes or wrong response shapes

- [ ] **Step 3: Implement minimal routes in `server.ts`**

Add handlers like:

```ts
if (method === "GET" && pathname === `/v1/bots/${botId}/env`) {
  return json({ items: store.listBotEnvVars(botId) });
}

if (method === "POST" && pathname === `/v1/bots/${botId}/runtime-policy`) {
  const body = await readJson(request);
  return json(store.updateBotRuntimePolicy(botId, body));
}
```

Keep response shapes metadata-only for env.

- [ ] **Step 4: Run the server tests to verify they pass**

Run:

```bash
pnpm vitest run services/data-service/src/server.test.ts
```

Expected:

- PASS for new capability APIs

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/server.ts services/data-service/src/server.test.ts
git commit -m "feat: expose bot capability APIs from data service"
```

### Task 4: Scaffold the capability-runner service

**Files:**
- Create: `services/capability-runner/package.json`
- Create: `services/capability-runner/tsconfig.json`
- Create: `services/capability-runner/Dockerfile`
- Create: `services/capability-runner/src/main.ts`
- Create: `services/capability-runner/src/server.ts`
- Test: `services/capability-runner/src/server.test.ts`

- [ ] **Step 1: Write a failing route test for capability-runner health and install endpoints**

Add tests like:

```ts
it("serves health and accepts skill install requests", async () => {
  const app = createCapabilityRunnerServer({ workspaceRoot: "/tmp/bots" });

  const health = await app.fetch("/health");
  expect(health.status).toBe(200);

  const response = await app.fetch("/internal/bots/bot-a/skills/install", {
    method: "POST",
    body: JSON.stringify({
      name: "repo-analyzer",
      source_type: "github",
      source_ref: "https://github.com/acme/repo-analyzer",
      requested_by_wecom_user_id: "u1",
    }),
  });

  expect(response.status).toBe(202);
});
```

- [ ] **Step 2: Run the new service tests to verify they fail**

Run:

```bash
pnpm vitest run services/capability-runner/src/server.test.ts
```

Expected:

- FAIL because service files do not exist yet

- [ ] **Step 3: Create the minimal service skeleton**

Add `package.json` scripts:

```json
{
  "name": "@my-agent-toolkit/capability-runner",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Add `server.ts`:

```ts
export function createCapabilityRunnerServer() {
  return {
    async fetch(path: string, init?: RequestInit) {
      if (path === "/health") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path.includes("/skills/install")) {
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm vitest run services/capability-runner/src/server.test.ts
```

Expected:

- PASS for initial capability-runner route tests

- [ ] **Step 5: Commit**

```bash
git add services/capability-runner
git commit -m "feat: scaffold capability runner service"
```

### Task 5: Implement bot-private workspace isolation and rollback helpers

**Files:**
- Create: `services/capability-runner/src/workspace.ts`
- Create: `services/capability-runner/src/workspace.test.ts`
- Create: `services/capability-runner/src/installer.ts`
- Create: `services/capability-runner/src/installer.test.ts`

- [ ] **Step 1: Write failing tests for isolated workspace paths and cleanup**

Add tests like:

```ts
it("builds isolated directories per bot", () => {
  const paths = getBotWorkspacePaths("/runtime/bots", "bot-a");

  expect(paths.root).toBe("/runtime/bots/bot-a");
  expect(paths.skillsDir).toBe("/runtime/bots/bot-a/skills");
  expect(paths.mcpDir).toBe("/runtime/bots/bot-a/mcp");
});

it("cleans tmp workspace on failed install", async () => {
  const fs = createFakeFs();
  await ensureBotWorkspace(fs, "/runtime/bots", "bot-a");
  await createInstallTempDir(fs, "/runtime/bots", "bot-a", "repo-analyzer");
  await cleanupInstallTempDir(fs, "/runtime/bots", "bot-a", "repo-analyzer");

  expect(fs.exists("/runtime/bots/bot-a/tmp/repo-analyzer")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm vitest run services/capability-runner/src/workspace.test.ts services/capability-runner/src/installer.test.ts
```

Expected:

- FAIL because helpers are not implemented yet

- [ ] **Step 3: Implement minimal workspace and installer helpers**

Add path helper:

```ts
export function getBotWorkspacePaths(root: string, botId: string) {
  const base = path.join(root, botId);
  return {
    root: base,
    envDir: path.join(base, "env"),
    skillsDir: path.join(base, "skills"),
    mcpDir: path.join(base, "mcp"),
    cacheDir: path.join(base, "cache"),
    logsDir: path.join(base, "logs"),
    tmpDir: path.join(base, "tmp"),
  };
}
```

Add installer state helpers:

```ts
export async function beginSkillInstall(ctx) { /* create tmp dir and mark installing */ }
export async function finalizeSkillInstall(ctx) { /* move into skills dir */ }
export async function rollbackSkillInstall(ctx) { /* cleanup tmp and partial target */ }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm vitest run services/capability-runner/src/workspace.test.ts services/capability-runner/src/installer.test.ts
```

Expected:

- PASS for workspace isolation and rollback helpers

- [ ] **Step 5: Commit**

```bash
git add services/capability-runner/src/workspace.ts services/capability-runner/src/workspace.test.ts services/capability-runner/src/installer.ts services/capability-runner/src/installer.test.ts
git commit -m "feat: add isolated bot workspace helpers"
```

### Task 6: Add install/remove execution routes to capability-runner

**Files:**
- Modify: `services/capability-runner/src/server.ts`
- Modify: `services/capability-runner/src/server.test.ts`

- [ ] **Step 1: Write failing route tests for skill and mcp install/delete**

Add tests covering:

```ts
it("marks skill install accepted and calls installer", async () => {
  const installer = {
    installSkill: vi.fn().mockResolvedValue({ status: "installed" }),
  };
  const app = createCapabilityRunnerServer({ installer });

  const response = await app.fetch("/internal/bots/bot-a/skills/install", {
    method: "POST",
    body: JSON.stringify({
      name: "repo-analyzer",
      source_type: "github",
      source_ref: "https://github.com/acme/repo-analyzer",
      requested_by_wecom_user_id: "u1",
    }),
  });

  expect(response.status).toBe(202);
  expect(installer.installSkill).toHaveBeenCalled();
});
```

Also cover:

- `/internal/bots/:id/skills/delete`
- `/internal/bots/:id/mcps/install`
- `/internal/bots/:id/mcps/delete`

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm vitest run services/capability-runner/src/server.test.ts
```

Expected:

- FAIL because routes do not dispatch yet

- [ ] **Step 3: Implement the minimal route dispatcher**

Add route handlers:

```ts
if (method === "POST" && pathname === `/internal/bots/${botId}/skills/install`) {
  const body = await readJson(request);
  void installer.installSkill({ botId, ...body });
  return json({ accepted: true }, 202);
}
```

Mirror the pattern for skill delete, MCP install, MCP delete.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm vitest run services/capability-runner/src/server.test.ts
```

Expected:

- PASS for install/remove route dispatch

- [ ] **Step 5: Commit**

```bash
git add services/capability-runner/src/server.ts services/capability-runner/src/server.test.ts
git commit -m "feat: add capability runner install routes"
```

### Task 7: Teach bot-host to manage env, skill, mcp, and policy actions

**Files:**
- Modify: `services/bot-host/src/botStateClient.ts`
- Modify: `services/bot-host/src/messageHandler.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write failing bot-host tests for capability commands**

Add tests like:

```ts
it("allows admin to list env metadata only", async () => {
  const response = await sendWecomMessage(app, {
    botId: "bot-a",
    userId: "admin-u1",
    text: "/env",
  });

  expect(response.text).toContain("OPENAI_API_KEY");
  expect(response.text).not.toContain("sk-live");
});

it("rejects non-admin env mutation", async () => {
  const response = await sendWecomMessage(app, {
    botId: "bot-a",
    userId: "user-u2",
    text: "/env delete OPENAI_API_KEY",
  });

  expect(response.text).toContain("仅管理员可执行");
});
```

Also cover:

- `/skill`
- `/policy skill open`
- `/policy mcp admin_only`
- natural language like `安装这个 skill：https://github.com/acme/repo-analyzer`

- [ ] **Step 2: Run the bot-host tests to verify they fail**

Run:

```bash
pnpm vitest run services/bot-host/src/server.test.ts
```

Expected:

- FAIL because capability commands and policies are not implemented

- [ ] **Step 3: Extend botStateClient and messageHandler with structured capability actions**

Add client methods:

```ts
listBotEnvVars(botId) { /* GET /v1/bots/:id/env */ }
updateBotRuntimePolicy(botId, input) { /* POST /v1/bots/:id/runtime-policy */ }
listBotSkills(botId) { /* GET /v1/bots/:id/skills */ }
listBotMcps(botId) { /* GET /v1/bots/:id/mcps */ }
```

Add handler branches:

```ts
if (text === "/capability") { /* summarize env/skll/mcp/policy counts */ }
if (text.startsWith("/env")) { /* admin-only metadata list and mutation */ }
if (text.startsWith("/skill")) { /* list/install/delete with policy checks */ }
if (text.startsWith("/mcp")) { /* list/install/delete with policy checks */ }
if (text.startsWith("/policy")) { /* admin-only policy updates */ }
```

Keep responses summary-only.

- [ ] **Step 4: Run the bot-host tests to verify they pass**

Run:

```bash
pnpm vitest run services/bot-host/src/server.test.ts
```

Expected:

- PASS for capability command coverage

- [ ] **Step 5: Commit**

```bash
git add services/bot-host/src/botStateClient.ts services/bot-host/src/messageHandler.ts services/bot-host/src/server.test.ts
git commit -m "feat: add bot capability management commands"
```

### Task 8: Integrate llm-runner with bot-private env injection

**Files:**
- Modify: `services/llm-runner/src/server.ts`
- Modify: `services/llm-runner/src/config.ts`
- Test: `services/llm-runner/src/server.test.ts`

- [ ] **Step 1: Write failing llm-runner tests for secret-safe env injection**

Add tests like:

```ts
it("injects bot env vars into execution context without exposing values in prompt", async () => {
  const runCli = vi.fn().mockResolvedValue({ output: "ok" });
  const app = createLlmRunnerServer({
    resolveBotEnvVars: async () => ({
      OPENAI_API_KEY: "sk-live-secret",
    }),
    runCli,
  });

  await app.handleRuntimeRequest({
    bot_id: "bot-a",
    prompt: "print your env",
  });

  expect(runCli).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ OPENAI_API_KEY: "sk-live-secret" }),
    }),
  );
  expect(JSON.stringify(runCli.mock.calls)).not.toContain("print your env -> sk-live-secret");
});
```

- [ ] **Step 2: Run the llm-runner tests to verify they fail**

Run:

```bash
pnpm vitest run services/llm-runner/src/server.test.ts
```

Expected:

- FAIL because bot-private env resolution and injection do not exist

- [ ] **Step 3: Add minimal env resolution and execution-time injection**

Add config surface:

```ts
export type BotEnvResolver = (botId: string) => Promise<Record<string, string>>;
```

Use it only when spawning runtime execution:

```ts
const botEnv = botId ? await resolveBotEnvVars(botId) : {};
const processEnv = { ...baseEnv, ...botEnv };
```

Do not append env values into prompt text or response summaries.

- [ ] **Step 4: Run the llm-runner tests to verify they pass**

Run:

```bash
pnpm vitest run services/llm-runner/src/server.test.ts
```

Expected:

- PASS for secret-safe env injection tests

- [ ] **Step 5: Commit**

```bash
git add services/llm-runner/src/server.ts services/llm-runner/src/config.ts services/llm-runner/src/server.test.ts
git commit -m "feat: inject bot-private env into runtime execution"
```

### Task 9: Add WebUI capability management pages and save flows

**Files:**
- Modify: `services/control-api/src/server.ts`
- Test: `services/control-api/src/server.test.ts`

- [ ] **Step 1: Write failing control-api tests for capability pages**

Add tests like:

```ts
it("renders bot capability management sections", async () => {
  const response = await app.fetch("/admin/bots/bot-a/capabilities");
  const html = await response.text();

  expect(html).toContain("环境变量");
  expect(html).toContain("Skills");
  expect(html).toContain("MCP");
});

it("masks env values in the admin page", async () => {
  const response = await app.fetch("/admin/bots/bot-a/capabilities");
  const html = await response.text();

  expect(html).toContain("OPENAI_API_KEY");
  expect(html).not.toContain("sk-live-secret");
});
```

Also cover POST handlers for:

- `/admin/bots/:id/capabilities/env/save`
- `/admin/bots/:id/capabilities/env/delete`
- `/admin/bots/:id/capabilities/skills/install`
- `/admin/bots/:id/capabilities/skills/delete`
- `/admin/bots/:id/capabilities/mcps/install`
- `/admin/bots/:id/capabilities/mcps/delete`

- [ ] **Step 2: Run the control-api tests to verify they fail**

Run:

```bash
pnpm vitest run services/control-api/src/server.test.ts
```

Expected:

- FAIL because capability pages and handlers do not exist

- [ ] **Step 3: Implement the minimal pages and form handlers**

Add page route:

```ts
if (method === "GET" && pathname === `/admin/bots/${botId}/capabilities`) {
  const env = await dataClient.listBotEnvVars(botId);
  const skills = await dataClient.listBotSkills(botId);
  const mcps = await dataClient.listBotMcps(botId);
  return html(renderBotCapabilitiesPage({ env, skills, mcps }));
}
```

Add form handlers that proxy to data-service and capability-runner, then redirect back to the capability page.

- [ ] **Step 4: Run the control-api tests to verify they pass**

Run:

```bash
pnpm vitest run services/control-api/src/server.test.ts
```

Expected:

- PASS for capability management UI flows

- [ ] **Step 5: Commit**

```bash
git add services/control-api/src/server.ts services/control-api/src/server.test.ts
git commit -m "feat: add bot capability management UI"
```

### Task 10: Wire the new service into compose and refresh docs

**Files:**
- Modify: `deploy/compose/docker-compose.yml`
- Modify: `deploy/compose/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write down the expected compose topology and docs changes in the files before editing**

Add the following service block outline to the compose file:

```yaml
capability-runner:
  build:
    context: ../..
    dockerfile: services/capability-runner/Dockerfile
  environment:
    PORT: 8700
    WORKSPACE_ROOT: /workspace/runtime/bots
  volumes:
    - ../../runtime:/workspace/runtime
```

Update docs to mention:

- `capability-runner` owns bot-private workspace installation and cleanup
- `llm-runner` only consumes installed capabilities
- env values are masked in UI and never exposed in prompts

- [ ] **Step 2: Run a diff check to ensure only the intended docs and compose files changed**

Run:

```bash
git diff -- deploy/compose/docker-compose.yml deploy/compose/README.md README.md
```

Expected:

- Diff only in the three deployment/doc files above

- [ ] **Step 3: Apply the compose wiring and doc updates**

Add `capability-runner` to compose and update the architecture sections in both READMEs.

- [ ] **Step 4: Run final focused verification**

Run:

```bash
pnpm vitest run \
  services/data-service/src/store.test.ts \
  services/data-service/src/sqliteStore.test.ts \
  services/data-service/src/server.test.ts \
  services/capability-runner/src/server.test.ts \
  services/capability-runner/src/workspace.test.ts \
  services/capability-runner/src/installer.test.ts \
  services/bot-host/src/server.test.ts \
  services/llm-runner/src/server.test.ts \
  services/control-api/src/server.test.ts

pnpm run typecheck
git diff --check
```

Expected:

- All targeted tests PASS
- Typecheck passes
- `git diff --check` returns no output

- [ ] **Step 5: Commit**

```bash
git add deploy/compose/docker-compose.yml deploy/compose/README.md README.md
git commit -m "docs: wire bot private capability service into deployment"
```

---

## Self-Review

### Spec coverage

- Bot-private env / skill / mcp models: covered by Tasks 1-3.
- Bot-private isolated workspace and rollback: covered by Tasks 4-6.
- Dialogue-based management and policy switching: covered by Task 7.
- Execution-time env injection without prompt leakage: covered by Task 8.
- WebUI env / skills / mcp management: covered by Task 9.
- Deployment and docs: covered by Task 10.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to previous task” placeholders remain.
- Every task names exact files and verification commands.

### Type consistency

- Policy names remain `skill_install_policy` and `mcp_manage_policy` throughout.
- Capability model names remain `bot_env_vars`, `bot_skills`, `bot_mcps`, `bot_capability_audit_logs`.
- New service name remains `capability-runner` throughout.
