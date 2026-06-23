# Bot API 与 WeCom Worker 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前职责混合的 bot-host 拆成 `bot-api` 与 `wecom-worker` 两个明确容器，并把初始化向导、待确认文档、runtime 配置等关键状态迁入 `data-service`。

**Architecture:** `control-api` 只调用 `bot-api`，真实企业微信长连接只由 `wecom-worker` 管理。`bot-api` 与 `wecom-worker` 不共享内存，二者通过 `data-service` 共享 bot 状态、初始化状态、待确认文档、runtime 配置，并共同调用同一套 message handler。LLM provider 差异只存在于 `llm-runner`，`wecom-worker` 不感知具体 provider。

**Tech Stack:** TypeScript, Node.js HTTP server, Docker Compose, Vitest, SQLite-backed `data-service`, existing `llm-runner`, existing WeCom long connection client.

---

## File Structure

### Data Service State

- Modify: `services/data-service/src/store.ts`
  - Add `InitializationSessionRecord`, `PendingGeneratedDocumentRecord`, `RuntimeConfigRecord`.
  - Add `DataStore` methods for create/update/get/delete/list of these records.
  - Add in-memory implementation.

- Modify: `services/data-service/src/sqliteStore.ts`
  - Add SQLite tables for persistent initialization sessions, pending generated documents, runtime configs.
  - Add SQLite implementation of the new `DataStore` methods.

- Modify: `services/data-service/src/server.ts`
  - Add internal HTTP endpoints for these states.

- Modify: `services/data-service/src/store.test.ts`
  - Test in-memory state behavior.

- Modify: `services/data-service/src/sqliteStore.test.ts`
  - Test persistence across store instances.

- Modify: `services/data-service/src/server.test.ts`
  - Test HTTP endpoints.

### Shared Bot Runtime

- Create: `services/bot-host/src/messageHandler.ts`
  - Move shared message processing out of `server.ts`.
  - Provide one `handleBotMessage()` used by both API and worker paths.

- Create: `services/bot-host/src/botStateClient.ts`
  - Wrap `data-service` calls for initialization sessions, pending generated documents, runtime config, bot config documents, memories, business documents.

- Modify: `services/bot-host/src/server.ts`
  - Keep route wiring and supervisor code.
  - Remove `wizardStatesByConfig`.
  - Remove `pendingBusinessDocumentsByConfig`.
  - Delegate message processing to `messageHandler.ts`.

- Modify: `services/bot-host/src/server.test.ts`
  - Replace memory-state tests with data-service-backed state tests.
  - Add cross-process style tests using separate `createBotHostServer()` and worker instances that share mocked data-service state.

### Split Entrypoints

- Create: `services/bot-host/src/botApiMain.ts`
  - Starts HTTP API only.
  - No WeCom supervisor.

- Create: `services/bot-host/src/wecomWorkerMain.ts`
  - Starts WeCom supervisor.
  - Provides only `/health` and `/internal/wecom-runtime/sync` if needed.

- Modify: `services/bot-host/src/main.ts`
  - Keep as compatibility entry during transition, or reduce it to a small wrapper that selects API/worker mode by `BOT_HOST_MODE`.

- Modify: `services/bot-host/Dockerfile`
  - Build both new entrypoints into `dist`.
  - Keep generic image reusable by `bot-api` and `wecom-worker`.

### Compose And Control API

- Modify: `deploy/compose/docker-compose.yml`
  - Rename `bot-host` service to `bot-api`.
  - Delete `bot-host-real`.
  - Add `wecom-worker`.
  - Point `control-api` to `BOT_HOST_URL=http://bot-api:8400`.

- Modify: `deploy/compose/README.md`
  - Document new service topology.
  - Document how to start local platform and real WeCom worker.
  - Remove `BOT_HOST_URL=http://bot-host-real:8401`.

- Modify: `services/control-api/src/server.test.ts`
  - Replace `bot-host-real` expectations with `bot-api`.

---

## Task 1: Add Initialization Session State To Data Service

**Files:**
- Modify: `services/data-service/src/store.ts`
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/store.test.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write in-memory store failing tests**

Add to `services/data-service/src/store.test.ts`:

```ts
it("upserts and clears active initialization sessions", () => {
  const store = createDataStore();
  store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" });

  const first = store.upsertInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
    phase: "soul",
    soul_answers: ["产品经理助手"],
    agents_answers: [],
    generation_in_progress: undefined,
    status: "active",
  });

  expect(first).toMatchObject({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
    phase: "soul",
    soul_answers: ["产品经理助手"],
    agents_answers: [],
    status: "active",
  });

  const second = store.upsertInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
    phase: "agents",
    soul_answers: ["产品经理助手", "冷静务实", "简洁直接"],
    agents_answers: ["撰写/维护 PRD"],
    generation_in_progress: "agents",
    status: "active",
  });

  expect(second.session_id).toBe(first.session_id);
  expect(store.getActiveInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
  })).toMatchObject({
    session_id: first.session_id,
    phase: "agents",
    agents_answers: ["撰写/维护 PRD"],
    generation_in_progress: "agents",
  });

  store.clearInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
  });

  expect(store.getActiveInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
  })).toBeUndefined();
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- services/data-service/src/store.test.ts -t "upserts and clears active initialization sessions"
```

