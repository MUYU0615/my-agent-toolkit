# 角色驱动初始化与可编辑配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dynamic configuration system for global documents, roles, role rule documents, and role questions, then drive bot initialization and WebUI editing from stored data instead of hardcoded role/question definitions.

**Architecture:** Add first-class data-service models and APIs for `global_documents`, `roles`, `role_documents`, and `role_questions`. Update `bot-host` initialization to generate `soul.md` immediately after Soul answers, then dynamically load enabled roles and role questions to generate `agents.md`. Extend `control-api` WebUI to manage global documents, roles, role rule documents, role questions, and bot `soul.md` / `agents.md`.

**Tech Stack:** TypeScript, Node.js, Vitest, existing in-memory store + SQLite store, server-rendered control-api WebUI, existing bot-host initialization pipeline

---

## File Structure

### Data layer

- Modify: `services/data-service/src/store.ts`
  - Add in-memory data structures and CRUD for global documents, roles, role documents, role questions.
- Modify: `services/data-service/src/sqliteStore.ts`
  - Add SQLite tables, migrations, CRUD, seed bootstrap helpers for the new configuration models.
- Modify: `services/data-service/src/server.ts`
  - Add HTTP routes for the new configuration APIs.
- Modify: `services/data-service/src/store.test.ts`
  - Cover in-memory CRUD, ordering, enabled filtering, and seed behavior.
- Modify: `services/data-service/src/sqliteStore.test.ts`
  - Cover SQLite CRUD, persistence, ordering, and enabled filtering.
- Modify: `services/data-service/src/server.test.ts`
  - Cover HTTP endpoints for all new resources.

### Bot initialization layer

- Modify: `services/bot-host/src/messageHandler.ts`
  - Replace hardcoded role/question flow with dynamic role selection and question loading.
  - Split Soul generation and Agents generation into two phases.
  - Inject waiting messages before all long-running document generation steps.
- Modify: `services/bot-host/src/server.test.ts`
  - Cover dynamic role loading, role-question flow, conditional questions, immediate `soul.md` generation, delayed `agents.md` generation, and waiting prompts.
- Modify: `services/bot-host/src/initialization.integration.test.ts`
  - Cover data-service-backed initialization flow with seeded `product-manager` role.

### Control plane / WebUI

- Modify: `services/control-api/src/server.ts`
  - Add admin pages and forms for global documents, roles, role documents, role questions.
  - Add editing for bot `soul.md` and `agents.md`.
- Modify: `services/control-api/src/server.test.ts`
  - Cover new pages, form handlers, updates, deletes, and bot config editing.

### Documentation

- Modify: `README.md`
  - Add a concise section explaining the new configurable role system and document layers.

---

### Task 1: Add data-service domain models and in-memory CRUD

**Files:**
- Modify: `services/data-service/src/store.ts`
- Test: `services/data-service/src/store.test.ts`

- [ ] **Step 1: Write failing in-memory store tests for global documents and roles**

Add tests that create, list, update, and delete:

```ts
it("stores and orders enabled global documents", () => {
  const store = createInMemoryStore();
  store.upsertGlobalDocument({
    title: "Playground",
    slug: "playground",
    content: "# Playground",
    enabled: true,
    sort_order: 20,
  });
  store.upsertGlobalDocument({
    title: "Safety",
    slug: "safety",
    content: "# Safety",
    enabled: false,
    sort_order: 10,
  });

  expect(store.listGlobalDocuments({ includeDisabled: true }).map((doc) => doc.slug)).toEqual([
    "safety",
    "playground",
  ]);
  expect(store.listGlobalDocuments().map((doc) => doc.slug)).toEqual(["playground"]);
});

it("stores roles, role documents, and role questions", () => {
  const store = createInMemoryStore();
  const role = store.upsertRole({
    name: "产品经理助手",
    slug: "product-manager",
    description: "产品经理角色",
    enabled: true,
    sort_order: 10,
  });

  store.upsertRoleDocument({
    role_id: role.role_id,
    title: "role.md",
    content: "# Role",
    enabled: true,
  });
  store.upsertRoleQuestion({
    role_id: role.role_id,
    key: "interaction_mode",
    title: "你希望它用什么方式和你交互？",
    question_type: "single_choice",
    options_json: [{ value: "step_by_step", label: "逐句引导" }],
    required: true,
    enabled: true,
    sort_order: 10,
  });

  expect(store.listRoles().map((item) => item.slug)).toEqual(["product-manager"]);
  expect(store.listRoleDocuments(role.role_id)).toHaveLength(1);
  expect(store.listRoleQuestions(role.role_id)).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/data-service/src/store.test.ts
```

