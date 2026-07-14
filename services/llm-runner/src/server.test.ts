import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "./config.js";
import { createLlmRunnerServer } from "./server.js";

const providerSessionId = "f2946a26-3735-4b08-8d05-c928010302d5";
const runtimeMetadata = `__MY_AGENT_TOOLKIT_RUNTIME_META__${JSON.stringify({
  provider_session_id: providerSessionId,
})}`;

describe("llm-runner server", () => {
  it("responds to health checks", async () => {
    const previousSha = process.env.APP_BUILD_SHA;
    const previousBuildTime = process.env.APP_BUILD_TIME;
    process.env.APP_BUILD_SHA = "sha-llm";
    process.env.APP_BUILD_TIME = "2026-06-24T12:00:02.000Z";
    const server = createLlmRunnerServer();
    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "llm-runner",
      status: "ok",
      git_sha: "sha-llm",
      build_time: "2026-06-24T12:00:02.000Z",
    });
    process.env.APP_BUILD_SHA = previousSha;
    process.env.APP_BUILD_TIME = previousBuildTime;
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

  it("forwards a Kiro cancellation only for the matching runtime session", async () => {
    const requests: Request[] = [];
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeout_ms: 1000,
      },
      kiro_relay_cancel_url: "http://kiro-relay/v1/kiro/cancel",
      kiro_relay_auth_token: "relay-token",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        return Response.json({ cancelled: true });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/runs/cancel", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "bot-a",
        user_id: "user-a",
        conversation_id: "conv-a",
        runtime: "kiro",
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cancelled: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://kiro-relay/v1/kiro/cancel");
    expect(requests[0].headers.get("authorization")).toBe("Bearer relay-token");
    await expect(requests[0].json()).resolves.toEqual({
      bot_id: "bot-a",
      user_id: "user-a",
      conversation_id: "conv-a",
    });
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

  it("executes multiple MCP tool calls before returning the final answer", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('project overview')) {",
      "    process.stdout.write('项目分析完成');",
      "  } else if (input.includes('README.md')) {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"project.read\",\"input\":{\"path\":\"README.md\"}}</mcp_tool_call>');",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"project.inspect\",\"input\":{}}</mcp_tool_call>');",
      "  }",
      "});",
    ].join(" ");
    let invocation = 0;
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: { command: process.execPath, args: ["-e", command], timeout_ms: 1000 },
      mcp: { service_url: "http://mcp-service:8700", runner_secret: "runner-secret" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        if (request.url.endsWith("/tools")) {
          return Response.json({ version: 1, directory_refs: [], tools: [] });
        }
        invocation += 1;
        if (invocation === 1) {
          return Response.json({ ok: true, result: { files: ["README.md"] } });
        }
        if (invocation === 2) {
          return Response.json({ ok: true, result: { content: "project overview" } });
        }
        return Response.json({ ok: true, result: { ignored: true } });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-multi-tool",
        runtime: "kiro",
        prompt: "analyze project",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toBe("项目分析完成");
    expect(mcpRequests.filter((request) => request.url.endsWith("/tools/call"))).toHaveLength(2);
  });

  it("does not expose a tool call when the MCP tool-call limit is reached", async () => {
    const command = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.stdout.write('<mcp_tool_call>{\"tool\":\"memory.stats\",\"input\":{}}</mcp_tool_call>'));",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: { command: process.execPath, args: ["-e", command], timeout_ms: 1000 },
      mcp: {
        service_url: "http://mcp-service:8700",
        runner_secret: "runner-secret",
        max_tool_rounds: 1,
      },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        if (request.url.endsWith("/tools")) {
          return Response.json({ version: 1, directory_refs: [], tools: [] });
        }
        return Response.json({ ok: true, result: {} });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-tool-limit",
        runtime: "kiro",
        prompt: "keep calling",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toBe("当前任务需要的工具调用次数过多，已停止继续调用。请缩小问题范围后重试。");
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

  it("persists kiro runtime sessions and resumes after llm-runner restart", async () => {
    const argsLogPath = `/tmp/kiro-runtime-session-${crypto.randomUUID()}.log`;
    const command = [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(1)) + '\\n');",
      `process.stderr.write(${JSON.stringify(`${runtimeMetadata}\n`)});`,
      "process.stdin.pipe(process.stdout);",
    ].join(" ");
    const storedSessions = new Map<string, unknown>();
    const fetchRequests: Request[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      fetchRequests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/internal/runtime-sessions/")) {
        const runnerSessionId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const session = storedSessions.get(runnerSessionId);
        return session
          ? new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: "runtime session not found" }), { status: 404 });
      }
      if (request.method === "PUT" && url.pathname === "/internal/runtime-sessions") {
        const payload = await request.json();
        storedSessions.set(payload.runner_session_id, payload);
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    const baseConfig: RunnerConfig = {
      enabled_runtimes: ["kiro"],
      data_service_url: "http://data-service:8300",
      kiro: {
        command: process.execPath,
        args: ["-e", command, "chat", "--no-interactive"],
        timeout_ms: 1000,
        env: {
          ARGS_LOG: argsLogPath,
        },
      },
      fetch: fetchStub,
    };

    for (const prompt of ["first", "second"]) {
      const server = createLlmRunnerServer(baseConfig);
      const response = await server.fetch(
        new Request("http://localhost/v1/chat", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            user_id: "user-a",
            conversation_id: "conv-1",
            runtime: "kiro",
            prompt,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const argsLines = (await fs.readFile(argsLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argsLines).toEqual([
      ["chat", "--no-interactive"],
      ["chat", "--resume-id", providerSessionId, "--no-interactive"],
    ]);
    expect(fetchRequests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /internal/runtime-sessions/kiro%3Aprd-bot%3Auser-a%3Aconv-1",
      "PUT /internal/runtime-sessions",
      "GET /internal/runtime-sessions/kiro%3Aprd-bot%3Auser-a%3Aconv-1",
      "PUT /internal/runtime-sessions",
    ]);
    expect(storedSessions.get("kiro:prd-bot:user-a:conv-1")).toMatchObject({
      provider_session_id: providerSessionId,
    });
  });

  it("serializes concurrent calls for the same runner session", async () => {
    const argsLogPath = `/tmp/kiro-runtime-lock-${crypto.randomUUID()}.log`;
    const command = [
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify({ args: process.argv.slice(1), input }) + '\\n');",
      "  setTimeout(() => {",
      "    process.stdout.write(input);",
      `    process.stderr.write(${JSON.stringify(`${runtimeMetadata}\n`)});`,
      "  }, 40);",
      "});",
    ].join(" ");
    const storedSessions = new Map<string, Record<string, unknown>>();
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/internal/runtime-sessions/")) {
        const runnerSessionId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const session = storedSessions.get(runnerSessionId);
        return session
          ? new Response(JSON.stringify(session), { status: 200 })
          : new Response(JSON.stringify({ error: "runtime session not found" }), { status: 404 });
      }
      if (request.method === "PUT" && url.pathname === "/internal/runtime-sessions") {
        const payload = await request.json() as Record<string, unknown>;
        storedSessions.set(String(payload.runner_session_id), payload);
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      data_service_url: "http://data-service:8300",
      kiro: {
        command: process.execPath,
        args: ["-e", command, "chat", "--no-interactive"],
        timeout_ms: 1000,
        env: { ARGS_LOG: argsLogPath },
      },
      fetch: fetchStub,
    });
    const requestFor = (prompt: string) => server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-lock",
          runtime: "kiro",
          prompt,
        }),
      }),
    );

    const responses = await Promise.all([requestFor("first"), requestFor("second")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const invocations = (await fs.readFile(argsLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    expect(invocations).toHaveLength(2);
    expect(invocations.filter(({ args }) => args.includes("--resume-id"))).toHaveLength(1);
    expect(invocations.find(({ args }) => args.includes("--resume-id"))?.args).toEqual([
      "chat",
      "--resume-id",
      providerSessionId,
      "--no-interactive",
    ]);
  });

  it("injects bot env vars into cli runtime execution without exposing them in prompt or output", async () => {
    const secretKey = "BOT_PRIVATE_TEST_SECRET";
    const sentinelPath = `/tmp/${secretKey}-value.txt`;
    const relayBotIdPath = `/tmp/${secretKey}-relay-bot-id.txt`;
    const relayUserIdPath = `/tmp/${secretKey}-relay-user-id.txt`;
    const relayConversationIdPath = `/tmp/${secretKey}-relay-conversation-id.txt`;
    const jiraUsernamePath = `/tmp/${secretKey}-jira-username.txt`;
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
            `fs.writeFileSync(${JSON.stringify(relayBotIdPath)}, process.env.KIRO_RELAY_BOT_ID || 'missing', 'utf8');`,
            `fs.writeFileSync(${JSON.stringify(relayUserIdPath)}, process.env.KIRO_RELAY_USER_ID || 'missing', 'utf8');`,
            `fs.writeFileSync(${JSON.stringify(relayConversationIdPath)}, process.env.KIRO_RELAY_CONVERSATION_ID || 'missing', 'utf8');`,
            `fs.writeFileSync(${JSON.stringify(jiraUsernamePath)}, process.env.EASEMOB_JIRA_USERNAME || 'missing', 'utf8');`,
            "process.stdout.write(`secret=${value}`);",
          ].join(" "),
        ],
        timeout_ms: 1000,
      },
      resolveBotEnvVars: vi.fn(async (botId: string) => {
        expect(botId).toBe("prd-bot");
        return {
          [secretKey]: "sk-live-secret",
          KIRO_RELAY_BOT_ID: "spoofed-bot-id",
          KIRO_RELAY_CONVERSATION_ID: "spoofed-conversation-id",
        };
      }),
      resolveUserEnvVars: vi.fn(async (botId: string, userId: string) => {
        expect(botId).toBe("prd-bot");
        expect(userId).toBe("user-a");
        return { EASEMOB_JIRA_USERNAME: "jira-user-a" };
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
    await expect(fs.readFile(relayBotIdPath, "utf8")).resolves.toBe("prd-bot");
    await expect(fs.readFile(relayUserIdPath, "utf8")).resolves.toBe("user-a");
    await expect(fs.readFile(relayConversationIdPath, "utf8")).resolves.toBe("conv-1");
    await expect(fs.readFile(jiraUsernamePath, "utf8")).resolves.toBe("jira-user-a");
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

  it("persists provider session ids after streamed Kiro output completes", async () => {
    const storedSessions = new Map<string, Record<string, unknown>>();
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/internal/runtime-sessions/")) {
        return new Response(JSON.stringify({ error: "runtime session not found" }), { status: 404 });
      }
      if (request.method === "PUT" && url.pathname === "/internal/runtime-sessions") {
        const payload = await request.json() as Record<string, unknown>;
        storedSessions.set(String(payload.runner_session_id), payload);
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      data_service_url: "http://data-service:8300",
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdout.write('streamed');",
            `process.stderr.write(${JSON.stringify(`${runtimeMetadata}\n`)});`,
          ].join(" "),
        ],
        timeout_ms: 1000,
      },
      fetch: fetchStub,
    });
    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-stream-session",
          runtime: "kiro",
          prompt: "hello",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.slice(1)).toEqual([
      { type: "chunk", content: "streamed" },
      { type: "done" },
    ]);
    expect(storedSessions.get("kiro:prd-bot:user-a:conv-stream-session")).toMatchObject({
      provider_session_id: providerSessionId,
    });
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
      { type: "chunk", content: "最终回复" },
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