Expected: FAIL because `upsertInitializationSession`, `getActiveInitializationSession`, and `clearInitializationSession` are not defined.

- [ ] **Step 3: Add store types and in-memory implementation**

In `services/data-service/src/store.ts`, add:

```ts
export type InitializationPhase = "soul" | "agents";
export type InitializationSessionStatus = "active" | "completed" | "cancelled";
export type InitializationGenerationInProgress = "soul" | "agents";

export interface InitializationSessionRecord {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: InitializationPhase;
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: InitializationGenerationInProgress;
  status: InitializationSessionStatus;
  created_at: string;
  updated_at: string;
}

export interface UpsertInitializationSessionInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: InitializationPhase;
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: InitializationGenerationInProgress;
  status: InitializationSessionStatus;
}

export interface InitializationSessionKeyInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}
```

Add methods to `DataStore`:

```ts
upsertInitializationSession(
  input: UpsertInitializationSessionInput,
): InitializationSessionRecord;
getActiveInitializationSession(
  input: InitializationSessionKeyInput,
): InitializationSessionRecord | undefined;
clearInitializationSession(input: InitializationSessionKeyInput): void;
```

In `createDataStore()`, add:

```ts
const initializationSessions = new Map<string, InitializationSessionRecord>();
```

Add helper near existing helper functions:

```ts
function initializationSessionKey(input: InitializationSessionKeyInput): string {
  return [
    requireText(input.bot_id, "bot_id"),
    requireText(input.wecom_user_id, "wecom_user_id"),
    requireText(input.conversation_id, "conversation_id"),
  ].join(":");
}
```

Add implementation inside returned store object:

```ts
upsertInitializationSession(input) {
  getRequiredBot(bots, input.bot_id);
  const key = initializationSessionKey(input);
  const existing = initializationSessions.get(key);
  const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
  const record: InitializationSessionRecord = {
    session_id: existing?.session_id ?? `init_${crypto.randomUUID()}`,
    bot_id: requireText(input.bot_id, "bot_id"),
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    conversation_id: requireText(input.conversation_id, "conversation_id"),
    phase: input.phase,
    soul_answers: [...input.soul_answers],
    agents_answers: [...input.agents_answers],
    ...(input.generation_in_progress
      ? { generation_in_progress: input.generation_in_progress }
      : {}),
    status: input.status,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  initializationSessions.set(key, record);
  return record;
},

getActiveInitializationSession(input) {
  const record = initializationSessions.get(initializationSessionKey(input));
  return record?.status === "active" ? record : undefined;
},

clearInitializationSession(input) {
  initializationSessions.delete(initializationSessionKey(input));
},
```

- [ ] **Step 4: Run in-memory store test**

Run:

```bash
npm test -- services/data-service/src/store.test.ts -t "upserts and clears active initialization sessions"
```

Expected: PASS.

- [ ] **Step 5: Add SQLite persistence failing test**

Add to `services/data-service/src/sqliteStore.test.ts`:

```ts
it("persists active initialization sessions across store instances", () => {
  const dbPath = makeTempDbPath();
  const first = createSqliteDataStore({ dbPath });
  first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" });
  const saved = first.upsertInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
    phase: "agents",
    soul_answers: ["产品经理助手", "冷静务实", "简洁直接"],
    agents_answers: ["撰写/维护 PRD"],
    generation_in_progress: undefined,
    status: "active",
  });
  first.close?.();

  const second = createSqliteDataStore({ dbPath });
  expect(second.getActiveInitializationSession({
    bot_id: "prd-bot",
    wecom_user_id: "admin-a",
    conversation_id: "conv-init",
  })).toMatchObject({
    session_id: saved.session_id,
    phase: "agents",
    soul_answers: ["产品经理助手", "冷静务实", "简洁直接"],
    agents_answers: ["撰写/维护 PRD"],
    status: "active",
  });
  second.close?.();
});
```

- [ ] **Step 6: Run SQLite failing test**

Run:

```bash
npm test -- services/data-service/src/sqliteStore.test.ts -t "persists active initialization sessions"
```

Expected: FAIL because the SQLite store does not create or query initialization session rows.

- [ ] **Step 7: Implement SQLite table and methods**

In `services/data-service/src/sqliteStore.ts`, add table creation in the schema setup:

```sql
create table if not exists initialization_sessions (
  session_key text primary key,
  session_id text not null,
  bot_id text not null,
  wecom_user_id text not null,
  conversation_id text not null,
  phase text not null,
  soul_answers_json text not null,
  agents_answers_json text not null,
  generation_in_progress text,
  status text not null,
  created_at text not null,
  updated_at text not null
)
```

Add the same three `DataStore` methods using an upsert statement shaped as `insert into initialization_sessions (...) values (...) on conflict(session_key) do update set phase = excluded.phase, soul_answers_json = excluded.soul_answers_json, agents_answers_json = excluded.agents_answers_json, generation_in_progress = excluded.generation_in_progress, status = excluded.status, updated_at = excluded.updated_at`. Serialize answers using `JSON.stringify()` and parse them using `JSON.parse()` into `string[]`.

