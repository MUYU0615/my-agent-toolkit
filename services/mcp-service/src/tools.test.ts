import { describe, expect, it } from "vitest";
import type { TrustedMcpContext } from "@my-agent-toolkit/contracts";
import { callMcpTool, type McpToolDependencies } from "./tools.js";

describe("document MCP tools", () => {
  const context: TrustedMcpContext = {
    bot_id: "prd-bot",
    user_id: "user-a",
    conversation_id: "conv-1",
    runtime: "kiro",
  };

  it("creates bot scoped documents through data-service", async () => {
    const calls: unknown[] = [];
    const deps: McpToolDependencies = {
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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.create",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        title: "语音转文字 API PRD",
        doc_type: "prd",
        content: "# PRD",
        tags: ["prd", "asr"],
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        document_id: "doc-1",
        title: "语音转文字 API PRD",
        version: 1,
      },
    });
    expect(calls).toEqual([
      {
        scope: "bot",
        owner_id: "prd-bot",
        title: "语音转文字 API PRD",
        doc_type: "prd",
        content: "# PRD",
        tags: ["prd", "asr"],
      },
    ]);
  });

  it("rejects config document titles before calling data-service", async () => {
    let called = false;
    const deps: McpToolDependencies = {
      dataClient: {
        async createDocument() {
          called = true;
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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.create",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        title: "agents.md",
        doc_type: "config",
        content: "not allowed",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "validation_error",
        message: "document title is reserved for bot configuration",
      },
    });
    expect(called).toBe(false);
  });

  it("prevents a bot from writing another bot owner scope", async () => {
    const deps: McpToolDependencies = {
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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.create",
      input: {
        scope: "bot",
        owner_id: "other-bot",
        title: "Other PRD",
        doc_type: "prd",
        content: "# PRD",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "bot scope owner must match trusted bot_id",
      },
    });
  });

  it("returns unsupported tool errors", async () => {
    const deps: McpToolDependencies = {
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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "unknown.tool",
      input: {},
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "validation_error",
        message: "unsupported MCP tool: unknown.tool",
      },
    });
  });

  it("writes user memory to data-service and memory backend", async () => {
    const calls: string[] = [];
    const deps: McpToolDependencies = {
      dataClient: {
        async createDocument() {
          return {};
        },
        async createMemory(input) {
          calls.push(`data:${input.content}`);
          return {
            memory_id: "mem-1",
            scope: input.scope,
            owner_id: input.owner_id,
          };
        },
        async getMemoryStats() {
          return {};
        },
      },
      memoryBackend: {
        async storeMemory(input) {
          calls.push(`backend:${input.content}`);
          return {
            backend_memory_id: "vec-1",
            chunks: 2,
          };
        },
        async search() {
          return { results: [] };
        },
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.write",
      input: {
        scope: "user",
        owner_id: "user-a",
        content: "用户关注环信 IM 产品和 PRD 质量。",
        tier: "core",
        tags: ["user-profile"],
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        memory: {
          memory_id: "mem-1",
          scope: "user",
          owner_id: "user-a",
        },
        backend: {
          backend_memory_id: "vec-1",
          chunks: 2,
        },
      },
    });
    expect(calls).toEqual([
      "data:用户关注环信 IM 产品和 PRD 质量。",
      "backend:用户关注环信 IM 产品和 PRD 质量。",
    ]);
  });

  it("rejects user memory writes for a different user owner", async () => {
    const deps = createNoopDeps();

    const result = await callMcpTool(context, deps, {
      tool: "memory.write",
      input: {
        scope: "user",
        owner_id: "other-user",
        content: "not allowed",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "user scope owner must match trusted user_id",
      },
    });
  });

  it("searches memory through memory backend", async () => {
    const deps: McpToolDependencies = {
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
        async search(input) {
          expect(input).toEqual({
            query: "PRD 质量",
            scopes: ["user", "bot"],
            owner_ids: ["user-a", "prd-bot"],
            tags: ["prd"],
            limit: 5,
          });
          return {
            results: [
              {
                source: "memory",
                id: "mem-1",
                snippet: "用户关注 PRD 质量。",
                score: 0.91,
                metadata: {
                  tier: "core",
                },
              },
            ],
          };
        },
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.search",
      input: {
        query: "PRD 质量",
        scopes: ["user", "bot"],
        owner_ids: ["user-a", "prd-bot"],
        tags: ["prd"],
        limit: 5,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        results: [
          {
            source: "memory",
            id: "mem-1",
            snippet: "用户关注 PRD 质量。",
            score: 0.91,
            metadata: {
              tier: "core",
            },
          },
        ],
      },
    });
  });

  it("returns memory stats from data-service", async () => {
    const deps: McpToolDependencies = {
      dataClient: {
        async createDocument() {
          return {};
        },
        async createMemory() {
          return {};
        },
        async getMemoryStats(input) {
          expect(input).toEqual({
            scope: "bot",
            owner_id: "prd-bot",
          });
          return {
            total_memories: 2,
            total_chunks: 8,
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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.stats",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        total_memories: 2,
        total_chunks: 8,
      },
    });
  });

  it("runs unified search through memory backend", async () => {
    const deps: McpToolDependencies = {
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
        async search(input) {
          expect(input).toMatchObject({
            query: "语音转文字 API",
            sources: ["documents", "memories"],
            scopes: ["bot"],
            owner_ids: ["prd-bot"],
          });
          return {
            results: [
              {
                source: "document",
                id: "doc-1",
                title: "语音转文字 API PRD",
                snippet: "计量计费",
                score: 0.93,
                metadata: {
                  doc_type: "prd",
                },
              },
            ],
          };
        },
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "search.query",
      input: {
        query: "语音转文字 API",
        sources: ["documents", "memories"],
        scopes: ["bot"],
        owner_ids: ["prd-bot"],
        limit: 10,
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        results: [
          {
            source: "document",
            id: "doc-1",
            title: "语音转文字 API PRD",
            snippet: "计量计费",
            score: 0.93,
            metadata: {
              doc_type: "prd",
            },
          },
        ],
      },
    });
  });

  it("ingests files as memory through memory backend", async () => {
    const deps = createNoopDeps({
      async ingestFile(input) {
        expect(input).toMatchObject({
          scope: "bot",
          owner_id: "prd-bot",
          filename: "guide.md",
          content: "# Guide",
          source_kind: "memory",
        });
        return {
          backend_memory_id: "mem-file",
          chunks: 3,
        };
      },
    });

    const result = await callMcpTool(context, deps, {
      tool: "memory.ingest_file",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        filename: "guide.md",
        content: "# Guide",
        tags: ["guide"],
        tier: "core",
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        backend_memory_id: "mem-file",
        chunks: 3,
      },
    });
  });

  it("fetches urls and scans authorized directories through memory backend", async () => {
    const deps = createNoopDeps({
      async fetchUrl(input) {
        expect(input.url).toBe("https://example.com/policy");
        return { backend_memory_id: "mem-url", chunks: 2 };
      },
      async scanDirectory(input) {
        expect(input.directory_ref).toBe("knowledge-base");
        expect(input.directory).toBe("/data/knowledge");
        return { scanned: 1, files: [] };
      },
    }, {
      "knowledge-base": "/data/knowledge",
    });

    await expect(callMcpTool(context, deps, {
      tool: "memory.ingest_url",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        url: "https://example.com/policy",
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        backend_memory_id: "mem-url",
        chunks: 2,
      },
    });

    await expect(callMcpTool(context, deps, {
      tool: "memory.scan",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        directory_ref: "knowledge-base",
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        scanned: 1,
        files: [],
      },
    });
  });

  it("rejects unknown directory refs and deletes backend memory", async () => {
    const deps = createNoopDeps({
      async deleteMemory(memoryId) {
        expect(memoryId).toBe("mem-1");
        return { deleted: "mem-1" };
      },
    });

    await expect(callMcpTool(context, deps, {
      tool: "memory.scan",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        directory_ref: "missing",
      },
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "directory_ref is not authorized",
      },
    });

    await expect(callMcpTool(context, deps, {
      tool: "memory.delete",
      input: {
        memory_id: "mem-1",
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        deleted: "mem-1",
      },
    });
  });
});

function createNoopDeps(
  memoryOverrides: Partial<McpToolDependencies["memoryBackend"]> = {},
  allowedDirectoryRefs: Record<string, string> = {},
): McpToolDependencies {
  return {
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
      ...memoryOverrides,
    },
    allowedDirectoryRefs,
  };
}
