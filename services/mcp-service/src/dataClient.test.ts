import { describe, expect, it } from "vitest";
import { createDataServiceClient } from "./dataClient.js";

describe("data service client", () => {
  it("creates business documents through data-service internal API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createDataServiceClient({
      baseUrl: "http://data-service:8300",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          document_id: "doc-1",
          title: "语音转文字 API PRD",
          version: 1,
        }, 201);
      },
    });

    const result = await client.createDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      content: "# PRD",
      tags: ["prd", "asr"],
    });

    expect(result).toEqual({
      document_id: "doc-1",
      title: "语音转文字 API PRD",
      version: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://data-service:8300/internal/documents");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
    });
  });

  it("throws data-service errors with their message", async () => {
    const client = createDataServiceClient({
      baseUrl: "http://data-service:8300",
      fetch: async () => jsonResponse({
        error: "bot config documents must use /v1/bot-config-documents",
      }, 400),
    });

    await expect(client.createDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "agents.md",
      doc_type: "config",
      content: "not allowed",
    })).rejects.toThrow("bot config documents must use /v1/bot-config-documents");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
