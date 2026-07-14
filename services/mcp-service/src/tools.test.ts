import { describe, expect, it, vi } from "vitest";
import {
  buildDefaultMcpCapabilityConfig,
  type TrustedMcpContext,
} from "@my-agent-toolkit/contracts";
import {
  callMcpTool,
  listMcpTools,
  type McpToolDependencies,
} from "./tools.js";

describe("document MCP tools", () => {
  const context: TrustedMcpContext = {
    bot_id: "prd-bot",
    user_id: "user-a",
    conversation_id: "conv-1",
    runtime: "kiro",
  };

  it("prepares the configured project using trusted conversation context", async () => {
    const ensure = vi.fn().mockResolvedValue({ path: "projects/im-test-hub" });
    const deps = createNoopDeps();
    deps.projectClient = {
      ensure,
      inspect: vi.fn(),
      read: vi.fn(),
      search: vi.fn(),
    };

    const result = await callMcpTool(context, deps, {
      tool: "project.ensure",
      input: { project_key: "im-test-hub" },
    });

    expect(result).toEqual({
      ok: true,
      result: { path: "projects/im-test-hub" },
    });
    expect(ensure).toHaveBeenCalledWith(context, "im-test-hub");
  });

  it("queries the shared project baseline without preparing a user workspace", async () => {
    const inspect = vi.fn().mockResolvedValue({ entries: [] });
    const read = vi.fn().mockResolvedValue({ content: "# README" });
    const search = vi.fn().mockResolvedValue({ results: [] });
    const deps = createNoopDeps();
    deps.projectClient = {
      ensure: vi.fn(),
      inspect,
      read,
      search,
    };

    await expect(callMcpTool(context, deps, {
      tool: "project.inspect",
      input: { project_key: "im-test-hub" },
    })).resolves.toEqual({ ok: true, result: { entries: [] } });
    await expect(callMcpTool(context, deps, {
      tool: "project.read",
      input: { project_key: "im-test-hub", path: "README.md", start_line: 2 },
    })).resolves.toEqual({ ok: true, result: { content: "# README" } });
    await expect(callMcpTool(context, deps, {
      tool: "project.search",
      input: { project_key: "im-test-hub", query: "SDK", path: "tests" },
    })).resolves.toEqual({ ok: true, result: { results: [] } });

    expect(inspect).toHaveBeenCalledWith(context, "im-test-hub");
    expect(read).toHaveBeenCalledWith(context, {
      projectKey: "im-test-hub",
      path: "README.md",
      startLine: 2,
    });
    expect(search).toHaveBeenCalledWith(context, {
      projectKey: "im-test-hub",
      query: "SDK",
      path: "tests",
    });
  });

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

  it("ingests document files into data-service and memory backend", async () => {
    const calls: unknown[] = [];
    const deps = createNoopDeps({
      async ingestFile(input) {
        calls.push({ backend: input });
        return {
          backend_memory_id: "vec-doc-1",
          chunks: 2,
        };
      },
    });
    deps.dataClient.createDocument = async (input) => {
      calls.push({ document: input });
      return {
        document_id: "doc-1",
        title: input.title,
        version: 1,
      };
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.ingest_file",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        filename: "asr-api.md",
        title: "语音转文字 API",
        doc_type: "prd",
        content: "# ASR API",
        tags: ["prd", "asr"],
        tier: "core",
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        document: {
          document_id: "doc-1",
          title: "语音转文字 API",
          version: 1,
        },
        backend: {
          backend_memory_id: "vec-doc-1",
          chunks: 2,
        },
      },
    });
    expect(calls).toEqual([
      {
        document: {
          scope: "bot",
          owner_id: "prd-bot",
          title: "语音转文字 API",
          doc_type: "prd",
          content: "# ASR API",
          tags: ["prd", "asr"],
          tier: "core",
          source_type: "file",
          source_uri: "asr-api.md",
          created_by_bot_id: "prd-bot",
          created_by_user_id: "user-a",
        },
      },
      {
        backend: {
          scope: "bot",
          owner_id: "prd-bot",
          filename: "asr-api.md",
          content: "# ASR API",
          tags: ["prd", "asr"],
          tier: "core",
          source_kind: "document",
          source_id: "doc-1",
        },
      },
    ]);
  });

  it("ingests document urls into data-service and memory backend", async () => {
    const calls: unknown[] = [];
    const deps = createNoopDeps({
      async fetchUrl(input) {
        calls.push({ backend: input });
        return {
          backend_memory_id: "vec-url-1",
          chunks: 4,
        };
      },
    });
    deps.dataClient.createDocument = async (input) => {
      calls.push({ document: input });
      return {
        document_id: "doc-url-1",
        title: input.title,
        version: 1,
      };
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.ingest_url",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        url: "https://example.com/asr",
        title: "ASR 参考资料",
        doc_type: "reference",
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        document: {
          document_id: "doc-url-1",
          title: "ASR 参考资料",
          version: 1,
        },
        backend: {
          backend_memory_id: "vec-url-1",
          chunks: 4,
        },
      },
    });
    expect(calls).toEqual([
      {
        document: expect.objectContaining({
          scope: "bot",
          owner_id: "prd-bot",
          title: "ASR 参考资料",
          doc_type: "reference",
          content: "Imported from URL: https://example.com/asr",
          source_type: "url",
          source_uri: "https://example.com/asr",
          created_by_bot_id: "prd-bot",
          created_by_user_id: "user-a",
        }),
      },
      {
        backend: {
          scope: "bot",
          owner_id: "prd-bot",
          url: "https://example.com/asr",
          source_kind: "document",
          source_id: "doc-url-1",
        },
      },
    ]);
  });

  it("scans authorized directories as document imports", async () => {
    const documents: unknown[] = [];
    const deps = createNoopDeps({
      async scanDirectory(input) {
        expect(input).toMatchObject({
          scope: "bot",
          owner_id: "prd-bot",
          directory_ref: "knowledge-base",
          directory: "/data/knowledge",
          source_kind: "document",
        });
        return {
          scanned: 2,
          files: [
            { backend_memory_id: "vec-1", filename: "a.md", chunks: 1 },
            { backend_memory_id: "vec-2", filename: "b.md", chunks: 3 },
          ],
        };
      },
    }, {
      "knowledge-base": "/data/knowledge",
    });
    deps.dataClient.createDocument = async (input) => {
      documents.push(input);
      return {
        document_id: `doc-${documents.length}`,
        title: input.title,
        version: 1,
      };
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.scan",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        directory_ref: "knowledge-base",
        doc_type: "reference",
        tags: ["kb"],
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        scanned: 2,
        documents: [
          { document_id: "doc-1", title: "a.md", version: 1 },
          { document_id: "doc-2", title: "b.md", version: 1 },
        ],
        backend: {
          scanned: 2,
          files: [
            { backend_memory_id: "vec-1", filename: "a.md", chunks: 1 },
            { backend_memory_id: "vec-2", filename: "b.md", chunks: 3 },
          ],
        },
      },
    });
    expect(documents).toEqual([
      expect.objectContaining({
        title: "a.md",
        doc_type: "reference",
        content: "Imported from directory knowledge-base: a.md",
        source_type: "file",
        source_uri: "knowledge-base/a.md",
        tags: ["kb"],
      }),
      expect.objectContaining({
        title: "b.md",
        source_uri: "knowledge-base/b.md",
      }),
    ]);
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

  it("rejects document writes outside bot capability writable scopes", async () => {
    let called = false;
    const deps = createNoopDeps();
    deps.capabilityConfig = {
      ...buildDefaultMcpCapabilityConfig(),
      documents: {
        enabled: true,
        writable_scopes: ["user"],
      },
    };
    deps.dataClient.createDocument = async () => {
      called = true;
      return {};
    };

    const result = await callMcpTool(context, deps, {
      tool: "document.create",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        title: "语音转文字 API PRD",
        doc_type: "prd",
        content: "# PRD",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "document writes to scope are disabled by bot capability config: bot",
      },
    });
    expect(called).toBe(false);
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

  it("rejects memory writes outside bot capability writable scopes", async () => {
    const calls: string[] = [];
    const deps = createNoopDeps({
      async storeMemory() {
        calls.push("backend");
        return {};
      },
    });
    deps.capabilityConfig = {
      ...buildDefaultMcpCapabilityConfig(),
      memory: {
        enabled: true,
        readable_scopes: ["bot"],
        writable_scopes: ["session"],
      },
    };
    deps.dataClient.createMemory = async () => {
      calls.push("data");
      return {};
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.write",
      input: {
        scope: "bot",
        owner_id: "prd-bot",
        content: "not allowed",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "memory writes to scope are disabled by bot capability config: bot",
      },
    });
    expect(calls).toEqual([]);
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

  it("rejects memory reads outside bot capability readable scopes", async () => {
    let called = false;
    const deps = createNoopDeps({
      async search() {
        called = true;
        return { results: [] };
      },
    });
    deps.capabilityConfig = {
      ...buildDefaultMcpCapabilityConfig(),
      memory: {
        enabled: true,
        readable_scopes: ["bot"],
        writable_scopes: ["bot"],
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.search",
      input: {
        query: "PRD",
        scopes: ["user"],
        owner_ids: ["user-a"],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "permission_denied",
        message: "memory reads from scope are disabled by bot capability config: user",
      },
    });
    expect(called).toBe(false);
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

describe("MCP tool discovery", () => {
  it("lists available tools with schemas and directory ref names", () => {
    const manifest = listMcpTools({
      allowedDirectoryRefs: {
        "knowledge-base": "/data/knowledge",
        prd: "/data/prd",
      },
    });

    expect(manifest.version).toBe(1);
    expect(manifest.directory_refs).toEqual(["knowledge-base", "prd"]);
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "document.create",
      "document.ingest_file",
      "document.ingest_url",
      "document.scan",
      "memory.write",
      "memory.ingest_file",
      "memory.ingest_url",
      "memory.scan",
      "memory.delete",
      "memory.search",
      "memory.stats",
      "search.query",
      "project.ensure",
      "project.inspect",
      "project.read",
      "project.search",
    ]);
    expect(manifest.tools.find((tool) => tool.name === "document.create")).toMatchObject({
      category: "document",
      permissions: {
        writes: ["bot", "user", "session"],
        reads: [],
      },
      input_schema: {
        required: ["scope", "owner_id", "title", "doc_type", "content"],
      },
    });
    expect(manifest.tools.find((tool) => tool.name === "document.scan")).toMatchObject({
      input_schema: {
        properties: {
          directory_ref: {
            enum: ["knowledge-base", "prd"],
          },
        },
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
