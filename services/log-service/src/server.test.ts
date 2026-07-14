import { describe, expect, it } from "vitest";
import { createLogServiceServer } from "./server.js";

describe("log-service server", () => {
  it("responds to health checks", async () => {
    const server = createLogServiceServer();

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "log-service",
      status: "ok",
    });
  });

  it("records and lists chat events over HTTP", async () => {
    const server = createLogServiceServer();

    const recordResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "hello",
          output: "mock: hello",
          run_id: "run-1",
          memory_refs: [],
        }),
      }),
    );

    expect(recordResponse.status).toBe(201);
    const created = await recordResponse.json() as { event_id: string };

    const listResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events?bot_id=prd-bot"),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject([
      {
        event_id: created.event_id,
        bot_id: "prd-bot",
        prompt: "hello",
        output: "mock: hello",
      },
    ]);
  });

  it("filters chat events over HTTP", async () => {
    const server = createLogServiceServer();

    const firstResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "first",
          output: "first output",
          run_id: "run-1",
          memory_refs: [],
        }),
      }),
    );
    const first = await firstResponse.json() as { created_at: string };

    const secondResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "second",
          output: "second output",
          run_id: "run-2",
          memory_refs: [],
        }),
      }),
    );
    const second = await secondResponse.json() as { created_at: string };

    await server.fetch(
      new Request("http://localhost/v1/chat-events", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          conversation_id: "conv-2",
          runtime: "mock",
          prompt: "third",
          output: "third output",
          run_id: "run-3",
          memory_refs: [],
        }),
      }),
    );

    const filteredResponse = await server.fetch(
      new Request(
        `http://localhost/v1/chat-events?bot_id=prd-bot&conversation_id=conv-1&created_from=${encodeURIComponent(first.created_at)}&created_to=${encodeURIComponent(second.created_at)}&limit=1&offset=1&order=asc`,
      ),
    );

    expect(filteredResponse.status).toBe(200);
    await expect(filteredResponse.json()).resolves.toMatchObject([
      {
        bot_id: "prd-bot",
        conversation_id: "conv-1",
        run_id: "run-2",
      },
    ]);

    const latestResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events?bot_id=prd-bot&conversation_id=conv-1&limit=1"),
    );
    await expect(latestResponse.json()).resolves.toMatchObject([
      { run_id: "run-2" },
    ]);

    const runResponse = await server.fetch(
      new Request("http://localhost/v1/chat-events?bot_id=prd-bot&run_id=run-1"),
    );

    await expect(runResponse.json()).resolves.toMatchObject([
      {
        run_id: "run-1",
      },
    ]);
  });

  it("records and lists audit events over HTTP", async () => {
    const server = createLogServiceServer();

    const recordResponse = await server.fetch(
      new Request("http://localhost/v1/audit-events", {
        method: "POST",
        body: JSON.stringify({
          actor_id: "admin-a",
          action: "memory.upsert",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            title: "soul",
          },
        }),
      }),
    );

    expect(recordResponse.status).toBe(201);
    const created = await recordResponse.json() as { event_id: string };

    const listResponse = await server.fetch(
      new Request(
        "http://localhost/v1/audit-events?target_type=bot&target_id=prd-bot",
      ),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject([
      {
        event_id: created.event_id,
        actor_id: "admin-a",
        action: "memory.upsert",
        target_type: "bot",
        target_id: "prd-bot",
      },
    ]);
  });

  it("records and lists internal tool events over HTTP with redaction", async () => {
    const server = createLogServiceServer();

    const recordResponse = await server.fetch(
      new Request("http://localhost/internal/tool-events", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          tool_name: "memory.write",
          input_summary: {
            content: "remember this",
            api_key: "api-key-value",
          },
          output_summary: {
            memory_id: "mem-1",
          },
          target_type: "memory",
          target_id: "mem-1",
          status: "ok",
          duration_ms: 42,
        }),
      }),
    );

    expect(recordResponse.status).toBe(201);
    const created = await recordResponse.json() as { event_id: string };
    expect(JSON.stringify(created)).not.toContain("api-key-value");

    const listResponse = await server.fetch(
      new Request("http://localhost/internal/tool-events?bot_id=prd-bot"),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject([
      {
        event_id: created.event_id,
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-1",
        tool_name: "memory.write",
        input_summary: {
          content: "remember this",
          api_key: "[REDACTED]",
        },
        status: "ok",
      },
    ]);
  });
});