- [ ] **Step 8: Run SQLite test**

Run:

```bash
npm test -- services/data-service/src/sqliteStore.test.ts -t "persists active initialization sessions"
```

Expected: PASS.

- [ ] **Step 9: Add HTTP endpoint failing test**

Add to `services/data-service/src/server.test.ts`:

```ts
it("stores initialization sessions over HTTP", async () => {
  const store = createDataStore();
  const server = createDataServiceServer(store);
  await server.fetch(new Request("http://localhost/v1/bots", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" }),
  }));

  const save = await server.fetch(new Request("http://localhost/internal/initialization-sessions", {
    method: "PUT",
    body: JSON.stringify({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "soul",
      soul_answers: ["产品经理助手"],
      agents_answers: [],
      status: "active",
    }),
  }));

  expect(save.status).toBe(200);

  const get = await server.fetch(
    new Request("http://localhost/internal/initialization-sessions/active?bot_id=prd-bot&wecom_user_id=admin-a&conversation_id=conv-init"),
  );
  await expect(get.json()).resolves.toMatchObject({
    bot_id: "prd-bot",
    phase: "soul",
    soul_answers: ["产品经理助手"],
  });

  const clear = await server.fetch(new Request("http://localhost/internal/initialization-sessions/active?bot_id=prd-bot&wecom_user_id=admin-a&conversation_id=conv-init", {
    method: "DELETE",
  }));
  expect(clear.status).toBe(200);
});
```

- [ ] **Step 10: Run HTTP failing test**

Run:

```bash
npm test -- services/data-service/src/server.test.ts -t "stores initialization sessions over HTTP"
```

Expected: FAIL with 404.

- [ ] **Step 11: Implement HTTP routes**

In `services/data-service/src/server.ts`, add routes:

```ts
if (request.method === "PUT" && url.pathname === "/internal/initialization-sessions") {
  return handleUpsertInitializationSession(request, store);
}

if (request.method === "GET" && url.pathname === "/internal/initialization-sessions/active") {
  return handleGetActiveInitializationSession(url, store);
}

if (request.method === "DELETE" && url.pathname === "/internal/initialization-sessions/active") {
  return handleClearInitializationSession(url, store);
}
```

Add handlers that read required `bot_id`, `wecom_user_id`, and `conversation_id` from query params for GET/DELETE and delegate to the new store methods. Return `{ cleared: true }` for DELETE.

- [ ] **Step 12: Run data-service tests**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/sqliteStore.ts services/data-service/src/server.ts services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
git commit -m "Persist initialization sessions in data service"
```

---

## Task 2: Add Pending Generated Document State To Data Service

**Files:**
- Modify: `services/data-service/src/store.ts`
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/store.test.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write failing in-memory test**

Add to `services/data-service/src/store.test.ts`:

```ts
it("stores and confirms pending generated documents", () => {
  const store = createDataStore();
  store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" });

  const pending = store.createPendingGeneratedDocument({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
    title: "prd/asr-api.md",
    content: "# ASR PRD",
    created_by_bot_id: "prd-bot",
    created_by_user_id: "user-a",
  });

  expect(store.listPendingGeneratedDocuments({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
  })).toEqual([pending]);

  const confirmed = store.confirmPendingGeneratedDocuments({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
  });

  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]).toMatchObject({
    pending_id: pending.pending_id,
    status: "confirmed",
  });
  expect(store.listPendingGeneratedDocuments({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
  })).toEqual([]);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test -- services/data-service/src/store.test.ts -t "stores and confirms pending generated documents"
```

Expected: FAIL because pending generated document methods do not exist.

- [ ] **Step 3: Implement store types and in-memory methods**

Add to `services/data-service/src/store.ts`:

```ts
export type PendingGeneratedDocumentStatus = "pending" | "confirmed" | "cancelled";

export interface PendingGeneratedDocumentRecord {
  pending_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  status: PendingGeneratedDocumentStatus;
  created_by_bot_id: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePendingGeneratedDocumentInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  created_by_bot_id: string;
  created_by_user_id: string;
}

