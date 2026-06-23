import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_CLAIM_TTL_MS } from "./store.js";
import { createSqliteDataStore } from "./sqliteStore.js";

describe("sqlite data store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
});
