import { describe, expect, it } from "vitest";
import { signRunnerToken } from "./context.js";
import {
  createMcpServiceServer,
  parseAllowedDirectoryRefs,
} from "./server.js";

describe("mcp-service server", () => {
  const runnerSecret = "test-runner-secret";

  it("responds to health checks", async () => {
    const server = createMcpServiceServer({ runnerSecret });

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "mcp-service",
      status: "ok",
    });
  });

  it("requires a runner token for MCP session routes", async () => {
    const server = createMcpServiceServer({ runnerSecret });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/context"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "permission_denied",
        message: "x-runner-token is required",
      },
    });
  });

  it("accepts a valid runner token for the requested MCP session", async () => {
    const server = createMcpServiceServer({ runnerSecret });
    const token = signRunnerToken(runnerSecret, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/context", {
        headers: {
          "x-runner-token": token,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });
  });

  it("rejects a runner token for a different MCP session", async () => {
    const server = createMcpServiceServer({ runnerSecret });
    const token = signRunnerToken(runnerSecret, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/other-bot/sessions/conv-1/context", {
        headers: {
          "x-runner-token": token,
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "permission_denied",
        message: "runner token context does not match request path",
      },
    });
  });

  it("calls document tools for a valid MCP session", async () => {
    const runnerSecret = "test-runner-secret";
    const calls: unknown[] = [];
    const server = createMcpServiceServer({
      runnerSecret,
      dataClient: {
        async createDocument(input) {
          calls.push(input);
          return {
            document_id: "doc-1",
            title: input.title,
            version: 1,
          };
        },
        async createMemory() {
          return {};
        },
        async getMemoryStats() {
          return {};
        },
      },
      memoryBackend: {
        async storeMemory() {
          return {};
        },
        async search() {
          return { results: [] };
        },
        async ingestFile() {
          return {};
        },
        async fetchUrl() {
          return {};
        },
        async scanDirectory() {
          return {};
        },
        async deleteMemory() {
          return {};
        },
      },
    });
    const token = signRunnerToken(runnerSecret, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/tools/call", {
        method: "POST",
        headers: {
          "x-runner-token": token,
        },
        body: JSON.stringify({
          tool: "document.create",
          input: {
            scope: "bot",
            owner_id: "prd-bot",
            title: "语音转文字 API PRD",
            doc_type: "prd",
            content: "# PRD",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: {
        document_id: "doc-1",
        title: "语音转文字 API PRD",
        version: 1,
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("passes configured directory refs to MCP tools", async () => {
    const runnerSecret = "test-runner-secret";
    const scanCalls: unknown[] = [];
    const server = createMcpServiceServer({
      runnerSecret,
      allowedDirectoryRefs: {
        "knowledge-base": "/data/knowledge",
      },
      dataClient: {
        async createDocument() {
          return {};
        },
        async createMemory() {
          return {};
        },
        async getMemoryStats() {
          return {};
        },
      },
      memoryBackend: {
        async storeMemory() {
          return {};
        },
        async search() {
          return { results: [] };
        },
        async ingestFile() {
          return {};
        },
        async fetchUrl() {
          return {};
        },
        async scanDirectory(input) {
          scanCalls.push(input);
          return { imported: 1 };
        },
        async deleteMemory() {
          return {};
        },
      },
    });
    const token = signRunnerToken(runnerSecret, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/tools/call", {
        method: "POST",
        headers: {
          "x-runner-token": token,
        },
        body: JSON.stringify({
          tool: "memory.scan",
          input: {
            scope: "bot",
            owner_id: "prd-bot",
            directory_ref: "knowledge-base",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(scanCalls).toEqual([
      expect.objectContaining({
        directory: "/data/knowledge",
        scope: "bot",
        owner_id: "prd-bot",
      }),
    ]);
  });

  it("parses allowed directory refs from env-style config", () => {
    expect(parseAllowedDirectoryRefs("knowledge-base:/data/knowledge,prd:/data/prd")).toEqual({
      "knowledge-base": "/data/knowledge",
      prd: "/data/prd",
    });
  });
});