export interface PendingGeneratedDocumentQuery {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}
```

Add `DataStore` methods:

```ts
createPendingGeneratedDocument(
  input: CreatePendingGeneratedDocumentInput,
): PendingGeneratedDocumentRecord;
listPendingGeneratedDocuments(
  input: PendingGeneratedDocumentQuery,
): PendingGeneratedDocumentRecord[];
confirmPendingGeneratedDocuments(
  input: PendingGeneratedDocumentQuery,
): PendingGeneratedDocumentRecord[];
cancelPendingGeneratedDocuments(
  input: PendingGeneratedDocumentQuery,
): PendingGeneratedDocumentRecord[];
```

Use a `Map<string, PendingGeneratedDocumentRecord>` keyed by `pending_id`. Filter by bot/user/conversation and `status === "pending"` when listing.

- [ ] **Step 4: Run in-memory test**

Run:

```bash
npm test -- services/data-service/src/store.test.ts -t "stores and confirms pending generated documents"
```

Expected: PASS.

- [ ] **Step 5: Add SQLite persistence test**

Add to `services/data-service/src/sqliteStore.test.ts`:

```ts
it("persists pending generated documents across store instances", () => {
  const dbPath = makeTempDbPath();
  const first = createSqliteDataStore({ dbPath });
  first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" });
  const pending = first.createPendingGeneratedDocument({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
    title: "prd/asr-api.md",
    content: "# ASR PRD",
    created_by_bot_id: "prd-bot",
    created_by_user_id: "user-a",
  });
  first.close?.();

  const second = createSqliteDataStore({ dbPath });
  expect(second.listPendingGeneratedDocuments({
    bot_id: "prd-bot",
    wecom_user_id: "user-a",
    conversation_id: "conv-1",
  })).toEqual([expect.objectContaining({
    pending_id: pending.pending_id,
    title: "prd/asr-api.md",
    content: "# ASR PRD",
    status: "pending",
  })]);
  second.close?.();
});
```

- [ ] **Step 6: Implement SQLite table and methods**

Add table:

```sql
create table if not exists pending_generated_documents (
  pending_id text primary key,
  bot_id text not null,
  wecom_user_id text not null,
  conversation_id text not null,
  title text not null,
  content text not null,
  status text not null,
  created_by_bot_id text not null,
  created_by_user_id text not null,
  created_at text not null,
  updated_at text not null
)
```

Confirm and cancel operations update `status` and `updated_at` for matching pending rows, then return the updated records.

- [ ] **Step 7: Add HTTP endpoint tests**

Add to `services/data-service/src/server.test.ts`:

```ts
it("stores pending generated documents over HTTP", async () => {
  const store = createDataStore();
  const server = createDataServiceServer(store);
  await server.fetch(new Request("http://localhost/v1/bots", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" }),
  }));

  const create = await server.fetch(new Request("http://localhost/internal/pending-generated-documents", {
    method: "POST",
    body: JSON.stringify({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      title: "prd/asr-api.md",
      content: "# ASR PRD",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "user-a",
    }),
  }));
  expect(create.status).toBe(201);

  const list = await server.fetch(
    new Request("http://localhost/internal/pending-generated-documents?bot_id=prd-bot&wecom_user_id=user-a&conversation_id=conv-1"),
  );
  await expect(list.json()).resolves.toEqual([
    expect.objectContaining({ title: "prd/asr-api.md", status: "pending" }),
  ]);

  const confirm = await server.fetch(new Request("http://localhost/internal/pending-generated-documents/confirm", {
    method: "POST",
    body: JSON.stringify({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
    }),
  }));
  await expect(confirm.json()).resolves.toEqual([
    expect.objectContaining({ title: "prd/asr-api.md", status: "confirmed" }),
  ]);
});
```

- [ ] **Step 8: Implement HTTP endpoints**

Routes:

```text
POST /internal/pending-generated-documents
GET  /internal/pending-generated-documents?bot_id=&wecom_user_id=&conversation_id=
POST /internal/pending-generated-documents/confirm
POST /internal/pending-generated-documents/cancel
```

Handlers delegate to the new store methods and return JSON.

- [ ] **Step 9: Run data-service tests**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/sqliteStore.ts services/data-service/src/server.ts services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
git commit -m "Persist pending generated documents"
```

---

## Task 3: Add Runtime Config State To Data Service

**Files:**
- Modify: `services/data-service/src/store.ts`
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/store.test.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write failing store test**

Add to `services/data-service/src/store.test.ts`:

```ts
it("stores bot runtime provider config independently from worker code", () => {
  const store = createDataStore();
  store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" });

  expect(store.getRuntimeConfig("prd-bot")).toMatchObject({
    bot_id: "prd-bot",
    provider: "mock",
    stream: true,
    options: {},
  });

  const updated = store.upsertRuntimeConfig("prd-bot", {
    provider: "kiro",
    stream: true,
    options: { timeout_ms: 120000 },
  });

  expect(updated).toEqual(expect.objectContaining({
    bot_id: "prd-bot",
    provider: "kiro",
    stream: true,
    options: { timeout_ms: 120000 },
  }));
});
```

- [ ] **Step 2: Implement runtime config types and store methods**

Add to `services/data-service/src/store.ts`:

```ts
export interface RuntimeConfigRecord {
  bot_id: string;
  provider: string;
  stream: boolean;
  options: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UpsertRuntimeConfigInput {
  provider: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}
```

Add methods:

```ts
getRuntimeConfig(botId: string): RuntimeConfigRecord;
upsertRuntimeConfig(
  botId: string,
  input: UpsertRuntimeConfigInput,
): RuntimeConfigRecord;
```

Default `getRuntimeConfig()` returns provider from existing `BotRecord.runtime`, `stream: true`, and empty options.

- [ ] **Step 3: Add SQLite and HTTP coverage**

Add table:

```sql
create table if not exists runtime_configs (
  bot_id text primary key,
  provider text not null,
  stream integer not null,
  options_json text not null,
  created_at text not null,
  updated_at text not null
)
```

Routes:

```text
GET /internal/bots/:botId/runtime-config
PUT /internal/bots/:botId/runtime-config
```

