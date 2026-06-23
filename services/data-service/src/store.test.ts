import { describe, expect, it } from "vitest";
import { buildDefaultMcpCapabilityConfig } from "@my-agent-toolkit/contracts";
import { ADMIN_CLAIM_TTL_MS, createDataStore } from "./store.js";

describe("data-service store", () => {
  it("creates and reads bot records", () => {
    const store = createDataStore();

    const bot = store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    expect(bot).toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      status: "draft",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(bot)).not.toContain("super-secret-value");
    expect(store.getBot("prd-bot")).toEqual(bot);
  });

  it("gets and updates bot MCP capability config", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(store.getBotMcpCapabilityConfig("prd-bot")).toEqual(
      buildDefaultMcpCapabilityConfig(),
    );

    const updated = store.updateBotMcpCapabilityConfig("prd-bot", {
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

    expect(updated).toEqual({
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
    expect(store.getBotMcpCapabilityConfig("prd-bot")).toEqual(updated);
    expect(() => store.getBotMcpCapabilityConfig("missing-bot"))
      .toThrow("bot not found: missing-bot");
    expect(() => store.updateBotMcpCapabilityConfig("prd-bot", {
      version: 1,
      memory: {
        enabled: true,
        readable_scopes: ["namespace"],
        writable_scopes: [],
      },
      documents: {
        enabled: true,
        writable_scopes: [],
      },
      tools: {
        enabled: [],
      },
      directory_refs: [],
    })).toThrow("scope must be system, shared, bot, user, or session");
  });

  it("upserts and clears active initialization sessions", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: [],
      generation_in_progress: "soul",
      status: "active",
    });

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: [],
      generation_in_progress: "soul",
      status: "active",
    });
    expect(created.session_id).toMatch(/^init_/);

    const updated = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });

    expect(updated.session_id).toBe(created.session_id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated).toMatchObject({
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });
    expect(updated.generation_in_progress).toBeUndefined();
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual(updated);

    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "completed",
    });
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toBeUndefined();

    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: [],
      agents_answers: [],
      status: "active",
    });
    store.clearInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toBeUndefined();
  });

  it("does not collide initialization session keys with delimiter-containing ids", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "bot:a", name: "Bot A", runtime: "kiro" });
    store.createBot({ bot_id: "bot", name: "Bot", runtime: "kiro" });

    const first = store.upsertInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
      phase: "soul",
      soul_answers: ["first"],
      agents_answers: [],
      status: "active",
    });
    const second = store.upsertInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
      phase: "agents",
      soul_answers: ["second"],
      agents_answers: ["agent"],
      status: "active",
    });

    expect(second.session_id).not.toBe(first.session_id);
    expect(store.getActiveInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
    })).toEqual(first);
    expect(store.getActiveInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
    })).toEqual(second);
  });

  it("rejects invalid initialization generation progress when provided", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: [],
      agents_answers: [],
      generation_in_progress: "",
      status: "active",
    } as unknown as Parameters<typeof store.upsertInitializationSession>[0])).toThrow(
      "generation_in_progress is invalid",
    );
  });

  it("stores and confirms pending generated documents", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.createBot({ bot_id: "ops-bot", name: "Ops Bot", runtime: "mock" });

    const created = store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      conversation_id: "conv-a",
      title: "other user",
      content: "not returned",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-b",
    });
    store.createPendingGeneratedDocument({
      bot_id: "ops-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "other bot",
      content: "not returned",
      created_by_bot_id: "ops-bot",
      created_by_user_id: "admin-a",
    });

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      status: "pending",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    expect(created.pending_id).toMatch(/^pending_/);
    expect(store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([created]);

    const confirmed = store.confirmPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      pending_id: created.pending_id,
      status: "confirmed",
    });
    expect(confirmed[0].created_at).toBe(created.created_at);
    expect(confirmed[0].updated_at).not.toBe(created.updated_at);
    expect(store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
    expect(store.confirmPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
  });

  it("rejects pending generated documents without creator fields", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0])).toThrow(
      "created_by_bot_id is required",
    );
    expect(() => store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_bot_id: "prd-bot",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0])).toThrow(
      "created_by_user_id is required",
    );
  });

  it("generates pending ids instead of accepting caller supplied ids", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createPendingGeneratedDocument({
      pending_id: "pending_client_supplied",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "First PRD",
      content: "# first",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0] & {
      pending_id: string;
    });
    const second = store.createPendingGeneratedDocument({
      pending_id: "pending_client_supplied",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "Second PRD",
      content: "# second",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0] & {
      pending_id: string;
    });

    expect(first.pending_id).toMatch(/^pending_/);
    expect(second.pending_id).toMatch(/^pending_/);
    expect(first.pending_id).not.toBe("pending_client_supplied");
    expect(second.pending_id).not.toBe("pending_client_supplied");
    expect(second.pending_id).not.toBe(first.pending_id);
    const listed = store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([first, second]));
  });

  it("creates versioned business documents and rejects bot config document titles", () => {
    const store = createDataStore();

    const document = store.createBusinessDocument({
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

    expect(document).toMatchObject({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      version: 1,
      tier: "core",
      status: "active",
      tags: ["prd", "asr"],
    });
    expect(store.getBusinessDocument(document.document_id)).toMatchObject({
      document_id: document.document_id,
      version: 1,
      content: "# v1",
    });

    const updated = store.updateBusinessDocument({
      document_id: document.document_id,
      content: "# v2",
      change_summary: "补充计量计费",
    });

    expect(updated).toMatchObject({
      document_id: document.document_id,
      version: 2,
      content: "# v2",
      change_summary: "补充计量计费",
    });
    expect(store.getBusinessDocument(document.document_id, 1)).toMatchObject({
      version: 1,
      content: "# v1",
    });
    expect(store.getBusinessDocument(document.document_id)).toMatchObject({
      version: 2,
      content: "# v2",
    });
    expect(store.listBusinessDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toMatchObject([
      {
        document_id: document.document_id,
        title: "语音转文字 API PRD",
        version: 2,
      },
    ]);

    expect(() => store.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "agents.md",
      doc_type: "config",
      content: "not allowed",
    })).toThrow("bot config documents must use /v1/bot-config-documents");
  });

  it("stores memory metadata chunks assets and stats", () => {
    const store = createDataStore();

    const memory = store.createMemoryRecord({
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

    expect(memory).toMatchObject({
      scope: "user",
      owner_id: "user-a",
      tier: "core",
      status: "active",
      tags: ["user-profile"],
    });

    const chunks = store.recordChunks({
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

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      source_type: "memory",
      source_id: memory.memory_id,
      scope: "user",
      owner_id: "user-a",
      chunk_index: 0,
    });

    const asset = store.recordAsset({
      source_type: "memory",
      source_id: memory.memory_id,
      filename: "profile.md",
      content_type: "text/markdown",
      storage_uri: "file:///data/profile.md",
      size_bytes: 128,
      content_hash: "hash-profile",
    });

    expect(asset).toMatchObject({
      source_type: "memory",
      source_id: memory.memory_id,
      filename: "profile.md",
      size_bytes: 128,
    });

    expect(store.getMemoryStats({
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
  });

  it("lists and updates bot records", () => {
    const store = createDataStore();
    const prd = store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
    });
    store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "mock",
    });

    expect(store.listBots()).toMatchObject([
      { bot_id: "prd-bot" },
      { bot_id: "ops-bot" },
    ]);

    const updated = store.updateBot("prd-bot", {
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret: "new-secret-value",
    });

    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret_configured: true,
      created_at: prd.created_at,
    });
    expect(JSON.stringify(updated)).not.toContain("new-secret-value");
    expect(updated.updated_at).not.toBe(prd.updated_at);
    expect(store.getBot("prd-bot")).toEqual(updated);
  });

  it("rejects duplicate wecom bot bindings", () => {
    const store = createDataStore();
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
  });

  it("tests wecom connection configuration without exposing secrets", async () => {
    const store = createDataStore();
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    const configured = await store.testWeComConnection("prd-bot");

    expect(configured).toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(configured.checked_at).toMatch(/T/);
    expect(JSON.stringify(configured)).not.toContain("super-secret-value");

    store.createBot({
      bot_id: "missing-secret",
      name: "Missing Secret",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-b",
    });
    await expect(store.testWeComConnection("missing-secret")).resolves.toMatchObject({
      bot_id: "missing-secret",
      status: "missing_config",
      missing: ["wecom_secret"],
      wecom_secret_configured: false,
    });

    store.createBot({
      bot_id: "missing-bot-id",
      name: "Missing Bot ID",
      runtime: "kiro",
    });
    await expect(store.testWeComConnection("missing-bot-id")).resolves.toMatchObject({
      bot_id: "missing-bot-id",
      status: "missing_config",
      missing: ["wecom_bot_id", "wecom_secret"],
    });
  });

  it("verifies wecom credentials with an injected verifier", async () => {
    const store = createDataStore({
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
      missing: [],
    });
  });

  it("stores failed wecom verification without exposing secrets", async () => {
    const store = createDataStore({
      wecomVerifier: {
        async verify() {
          return { verified: false, error: "auth failed" };
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

    const result = await store.testWeComConnection("prd-bot");

    expect(result).toMatchObject({
      bot_id: "prd-bot",
      status: "failed",
      error: "auth failed",
    });
    expect(store.getBot("prd-bot")).toMatchObject({
      wecom_connection_status: "failed",
      last_wecom_error: "auth failed",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("creates claim code and verifies admin claim without storing plain code", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "admin_unclaimed",
    });

    const claim = store.createAdminClaim("prd-bot");
    expect(claim.code).toMatch(/^[0-9]{6}$/);
    expect(claim.code_hash).not.toBe(claim.code);
    expect(new Date(claim.expires_at).getTime() - new Date(claim.created_at).getTime())
      .toBe(ADMIN_CLAIM_TTL_MS);

    expect(() => store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: "000000",
    })).toThrow("invalid admin claim code");

    const admin = store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    expect(admin).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      role: "admin",
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "initializing",
      is_admin: true,
      conversation: {
        purpose: "init",
      },
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "initialization_required",
      is_admin: false,
    });

    store.markBotReady("prd-bot");
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "ready",
      is_admin: false,
    });
  });

  it("refreshes admin claim codes by replacing the pending code", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createAdminClaim("prd-bot");
    const second = store.createAdminClaim("prd-bot");

    expect(second.code).toMatch(/^[0-9]{6}$/);
    expect(second.code_hash).not.toBe(first.code_hash);
    expect(() => store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: first.code,
    })).toThrow("invalid admin claim code");
    expect(store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: second.code,
    })).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
    });
  });

  it("gets and transfers bot admin", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = store.createAdminClaim("prd-bot");
    const admin = store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });

    expect(store.getAdmin("prd-bot")).toEqual(admin);

    const transferred = store.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "admin-a",
      new_wecom_user_id: "admin-b",
    });

    expect(transferred).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      role: "admin",
    });
    expect(store.getAdmin("prd-bot")).toEqual(transferred);
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "initialization_required",
      is_admin: false,
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "initializing",
      is_admin: true,
    });
  });

  it("rejects admin transfer from non-current admins", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = store.createAdminClaim("prd-bot");
    store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });

    expect(() => store.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "user-a",
      new_wecom_user_id: "admin-b",
    })).toThrow("current admin does not match");
    expect(store.getAdmin("prd-bot")).toMatchObject({
      wecom_user_id: "admin-a",
    });
  });

  it("resolves the same conversation for the same bot user channel and purpose", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    const second = store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });

    expect(second).toEqual(first);
    expect(first.conversation_id).toMatch(/^conv_/);
  });

  it("creates a new memory document version on update", () => {
    const store = createDataStore();
    const first = store.upsertMemoryDocument({
      scope: "shared",
      owner_id: "platform",
      title: "Product Context",
      content: "v1",
    });
    const second = store.upsertMemoryDocument({
      memory_doc_id: first.memory_doc_id,
      scope: "shared",
      owner_id: "platform",
      title: "Product Context",
      content: "v2",
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.memory_doc_id).toBe(first.memory_doc_id);
    expect(store.listMemoryDocumentVersions(first.memory_doc_id)).toEqual([
      first,
      second,
    ]);
  });

  it("lists only current memory document versions for a scope owner", () => {
    const store = createDataStore();
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
      scope: "bot",
      owner_id: "other-bot",
      title: "prd-guideline",
      content: "other",
    });

    expect(store.listCurrentMemoryDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual([currentGuideline, processDoc]);
  });
});
