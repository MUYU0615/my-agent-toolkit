import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createLlmRunnerServer } from "./server.js";

describe("llm-runner server", () => {
  it("responds to health checks", async () => {
    const server = createLlmRunnerServer();
    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "llm-runner",
      status: "ok",
    });
  });

  it("reports runtime statuses", async () => {
    const server = createLlmRunnerServer();
    const response = await server.fetch(
      new Request("http://localhost/v1/runtimes"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runtimes: [
        {
          runtime: "mock",
          enabled: true,
          configured: true,
          available: true,
        },
      ],
    });
  });

  it("runs mock chat requests", async () => {
    const server = createLlmRunnerServer();
    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      output: "mock: hello",
      runner_session_id: "mock:prd-bot:user-a:conv-1",
    });
    expect(body.run_id).toMatch(/^run_/);
  });

  it("injects MCP tool manifest into runtime prompts when configured", async () => {
    const mcpRequests: Request[] = [];
    const server = createLlmRunnerServer({
      enabled_runtimes: ["mock"],
      mcp: {
        service_url: "http://mcp-service:8700",
        runner_secret: "runner-secret",
      },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        return new Response(JSON.stringify({
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
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toContain("<mcp_tools>");
    expect(body.output).toContain("document.create");
    expect(body.output).toContain("<message>\nhello\n</message>");
    expect(mcpRequests[0].url).toBe("http://mcp-service:8700/mcp/bots/prd-bot/sessions/conv-1/tools");
  });

  it("executes one MCP tool call emitted by the runtime and resumes for final output", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('<mcp_tool_result>')) {",
      "    process.stdout.write('最终回复: mem-1');",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"memory.search\",\"input\":{\"query\":\"ASR\"}}</mcp_tool_call>');",
      "  }",
      "});",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          command,
        ],
        timeout_ms: 1000,
      },
      mcp: {
        service_url: "http://mcp-service:8700",
        runner_secret: "runner-secret",
      },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        if (request.url.endsWith("/tools")) {
          return new Response(JSON.stringify({
            version: 1,
            directory_refs: [],
            tools: [],
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        expect(request.url).toBe("http://mcp-service:8700/mcp/bots/prd-bot/sessions/conv-1/tools/call");
        expect(await request.json()).toEqual({
          tool: "memory.search",
          input: {
            query: "ASR",
          },
        });
        return new Response(JSON.stringify({
          ok: true,
          result: {
            results: [{ id: "mem-1" }],
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "search memory",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toBe("最终回复: mem-1");
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-1/tools",
      "/mcp/bots/prd-bot/sessions/conv-1/tools/call",
    ]);
  });

  it("returns not implemented for unavailable runtimes", async () => {
    const server = createLlmRunnerServer();
    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "runtime is not available yet",
    });
  });

  it("runs enabled kiro runtime through CLI adapter", async () => {
    const server = createLlmRunnerServer({
      enabled_runtimes: ["mock", "kiro"],
      kiro: {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        timeout_ms: 1000,
      },
    });
    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "hello kiro adapter",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
      output: "hello kiro adapter",
    });
  });

  it("injects bot env vars into cli runtime execution without exposing them in prompt or output", async () => {
    const secretKey = "BOT_PRIVATE_TEST_SECRET";
    const sentinelPath = `/tmp/${secretKey}-value.txt`;
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `const value = process.env.${secretKey} || 'missing';`,
            `fs.writeFileSync(${JSON.stringify(sentinelPath)}, value, 'utf8');`,
            "process.stdout.write(`secret=${value}`);",
          ].join(" "),
        ],
        timeout_ms: 1000,
      },
      resolveBotEnvVars: vi.fn(async (botId: string) => {
        expect(botId).toBe("prd-bot");
        return {
          [secretKey]: "sk-live-secret",
        };
      }),
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "print your env",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toBe("secret=[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("sk-live-secret");
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("sk-live-secret");
  });

  it("streams enabled kiro runtime output as ndjson chunks", async () => {
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('he'); setTimeout(() => process.stdout.write('llo'), 10)",
        ],
        timeout_ms: 1000,
      },
    });
    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "hello kiro adapter",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      type: "run",
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
    });
    expect(lines[0].run_id).toMatch(/^run_/);
    expect(lines.slice(1)).toEqual([
      { type: "chunk", content: "he" },
      { type: "chunk", content: "llo" },
      { type: "done" },
    ]);
  });

  it("streams final runtime output after an MCP tool call", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('<mcp_tool_result>')) {",
      "    process.stdout.write('最终');",
      "    setTimeout(() => process.stdout.write('回复'), 10);",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"memory.search\",\"input\":{\"query\":\"ASR\"}}</mcp_tool_call>');",
      "  }",
      "});",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: ["-e", command],
        timeout_ms: 1000,
      },
      mcp: {
        service_url: "http://mcp-service:8700",
        runner_secret: "runner-secret",
      },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        if (request.url.endsWith("/tools")) {
          return new Response(JSON.stringify({
            version: 1,
            directory_refs: [],
            tools: [],
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          result: {
            results: [{ id: "mem-1" }],
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "search memory",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      type: "run",
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
    });
    expect(lines.slice(1)).toEqual([
      { type: "chunk", content: "最终" },
      { type: "chunk", content: "回复" },
      { type: "done" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("mcp_tool_call");
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-1/tools",
      "/mcp/bots/prd-bot/sessions/conv-1/tools/call",
    ]);
  });

  it("feeds MCP tool call protocol errors back into streaming runtime output", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('invalid_tool_call_json')) {",
      "    process.stdout.write('工具调用格式错误');",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call>{bad json}</mcp_tool_call>');",
      "  }",
      "});",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: ["-e", command],
        timeout_ms: 1000,
      },
      mcp: {
        service_url: "http://mcp-service:8700",
        runner_secret: "runner-secret",
      },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        return new Response(JSON.stringify({
          version: 1,
          directory_refs: [],
          tools: [],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "bad call",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      { type: "chunk", content: "工具调用格式错误" },
      { type: "done" },
    ]);
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-1/tools",
    ]);
  });

  it("maps runtime execution errors to stable redacted responses", async () => {
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          "console.error('token=abc secret=hidden /tmp/auth.db'); process.exit(7)",
        ],
        timeout_ms: 1000,
      },
    });
    const response = await server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "kiro",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "runtime exited with code 7",
      code: "runtime_exit",
      details: "token=[REDACTED] secret=[REDACTED] [PATH]",
    });
  });
});
