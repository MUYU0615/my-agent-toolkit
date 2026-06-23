import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_CLAIM_TTL_MS } from "./store.js";
import { createSqliteDataStore } from "./sqliteStore.js";

describe("sqlite data store", () => {
  const dirs: string[] = [];

  afterEach(() => {
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
});