Server test:

```ts
it("updates runtime config over HTTP", async () => {
  const store = createDataStore();
  const server = createDataServiceServer(store);
  await server.fetch(new Request("http://localhost/v1/bots", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", name: "PRD Bot", runtime: "mock" }),
  }));

  const update = await server.fetch(new Request("http://localhost/internal/bots/prd-bot/runtime-config", {
    method: "PUT",
    body: JSON.stringify({ provider: "kiro", stream: true, options: { timeout_ms: 120000 } }),
  }));
  expect(update.status).toBe(200);

  const get = await server.fetch(new Request("http://localhost/internal/bots/prd-bot/runtime-config"));
  await expect(get.json()).resolves.toMatchObject({
    bot_id: "prd-bot",
    provider: "kiro",
    stream: true,
    options: { timeout_ms: 120000 },
  });
});
```

- [ ] **Step 4: Run data-service tests**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/sqliteStore.ts services/data-service/src/server.ts services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts
git commit -m "Persist bot runtime config"
```

---

## Task 4: Move Bot Host State Access Behind A Data-Service Client

**Files:**
- Create: `services/bot-host/src/botStateClient.ts`
- Modify: `services/bot-host/src/server.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write failing bot-host test for cross-instance wizard state**

Add to `services/bot-host/src/server.test.ts`:

```ts
it("continues initialization wizard from data-service state across bot-api instances", async () => {
  const sessions = new Map<string, unknown>();
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const makeServer = () => createBotHostServer({
    dataServiceUrl: "http://data-service",
    llmRunnerUrl: "http://llm-runner",
    fetch: async (request) => {
      if (!(request instanceof Request)) {
        throw new Error("expected Request");
      }
      const body = request.method === "POST" || request.method === "PUT"
        ? await request.json().catch(() => undefined)
        : undefined;
      calls.push({ url: request.url, method: request.method, body });

      if (request.url === "http://data-service/v1/message-context/resolve") {
        return Response.json({
          allowed: true,
          reason: "initializing",
          is_admin: true,
          conversation: { conversation_id: "conv-init", purpose: "init" },
        });
      }

      if (request.url === "http://data-service/internal/initialization-sessions/active?bot_id=prd-bot&wecom_user_id=admin-a&conversation_id=conv-init") {
        return Response.json(sessions.get("session") ?? null);
      }

      if (request.url === "http://data-service/internal/initialization-sessions") {
        sessions.set("session", body);
        return Response.json({ session_id: "init-1", ...(body as object) });
      }

      if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
        return Response.json([]);
      }

      if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
        return Response.json([]);
      }

      return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
    },
  });

  const first = makeServer();
  const start = await first.fetch(new Request("http://localhost/v1/messages/wecom", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
  }));
  await expect(start.json()).resolves.toMatchObject({
    output: expect.stringContaining("Soul 引导 2/3"),
  });

  const second = makeServer();
  const next = await second.fetch(new Request("http://localhost/v1/messages/wecom", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
  }));
  await expect(next.json()).resolves.toMatchObject({
    output: expect.stringContaining("Soul 引导 3/3"),
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts -t "continues initialization wizard from data-service state"
```

Expected: FAIL because `server.ts` still uses `wizardStatesByConfig`.

- [ ] **Step 3: Create `botStateClient.ts`**

Create `services/bot-host/src/botStateClient.ts`:

```ts
import type { BotHostConfig } from "./server.js";

export interface InitializationSessionDto {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: "soul" | "agents";
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: "soul" | "agents";
  status: "active" | "completed" | "cancelled";
}

export async function getActiveInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<InitializationSessionDto | undefined> {
  const url = `${config.dataServiceUrl}/internal/initialization-sessions/active?bot_id=${encodeURIComponent(input.bot_id)}&wecom_user_id=${encodeURIComponent(input.wecom_user_id)}&conversation_id=${encodeURIComponent(input.conversation_id)}`;
  const response = await config.fetch(new Request(url));
  if (response.status === 404) {
    return undefined;
  }
  const body = await response.json();
  return body === null ? undefined : body as InitializationSessionDto;
}

export async function upsertInitializationSession(
  config: BotHostConfig,
  input: Omit<InitializationSessionDto, "session_id">,
): Promise<InitializationSessionDto> {
  const response = await config.fetch(new Request(`${config.dataServiceUrl}/internal/initialization-sessions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) {
    throw new Error("failed to upsert initialization session");
  }
  return await response.json() as InitializationSessionDto;
}