Expected:

- FAIL with missing store methods/types for `upsertGlobalDocument`, `upsertRole`, `upsertRoleDocument`, `upsertRoleQuestion`

- [ ] **Step 3: Add minimal store types and CRUD implementation**

In `services/data-service/src/store.ts`, add record/input types and in-memory maps:

```ts
export type GlobalDocumentRecord = {
  document_id: string;
  title: string;
  slug: string;
  content: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type RoleRecord = {
  role_id: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};
```

Add store methods:

```ts
upsertGlobalDocument(input) { /* insert/update by slug */ }
listGlobalDocuments(options = {}) { /* ordered by sort_order */ }
deleteGlobalDocument(documentId) { /* remove */ }

upsertRole(input) { /* insert/update by role_id or slug */ }
listRoles(options = {}) { /* enabled filter + ordered */ }
deleteRole(roleId) { /* remove role + dependent role docs/questions */ }

upsertRoleDocument(input) { /* one or more docs per role */ }
listRoleDocuments(roleId, options = {}) { /* enabled filter */ }
deleteRoleDocument(roleDocumentId) { /* remove */ }

upsertRoleQuestion(input) { /* insert/update */ }
listRoleQuestions(roleId, options = {}) { /* enabled filter + ordered */ }
deleteRoleQuestion(questionId) { /* remove */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/data-service/src/store.test.ts
```

Expected:

- PASS for new in-memory CRUD tests

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/store.test.ts
git commit -m "feat: add configurable role data models to in-memory store"
```

### Task 2: Add SQLite persistence and bootstrap seed data

**Files:**
- Modify: `services/data-service/src/sqliteStore.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`

- [ ] **Step 1: Write failing SQLite tests for persistence and seed bootstrap**

Add tests:

```ts
it("persists global documents and roles in sqlite", () => {
  const store = createSqliteStore(":memory:");
  const playground = store.upsertGlobalDocument({
    title: "Playground",
    slug: "playground",
    content: "# Playground",
    enabled: true,
    sort_order: 10,
  });
  const role = store.upsertRole({
    name: "产品经理助手",
    slug: "product-manager",
    description: "产品经理角色",
    enabled: true,
    sort_order: 10,
  });

  expect(store.listGlobalDocuments()[0]?.document_id).toBe(playground.document_id);
  expect(store.listRoles()[0]?.role_id).toBe(role.role_id);
});

