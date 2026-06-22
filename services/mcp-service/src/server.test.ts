import { describe, expect, it } from "vitest";
import { buildDefaultMcpCapabilityConfig } from "@my-agent-toolkit/contracts";
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

  it("lists MCP tools for a valid MCP session", async () => {
    const server = createMcpServiceServer({
      runnerSecret,
      dataClient: dataClientWithCapability({
        ...buildDefaultMcpCapabilityConfig(),
        directory_refs: ["knowledge-base"],
      }),
      allowedDirectoryRefs: {
        "knowledge-base": "/data/knowledge",
      },
    });
    const token = signRunnerToken(runnerSecret, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    const response = await server.fetch(
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/tools", {
        headers: {
          "x-runner-token": token,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      version: number;
      directory_refs: string[];
      tools: Array<{ name: string }>;
    };
    expect(body.version).toBe(1);
    expect(body.directory_refs).toEqual(["knowledge-base"]);
    expect(body.tools).toContainEqual(expect.objectContaining({
      name: "document.create",
    }));
  });

  it("filters MCP tools by bot capability config", async () => {
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
        async getMcpCapabilityConfig() {
          return {
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
            directory_refs: ["knowledge-base"],
          };
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
      new Request("http://localhost/mcp/bots/prd-bot/sessions/conv-1/tools", {
        headers: {
          "x-runner-token": token,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      directory_refs: string[];
      tools: Array<{ name: string }>;
    };
    expect(body.directory_refs).toEqual(["knowledge-base"]);
    expect(body.tools).toEqual([
      expect.objectContaining({ name: "memory.search" }),
    ]);
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
        async getMcpCapabilityConfig() {
          return buildDefaultMcpCapabilityConfig();
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

  it("rejects tool calls disabled by bot capability config", async () => {
    const runnerSecret = "test-runner-secret";
    const calls: unknown[] = [];
    const server = createMcpServiceServer({
      runnerSecret,
      dataClient: {
        async createDocument(input) {
          calls.push(input);
          return {};
        },
        async createMemory() {
          return {};
        },
        async getMemoryStats() {
          return {};
        },
        async getMcpCapabilityConfig() {
          return {
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
            directory_refs: [],
          };
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
      ok: false,
      error: {
        code: "permission_denied",
        message: "MCP tool is disabled by bot capability config: document.create",
      },
    });
    expect(calls).toEqual([]);
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
        async getMcpCapabilityConfig() {
          return {
            ...buildDefaultMcpCapabilityConfig(),
            directory_refs: ["knowledge-base"],
          };
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

function dataClientWithCapability(
  config = buildDefaultMcpCapabilityConfig(),
) {
  return {
    async createDocument() {
      return {};
    },
    async createMemory() {
      return {};
    },
    async getMemoryStats() {
      return {};
    },
    async getMcpCapabilityConfig() {
      return config;
    },
  };
}
