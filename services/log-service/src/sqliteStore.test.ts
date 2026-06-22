import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteLogStore } from "./sqliteStore.js";

describe("sqlite log store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists chat events across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "log.db");

    const first = createSqliteLogStore(dbPath);
    const event = first.recordChatEvent({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
      prompt: "hello",
      output: "answer",
      run_id: "run-1",
      memory_refs: [
        {
          scope: "bot",
          owner_id: "prd-bot",
          memory_doc_id: "mem-soul",
          title: "soul",
          version: 3,
        },
      ],
    });
    first.close?.();

    const second = createSqliteLogStore(dbPath);
    expect(second.listChatEvents("prd-bot")).toEqual([event]);
    second.close?.();
  });

  it("filters chat events by conversation run time range and pagination", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "log.db");
    const store = createSqliteLogStore(dbPath);

    const first = store.recordChatEvent({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "first",
      output: "first output",
      run_id: "run-1",
      memory_refs: [],
    });
    const second = store.recordChatEvent({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "second",
      output: "second output",
      run_id: "run-2",
      memory_refs: [],
    });
    store.recordChatEvent({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-2",
      runtime: "mock",
      prompt: "third",
      output: "third output",
      run_id: "run-3",
      memory_refs: [],
    });

    expect(store.listChatEvents({
      bot_id: "prd-bot",
      conversation_id: "conv-1",
      created_from: first.created_at,
      created_to: second.created_at,
      limit: 1,
      offset: 1,
    })).toEqual([second]);
    expect(store.listChatEvents({
      bot_id: "prd-bot",
      run_id: "run-1",
    })).toEqual([first]);
    store.close?.();
  });

  it("persists audit events across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "log.db");

    const first = createSqliteLogStore(dbPath);
    const event = first.recordAuditEvent({
      actor_id: "admin-a",
      action: "admin.transfer",
      target_type: "bot",
      target_id: "prd-bot",
      metadata: {
        new_wecom_user_id: "admin-b",
      },
    });
    first.close?.();

    const second = createSqliteLogStore(dbPath);
    expect(second.listAuditEvents({
      target_type: "bot",
      target_id: "prd-bot",
    })).toEqual([event]);
    second.close?.();
  });

  it("persists redacted tool events across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "log.db");

    const first = createSqliteLogStore(dbPath);
    const event = first.recordToolEvent({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      tool_name: "document.create",
      input_summary: {
        title: "语音转文字 API PRD",
        claim_code: "123456",
      },
      output_summary: {
        document_id: "doc-1",
      },
      target_type: "document",
      target_id: "doc-1",
      status: "ok",
      duration_ms: 35,
    });
    first.close?.();

    const second = createSqliteLogStore(dbPath);
    expect(JSON.stringify(event)).not.toContain("123456");
    expect(second.listToolEvents({
      bot_id: "prd-bot",
    })).toEqual([event]);
    second.close?.();
  });
});
