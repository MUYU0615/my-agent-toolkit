import { describe, expect, it } from "vitest";
import {
  buildMcpPromptSection,
  callMcpTool,
  fetchMcpToolManifest,
  formatMcpToolResult,
  parseMcpToolCallRequest,
  parseMcpToolCall,
  signRunnerToken,
} from "./mcpClient.js";

describe("mcpClient", () => {
  it("fetches tool manifests with a signed runner token", async () => {
    const requests: Request[] = [];
    const manifest = {
      version: 1,
      directory_refs: ["knowledge-base"],
      tools: [
        {
          name: "document.create",
          category: "document",
          description: "Create a document.",
          input_schema: {
            type: "object",
            required: ["scope", "owner_id", "title", "doc_type", "content"],
            properties: {},
          },
          permissions: {
            reads: [],
            writes: ["bot", "user", "session"],
          },
        },
      ],
    };

    const result = await fetchMcpToolManifest({
      service_url: "http://mcp-service:8700",
      runner_secret: "runner-secret",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    }, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    expect(result).toEqual(manifest);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://mcp-service:8700/mcp/bots/prd-bot/sessions/conv-1/tools");
    expect(requests[0].headers.get("x-runner-token")).toMatch(/^[^.]+\.[^.]+$/);
  });

  it("builds a compact prompt section from a tool manifest", () => {
    const section = buildMcpPromptSection({
      version: 1,
      directory_refs: ["knowledge-base"],
      tools: [
        {
          name: "document.create",
          category: "document",
          description: "Create a document.",
          input_schema: {
            type: "object",
            required: ["scope", "owner_id", "title", "doc_type", "content"],
            properties: {},
          },
          permissions: {
            reads: [],
            writes: ["bot", "user", "session"],
          },
        },
      ],
    });

    expect(section).toContain("<mcp_tools>");
    expect(section).toContain("Allowed directory refs: knowledge-base");
    expect(section).toContain("document.create");
    expect(section).toContain("required: scope, owner_id, title, doc_type, content");
    expect(section).toContain("&lt;mcp_tool_call&gt;{\"tool\":\"tool.name\",\"input\":{}}&lt;/mcp_tool_call&gt;");
    expect(section).toContain("The user prepares the project with /sync");
    expect(section).toContain("Native Git commit and push are disabled in the CLI runtime");
    expect(section).toContain("reply with exactly one project.publish MCP call first");
    expect(section).toContain("Do not invoke native Kiro CLI tools");
    expect(section).toContain("</mcp_tools>");
  });

  it("signs runner tokens using the MCP runner secret", () => {
    const token = signRunnerToken("runner-secret", {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    expect(token).toMatch(/^[^.]+\.[^.]+$/);
  });

  it("parses a single XML wrapped MCP tool call", () => {
    expect(parseMcpToolCall([
      "before",
      "<mcp_tool_call>",
      "{\"tool\":\"memory.search\",\"input\":{\"query\":\"ASR\",\"scopes\":[\"bot\"],\"owner_ids\":[\"prd-bot\"]}}",
      "</mcp_tool_call>",
      "after",
    ].join("\n"))).toEqual({
      tool: "memory.search",
      input: {
        query: "ASR",
        scopes: ["bot"],
        owner_ids: ["prd-bot"],
      },
    });
  });

  it("returns no_call when runtime output has no MCP tool call", () => {
    expect(parseMcpToolCallRequest("plain answer")).toEqual({
      status: "none",
    });
  });

  it("returns protocol errors for invalid MCP tool call JSON", () => {
    expect(parseMcpToolCallRequest("<mcp_tool_call>{bad json}</mcp_tool_call>")).toEqual({
      status: "error",
      result: {
        ok: false,
        error: {
          code: "invalid_tool_call_json",
          message: "MCP tool call JSON is invalid",
        },
      },
    });
  });

  it("returns protocol errors for multiple MCP tool calls", () => {
    expect(parseMcpToolCallRequest([
      "<mcp_tool_call>{\"tool\":\"memory.search\",\"input\":{}}</mcp_tool_call>",
      "<mcp_tool_call>{\"tool\":\"memory.stats\",\"input\":{}}</mcp_tool_call>",
    ].join("\n"))).toEqual({
      status: "error",
      result: {
        ok: false,
        error: {
          code: "multiple_tool_calls",
          message: "Only one MCP tool call is allowed per runtime turn",
        },
      },
    });
  });

  it("returns protocol errors for missing MCP tool names", () => {
    expect(parseMcpToolCallRequest("<mcp_tool_call>{\"input\":{}}</mcp_tool_call>")).toEqual({
      status: "error",
      result: {
        ok: false,
        error: {
          code: "invalid_tool_call",
          message: "MCP tool call requires a non-empty tool name",
        },
      },
    });
  });

  it("calls MCP tools with a signed runner token", async () => {
    const requests: Request[] = [];
    const result = await callMcpTool({
      service_url: "http://mcp-service:8700",
      runner_secret: "runner-secret",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        expect(await request.json()).toEqual({
          tool: "memory.search",
          input: {
            query: "ASR",
          },
        });
        return new Response(JSON.stringify({
          ok: true,
          result: {
            results: [],
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    }, {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    }, {
      tool: "memory.search",
      input: {
        query: "ASR",
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        results: [],
      },
    });
    expect(requests[0].url).toBe("http://mcp-service:8700/mcp/bots/prd-bot/sessions/conv-1/tools/call");
    expect(requests[0].headers.get("x-runner-token")).toMatch(/^[^.]+\.[^.]+$/);
  });

  it("formats MCP tool results for runtime consumption", () => {
    expect(formatMcpToolResult({
      ok: true,
      result: {
        document_id: "doc-1",
      },
    })).toBe([
      "<mcp_tool_result>",
      "{\"ok\":true,\"result\":{\"document_id\":\"doc-1\"}}",
      "</mcp_tool_result>",
    ].join("\n"));
  });
});