export async function clearInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<void> {
  const url = `${config.dataServiceUrl}/internal/initialization-sessions/active?bot_id=${encodeURIComponent(input.bot_id)}&wecom_user_id=${encodeURIComponent(input.wecom_user_id)}&conversation_id=${encodeURIComponent(input.conversation_id)}`;
  const response = await config.fetch(new Request(url, { method: "DELETE" }));
  if (!response.ok) {
    throw new Error("failed to clear initialization session");
  }
}
```

- [ ] **Step 4: Replace wizard memory map with data-service calls**

In `services/bot-host/src/server.ts`:

- Delete `wizardStatesByConfig`.
- Replace `getWizardStates()`, `findWizardKeyForUser()`, and `resetWizardStateForUser()` usage with `getActiveInitializationSession()`, `upsertInitializationSession()`, and `clearInitializationSession()`.
- Keep local `WizardState` type only as an internal view of `InitializationSessionDto`.

When starting initialization, write:

```ts
await upsertInitializationSession(config, {
  bot_id: input.bot_id,
  wecom_user_id: input.wecom_user_id,
  conversation_id,
  phase: "soul",
  soul_answers: [],
  agents_answers: [],
  status: "active",
});
```

- [ ] **Step 5: Run bot-host wizard tests**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts -t "wizard|initialization|guides soul first|continues initialization wizard"
```

Expected: PASS after adapting mocks to handle initialization session endpoints.

- [ ] **Step 6: Commit**

```bash
git add services/bot-host/src/botStateClient.ts services/bot-host/src/server.ts services/bot-host/src/server.test.ts
git commit -m "Use data service for initialization wizard state"
```

---

## Task 5: Move Pending Document Confirmation To Data Service

**Files:**
- Modify: `services/bot-host/src/botStateClient.ts`
- Modify: `services/bot-host/src/server.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write cross-instance pending document test**

Add to `services/bot-host/src/server.test.ts`:

```ts
it("confirms generated markdown documents from data-service state across bot-host instances", async () => {
  const pending: unknown[] = [];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const makeServer = () => createBotHostServer({
    dataServiceUrl: "http://data-service",
    llmRunnerUrl: "http://llm-runner",
    fetch: async (request) => {
      if (!(request instanceof Request)) {
        throw new Error("expected Request");
      }
      const body = request.method === "POST" || request.method === "PUT" || request.method === "PATCH"
        ? await request.json().catch(() => undefined)
        : undefined;
      calls.push({ url: request.url, method: request.method, body });

      if (request.url === "http://data-service/v1/message-context/resolve") {
        return Response.json({
          allowed: true,
          reason: "ready",
          conversation: { conversation_id: "conv-1" },
        });
      }
      if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
        return Response.json([]);
      }
      if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
        return Response.json([]);
      }
      if (request.url === "http://llm-runner/v1/chat") {
        return Response.json({
          run_id: "run-doc",
          output: "~document:prd/asr-api.md\n# ASR PRD\n~/document",
        });
      }
      if (request.url === "http://data-service/internal/pending-generated-documents") {
        pending.push({ pending_id: "pending-1", ...(body as object), status: "pending" });
        return Response.json(pending.at(-1), { status: 201 });
      }
      if (request.url === "http://data-service/internal/pending-generated-documents?bot_id=prd-bot&wecom_user_id=user-a&conversation_id=conv-1") {
        return Response.json(pending.filter((item) => (item as { status: string }).status === "pending"));
      }
      if (request.url === "http://data-service/internal/pending-generated-documents/confirm") {
        return Response.json(pending.map((item) => ({ ...(item as object), status: "confirmed" })));
      }
      if (request.url === "http://data-service/internal/documents?scope=bot&owner_id=prd-bot") {
        return Response.json([]);
      }
      if (request.url === "http://data-service/internal/documents") {
        return Response.json({ document_id: "doc-1", version: 1 }, { status: 201 });
      }
      return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
    },
  });

  const first = makeServer();
  await first.fetch(new Request("http://localhost/v1/messages/wecom", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "user-a", text: "生成 PRD", runtime: "mock" }),
  }));

  const second = makeServer();
  const confirmed = await second.fetch(new Request("http://localhost/v1/messages/wecom", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "user-a", text: "确认", runtime: "mock" }),
  }));

  await expect(confirmed.json()).resolves.toMatchObject({
    output: "已保存到长期文档存储：prd/asr-api.md v1。",
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts -t "confirms generated markdown documents from data-service state"
```

Expected: FAIL because pending documents are stored in `pendingBusinessDocumentsByConfig`.

- [ ] **Step 3: Add pending document client functions**

Add to `services/bot-host/src/botStateClient.ts`:

```ts
export interface PendingGeneratedDocumentDto {
  pending_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  status: "pending" | "confirmed" | "cancelled";
  created_by_bot_id: string;
  created_by_user_id: string;
}
```

Add:

```ts
export async function createPendingGeneratedDocument(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
    title: string;
    content: string;
    created_by_bot_id: string;
    created_by_user_id: string;
  },
): Promise<PendingGeneratedDocumentDto>

export async function listPendingGeneratedDocuments(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
  },
): Promise<PendingGeneratedDocumentDto[]>

export async function confirmPendingGeneratedDocuments(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
  },
): Promise<PendingGeneratedDocumentDto[]>
```

Use the endpoints from Task 2.

- [ ] **Step 4: Replace pending document memory map**

In `services/bot-host/src/server.ts`:

- Delete `pendingBusinessDocumentsByConfig`.
- When `processAssistantOutput()` extracts non-config markdown documents, call `createPendingGeneratedDocument()` for each document.
- When user sends confirm, call `listPendingGeneratedDocuments()` and `confirmPendingGeneratedDocuments()`.
- Save confirmed documents through existing business document create/update logic.

- [ ] **Step 5: Run bot-host document tests**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts -t "generated markdown document|pending document|streaming workers"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/bot-host/src/botStateClient.ts services/bot-host/src/server.ts services/bot-host/src/server.test.ts
git commit -m "Use data service for pending generated documents"
```

