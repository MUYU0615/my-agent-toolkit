import { describe, expect, it } from "vitest";
import { createLogStore } from "./store.js";

describe("log-service store", () => {
  it("records and lists chat events by bot", () => {
    const store = createLogStore();

    const event = store.recordChatEvent({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "hello",
      output: "mock: hello",
      run_id: "run-1",
      memory_refs: [
        {
          scope: "bot",
          owner_id: "prd-bot",
          memory_doc_id: "mem-1",
          title: "soul",
          version: 2,
        },
      ],
    });

    expect(event.event_id).toMatch(/^evt_/);
    expect(event.created_at).toEqual(expect.any(String));
    expect(store.listChatEvents("prd-bot")).toEqual([event]);
  });

  it("filters chat events by conversation run time range and pagination", () => {
    const store = createLogStore();

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
  });

  it("records and lists audit events by target", () => {
    const store = createLogStore();

    const event = store.recordAuditEvent({
      actor_id: "admin-a",
      action: "bot.ready",
      target_type: "bot",
      target_id: "prd-bot",
      metadata: {
        status: "ready",
      },
    });

    expect(event.event_id).toMatch(/^audit_/);
    expect(event.created_at).toEqual(expect.any(String));
    expect(store.listAuditEvents({
      target_type: "bot",
      target_id: "prd-bot",
    })).toEqual([event]);
  });

  it("records redacted tool events and lists them by bot", () => {
    const store = createLogStore();

    const event = store.recordToolEvent({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      tool_name: "memory.write",
      input_summary: {
        content: "remember this",
        secret: "super-secret-value",
        nested: {
          api_key: "api-key-value",
        },
      },
      output_summary: {
        memory_id: "mem-1",
        token: "runner-token-value",
      },
      target_type: "memory",
      target_id: "mem-1",
      status: "ok",
      duration_ms: 42,
    });

    expect(event.event_id).toMatch(/^tool_/);
    expect(event.created_at).toEqual(expect.any(String));
    expect(JSON.stringify(event)).not.toContain("super-secret-value");
    expect(JSON.stringify(event)).not.toContain("api-key-value");
    expect(JSON.stringify(event)).not.toContain("runner-token-value");
    expect(event.input_summary).toEqual({
      content: "remember this",
      secret: "[REDACTED]",
      nested: {
        api_key: "[REDACTED]",
      },
    });
    expect(event.output_summary).toEqual({
      memory_id: "mem-1",
      token: "[REDACTED]",
    });
    expect(store.listToolEvents({
      bot_id: "prd-bot",
    })).toEqual([event]);
  });
});