it("seeds default playground and product manager role when empty", () => {
  const store = createSqliteStore(":memory:");
  seedDefaultRoleConfig(store);

  expect(store.listGlobalDocuments().map((doc) => doc.slug)).toContain("playground");
  expect(store.listRoles().map((role) => role.slug)).toContain("product-manager");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/data-service/src/sqliteStore.test.ts
```

Expected:

- FAIL because tables, methods, or bootstrap seed helper do not exist

- [ ] **Step 3: Add SQLite tables, CRUD, and seeding**

Add schema in `services/data-service/src/sqliteStore.ts`:

```sql
create table if not exists global_documents (
  document_id text primary key,
  title text not null,
  slug text not null unique,
  content text not null,
  enabled integer not null,
  sort_order integer not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists roles (
  role_id text primary key,
  name text not null,
  slug text not null unique,
  description text not null,
  enabled integer not null,
  sort_order integer not null,
  created_at text not null,
  updated_at text not null
);
```

Also add:

- `role_documents`
- `role_questions`
- `seedDefaultRoleConfig(store)` helper that creates:
  - `playground` global doc
  - `product-manager` role
  - one product-manager role document
  - initial product-manager role questions

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/data-service/src/sqliteStore.test.ts
```

Expected:

- PASS for persistence and seed tests

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/sqliteStore.ts services/data-service/src/sqliteStore.test.ts
git commit -m "feat: persist role configuration in sqlite"
```

### Task 3: Expose data-service HTTP APIs for global documents, roles, role documents, and role questions

**Files:**
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write failing server tests for all new endpoints**

Add tests similar to:

```ts
it("creates and lists global documents over http", async () => {
  const server = createDataServiceServer();
  const createResponse = await server.fetch(new Request("http://localhost/v1/global-documents", {
    method: "POST",
    body: JSON.stringify({
      title: "Playground",
      slug: "playground",
      content: "# Playground",
      enabled: true,
      sort_order: 10,
    }),
  }));
  expect(createResponse.status).toBe(201);

  const listResponse = await server.fetch(new Request("http://localhost/v1/global-documents"));
  await expect(listResponse.json()).resolves.toMatchObject([
    { slug: "playground" },
  ]);
});
```

Also add endpoint tests for:

- `GET/POST/PUT/DELETE /v1/roles`
- `GET/POST/PUT/DELETE /v1/roles/:id/documents`
- `GET/POST/PUT/DELETE /v1/roles/:id/questions`

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/data-service/src/server.test.ts
```

Expected:

- FAIL with 404 or handler-missing assertions

- [ ] **Step 3: Implement HTTP routes with existing server style**

In `services/data-service/src/server.ts`, add route handlers:

```ts
if (url.pathname === "/v1/global-documents" && request.method === "GET") { /* list */ }
if (url.pathname === "/v1/global-documents" && request.method === "POST") { /* create */ }
if (matchPath(url.pathname, "/v1/global-documents/:id") && request.method === "PUT") { /* update */ }
if (matchPath(url.pathname, "/v1/global-documents/:id") && request.method === "DELETE") { /* delete */ }
```

Repeat same route pattern for roles, role documents, role questions.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/data-service/src/server.test.ts
```

Expected:

- PASS for all new HTTP endpoint tests

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/server.ts services/data-service/src/server.test.ts
git commit -m "feat: expose role configuration data-service apis"
```

### Task 4: Refactor bot-host Soul flow to generate `soul.md` immediately

**Files:**
- Modify: `services/bot-host/src/messageHandler.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write failing tests for Soul-only generation and waiting message**

Add a test that:

```ts
it("generates soul immediately after soul answers and then starts role selection", async () => {
  // answer Soul questions
  // expect output contains "Soul 正在生成，请稍等。"
  // expect soul persisted before any role questions are asked
  // expect next output prompts for role selection
});
```

Also assert:

- `agents.md` is not written yet
- role options come from data-service, not hardcoded constants

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts
```

Expected:

- FAIL because current flow still couples soul/agents initialization or does not prompt role selection dynamically

- [ ] **Step 3: Implement Soul phase split**

In `services/bot-host/src/messageHandler.ts`:

- change initialization state shape to track:

```ts
type InitializationState = {
  phase: "soul" | "role_select" | "role_questions" | "done";
  soulAnswers: string[];
  selectedRoleId?: string;
  roleAnswers: Record<string, string | string[]>;
  generationInProgress?: "soul" | "agents";
};
```

- after Soul answers complete:
  - emit `Soul 正在生成，请稍等。`
  - generate `soul.md`
  - persist it
  - emit `Soul 已生成。`
  - transition to `role_select`

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts
```

Expected:

- PASS for Soul-phase split behavior

- [ ] **Step 5: Commit**

```bash
git add services/bot-host/src/messageHandler.ts services/bot-host/src/server.test.ts
git commit -m "feat: generate soul before dynamic role onboarding"
```

### Task 5: Replace hardcoded role list and role questions with data-driven initialization

**Files:**
- Modify: `services/bot-host/src/messageHandler.ts`
- Test: `services/bot-host/src/server.test.ts`
- Test: `services/bot-host/src/initialization.integration.test.ts`

- [ ] **Step 1: Write failing tests for dynamic role selection and question flow**

Add tests covering:

```ts
it("loads enabled roles from data-service for role selection", async () => {
  // mocked roles response includes product-manager and qa
  // expect prompt options contain both roles from payload
});

it("loads enabled questions for selected role and skips disabled ones", async () => {
  // mocked role_questions include ordered enabled questions
  // expect prompts follow stored order
});
```

Add one test for conditional question visibility using `depends_on_json`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts services/bot-host/src/initialization.integration.test.ts
```

Expected:

- FAIL because current code still uses `SOUL_WIZARD_QUESTIONS`, `AGENTS_WIZARD_QUESTIONS`, or static role options

- [ ] **Step 3: Implement dynamic role/question loading**

Add helper fetches in `messageHandler.ts`:

```ts
async function listEnabledRoles(config: BotHostConfig): Promise<RoleRecord[]> { /* GET data-service */ }
async function listEnabledRoleQuestions(config: BotHostConfig, roleId: string): Promise<RoleQuestionRecord[]> { /* GET data-service */ }
```

Implement:

- role selection prompt from `roles`
- per-role question loop from `role_questions`
- conditional skip based on `depends_on_json`
- answer collection keyed by question `key`

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts services/bot-host/src/initialization.integration.test.ts
```

Expected:

- PASS for dynamic role and question loading

- [ ] **Step 5: Commit**

```bash
git add services/bot-host/src/messageHandler.ts services/bot-host/src/server.test.ts services/bot-host/src/initialization.integration.test.ts
git commit -m "feat: drive role onboarding from stored role configuration"
```

### Task 6: Generate `agents.md` from global docs, role docs, and role answers

**Files:**
- Modify: `services/bot-host/src/messageHandler.ts`
- Test: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write failing tests for `agents.md` generation inputs and waiting message**

Add tests asserting:

- `agents.md` generation happens only after role questions finish
- output contains `工作方式正在生成，请稍等。`
- prompt to llm/fallback includes:
  - enabled global docs
  - selected role document
  - Soul summary
  - role answers

Example expectation:

```ts
expect((llmCall.body as { prompt: string }).prompt).toContain("Playground");
expect((llmCall.body as { prompt: string }).prompt).toContain("Role: Product Manager");
expect((llmCall.body as { prompt: string }).prompt).toContain("你希望它用什么方式和你交互");
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts
```

Expected:

- FAIL because current prompt construction does not include data-driven global/role docs

- [ ] **Step 3: Implement new agents generation input pipeline**

Add helper fetches:

```ts
async function listEnabledGlobalDocuments(config: BotHostConfig): Promise<GlobalDocumentRecord[]> { /* GET data-service */ }
async function listEnabledRoleDocuments(config: BotHostConfig, roleId: string): Promise<RoleDocumentRecord[]> { /* GET data-service */ }
```

Use them in agents generation:

- emit waiting message
- build prompt from:
  - global docs
  - role docs
  - soul answers
  - role answers
- persist `agents.md`
- mark bot ready

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/bot-host/src/server.test.ts
```

Expected:

- PASS for `agents.md` generation and waiting prompt coverage

- [ ] **Step 5: Commit**

```bash
git add services/bot-host/src/messageHandler.ts services/bot-host/src/server.test.ts
git commit -m "feat: generate agents from global and role configuration"
```

### Task 7: Build control-api management pages for global documents and roles

**Files:**
- Modify: `services/control-api/src/server.ts`
- Test: `services/control-api/src/server.test.ts`

- [ ] **Step 1: Write failing UI/server tests for global documents and role CRUD**

Add tests covering:

```ts
it("renders global documents management page", async () => {
  const response = await server.fetch(new Request("http://localhost/admin/global-documents"));
  const html = await response.text();
  expect(html).toContain("全局配置");
  expect(html).toContain("playground.md");
});

it("creates a role through the admin form", async () => {
  // submit POST form to create role
  // assert control-api posts to data-service roles endpoint
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected:

- FAIL with missing routes or missing form handlers

- [ ] **Step 3: Implement global documents and roles management UI**

In `services/control-api/src/server.ts`, add:

- navigation links for:
  - global configuration
  - role management
- pages and form handlers for:
  - list/create/update/delete global docs
  - list/create/update/delete roles

Keep UI plain and consistent with current server-rendered style:

```html
<section>
  <h2>全局配置</h2>
  <form method="post" action="/admin/global-documents/create">...</form>
</section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected:

- PASS for management page rendering and CRUD handlers

- [ ] **Step 5: Commit**

```bash
git add services/control-api/src/server.ts services/control-api/src/server.test.ts
git commit -m "feat: add webui management for global docs and roles"
```

### Task 8: Add WebUI editing for role rule documents, role questions, and bot config docs

**Files:**
- Modify: `services/control-api/src/server.ts`
- Test: `services/control-api/src/server.test.ts`

- [ ] **Step 1: Write failing tests for role detail editing and bot soul/agents editing**

Add tests covering:

- role document edit form loads existing content
- role question list renders and can add/edit/delete questions
- bot detail page can update `soul.md`
- bot detail page can update `agents.md`

Example:

```ts
it("updates soul.md from bot detail page", async () => {
  // submit bot config edit form
  // assert control-api writes to /v1/bot-config-documents
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected:

- FAIL because current UI only previews or lacks edit endpoints

- [ ] **Step 3: Implement editors and form handlers**

Add to `services/control-api/src/server.ts`:

- role detail page sections:
  - role metadata
  - role rule document textarea
  - role questions table/form
- bot detail page sections:
  - editable `soul.md`
  - editable `agents.md`

Use existing textarea/form conventions:

```html
<label>Soul<textarea name="content">...</textarea></label>
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected:

- PASS for editing flows

- [ ] **Step 5: Commit**

```bash
git add services/control-api/src/server.ts services/control-api/src/server.test.ts
git commit -m "feat: add editable role rules questions and bot config docs"
```

### Task 9: Seed product-manager defaults and verify end-to-end initialization

**Files:**
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/bot-host/src/initialization.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing integration/readme tests or assertions for seeded product-manager role**

Extend integration coverage:

```ts
it("initializes a bot with the seeded product-manager role", async () => {
  // seeded data-service
  // Soul answers
  // choose 产品经理助手
  // answer role questions
  // assert soul written first
  // assert agents written second
  // assert ready status
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- services/bot-host/src/initialization.integration.test.ts
```

Expected:

- FAIL until seeded product-manager config and dynamic flow are wired together

- [ ] **Step 3: Finalize seed content and docs**

Ensure default seed creates:

- one `playground.md`
- one enabled `product-manager` role
- one enabled product-manager role document
- initial product-manager role questions aligned with approved onboarding

Update `README.md` with concise setup notes:

- role config lives in data-service
- global docs / roles / role docs / role questions are editable in WebUI

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts services/bot-host/src/server.test.ts services/bot-host/src/initialization.integration.test.ts services/control-api/src/server.test.ts
npm run typecheck
git diff --check
```

Expected:

- all targeted tests PASS
- typecheck PASS
- no whitespace or patch formatting issues

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/sqliteStore.ts services/bot-host/src/initialization.integration.test.ts README.md
git commit -m "feat: seed configurable product manager onboarding"
```

## Self-Review

### Spec coverage

- Global documents: covered by Tasks 1, 2, 3, 7
- Roles / role documents / role questions: covered by Tasks 1, 2, 3, 5, 7, 8
- Soul and agents WebUI editing: covered by Task 8
- Soul generated before agents: covered by Task 4
- Dynamic role onboarding: covered by Task 5
- Waiting feedback for document generation: covered by Tasks 4 and 6
- Seed product-manager role and initialization flow: covered by Task 9

No spec gaps remain in this first-phase plan.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to Task N” placeholders remain.
- Every task includes exact files, concrete tests, commands, and commit boundaries.

### Type consistency

- New resources consistently use:
  - `global_documents`
  - `roles`
  - `role_documents`
  - `role_questions`
- Bot initialization consistently uses:
  - `soul.md`
  - `agents.md`
- Dynamic role flow consistently uses:
  - `selectedRoleId`
  - `roleAnswers`

