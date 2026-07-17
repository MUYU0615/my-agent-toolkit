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

  it("does not prepare a project before every runtime call", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => process.stdout.write(input));",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: { command: process.execPath, args: ["-e", command], timeout_ms: 1000 },
      mcp: { service_url: "http://mcp-service:8700", runner_secret: "runner-secret" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        if (request.url.endsWith("/tools")) {
          return Response.json({
            version: 1,
            directory_refs: [],
            tools: [
              {
                name: "project.publish",
                category: "project",
                description: "Publish changes.",
                input_schema: {
                  type: "object",
                  required: ["project_key", "branch", "commit_message"],
                  properties: { project_key: {}, branch: {}, commit_message: {} },
                },
                permissions: { reads: [], writes: [] },
              },
            ],
          });
        }
        return Response.json({ error: "unexpected MCP tool call" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-project-auto",
        runtime: "kiro",
        prompt: "新增一个 Case",
      }),
    }));
    const body = await response.json() as { output: string };
    expect(body.output).toContain("- project.publish [project]");
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-project-auto/tools",
    ]);
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
      "  } else if (input.includes('phase-one')) {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"memory.stats\",\"input\":{}}</mcp_tool_call>');",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"memory.search\",\"input\":{\"query\":\"project\",\"scopes\":[\"session\"],\"owner_ids\":[\"conv-multi-tool\"]}}</mcp_tool_call>');",
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
          return Response.json({ ok: true, result: { phase: "phase-one" } });
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

  it("serializes concurrent Kiro calls for the same Bot user across conversations", async () => {
    const argsLogPath = `/tmp/kiro-runtime-lock-${crypto.randomUUID()}.log`;
    const activePath = `/tmp/kiro-runtime-active-${crypto.randomUUID()}.lock`;
    const command = [
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const overlap = fs.existsSync(process.env.ACTIVE_LOG);",
      "  fs.writeFileSync(process.env.ACTIVE_LOG, input);",
      "  fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify({ args: process.argv.slice(1), input, overlap }) + '\\n');",
      "  setTimeout(() => {",
      "    fs.rmSync(process.env.ACTIVE_LOG, { force: true });",
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
        env: { ARGS_LOG: argsLogPath, ACTIVE_LOG: activePath },
      },
      fetch: fetchStub,
    });
    const requestFor = (prompt: string, conversationId: string) => server.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: conversationId,
          runtime: "kiro",
          prompt,
        }),
      }),
    );

    const responses = await Promise.all([
      requestFor("first", "conv-lock-a"),
      requestFor("second", "conv-lock-b"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const invocations = (await fs.readFile(argsLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string; overlap: boolean });
    expect(invocations).toHaveLength(2);
    expect(invocations.every(({ overlap }) => overlap === false)).toBe(true);
    expect(invocations.filter(({ args }) => args.includes("--resume-id"))).toHaveLength(0);
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

  it("injects the managed project .env into cli runtime execution", async () => {
    const capturedPath = `/tmp/project-env-${crypto.randomUUID()}.json`;
    const projectDotenv = [
      "IM_TEST_HUB_PYTHON=/opt/im-test-hub/.venv/bin/python",
      "IM_TEST_HUB_API_SECRET=project-secret-value",
      "export IM_TEST_HUB_TARGET=staging",
      "",
    ].join("\n");
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/internal/bots/prd-bot/project-env") {
        expect(request.headers.get("authorization")).toBe("Bearer internal-token");
        return new Response(JSON.stringify({ configured: true, content: projectDotenv }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/internal/user-credentials/runtime-env") {
        return new Response(JSON.stringify({ env: {} }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname.startsWith("/internal/runtime-sessions/")) {
        return new Response(JSON.stringify({ error: "runtime session not found" }), { status: 404 });
      }
      if (request.method === "PUT" && url.pathname === "/internal/runtime-sessions") {
        return new Response(await request.text(), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      data_service_url: "http://data-service:8300",
      credential_internal_token: "internal-token",
      kiro: {
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({`,
            "python: process.env.IM_TEST_HUB_PYTHON,",
            "secret: process.env.IM_TEST_HUB_API_SECRET,",
            "target: process.env.IM_TEST_HUB_TARGET,",
            "dotenv: process.env.MY_AGENT_PROJECT_DOTENV_B64,",
            "}), 'utf8');",
            "process.stdout.write(process.env.IM_TEST_HUB_API_SECRET);",
            `process.stderr.write(${JSON.stringify(`${runtimeMetadata}\n`)});`,
          ].join(" "),
        ],
        timeout_ms: 1000,
      },
      fetch: fetchStub,
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-project-env",
        runtime: "kiro",
        prompt: "run the configured test",
      }),
    }));

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.output).toBe("[REDACTED]");
    const captured = JSON.parse(await fs.readFile(capturedPath, "utf8"));
    expect(captured).toEqual({
      python: "/opt/im-test-hub/.venv/bin/python",
      secret: "project-secret-value",
      target: "staging",
      dotenv: Buffer.from(projectDotenv, "utf8").toString("base64"),
    });
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
      { type: "chunk", content: "hello" },
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

  it("never leaks an MCP tool call when MCP is not configured", async () => {
    const command = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('<mcp_tool_call>{\"tool\":\"project.legacy\",\"input\":{}}</mcp_tool_call>');",
      "});",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: {
        command: process.execPath,
        args: ["-e", command],
        timeout_ms: 1000,
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-mcp-disabled",
          runtime: "kiro",
          prompt: "work on the project",
        }),
      }),
    );

    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      {
        type: "chunk",
        content: "项目工具当前未正确配置，任务尚未执行。请联系管理员检查 MCP Runner 配置。",
      },
      { type: "done" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("mcp_tool_call");
  });

  it("keeps a completed report instead of replaying an earlier MCP call", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('<mcp_tool_call>{\"tool\":\"project.legacy\",\"input\":{}}</mcp_tool_call>\\n');",
      "  process.stdout.write('## 执行结果\\n\\n- 验证状态：通过');",
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
        return Response.json({
          version: 1,
          directory_refs: ["../../projects/im-test-hub"],
          tools: [],
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/chat/stream", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-completed-report",
          runtime: "kiro",
          prompt: "create and run a case",
        }),
      }),
    );

    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      { type: "chunk", content: "## 执行结果\n\n- 验证状态：通过" },
      { type: "done" },
    ]);
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-completed-report/tools",
    ]);
    expect(JSON.stringify(lines)).not.toContain("mcp_tool_call");
  });

  it("returns a verified project.publish result directly with its GitHub URL", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('<mcp_tool_call>{\"tool\":\"project.publish\",\"input\":{\"project_key\":\"im-test-hub\",\"branch\":\"bot/duplicate-user\",\"commit_message\":\"Add duplicate user case\"}}</mcp_tool_call>');",
      "});",
    ].join(" ");
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
        return Response.json({
          ok: true,
          result: {
            branch: "bot/duplicate-user",
            commit: "a".repeat(40),
            changed_paths: ["CHANGELOG.md", "tests/e2e/server/user/test_auth_parameters.py"],
            github_url: "https://github.com/acme/im-test-hub/tree/bot/duplicate-user",
          },
        });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-publish",
        runtime: "kiro",
        prompt: "请推送代码",
      }),
    }));

    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      {
        type: "chunk",
        content: [
          "提交并 Push 成功。",
          "- 分支：bot/duplicate-user",
          `- Commit：${"a".repeat(40)}`,
          "- 变更文件：CHANGELOG.md、tests/e2e/server/user/test_auth_parameters.py",
          "- GitHub：https://github.com/acme/im-test-hub/tree/bot/duplicate-user",
        ].join("\n"),
      },
      { type: "done" },
    ]);
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-publish/tools",
      "/mcp/bots/prd-bot/sessions/conv-publish/tools/call",
    ]);
  });

  it("retries an explicit submit request until the runtime calls project.publish", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('PUBLISH_GATE')) {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"project.publish\",\"input\":{\"project_key\":\"im-test-hub\",\"branch\":\"bot/gated-publish\",\"commit_message\":\"test: gated publish\"}}</mcp_tool_call>');",
      "  } else {",
      "    process.stdout.write('本地提交成功');",
      "  }",
      "});",
    ].join(" ");
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
        return Response.json({
          ok: true,
          result: {
            branch: "bot/gated-publish",
            commit: "c".repeat(40),
            changed_paths: ["tests/e2e/new_case.py"],
            github_url: "https://github.com/acme/im-test-hub/tree/bot/gated-publish",
          },
        });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-gated-publish",
        runtime: "kiro",
        prompt: [
          "<project>",
          "  <root>../../projects/im-test-hub</root>",
          "</project>",
          "<user-message>",
          "请帮我把代码提交一下并推送到 GitHub",
          "</user-message>",
        ].join("\n"),
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { output: string };
    expect(body.output).toContain("提交并 Push 成功。");
    expect(body.output).not.toContain("本地提交成功");
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-gated-publish/tools",
      "/mcp/bots/prd-bot/sessions/conv-gated-publish/tools/call",
    ]);
  });

  it("rejects project.publish when the user only asks to generate and report a test case", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('<mcp_tool_call>{\"tool\":\"project.publish\",\"input\":{\"project_key\":\"im-test-hub\",\"branch\":\"bot/unrequested-publish\",\"commit_message\":\"test: unrequested publish\"}}</mcp_tool_call>');",
      "});",
    ].join(" ");
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: { command: process.execPath, args: ["-e", command], timeout_ms: 1000 },
      mcp: { service_url: "http://mcp-service:8700", runner_secret: "runner-secret" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        mcpRequests.push(request);
        return Response.json({ version: 1, directory_refs: [], tools: [] });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-unrequested-publish",
        runtime: "kiro",
        prompt: [
          "<project>",
          "  <root>../../projects/im-test-hub</root>",
          "</project>",
          "<user-message>",
          "帮我为 im-test-hub 生成一个有意义的 Case，直接生成测试报告",
          "</user-message>",
        ].join("\n"),
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { output: string };
    expect(body.output).toBe("提交和 Push 失败：project.publish requires an explicit user request to submit or Push code");
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-unrequested-publish/tools",
    ]);
  });

  it("does not claim success when an explicit submit request still omits project.publish", async () => {
    const command = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('本地提交成功'));";
    const server = createLlmRunnerServer({
      enabled_runtimes: ["kiro"],
      kiro: { command: process.execPath, args: ["-e", command], timeout_ms: 1000 },
      mcp: { service_url: "http://mcp-service:8700", runner_secret: "runner-secret" },
      fetch: async () => Response.json({ version: 1, directory_refs: [], tools: [] }),
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-gated-publish-failure",
        runtime: "kiro",
        prompt: "推送代码",
      }),
    }));

    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      {
        type: "chunk",
        content: "提交未执行：机器人没有调用 project.publish，未创建或推送经验证的 Commit。请重试。",
      },
      { type: "done" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("本地提交成功");
  });

  it("corrects fabricated MCP result markup and only reports a verified Push", async () => {
    const mcpRequests: Request[] = [];
    const command = [
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (input.includes('invalid_mcp_result_markup')) {",
      "    process.stdout.write('<mcp_tool_call>{\"tool\":\"project.publish\",\"input\":{\"project_key\":\"im-test-hub\",\"branch\":\"bot/duplicate-user\",\"commit_message\":\"Add duplicate user case\"}}</mcp_tool_call>');",
      "  } else {",
      "    process.stdout.write('<mcp_tool_call result=\"{\\\"ok\\\":true}\"></mcp_tool_call>\\n提交成功。');",
      "  }",
      "});",
    ].join(" ");
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
        return Response.json({
          ok: true,
          result: {
            branch: "bot/duplicate-user",
            commit: "b".repeat(40),
            changed_paths: ["CHANGELOG.md", "tests/e2e/server/user/test_auth_parameters.py"],
            github_url: "https://github.com/acme/im-test-hub/tree/bot/duplicate-user",
          },
        });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "conv-forged-publish",
        runtime: "kiro",
        prompt: "请推送代码",
      }),
    }));
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(1)).toEqual([
      {
        type: "chunk",
        content: [
          "提交并 Push 成功。",
          "- 分支：bot/duplicate-user",
          `- Commit：${"b".repeat(40)}`,
          "- 变更文件：CHANGELOG.md、tests/e2e/server/user/test_auth_parameters.py",
          "- GitHub：https://github.com/acme/im-test-hub/tree/bot/duplicate-user",
        ].join("\n"),
      },
      { type: "done" },
    ]);
    expect(mcpRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/mcp/bots/prd-bot/sessions/conv-forged-publish/tools",
      "/mcp/bots/prd-bot/sessions/conv-forged-publish/tools/call",
    ]);
    expect(JSON.stringify(lines)).not.toContain("mcp_tool_call");
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
