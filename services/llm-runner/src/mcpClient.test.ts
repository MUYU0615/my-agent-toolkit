import { describe, expect, it } from "vitest";
import {
  buildMcpPromptSection,
  fetchMcpToolManifest,
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
});
