import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_CLAIM_TTL_MS } from "./store.js";
import { createSqliteDataStore, seedDefaultRoleConfig } from "./sqliteStore.js";

function withInjectedUniqueCollision(
  dbPath: string,
  sqlFragment: string,
  injector: () => void,
): void {
  const originalPrepare = Database.prototype.prepare;
  let injected = false;

  vi.spyOn(Database.prototype, "prepare").mockImplementation(function mockedPrepare(
    this: Database.Database,
    sql: string,
    ...args: any[]
  ) {
    const callPrepare = originalPrepare as unknown as (
      this: Database.Database,
      sql: string,
      ...rest: any[]
    ) => ReturnType<typeof Database.prototype.prepare>;
    const statement = callPrepare.call(this, sql, ...args);
    if (!sql.includes(sqlFragment)) {
      return statement;
    }

    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== "run") {
          return Reflect.get(target, property, receiver);
        }

        return (...runArgs: any[]) => {
          if (!injected) {
            injected = true;
            const raw = new Database(dbPath);
            try {
              injector();
            } finally {
              raw.close();
            }
          }
          return Reflect.apply(target.run as (...args: any[]) => unknown, target, runArgs);
        };
      },
    });
  });
}

describe("sqlite data store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists Bot main project configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const first = createSqliteDataStore(dbPath);
    first.createBot({
      bot_id: "qa-bot",
      name: "QA Bot",
      runtime: "kiro",
      project_key: "im-test-hub",
      project_repository_url: "https://github.com/example/im-test-hub.git",
      project_default_branch: "main",
      project_directory: "im-test-hub",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBot("qa-bot")).toMatchObject({
      project_key: "im-test-hub",
      project_repository_url: "https://github.com/example/im-test-hub.git",
      project_default_branch: "main",
      project_directory: "im-test-hub",
    });
    second.close?.();
  });

  it("persists repository-only project configuration with derived defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const first = createSqliteDataStore(dbPath);
    first.createBot({
      bot_id: "qa-bot",
      name: "QA Bot",
      runtime: "kiro",
      project_key: "",
      project_repository_url: "git@github.com:example/im-test-hub.git",
      project_default_branch: "",
      project_directory: "",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBot("qa-bot")).toMatchObject({
      project_key: "im-test-hub",
      project_repository_url: "git@github.com:example/im-test-hub.git",
      project_default_branch: "main",
      project_directory: "im-test-hub",
    });
    second.close?.();
  });

  it("persists bot admin and conversation records across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = first.createAdminClaim("prd-bot");
    expect(new Date(claim.expires_at).getTime() - new Date(claim.created_at).getTime())
      .toBe(ADMIN_CLAIM_TTL_MS);
    first.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    first.markBotReady("prd-bot");
    const conversation = first.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBot("prd-bot")).toMatchObject({
      bot_id: "prd-bot",
      status: "ready",
    });
    expect(second.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toEqual(conversation);
    second.close?.();
  });

  it("keeps stable conversation sequence numbers after opening history", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const first = store.createConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    const second = store.createConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    const secondUpdatedAt = second.updated_at;

    expect([first.sequence_no, second.sequence_no]).toEqual([1, 2]);
    store.openConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: first.conversation_id,
    });
    const conversations = store.listConversations({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });

    expect(conversations.map((conversation) => conversation.sequence_no)).toEqual([2, 1]);
    expect(conversations.find((conversation) => conversation.sequence_no === 1)?.is_active).toBe(true);
    expect(conversations.find((conversation) => conversation.sequence_no === 2)).toMatchObject({
      is_active: false,
      updated_at: secondUpdatedAt,
    });
    store.close?.();
  });

  it("persists runtime sessions across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const created = first.upsertRuntimeSession({
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
      provider_session_id: "kiro-session-a",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getRuntimeSession(created.runner_session_id)).toEqual(created);
    second.close?.();
  });

  it("migrates existing conversation rows without scope keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const raw = new Database(dbPath);
    raw.exec(`
      create table bots (
        bot_id text primary key,
        name text not null,
        runtime text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create table conversations (
        conversation_id text primary key,
        conversation_key text not null,
        bot_id text not null,
        wecom_user_id text not null,
        channel text not null,
        purpose text not null,
        display_name text,
        created_at text not null,
        updated_at text not null
      );
      insert into bots (
        bot_id, name, runtime, status, created_at, updated_at
      ) values (
        'prd-bot', 'PRD Bot', 'kiro', 'ready',
        '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
      );
      insert into conversations (
        conversation_id, conversation_key, bot_id, wecom_user_id,
        channel, purpose, display_name, created_at, updated_at
      ) values (
        'conv-a', 'legacy-key', 'prd-bot', 'user-a',
        'wecom_direct', 'normal_chat', null,
        '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
      );
    `);
    raw.close();

    const store = createSqliteDataStore(dbPath);
    expect(store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      conversation_id: "conv-a",
      sequence_no: 1,
    });
    store.close?.();
  });

  it("persists pending and claimed admin claim detail states across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "secret-a",
    });
    const claim = first.createAdminClaim("prd-bot");
    expect(first.getBotChannelDetail("prd-bot")).toMatchObject({
      pending_admin_claim: {
        status: "pending",
        code: claim.code,
        expires_at: claim.expires_at,
      },
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBotChannelDetail("prd-bot")).toMatchObject({
      pending_admin_claim: {
        status: "pending",
        code: claim.code,
        expires_at: claim.expires_at,
      },
    });
    second.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    expect(second.getBotChannelDetail("prd-bot")).toMatchObject({
      admin: {
        wecom_user_id: "admin-a",
      },
      pending_admin_claim: {
        status: "claimed",
      },
    });
    second.close?.();
  });

  it("persists listed and updated bot records across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const prd = first.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });
    first.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "mock",
    });
    const updated = first.updateBot("prd-bot", {
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret: "new-secret-value",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(updated.created_at).toBe(prd.created_at);
    expect(updated.updated_at).not.toBe(prd.updated_at);
    expect(second.getBot("prd-bot")).toEqual(updated);
    expect(second.getBot("prd-bot")).toMatchObject({
      wecom_bot_id: "wecom-bot-b",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(second.getBot("prd-bot"))).not.toContain("new-secret-value");
    expect(JSON.stringify(second.getBot("prd-bot"))).not.toContain("super-secret-value");
    expect(second.listBots()).toMatchObject([
      { bot_id: "prd-bot", name: "PRD Assistant" },
      { bot_id: "ops-bot", name: "Ops Bot" },
    ]);
    second.close?.();
  });

  it("persists bot MCP capability config across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    first.updateBotMcpCapabilityConfig("prd-bot", {
      version: 1,
      memory: {
        enabled: true,
        readable_scopes: ["bot"],
        writable_scopes: ["bot"],
      },
      documents: {
        enabled: false,
        writable_scopes: [],
      },
      tools: {
        enabled: ["memory.search"],
      },
      directory_refs: ["bot-workspace"],
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBotMcpCapabilityConfig("prd-bot")).toEqual({
      version: 1,
      memory: {
        enabled: true,
        readable_scopes: ["bot"],
        writable_scopes: ["bot"],
      },
      documents: {
        enabled: false,
        writable_scopes: [],
      },
      tools: {
        enabled: ["memory.search"],
      },
      directory_refs: ["bot-workspace"],
    });
    second.close?.();
  });

  it("persists runtime config across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    expect(first.getRuntimeConfig("prd-bot")).toMatchObject({
      bot_id: "prd-bot",
      provider: "kiro",
      stream: true,
      options: {},
    });
    const updated = first.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      stream: false,
      options: {
        model: "gpt-5",
      },
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getRuntimeConfig("prd-bot")).toEqual(updated);
    const repeated = second.upsertRuntimeConfig("prd-bot", {
      provider: "kimi",
    });
    expect(repeated).toMatchObject({
      bot_id: "prd-bot",
      provider: "kimi",
      stream: true,
      options: {},
    });
    expect(repeated.created_at).toBe(updated.created_at);
    expect(repeated.updated_at).not.toBe(updated.updated_at);
    second.close?.();
  });

  it("persists global documents with enabled filtering ordering and logical-key upserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const disabled = first.upsertGlobalDocument({
      title: "Safety",
      slug: "safety",
      content: "# Safety",
      enabled: false,
      sort_order: 10,
    });
    const created = first.upsertGlobalDocument({
      title: "Playground",
      slug: "playground",
      content: "# Playground",
      enabled: true,
      sort_order: 20,
    });
    const updated = first.upsertGlobalDocument({
      title: "Playground Guide",
      slug: "playground",
      content: "# Playground v2",
      enabled: true,
      sort_order: 30,
    });

    expect(updated.document_id).toBe(created.document_id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(first.listGlobalDocuments({ includeDisabled: true }).map((document) => document.slug)).toEqual([
      "safety",
      "playground",
    ]);
    expect(first.listGlobalDocuments().map((document) => document.slug)).toEqual(["playground"]);
    expect(() => first.upsertGlobalDocument({
      document_id: "global_doc_missing",
      title: "Missing",
      slug: "missing",
      content: "# Missing",
    })).toThrow("global document not found: global_doc_missing");
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listGlobalDocuments({ includeDisabled: true })).toEqual([
      disabled,
      updated,
    ]);
    second.close?.();
  });

  it("persists roles role documents and role questions with task-1 semantics", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const disabledRole = first.upsertRole({
      name: "Disabled role",
      slug: "disabled-role",
      description: "disabled",
      enabled: false,
      sort_order: 5,
    });
    const createdRole = first.upsertRole({
      name: "Product Manager",
      slug: "product-manager",
      description: "产品经理角色",
      enabled: true,
      sort_order: 10,
    });
    const updatedRole = first.upsertRole({
      name: "Senior Product Manager",
      slug: "product-manager",
      description: "更新后的产品经理角色",
      enabled: true,
      sort_order: 20,
    });
    expect(updatedRole.role_id).toBe(createdRole.role_id);
    expect(updatedRole.created_at).toBe(createdRole.created_at);
    expect(updatedRole.updated_at).not.toBe(createdRole.updated_at);
    expect(first.listRoles({ includeDisabled: true }).map((role) => role.slug)).toEqual([
      "disabled-role",
      "product-manager",
    ]);
    expect(first.listRoles().map((role) => role.slug)).toEqual(["product-manager"]);
    expect(() => first.upsertRole({
      role_id: "role_missing",
      name: "Ghost",
      slug: "ghost",
      description: "ghost",
    })).toThrow("role not found: role_missing");

    const disabledDocument = first.upsertRoleDocument({
      role_id: updatedRole.role_id,
      title: "disabled.md",
      content: "# Disabled",
      enabled: false,
    });
    const createdDocument = first.upsertRoleDocument({
      role_id: updatedRole.role_id,
      title: "role.md",
      content: "# Role",
      enabled: true,
    });
    const updatedDocument = first.upsertRoleDocument({
      role_id: updatedRole.role_id,
      title: "role.md",
      content: "# Role v2",
      enabled: true,
    });
    expect(updatedDocument.role_document_id).toBe(createdDocument.role_document_id);
    expect(updatedDocument.created_at).toBe(createdDocument.created_at);
    expect(updatedDocument.updated_at).not.toBe(createdDocument.updated_at);
    expect(first.listRoleDocuments(updatedRole.role_id, { includeDisabled: true })).toEqual([
      disabledDocument,
      updatedDocument,
    ]);
    expect(first.listRoleDocuments(updatedRole.role_id)).toEqual([updatedDocument]);
    expect(() => first.upsertRoleDocument({
      role_document_id: "role_doc_missing",
      role_id: updatedRole.role_id,
      title: "missing.md",
      content: "# Missing",
    })).toThrow("role document not found: role_doc_missing");

    const disabledQuestion = first.upsertRoleQuestion({
      role_id: updatedRole.role_id,
      key: "legacy_mode",
      title: "Legacy mode?",
      description: "legacy",
      question_type: "free_text",
      enabled: false,
      sort_order: 5,
    });
    const createdQuestion = first.upsertRoleQuestion({
      role_id: updatedRole.role_id,
      key: "interaction_mode",
      title: "How should it interact?",
      description: "Choose the operating style",
      question_type: "single_choice",
      options_json: [{ value: "step_by_step", label: "Step by step" }],
      required: true,
      enabled: true,
      sort_order: 10,
      depends_on_json: [{ key: "team_mode", equals: "enabled" }],
    });
    const updatedQuestion = first.upsertRoleQuestion({
      role_id: updatedRole.role_id,
      key: "interaction_mode",
      title: "How should it interact now?",
      description: "Updated guidance",
      question_type: "single_choice",
      options_json: [{ value: "direct", label: "Direct" }],
      required: true,
      enabled: true,
      sort_order: 20,
      depends_on_json: [{ key: "team_mode", equals: "enabled" }],
    });
    expect(updatedQuestion.question_id).toBe(createdQuestion.question_id);
    expect(updatedQuestion.created_at).toBe(createdQuestion.created_at);
    expect(updatedQuestion.updated_at).not.toBe(createdQuestion.updated_at);
    expect(first.listRoleQuestions(updatedRole.role_id, { includeDisabled: true })).toEqual([
      disabledQuestion,
      updatedQuestion,
    ]);
    expect(first.listRoleQuestions(updatedRole.role_id)).toEqual([updatedQuestion]);
    expect(updatedQuestion.description).toBe("Updated guidance");
    expect(updatedQuestion.depends_on_json).toEqual([{ key: "team_mode", equals: "enabled" }]);
    expect(() => first.upsertRoleQuestion({
      question_id: "question_missing",
      role_id: updatedRole.role_id,
      key: "missing_question",
      title: "Missing question",
      question_type: "free_text",
    })).toThrow("role question not found: question_missing");
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listRoles({ includeDisabled: true })).toEqual([
      disabledRole,
      updatedRole,
    ]);
    expect(second.listRoleDocuments(updatedRole.role_id, { includeDisabled: true })).toEqual([
      disabledDocument,
      updatedDocument,
    ]);
    expect(second.listRoleQuestions(updatedRole.role_id, { includeDisabled: true })).toEqual([
      disabledQuestion,
      updatedQuestion,
    ]);

    second.deleteRole(updatedRole.role_id);
    expect(second.listRoleDocuments(updatedRole.role_id, { includeDisabled: true })).toEqual([]);
    expect(second.listRoleQuestions(updatedRole.role_id, { includeDisabled: true })).toEqual([]);
    second.close?.();
  });

  it("seeds default role configuration when sqlite config tables are empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    seedDefaultRoleConfig(first);
    seedDefaultRoleConfig(first);

    expect(first.listGlobalDocuments().map((document) => document.slug)).toEqual(["playground"]);
    const roles = first.listRoles();
    expect(roles.map((role) => role.slug)).toEqual([
      "product-manager",
      "qa-engineer",
      "engineer",
      "marketing",
      "operations",
    ]);
    const productManager = roles.find((role) => role.slug === "product-manager");
    expect(productManager).toMatchObject({
      name: "产品经理",
      slug: "product-manager",
    });
    expect(first.listRoleDocuments(productManager!.role_id)).toHaveLength(1);
    expect(first.listRoleQuestions(productManager!.role_id)).not.toHaveLength(0);
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    const persistedRole = second.listRoles().find((role) => role.slug === "product-manager");
    expect(second.listGlobalDocuments().map((document) => document.slug)).toEqual(["playground"]);
    expect(second.listRoleDocuments(persistedRole!.role_id)).toHaveLength(1);
    expect(second.listRoleQuestions(persistedRole!.role_id)[0]).toMatchObject({
      role_id: persistedRole!.role_id,
      description: expect.any(String),
      depends_on_json: expect.any(Array),
    });
    second.close?.();
  });

  it("does not overwrite customized seeded role configuration on repeated bootstrap", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    seedDefaultRoleConfig(store);

    const [seededPlayground] = store.listGlobalDocuments({ includeDisabled: true });
    const [seededRole] = store.listRoles({ includeDisabled: true });
    const [seededRoleDocument] = store.listRoleDocuments(seededRole.role_id, {
      includeDisabled: true,
    });
    const seededQuestions = store.listRoleQuestions(seededRole.role_id, {
      includeDisabled: true,
    });
    const seededMemoryStorage = seededQuestions.find((question) => question.key === "memory_storage");
    const seededInteractionMode = seededQuestions.find(
      (question) => question.key === "interaction_mode",
    );
    const seededWorkRules = seededQuestions.find((question) => question.key === "work_rules");

    expect(seededMemoryStorage).toBeDefined();
    expect(seededInteractionMode).toBeDefined();
    expect(seededWorkRules).toBeDefined();

    const customizedPlayground = store.upsertGlobalDocument({
      document_id: seededPlayground.document_id,
      title: "Custom Playground",
      slug: seededPlayground.slug,
      content: "# Custom Playground",
      enabled: false,
      sort_order: 99,
    });
    const customizedRole = store.upsertRole({
      role_id: seededRole.role_id,
      name: "Custom Product Manager",
      slug: seededRole.slug,
      description: "Custom role guidance.",
      enabled: false,
      sort_order: 99,
    });
    const customizedRoleDocument = store.upsertRoleDocument({
      role_document_id: seededRoleDocument.role_document_id,
      role_id: seededRole.role_id,
      title: seededRoleDocument.title,
      content: "# Custom Role",
      enabled: false,
    });
    const customizedMemoryStorage = store.upsertRoleQuestion({
      question_id: seededMemoryStorage!.question_id,
      role_id: seededRole.role_id,
      key: seededMemoryStorage!.key,
      title: "Custom memory storage",
      description: "Custom memory guidance.",
      question_type: "single_choice",
      options_json: [{ value: "beta", label: "Beta" }],
      required: false,
      enabled: false,
      sort_order: 99,
      depends_on_json: [],
    });
    const customizedInteractionMode = store.upsertRoleQuestion({
      question_id: seededInteractionMode!.question_id,
      role_id: seededRole.role_id,
      key: seededInteractionMode!.key,
      title: "Custom interaction mode",
      description: "Custom interaction guidance.",
      question_type: "single_choice",
      options_json: [{ value: "async", label: "Async" }],
      required: false,
      enabled: false,
      sort_order: 100,
      depends_on_json: [{ key: "memory_storage", equals: "beta" }],
    });
    const customizedWorkRules = store.upsertRoleQuestion({
      question_id: seededWorkRules!.question_id,
      role_id: seededRole.role_id,
      key: seededWorkRules!.key,
      title: "Custom work rules",
      description: "Custom work rule guidance.",
      question_type: "single_choice",
      options_json: [{ value: "policy", label: "Policy" }],
      required: false,
      enabled: false,
      sort_order: 101,
      depends_on_json: [{ key: "interaction_mode", equals: "async" }],
    });

    seedDefaultRoleConfig(store);

    expect(store.listGlobalDocuments({ includeDisabled: true })).toEqual([customizedPlayground]);
    expect(store.listRoles({ includeDisabled: true })).toEqual(
      expect.arrayContaining([customizedRole]),
    );
    expect(
      store.listRoleDocuments(customizedRole.role_id, { includeDisabled: true }),
    ).toEqual([customizedRoleDocument]);
    expect(
      store.listRoleQuestions(customizedRole.role_id, { includeDisabled: true }),
    ).toEqual(expect.arrayContaining([
      customizedMemoryStorage,
      customizedInteractionMode,
      customizedWorkRules,
      expect.objectContaining({
        role_id: customizedRole.role_id,
        key: "output_shape",
        title: "默认输出更偏向哪类内容？",
      }),
      expect.objectContaining({
        role_id: customizedRole.role_id,
        key: "recommendation_first",
        title: "是否需要优先给推荐方案？",
      }),
    ]));
    expect(
      store.listRoleQuestions(customizedRole.role_id, { includeDisabled: true })
        .map((question) => question.key),
    ).not.toContain("structured_conclusion");
    store.close?.();
  });

  it("backfills missing seeded records by logical key without overwriting customized state", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    const existingGlobal = store.upsertGlobalDocument({
      title: "Safety",
      slug: "safety",
      content: "# Safety",
      enabled: false,
      sort_order: 50,
    });
    const productManager = store.upsertRole({
      name: "Custom Product Manager",
      slug: "product-manager",
      description: "Customized role guidance.",
      enabled: false,
      sort_order: 77,
    });
    const existingQuestion = store.upsertRoleQuestion({
      role_id: productManager.role_id,
      key: "memory_storage",
      title: "Custom memory storage",
      description: "Keep this customization.",
      question_type: "single_choice",
      options_json: [{ value: "beta", label: "Beta" }],
      required: false,
      enabled: false,
      sort_order: 99,
      depends_on_json: [],
    });

    seedDefaultRoleConfig(store);

    expect(store.listGlobalDocuments({ includeDisabled: true })).toEqual([
      expect.objectContaining({ slug: "playground", title: "playground.md" }),
      expect.objectContaining({ document_id: existingGlobal.document_id, slug: "safety" }),
    ]);
    expect(store.listRoles({ includeDisabled: true })).toEqual(
      expect.arrayContaining([productManager]),
    );
    expect(store.listRoleDocuments(productManager.role_id, { includeDisabled: true })).toEqual([
      expect.objectContaining({
        role_id: productManager.role_id,
        title: "role.md",
        content: expect.stringContaining("# Role: Product Manager"),
      }),
    ]);
    expect(store.listRoleQuestions(productManager.role_id, { includeDisabled: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role_id: productManager.role_id,
        key: "interaction_mode",
        title: "你希望它用什么方式和你交互？",
      }),
      expect.objectContaining({
        role_id: productManager.role_id,
        key: "output_shape",
        title: "默认输出更偏向哪类内容？",
      }),
      expect.objectContaining({
        role_id: productManager.role_id,
        key: "work_rules",
        title: "是否有额外工作规则？",
      }),
      existingQuestion,
      expect.objectContaining({
        role_id: productManager.role_id,
        key: "recommendation_first",
        title: "是否需要优先给推荐方案？",
      }),
    ]));
    expect(
      store.listRoleQuestions(productManager.role_id, { includeDisabled: true })
        .map((question) => question.key),
    ).not.toContain("structured_conclusion");
    store.close?.();
  });

  it("adds missing seeded playground and product-manager even when collections are already populated", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    const existingGlobal = store.upsertGlobalDocument({
      title: "Safety",
      slug: "safety",
      content: "# Safety",
    });
    const existingRole = store.upsertRole({
      name: "Designer",
      slug: "designer",
      description: "Existing role.",
    });

    seedDefaultRoleConfig(store);

    expect(store.listGlobalDocuments({ includeDisabled: true })).toEqual([
      expect.objectContaining({ document_id: existingGlobal.document_id, slug: "safety" }),
      expect.objectContaining({ slug: "playground" }),
    ]);
    expect(store.listRoles({ includeDisabled: true })).toEqual([
      existingRole,
      expect.objectContaining({ slug: "product-manager", name: "产品经理" }),
      expect.objectContaining({ slug: "qa-engineer", name: "测试工程师" }),
      expect.objectContaining({ slug: "engineer", name: "研发工程师" }),
      expect.objectContaining({ slug: "marketing", name: "市场人员" }),
      expect.objectContaining({ slug: "operations", name: "运营人员" }),
    ]);
    store.close?.();
  });

  it("resets bot and role data but preserves playground", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    seedDefaultRoleConfig(store);
    const playgroundBefore = store.listGlobalDocuments().find((doc) => doc.slug === "playground");
    store.createBot({ bot_id: "bot-1", name: "old bot", runtime: "kiro" });

    store.resetToStandardRoleConfig();

    expect(store.listBots()).toEqual([]);
    expect(store.listRoles().map((role) => role.name)).toEqual([
      "产品经理",
      "测试工程师",
      "研发工程师",
      "市场人员",
      "运营人员",
    ]);
    expect(store.listGlobalDocuments().find((doc) => doc.slug === "playground")?.document_id).toBe(
      playgroundBefore?.document_id,
    );
    store.close?.();
  });

  it("resetBot clears bot config documents and initialization sessions in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.claimAdmin({ bot_id: "prd-bot", wecom_user_id: "admin-a" });
    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "agents",
      selected_role_id: "role-product-manager",
      soul_answers: ["旧 bot", "1"],
      agents_answers: ["interaction_mode=step_by_step"],
      status: "active",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "soul",
      content: "# Soul\n旧内容",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "agents.md",
      content: "# AGENTS\n旧内容",
    });

    const reset = store.resetBot("prd-bot");

    expect(reset.status).toBe("initializing");
    expect(store.listBotConfigDocuments("prd-bot")).toEqual([]);
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
    })).toBeUndefined();
    store.close?.();
  });

  it("persists rules.md as a per-Bot configuration document in sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const rule = store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "instructions/rules.md",
      content: "只在当前会话目录工作。",
    });

    expect(rule).toMatchObject({
      bot_id: "prd-bot",
      title: "rules.md",
      content: "只在当前会话目录工作。",
    });
    expect(store.listBotConfigDocuments("prd-bot")).toMatchObject([rule]);
    expect(() => store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "rules.md",
      content: "not allowed",
    })).toThrow("bot config documents must use /v1/bot-config-documents");
    store.close?.();
  });

  it("rejects non-boolean runtime config stream values", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      stream: "false" as unknown as boolean,
    })).toThrow("stream must be a boolean");
    store.close?.();
  });

  it("persists pending generated documents across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const created = first.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([created]);
    const cancelled = second.cancelPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(cancelled).toMatchObject([
      {
        pending_id: created.pending_id,
        status: "cancelled",
      },
    ]);
    second.close?.();

    const third = createSqliteDataStore(dbPath);
    expect(third.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
    expect(third.cancelPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
    third.close?.();
  });

  it("applies pending generated documents atomically across sqlite store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const pendingA = first.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/a.md",
      content: "# A",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    const pendingB = first.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/b.md",
      content: "# B",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.applyPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    })).toEqual([
      { pending_id: pendingA.pending_id, title: "prd/a.md", version: 1 },
      { pending_id: pendingB.pending_id, title: "prd/b.md", version: 1 },
    ]);
    second.close?.();

    const third = createSqliteDataStore(dbPath);
    expect(third.applyPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    })).toEqual([]);
    expect(third.listBusinessDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "prd/a.md", version: 1 }),
      expect.objectContaining({ title: "prd/b.md", version: 1 }),
    ]));
    third.close?.();
  });

  it("applies pending generated documents in insertion order when timestamps tie", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T10:00:00.000Z"));

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const pendingA = first.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/a.md",
      content: "# A",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    const pendingB = first.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/b.md",
      content: "# B",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    }).map((document) => document.pending_id)).toEqual([
      pendingA.pending_id,
      pendingB.pending_id,
    ]);
    expect(second.applyPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    })).toEqual([
      { pending_id: pendingA.pending_id, title: "prd/a.md", version: 1 },
      { pending_id: pendingB.pending_id, title: "prd/b.md", version: 1 },
    ]);
    second.close?.();
  });

  it("rejects duplicate persisted wecom bot bindings", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    });

    expect(() => store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");

    store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-b",
    });

    expect(() => store.updateBot("ops-bot", {
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");
    store.close?.();
  });

  it("surfaces logical-key duplicate errors instead of raw sqlite constraint errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const store = createSqliteDataStore(dbPath);

    withInjectedUniqueCollision(dbPath, "insert into global_documents", () => {
      const raw = new Database(dbPath);
      const now = new Date().toISOString();
      try {
        raw.prepare(
          "insert into global_documents (document_id, title, slug, content, enabled, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("global_doc_existing", "Existing Playground", "playground", "# Existing", 1, 5, now, now);
      } finally {
        raw.close();
      }
    });
    expect(() => store.upsertGlobalDocument({
      title: "Playground",
      slug: "playground",
      content: "# Playground",
    })).toThrow("global document slug already exists: playground");
    vi.restoreAllMocks();

    withInjectedUniqueCollision(dbPath, "insert into roles", () => {
      const raw = new Database(dbPath);
      const now = new Date().toISOString();
      try {
        raw.prepare(
          "insert into roles (role_id, name, slug, description, enabled, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("role_existing", "Existing PM", "product-manager", "Existing", 1, 5, now, now);
      } finally {
        raw.close();
      }
    });
    expect(() => store.upsertRole({
      name: "Product Manager",
      slug: "product-manager",
      description: "Role guidance",
    })).toThrow("role slug already exists: product-manager");
    vi.restoreAllMocks();

    const researchRole = store.upsertRole({
      name: "Researcher",
      slug: "researcher",
      description: "Research role.",
    });
    withInjectedUniqueCollision(dbPath, "insert into role_documents", () => {
      const raw = new Database(dbPath);
      const now = new Date().toISOString();
      try {
        raw.prepare(
          "insert into role_documents (role_document_id, role_id, title, content, enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        ).run("role_doc_existing", researchRole.role_id, "role.md", "# Existing", 1, now, now);
      } finally {
        raw.close();
      }
    });
    expect(() => store.upsertRoleDocument({
      role_id: researchRole.role_id,
      title: "role.md",
      content: "# Role",
    })).toThrow(
      `role document already exists for role ${researchRole.role_id} and title role.md`,
    );
    vi.restoreAllMocks();

    withInjectedUniqueCollision(dbPath, "insert into role_questions", () => {
      const raw = new Database(dbPath);
      const now = new Date().toISOString();
      try {
        raw.prepare(
          "insert into role_questions (question_id, role_id, key, title, description, question_type, options_json, required, enabled, sort_order, depends_on_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          "question_existing",
          researchRole.role_id,
          "interaction_mode",
          "Existing question",
          "Existing",
          "single_choice",
          JSON.stringify([{ value: "direct", label: "Direct" }]),
          1,
          1,
          10,
          JSON.stringify([]),
          now,
          now,
        );
      } finally {
        raw.close();
      }
    });
    expect(() => store.upsertRoleQuestion({
      role_id: researchRole.role_id,
      key: "interaction_mode",
      title: "Interaction mode",
      description: "Question",
      question_type: "single_choice",
      options_json: [{ value: "direct", label: "Direct" }],
    })).toThrow(
      `role question already exists for role ${researchRole.role_id} and key interaction_mode`,
    );
    store.close?.();
  });

  it("tests persisted wecom connection configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    const result = await second.testWeComConnection("prd-bot");

    expect(result).toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    second.close?.();
  });

  it("verifies persisted wecom credentials with an injected verifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath, {
      wecomVerifier: {
        async verify(input) {
          expect(input).toEqual({
            bot_id: "wecom-bot-a",
            secret: "super-secret-value",
          });
          return { verified: true };
        },
      },
    });
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    await expect(store.testWeComConnection("prd-bot")).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "verified",
    });
    expect(store.getBot("prd-bot")).toMatchObject({
      wecom_connection_status: "verified",
    });
    store.close?.();
  });

  it("persists transferred admins across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = first.createAdminClaim("prd-bot");
    first.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    const transferred = first.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "admin-a",
      new_wecom_user_id: "admin-b",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getAdmin("prd-bot")).toEqual(transferred);
    second.close?.();
  });

  it("persists memory document versions across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const initial = first.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "first version",
    });
    const updated = first.upsertMemoryDocument({
      memory_doc_id: initial.memory_doc_id,
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "second version",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listMemoryDocumentVersions(initial.memory_doc_id)).toEqual([
      initial,
      updated,
    ]);
    second.close?.();
  });

  it("lists current memory document versions for a scope owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const store = createSqliteDataStore(dbPath);

    const guideline = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v1",
    });
    const currentGuideline = store.upsertMemoryDocument({
      memory_doc_id: guideline.memory_doc_id,
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v2",
    });
    const processDoc = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-process",
      content: "agent docs",
    });
    store.upsertMemoryDocument({
      scope: "shared",
      owner_id: "prd-bot",
      title: "shared",
      content: "not returned",
    });

    expect(store.listCurrentMemoryDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual([currentGuideline, processDoc]);
    store.close?.();
  });

  it("persists business document versions across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const document = first.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      content: "# v1",
      visibility: "bot",
      tier: "core",
      tags: ["prd", "asr"],
      created_by_bot_id: "prd-bot",
      created_by_user_id: "user-a",
    });
    const updated = first.updateBusinessDocument({
      document_id: document.document_id,
      content: "# v2",
      change_summary: "补充计量计费",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBusinessDocument(document.document_id, 1)).toMatchObject({
      document_id: document.document_id,
      version: 1,
      content: "# v1",
    });
    expect(second.getBusinessDocument(document.document_id)).toEqual(updated);
    expect(second.listBusinessDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toMatchObject([
      {
        document_id: document.document_id,
        title: "语音转文字 API PRD",
        version: 2,
        tags: ["prd", "asr"],
      },
    ]);
    expect(() => second.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "soul.md",
      doc_type: "config",
      content: "not allowed",
    })).toThrow("bot config documents must use /v1/bot-config-documents");
    second.close?.();
  });

  it("persists memory metadata chunks assets and stats", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const memory = first.createMemoryRecord({
      scope: "user",
      owner_id: "user-a",
      content: "用户关注环信 IM 产品和 PRD 质量。",
      tier: "core",
      source_type: "text",
      source_conversation_id: "conv-a",
      source_message_id: "msg-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "user-a",
      tags: ["user-profile"],
    });
    first.recordChunks({
      source_type: "memory",
      source_id: memory.memory_id,
      scope: "user",
      owner_id: "user-a",
      chunks: [
        {
          content: "用户关注环信 IM 产品。",
          chunk_index: 0,
          heading_path: "profile",
          location: "line:1",
          tier: "core",
        },
        {
          content: "用户关注 PRD 质量。",
          chunk_index: 1,
          heading_path: "profile",
          location: "line:2",
          tier: "core",
        },
      ],
    });
    first.recordAsset({
      source_type: "memory",
      source_id: memory.memory_id,
      filename: "profile.md",
      content_type: "text/markdown",
      storage_uri: "file:///data/profile.md",
      size_bytes: 128,
      content_hash: "hash-profile",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listMemories({
      scope: "user",
      owner_id: "user-a",
    })).toMatchObject([
      {
        memory_id: memory.memory_id,
        scope: "user",
        owner_id: "user-a",
        tier: "core",
        tags: ["user-profile"],
      },
    ]);
    expect(second.getMemoryStats({
      scope: "user",
      owner_id: "user-a",
    })).toEqual({
      total_memories: 1,
      total_chunks: 2,
      by_tier: {
        core: 1,
        reference: 0,
        temp: 0,
      },
      disk_usage_bytes: 128,
    });
    second.close?.();
  });

  it("persists active initialization sessions across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const created = first.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: [],
      generation_in_progress: "soul",
      status: "active",
    });
    const updated = first.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      generation_in_progress: "agents",
      status: "active",
    });
    first.close?.();

    expect(updated.session_id).toBe(created.session_id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);

    const second = createSqliteDataStore(dbPath);
    expect(second.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual(updated);

    second.clearInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(second.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toBeUndefined();
    second.close?.();
  });

  it("preserves initialization session identity on conflicting sqlite upserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    first.close?.();

    const db = new Database(dbPath);
    db.exec(`
      create trigger simulate_concurrent_initialization_session_insert
      before insert on initialization_sessions
      when NEW.session_key = '["prd-bot","admin-a","conv-a"]'
        and not exists (
          select 1
          from initialization_sessions
          where session_key = NEW.session_key
        )
      begin
        insert into initialization_sessions (
          session_key, session_id, bot_id, wecom_user_id, conversation_id,
          phase, soul_answers_json, agents_answers_json,
          generation_in_progress, status, created_at, updated_at
        ) values (
          NEW.session_key, 'init_concurrent', NEW.bot_id, NEW.wecom_user_id,
          NEW.conversation_id, 'soul', '["first"]', '[]',
          null, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      end;
    `);
    db.close();

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const second = createSqliteDataStore(dbPath);
    const updated = second.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["first", "second"],
      agents_answers: ["agent"],
      status: "active",
    });

    expect(updated.session_id).toBe("init_concurrent");
    expect(updated.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updated_at).toBe("2026-01-01T00:00:01.000Z");
    expect(second.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual(updated);
    second.close?.();
  });

  it("does not collide persisted initialization session keys with delimiter-containing ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const firstStore = createSqliteDataStore(dbPath);
    firstStore.createBot({ bot_id: "bot:a", name: "Bot A", runtime: "kiro" });
    firstStore.createBot({ bot_id: "bot", name: "Bot", runtime: "kiro" });
    const first = firstStore.upsertInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
      phase: "soul",
      soul_answers: ["first"],
      agents_answers: [],
      status: "active",
    });
    const second = firstStore.upsertInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
      phase: "agents",
      soul_answers: ["second"],
      agents_answers: ["agent"],
      status: "active",
    });
    firstStore.close?.();

    expect(second.session_id).not.toBe(first.session_id);

    const secondStore = createSqliteDataStore(dbPath);
    expect(secondStore.getActiveInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
    })).toEqual(first);
    expect(secondStore.getActiveInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
    })).toEqual(second);
    secondStore.close?.();
  });

  it("isolates persisted initialization session answer arrays from caller and reader mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const created = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });
    created.soul_answers.push("外部修改");
    created.agents_answers[0] = "被篡改";

    const fetched = store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });

    expect(fetched).toMatchObject({
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
    });

    fetched?.soul_answers.push("再次修改");
    if (fetched) {
      fetched.agents_answers[0] = "再次篡改";
    }

    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toMatchObject({
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
    });
    store.close?.();
  });

  it("persists bot runtime policies across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = first.getOrCreateBotRuntimePolicy("prd-bot");
    const updated = first.updateBotRuntimePolicy("prd-bot", {
      skill_install_policy: "open",
    });
    first.close?.();

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      skill_install_policy: "admin_only",
      mcp_manage_policy: "admin_only",
    });
    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      skill_install_policy: "open",
      mcp_manage_policy: "admin_only",
    });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);

    const second = createSqliteDataStore(dbPath);
    expect(second.getOrCreateBotRuntimePolicy("prd-bot")).toEqual(updated);
    second.close?.();
  });

  it("persists bot env vars as metadata-only list entries across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = first.upsertBotEnvVar("prd-bot", {
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v1",
      updated_by_wecom_user_id: "admin-a",
    });
    const updated = first.upsertBotEnvVar("prd-bot", {
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v2",
      updated_by_wecom_user_id: "admin-b",
    });
    const listed = first.listBotEnvVars("prd-bot");
    first.close?.();

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v1",
      is_set: true,
      updated_by_wecom_user_id: "admin-a",
    });
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(listed).toEqual([
      {
        bot_id: "prd-bot",
        key: "OPENAI_API_KEY",
        is_set: true,
        updated_at: updated.updated_at,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("ciphertext-v2");

    const second = createSqliteDataStore(dbPath);
    expect(second.listBotEnvVars("prd-bot")).toEqual(listed);
    second.deleteBotEnvVar("prd-bot", "OPENAI_API_KEY");
    expect(second.listBotEnvVars("prd-bot")).toEqual([]);
    second.close?.();
  });

  it("persists user env vars per bot and WeCom user without exposing ciphertext in metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const saved = first.upsertUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      key: "HIM22187_AUTH_TOKEN",
      value_ciphertext: "ciphertext-user-a",
    });
    first.upsertUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-b",
      key: "HIM22187_AUTH_TOKEN",
      value_ciphertext: "ciphertext-user-b",
    });
    const listed = first.listUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" });
    first.close?.();

    expect(listed).toEqual([{
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      key: "HIM22187_AUTH_TOKEN",
      is_set: true,
      updated_at: saved.updated_at,
    }]);
    expect(JSON.stringify(listed)).not.toContain("ciphertext-user-a");

    const second = createSqliteDataStore(dbPath);
    expect(second.getUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" }))
      .toMatchObject([{ value_ciphertext: "ciphertext-user-a" }]);
    expect(second.getUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-b" }))
      .toMatchObject([{ value_ciphertext: "ciphertext-user-b" }]);
    second.deleteUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      key: "HIM22187_AUTH_TOKEN",
    });
    expect(second.listUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" })).toEqual([]);
    expect(second.listUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-b" })).toHaveLength(1);
    second.close?.();
  });

  it("persists bot skills mcps and capability audit logs with newest-first ordering", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const repoAnalyzer = first.upsertBotSkill("prd-bot", {
      name: "repo-analyzer",
      source_type: "github",
      source_ref: "https://github.com/acme/repo-analyzer",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const promptLinter = first.upsertBotSkill("prd-bot", {
      name: "prompt-linter",
      source_type: "builtin",
      source_ref: "builtin:prompt-linter",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const updatedSkill = first.upsertBotSkill("prd-bot", {
      name: "repo-analyzer",
      source_type: "url",
      source_ref: "https://example.com/repo-analyzer.tgz",
      status: "failed",
      installed_by_wecom_user_id: "admin-b",
      last_error: "network timeout",
    });

    const searchMcp = first.upsertBotMcp("prd-bot", {
      name: "search-mcp",
      mode: "config",
      source_ref: "http://localhost:9300",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const filesystemMcp = first.upsertBotMcp("prd-bot", {
      name: "filesystem-mcp",
      mode: "package",
      source_ref: "@acme/filesystem-mcp",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const updatedMcp = first.upsertBotMcp("prd-bot", {
      name: "search-mcp",
      mode: "package",
      source_ref: "@acme/search-mcp",
      status: "failed",
      installed_by_wecom_user_id: "admin-b",
      last_error: "install failed",
    });

    const firstAudit = first.appendBotCapabilityAuditLog({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      display_name: "Alice",
      action_type: "env_set",
      target_name: "OPENAI_API_KEY",
      result: "success",
    });
    const secondAudit = first.appendBotCapabilityAuditLog({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      action_type: "skill_install",
      target_name: "repo-analyzer",
      source_ref: "https://github.com/acme/repo-analyzer",
      result: "failed",
      error_message: "network timeout",
    });
    first.close?.();

    expect(repoAnalyzer.skill_id).toBe(updatedSkill.skill_id);
    expect(searchMcp.mcp_id).toBe(updatedMcp.mcp_id);
    expect(promptLinter.skill_id).toMatch(/^skill_/);
    expect(filesystemMcp.mcp_id).toMatch(/^mcp_/);
    expect(firstAudit.log_id).toMatch(/^cap_audit_/);

    const second = createSqliteDataStore(dbPath);
    expect(second.listBotSkills("prd-bot").map((skill) => skill.name)).toEqual([
      "repo-analyzer",
      "prompt-linter",
    ]);
    expect(second.listBotSkills("prd-bot")[0]).toMatchObject({
      name: "repo-analyzer",
      source_type: "url",
      status: "failed",
      last_error: "network timeout",
    });

    expect(second.listBotMcps("prd-bot").map((mcp) => mcp.name)).toEqual([
      "search-mcp",
      "filesystem-mcp",
    ]);
    expect(second.listBotMcps("prd-bot")[0]).toMatchObject({
      name: "search-mcp",
      mode: "package",
      status: "failed",
      last_error: "install failed",
    });

    expect(second.listBotCapabilityAuditLogs("prd-bot")).toEqual([
      secondAudit,
      firstAudit,
    ]);

    second.deleteBotSkill("prd-bot", "prompt-linter");
    second.deleteBotMcp("prd-bot", "filesystem-mcp");
    expect(second.listBotSkills("prd-bot").map((skill) => skill.name)).toEqual([
      "repo-analyzer",
    ]);
    expect(second.listBotMcps("prd-bot").map((mcp) => mcp.name)).toEqual([
      "search-mcp",
    ]);
    second.close?.();
  });

  it("filters bot capability lists by bot id", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.createBot({ bot_id: "ops-bot", name: "Ops Bot", runtime: "codex" });

    store.upsertBotEnvVar("prd-bot", {
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-prd",
      updated_by_wecom_user_id: "admin-a",
    });
    store.upsertBotEnvVar("ops-bot", {
      key: "GITHUB_TOKEN",
      value_ciphertext: "ciphertext-ops",
      updated_by_wecom_user_id: "admin-b",
    });

    store.upsertBotSkill("prd-bot", {
      name: "repo-analyzer",
      source_type: "github",
      source_ref: "https://github.com/acme/repo-analyzer",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    store.upsertBotSkill("ops-bot", {
      name: "deploy-helper",
      source_type: "local",
      source_ref: "/opt/skills/deploy-helper",
      status: "installed",
      installed_by_wecom_user_id: "admin-b",
    });

    store.upsertBotMcp("prd-bot", {
      name: "search-mcp",
      mode: "config",
      source_ref: "http://localhost:9300",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    store.upsertBotMcp("ops-bot", {
      name: "filesystem-mcp",
      mode: "package",
      source_ref: "@acme/filesystem-mcp",
      status: "installed",
      installed_by_wecom_user_id: "admin-b",
    });

    store.appendBotCapabilityAuditLog({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      action_type: "env_set",
      target_name: "OPENAI_API_KEY",
      result: "success",
    });
    store.appendBotCapabilityAuditLog({
      bot_id: "ops-bot",
      wecom_user_id: "admin-b",
      action_type: "mcp_install",
      target_name: "filesystem-mcp",
      result: "success",
    });

    expect(store.listBotEnvVars("prd-bot").map((env) => env.key)).toEqual(["OPENAI_API_KEY"]);
    expect(store.listBotEnvVars("ops-bot").map((env) => env.key)).toEqual(["GITHUB_TOKEN"]);

    expect(store.listBotSkills("prd-bot").map((skill) => skill.name)).toEqual([
      "repo-analyzer",
    ]);
    expect(store.listBotSkills("ops-bot").map((skill) => skill.name)).toEqual([
      "deploy-helper",
    ]);

    expect(store.listBotMcps("prd-bot").map((mcp) => mcp.name)).toEqual(["search-mcp"]);
    expect(store.listBotMcps("ops-bot").map((mcp) => mcp.name)).toEqual(["filesystem-mcp"]);

    expect(store.listBotCapabilityAuditLogs("prd-bot").map((log) => log.target_name)).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(store.listBotCapabilityAuditLogs("ops-bot").map((log) => log.target_name)).toEqual([
      "filesystem-mcp",
    ]);

    store.close?.();
  });

  it("persists user credential ciphertext with user isolation across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const scope = {
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      provider: "easemob_jira" as const,
    };

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "jira-bot", name: "Jira Bot", runtime: "kiro" });
    const binding = first.createUserCredentialBinding(scope);
    first.completeUserCredentialBinding({
      token: binding.token,
      payload_ciphertext: "encrypted-payload-a",
    });
    expect(() => first.createUserCredentialBinding(scope)).toThrow("already bound");
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getUserCredential(scope)?.payload_ciphertext).toBe("encrypted-payload-a");
    expect(second.getUserCredential({ ...scope, wecom_user_id: "user-b" })).toBeUndefined();
    second.deleteUserCredential(scope);
    expect(second.getUserCredential(scope)).toBeUndefined();
    second.close?.();
  });
});