---

## Task 6: Extract Shared Message Handler

**Files:**
- Create: `services/bot-host/src/messageHandler.ts`
- Modify: `services/bot-host/src/server.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Add exported handler test through existing public behavior**

Keep tests at the server boundary. Add one regression test in `services/bot-host/src/server.test.ts`:

```ts
it("uses the same ready message handler for api and worker paths", async () => {
  const prompts: string[] = [];
  const makeFetch = async (request: Request) => {
    const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
    if (request.url === "http://data-service/v1/message-context/resolve") {
      return Response.json({ allowed: true, reason: "ready", conversation: { conversation_id: "conv-1" } });
    }
    if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
      return Response.json([]);
    }
    if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
      return Response.json([]);
    }
    if (request.url === "http://llm-runner/v1/chat") {
      prompts.push((body as { prompt: string }).prompt);
      return Response.json({ run_id: "run-1", output: "mock: ok" });
    }
    return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
  };

  const server = createBotHostServer({
    dataServiceUrl: "http://data-service",
    llmRunnerUrl: "http://llm-runner",
    fetch: makeFetch,
  });

  await server.fetch(new Request("http://localhost/v1/messages/wecom", {
    method: "POST",
    body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "user-a", text: "hello", runtime: "mock" }),
  }));

  expect(prompts).toEqual(["hello"]);
});
```

This test passes before refactor and must keep passing after extraction.

- [ ] **Step 2: Create `messageHandler.ts` with moved functions**

Move these functions from `server.ts` to `messageHandler.ts`:

```ts
processWeComMessage
processAllowedWeComMessage
streamAllowedWeComMessage
handleRememberCommand
processAssistantOutput
selectVisibleAssistantOutput
listPromptMemoryDocuments
recordChatEvent
buildPrompt
```

Export:

```ts
export async function handleBotMessage(input: {
  config: BotHostConfig;
  message: WeComMessageInput;
  stream?: {
    wecomConversationId: string;
    wecomClient: WeComClient;
  };
}): Promise<Record<string, unknown> | void>
```

Keep `server.ts` responsible for:

```ts
HTTP routing
WeCom client lifecycle
supervisor sync
blocked reply mapping
admin claim routing
```

- [ ] **Step 3: Run bot-host tests**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/bot-host/src/messageHandler.ts services/bot-host/src/server.ts services/bot-host/src/server.test.ts
git commit -m "Extract shared bot message handler"
```

---

## Task 7: Split Bot API And WeCom Worker Entrypoints

**Files:**
- Create: `services/bot-host/src/botApiMain.ts`
- Create: `services/bot-host/src/wecomWorkerMain.ts`
- Modify: `services/bot-host/src/main.ts`
- Modify: `services/bot-host/Dockerfile`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Create `botApiMain.ts`**

Create `services/bot-host/src/botApiMain.ts`:

```ts
import { createServer } from "node:http";
import { createBotHostServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "8400", 10);
const app = createBotHostServer({
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
  logServiceUrl: process.env.LOG_SERVICE_URL,
  fetch,
});

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
  const response = await app.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`bot-api listening on ${port}`);
});
```

- [ ] **Step 2: Create `wecomWorkerMain.ts`**

Create `services/bot-host/src/wecomWorkerMain.ts`:

```ts
import { createServer } from "node:http";
import { createBotHostSupervisor } from "./server.js";
import { WeComLongConnectionClient } from "./wecomClient.js";

const port = Number.parseInt(process.env.PORT ?? "8401", 10);
const hostConfig = {
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
  logServiceUrl: process.env.LOG_SERVICE_URL,
  fetch,
};

const supervisor = createBotHostSupervisor({
  ...hostConfig,
  pollIntervalMs: Number.parseInt(process.env.WECOM_RUNTIME_SYNC_INTERVAL_MS ?? "5000", 10),
  createWeComClient(input) {
    return new WeComLongConnectionClient({
      botId: input.botId,
      secret: input.secret,
    });
  },
});

const server = createServer(async (req, res) => {
  const url = new URL(`http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: "wecom-worker", status: "ok" }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/internal/wecom-runtime/sync") {
    await supervisor.sync?.();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ synced: true }));
    return;
  }
  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`wecom-worker listening on ${port}`);
});

