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
      },
    };

    const result = await callMcpTool(context, deps, {
      tool: "memory.write",
      input: {},
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "validation_error",
        message: "unsupported MCP tool: memory.write",
      },
    });
  });
});