supervisor.start().catch((error) => {
  console.error("failed to start WeCom worker", error);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Keep `main.ts` compatibility**

Change `services/bot-host/src/main.ts` to:

```ts
const mode = process.env.BOT_HOST_MODE ?? "api";

if (mode === "worker") {
  await import("./wecomWorkerMain.js");
} else {
  await import("./botApiMain.js");
}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/bot-host/src/botApiMain.ts services/bot-host/src/wecomWorkerMain.ts services/bot-host/src/main.ts services/bot-host/Dockerfile
git commit -m "Split bot api and wecom worker entrypoints"
```

---

## Task 8: Update Compose And Control API Wiring

**Files:**
- Modify: `deploy/compose/docker-compose.yml`
- Modify: `deploy/compose/README.md`
- Modify: `services/control-api/src/server.test.ts`

- [ ] **Step 1: Update compose**

In `deploy/compose/docker-compose.yml`:

- Rename `bot-host` service to `bot-api`.
- Delete `bot-host-real`.
- Add `wecom-worker`.
- Change `control-api` env:

```yaml
BOT_HOST_URL: "${BOT_HOST_URL:-http://bot-api:8400}"
```

`bot-api` service:

```yaml
bot-api:
  build:
    context: ../..
    dockerfile: services/bot-host/Dockerfile
  command: ["node", "services/bot-host/dist/botApiMain.js"]
  environment:
    PORT: "8400"
    DATA_SERVICE_URL: "http://data-service:8300"
    LLM_RUNNER_URL: "http://llm-runner:8200"
    LOG_SERVICE_URL: "http://log-service:8500"
```

`wecom-worker` service:

```yaml
wecom-worker:
  profiles:
    - wecom
  build:
    context: ../..
    dockerfile: services/bot-host/Dockerfile
  command: ["node", "services/bot-host/dist/wecomWorkerMain.js"]
  environment:
    PORT: "8401"
    DATA_SERVICE_URL: "http://data-service:8300"
    LLM_RUNNER_URL: "http://llm-runner:8200"
    LOG_SERVICE_URL: "http://log-service:8500"
    WECOM_RUNTIME_SYNC_INTERVAL_MS: "5000"
```

- [ ] **Step 2: Update control-api tests**

In `services/control-api/src/server.test.ts`, replace expectations that use:

```text
http://bot-host-real
```

with:

```text
http://bot-api
```

Keep tests that explicitly simulate `botHostUrl: "http://bot-host"` only if the test name is about custom host configuration. Rename that custom host to `http://custom-bot-api` for clarity.

- [ ] **Step 3: Update README**

In `deploy/compose/README.md`, replace the old topology text with:

```md
默认启动 `bot-api`、`data-service`、`llm-runner`、`log-service`、`control-api`。

真实企业微信长连接由 `wecom-worker` 负责，位于 `wecom` profile 下：

```bash
docker compose -f deploy/compose/docker-compose.yml --profile wecom up -d
```

`control-api` 始终调用 `http://bot-api:8400`，不再切换到 `bot-host-real`。
```

- [ ] **Step 4: Validate compose config**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml config
```

Expected: command exits 0 and output contains `bot-api:` and `wecom-worker:`, not `bot-host-real:`.

- [ ] **Step 5: Run control-api tests**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose/docker-compose.yml deploy/compose/README.md services/control-api/src/server.test.ts
git commit -m "Wire compose to bot api and wecom worker"
```

---

## Task 9: End-To-End Verification

**Files:**
- No production code changes expected.
- Verification only.

- [ ] **Step 1: Run full relevant test suite**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts services/bot-host/src/server.test.ts services/bot-host/src/initialization.integration.test.ts services/control-api/src/server.test.ts services/log-service/src/server.test.ts services/llm-runner/src/server.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Build compose images**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml build bot-api wecom-worker control-api data-service llm-runner log-service
```

Expected: all images build successfully.

- [ ] **Step 4: Start base compose**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml up -d control-api bot-api data-service llm-runner log-service
```

Expected:

```bash
docker compose -f deploy/compose/docker-compose.yml ps
```

shows `control-api`, `bot-api`, `data-service`, `llm-runner`, and `log-service` as healthy.

- [ ] **Step 5: Verify service health**

Run:

```bash
curl -f http://localhost:8600/health
curl -f http://localhost:8400/health
curl -f http://localhost:8300/health
curl -f http://localhost:8200/health
curl -f http://localhost:8500/health
```

Expected: all commands exit 0.

- [ ] **Step 6: Verify old service is absent**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml config | grep -q "bot-host-real" && exit 1 || exit 0
```

Expected: exits 0.

- [ ] **Step 7: Commit verification note if docs changed**

If verification requires README command corrections, commit them:

```bash
git add deploy/compose/README.md
git commit -m "Document bot api worker verification"
```

If no files changed, do not commit.

---

## Self-Review

Spec coverage:

- Container/service relationship is covered by Tasks 7 and 8.
- `wecom-worker` not caring about LLM provider is covered by Task 3 runtime config and Task 6 shared handler.
- Critical state migration is covered by Tasks 1, 2, 4, and 5.
- Multi-bot isolation remains on existing `bot_id` data model and is preserved by data-service query keys in Tasks 1 through 5.
- Compose removal of `bot-host-real` is covered by Task 8 and verified in Task 9.

Placeholder scan:

- This plan does not contain `TODO`, `TBD`, or unspecified implementation steps.
- Every task includes exact files, commands, and expected results.

Type consistency:

- `InitializationSessionRecord` and `PendingGeneratedDocumentRecord` names are consistent across store, server, and bot-host client tasks.
- Runtime config uses `provider`, `stream`, and `options` consistently.
