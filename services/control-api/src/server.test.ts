import { describe, expect, it } from "vitest";
import { createControlApiServer } from "./server.js";

describe("control-api server", () => {
  it("responds to health checks", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "control-api",
      status: "ok",
    });
  });

  it("serves the setup page", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(html).toContain("Bot Control");
    expect(html).toContain("/v1/bots");
    expect(html).toContain("Channel 管理");
    expect(html).toContain("Channel 列表");
    expect(html).toContain("新增 Channel");
    expect(html).toContain("名称");
    expect(html).toContain("LLM");
    expect(html).toContain("企业微信Bot ID");
    expect(html).toContain("企业微信 Secret");
    expect(html).toContain("保存并生成验证码");
    expect(html).toContain("重置管理员");
    expect(html).toContain("重置引导");
    expect(html).toContain("删除 Channel");
    expect(html).toContain("编辑配置");
    expect(html).toContain("生命周期");
    expect(html).toContain("复制认领命令");
    expect(html).toContain("已同步");
    expect(html).toContain("机器人配置");
    expect(html).toContain("能力状态");
    expect(html).toContain("编辑能力");
    expect(html).toContain("保存能力配置");
    expect(html).toContain("MCP Tools");
    expect(html).toContain("记忆索引");
    expect(html).toContain("memory-readable-scope");
    expect(html).toContain("memory-writable-scope");
    expect(html).toContain("document-writable-scope");
    expect(html).toContain("mcp-tool");
    expect(html).toContain("directory_refs");
    expect(html).toContain("config-status");
    expect(html).toContain("capability_config");
    expect(html).toContain("最近更新");
    expect(html).toContain("Soul：机器人是谁，包括身份、性格、沟通风格、价值观和人格边界。");
    expect(html).toContain("Agents：机器人如何工作，包括能力范围、行为规则、任务流程、工具与文档规范。");
    expect(html).toContain("文档");
    expect(html).toContain("normalDocs");
    expect(html).toContain("isBotConfigDocument");
    expect(html).toContain("暂无普通文档");
    expect(html).toContain("机器人配置或普通文档");
    expect(html).toContain('type="password"');
    expect(html).toContain("/admin/claims");
    expect(html).toContain("/admin/reset");
    expect(html).toContain("/v1/bot-channels");
    expect(html).toContain("/config-documents");
    expect(html).toContain("/mcp-capabilities");
    expect(html).toContain("/mcp-capabilities/config");
    expect(html).toContain("/initialization/restart");
    expect(html).toContain("setInterval");
    expect(html).not.toContain("模拟管理员启用");
    expect(html).not.toContain("模拟发送消息");
    expect(html).not.toContain("新建空白");
    expect(html).not.toContain("联调流程");
    expect(html).not.toContain("requestStatus");
    expect(html).not.toContain('response.ok ? "完成"');
    expect(html).not.toContain("查询审计日志");
    expect(html).not.toContain("写入 Memory 文档");
  });

  it("creates bots through data-service", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      botHostUrl: "http://bot-api",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = await request.json();
        calls.push({ url: request.url, body });
        return Response.json({
          bot_id: body.bot_id,
          name: body.name,
          runtime: body.runtime,
          status: "draft",
          wecom_bot_id: body.wecom_bot_id,
          wecom_secret_configured: Boolean(body.wecom_secret),
        }, { status: 201 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "draft",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(calls[0]).toEqual(
      {
        url: "http://data-service/v1/bots",
        body: {
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        },
      },
    );
  });

  it("gets bot records through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      botHostUrl: "http://bot-api",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({ bot_id: "prd-bot", status: "ready" });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      status: "ready",
    });
    expect(calls).toEqual(["http://data-service/v1/bots/prd-bot"]);
  });

  it("builds bot MCP capability views from data-service state", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        if (request.url === "http://data-service/v1/bots/prd-bot") {
          return Response.json({
            bot_id: "prd-bot",
            name: "PRD Bot",
            status: "ready",
            runtime: "kiro",
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([
            { title: "soul.md", content: "我是产品经理机器人" },
            { title: "AGENTS.md", content: "按 PRD 流程工作" },
          ]);
        }
        if (request.url === "http://data-service/internal/documents?scope=bot&owner_id=prd-bot&status=active") {
          return Response.json([
            { document_id: "doc-1", title: "语音转文字 PRD", doc_type: "prd" },
            { document_id: "doc-2", title: "ASR 竞品分析", doc_type: "analysis" },
          ]);
        }
        if (request.url === "http://data-service/internal/memory-stats?scope=bot&owner_id=prd-bot") {
          return Response.json({
            memories: 6,
            memory_documents: 2,
            chunks: 18,
            assets: 2,
            by_tier: {
              core: 3,
              reference: 2,
              temp: 1,
            },
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/mcp-capabilities/config") {
          return Response.json({
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
            directory_refs: ["bot-workspace"],
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/mcp-capabilities"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      status: "ready",
      runtime: "kiro",
      config_documents: {
        soul: {
          configured: true,
          title: "soul.md",
        },
        agents: {
          configured: true,
          title: "AGENTS.md",
        },
      },
      documents: {
        count: 2,
        by_type: {
          analysis: 1,
          prd: 1,
        },
      },
      memory: {
        memories: 6,
        memory_documents: 2,
        chunks: 18,
        assets: 2,
        by_tier: {
          core: 3,
          reference: 2,
          temp: 1,
        },
      },
      capability_config: {
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
        directory_refs: ["bot-workspace"],
      },
    });
    expect(calls).toEqual([
      "http://data-service/v1/bots/prd-bot",
      "http://data-service/v1/bots/prd-bot/config-documents",
      "http://data-service/internal/documents?scope=bot&owner_id=prd-bot&status=active",
      "http://data-service/internal/memory-stats?scope=bot&owner_id=prd-bot",
      "http://data-service/v1/bots/prd-bot/mcp-capabilities/config",
    ]);
  });

  it("updates bot MCP capability config through data-service and records audit events", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "PUT" || request.method === "POST"
          ? await request.text()
          : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bots/prd-bot/mcp-capabilities/config") {
          return Response.json(body);
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const payload = {
      actor_id: "admin-a",
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
      directory_refs: ["bot-workspace"],
    };
    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/mcp-capabilities/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bots/prd-bot/mcp-capabilities/config",
        method: "PUT",
        body: payload,
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "mcp.capability_config.update",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            tools_enabled: ["memory.search"],
            readable_scopes: ["bot"],
            writable_scopes: ["bot"],
            directory_refs: ["bot-workspace"],
          },
        },
      },
    ]);
  });

  it("lists bot records through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([{ bot_id: "prd-bot", status: "ready" }]);
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/bots"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { bot_id: "prd-bot", status: "ready" },
    ]);
    expect(calls).toEqual(["http://data-service/v1/bots"]);
  });

  it("lists bot channels through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([
          {
            channel_id: "wecom:prd-bot",
            bot_id: "prd-bot",
            channel_type: "wecom",
            display_name: "企业微信",
            runtime_enabled: true,
          },
        ]);
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bot-channels?bot_id=prd-bot"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      {
        channel_id: "wecom:prd-bot",
        bot_id: "prd-bot",
      },
    ]);
    expect(calls).toEqual([
      "http://data-service/v1/bot-channels?bot_id=prd-bot",
    ]);
  });

  it("gets channel details through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({
          channel: { channel_id: "wecom:prd-bot", bot_id: "prd-bot" },
          bot: { bot_id: "prd-bot" },
          memory_documents: [],
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bot-channels/wecom:prd-bot"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channel: {
        channel_id: "wecom:prd-bot",
      },
    });
    expect(calls).toEqual([
      "http://data-service/v1/bot-channels/wecom:prd-bot",
    ]);
  });

  it("proxies channel and bot reset actions with audit events", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      botHostUrl: "http://bot-api",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ ok: true }, { status: 201 });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/admin") {
          return Response.json({ bot_id: "prd-bot", wecom_user_id: "admin-a" });
        }
        if (request.url.endsWith("/admin/reset")) {
          return Response.json({ bot_id: "prd-bot", code: "123456" }, { status: 201 });
        }
        if (request.url === "http://bot-api/internal/bots/prd-bot/initialization/restart") {
          return Response.json({
            bot_id: "prd-bot",
            admin_wecom_user_id: "admin-a",
            output: "问题 1/8：先了解一下业务背景",
          });
        }
        if (request.url.endsWith("/reset")) {
          return Response.json({ bot_id: "prd-bot", status: "initializing" });
        }
        if (request.method === "DELETE") {
          return Response.json({ bot_id: "prd-bot", runtime_enabled: false });
        }
        if (request.url === "http://bot-api/internal/wecom-runtime/sync") {
          return Response.json({ synced: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    await expect(server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/reset", {
        method: "POST",
      }),
    )).resolves.toMatchObject({ status: 201 });
    await expect(server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/reset", {
        method: "POST",
      }),
    )).resolves.toMatchObject({ status: 200 });
    await expect(server.fetch(
      new Request("http://localhost/v1/bot-channels/wecom:prd-bot", {
        method: "DELETE",
      }),
    )).resolves.toMatchObject({ status: 200 });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://data-service/v1/bots/prd-bot/admin/reset",
      "POST http://log-service/v1/audit-events",
      "GET http://data-service/v1/bots/prd-bot/admin",
      "POST http://data-service/v1/bots/prd-bot/reset",
      "POST http://bot-api/internal/bots/prd-bot/initialization/restart",
      "POST http://log-service/v1/audit-events",
      "DELETE http://data-service/v1/bot-channels/wecom:prd-bot",
      "POST http://bot-api/internal/wecom-runtime/sync",
      "POST http://log-service/v1/audit-events",
    ]);
  });

  it("restarts initialization and asks bot-api to message the admin", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      botHostUrl: "http://bot-api",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bots/prd-bot/admin") {
          return Response.json({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/reset") {
          return Response.json({ bot_id: "prd-bot", status: "initializing" });
        }
        if (request.url === "http://bot-api/internal/bots/prd-bot/initialization/restart") {
          return Response.json({
            bot_id: "prd-bot",
            admin_wecom_user_id: "admin-a",
            output: "问题 1/8：先了解一下业务背景",
          });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/initialization/restart", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      admin_wecom_user_id: "admin-a",
      output: "问题 1/8：先了解一下业务背景",
    });
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bots/prd-bot/admin",
        method: "GET",
      },
      {
        url: "http://data-service/v1/bots/prd-bot/reset",
        method: "POST",
      },
      {
        url: "http://bot-api/internal/bots/prd-bot/initialization/restart",
        method: "POST",
        body: {
          admin_wecom_user_id: "admin-a",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "bot.initialization.restart",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            status: "initializing",
            admin_wecom_user_id: "admin-a",
          },
        },
      },
    ]);
  });

  it("proxies simulated wecom messages through bot-api", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      botHostUrl: "http://bot-api",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push({ url: request.url, body: await request.json() });
        return Response.json({
          conversation_id: "conv-a",
          run_id: "run-a",
          output: "mock: hi",
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "hi",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      conversation_id: "conv-a",
      run_id: "run-a",
      output: "mock: hi",
    });
    expect(calls).toEqual([
      {
        url: "http://bot-api/v1/messages/wecom",
        body: {
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "hi",
          runtime: "mock",
        },
      },
    ]);
  });

  it("updates bot records through data-service and records audit events", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "PATCH" || request.method === "POST"
          ? await request.json()
          : undefined;
        calls.push({ url: request.url, body });
        if (request.url === "http://data-service/v1/bots/prd-bot") {
          return Response.json({
            bot_id: "prd-bot",
            name: body.name,
            runtime: body.runtime,
            status: body.status,
            wecom_bot_id: body.wecom_bot_id,
            wecom_secret_configured: Boolean(body.wecom_secret),
          });
        }
        return Response.json({ event_id: "audit-1" }, { status: 201 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot", {
        method: "PATCH",
        body: JSON.stringify({
          actor_id: "admin-a",
          name: "PRD Assistant",
          runtime: "mock",
          status: "initializing",
          wecom_bot_id: "wecom-bot-b",
          wecom_secret: "new-secret-value",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
    });
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bots/prd-bot",
        body: {
          actor_id: "admin-a",
          name: "PRD Assistant",
          runtime: "mock",
          status: "initializing",
          wecom_bot_id: "wecom-bot-b",
          wecom_secret: "new-secret-value",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        body: {
          actor_id: "admin-a",
          action: "bot.update",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            name: "PRD Assistant",
            runtime: "mock",
            status: "initializing",
            wecom_bot_id: "wecom-bot-b",
            wecom_secret_configured: true,
          },
        },
      },
    ]);
    expect(JSON.stringify(calls[1])).not.toContain("new-secret-value");
  });

  it("checks wecom configuration through data-service and records audit events", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, body });
        if (request.url === "http://data-service/v1/bots/prd-bot/wecom/test") {
          return Response.json({
            bot_id: "prd-bot",
            status: "configured",
            wecom_bot_id: "wecom-bot-a",
            wecom_secret_configured: true,
            missing: [],
            checked_at: "2026-06-21T00:00:00.000Z",
          });
        }
        return Response.json({ event_id: "audit-1" }, { status: 201 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/wecom/test", {
        method: "POST",
        body: JSON.stringify({ actor_id: "admin-a" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_secret_configured: true,
    });
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bots/prd-bot/wecom/test",
        body: {
          actor_id: "admin-a",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        body: {
          actor_id: "admin-a",
          action: "wecom.config.check",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            status: "configured",
            missing: [],
            wecom_secret_configured: true,
          },
        },
      },
    ]);
  });

  it("creates admin claim codes through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({
          bot_id: "prd-bot",
          code: "123456",
          expires_at: "2026-06-22T16:00:00.000Z",
        }, { status: 201 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      code: "123456",
      expires_at: "2026-06-22T16:00:00.000Z",
    });
    expect(calls.filter((url) => url.startsWith("http://data-service"))).toEqual([
      "http://data-service/v1/bots/prd-bot/admin/claims",
    ]);
  });

  it("gets admins through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({ bot_id: "prd-bot", wecom_user_id: "admin-a" });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
    });
    expect(calls).toEqual(["http://data-service/v1/bots/prd-bot/admin"]);
  });

  it("transfers admins through data-service", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = await request.json();
        calls.push({ url: request.url, body });
        return Response.json({ bot_id: "prd-bot", wecom_user_id: "admin-b" });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/transfer", {
        method: "POST",
        body: JSON.stringify({
          current_wecom_user_id: "admin-a",
          new_wecom_user_id: "admin-b",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
    });
    expect(calls[0]).toEqual(
      {
        url: "http://data-service/v1/bots/prd-bot/admin/transfer",
        body: {
          current_wecom_user_id: "admin-a",
          new_wecom_user_id: "admin-b",
        },
      },
    );
  });

  it("upserts memory documents through data-service", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = await request.json();
        calls.push({ url: request.url, body });
        return Response.json({ ...body, memory_doc_id: "mem-1", version: 1 }, { status: 201 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          owner_id: "prd-bot",
          title: "soul",
          content: "bot soul",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      memory_doc_id: "mem-1",
      version: 1,
    });
    expect(calls[0]).toEqual({
      url: "http://data-service/v1/memory-documents",
      body: {
        scope: "bot",
        owner_id: "prd-bot",
        title: "soul",
        content: "bot soul",
      },
    });
  });

  it("queries current memory documents through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([{ title: "soul", version: 2 }]);
      },
    });

    const response = await server.fetch(
      new Request(
        "http://localhost/v1/memory-documents/current?scope=bot&owner_id=prd-bot",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { title: "soul", version: 2 },
    ]);
    expect(calls).toEqual([
      "http://data-service/v1/memory-documents/current?scope=bot&owner_id=prd-bot",
    ]);
  });

  it("queries bot config documents through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([{ title: "soul", content: "bot soul", updated_at: "2026-06-22T00:00:00.000Z" }]);
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/config-documents"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { title: "soul", content: "bot soul", updated_at: "2026-06-22T00:00:00.000Z" },
    ]);
    expect(calls).toEqual([
      "http://data-service/v1/bots/prd-bot/config-documents",
    ]);
  });

  it("marks bots ready through data-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({ bot_id: "prd-bot", status: "ready" });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/ready", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      bot_id: "prd-bot",
      status: "ready",
    });
    expect(calls.filter((url) => url.startsWith("http://data-service"))).toEqual([
      "http://data-service/v1/bots/prd-bot/ready",
    ]);
  });

  it("queries chat events through log-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([{ event_id: "evt-1", bot_id: "prd-bot" }]);
      },
    });

    const response = await server.fetch(
      new Request(
        "http://localhost/v1/chat-events?bot_id=prd-bot&conversation_id=conv-1&limit=10",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { event_id: "evt-1", bot_id: "prd-bot" },
    ]);
    expect(calls).toEqual([
      "http://log-service/v1/chat-events?bot_id=prd-bot&conversation_id=conv-1&limit=10",
    ]);
  });

  it("records audit events after management writes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/memory-documents") {
          return Response.json({
            memory_doc_id: "mem-1",
            scope: body.scope,
            owner_id: body.owner_id,
            title: body.title,
            version: 1,
          }, { status: 201 });
        }

        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          actor_id: "admin-a",
          scope: "bot",
          owner_id: "prd-bot",
          title: "soul",
          content: "bot soul",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(calls[1]).toEqual({
      url: "http://log-service/v1/audit-events",
      body: {
        actor_id: "admin-a",
        action: "memory.upsert",
        target_type: "bot",
        target_id: "prd-bot",
        metadata: {
          memory_doc_id: "mem-1",
          title: "soul",
          version: 1,
        },
      },
    });
  });

  it("records audit events for bot admin and ready writes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/bots") {
          return Response.json({ bot_id: body.bot_id, status: "draft" }, { status: 201 });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/admin/claims") {
          return Response.json({ bot_id: "prd-bot", code: "123456" }, { status: 201 });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/admin/transfer") {
          return Response.json({ bot_id: "prd-bot", wecom_user_id: "admin-b" });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          actor_id: "admin-a",
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
        body: JSON.stringify({ actor_id: "admin-a" }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/ready", {
        method: "POST",
        body: JSON.stringify({ actor_id: "admin-a" }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/transfer", {
        method: "POST",
        body: JSON.stringify({
          current_wecom_user_id: "admin-a",
          new_wecom_user_id: "admin-b",
        }),
      }),
    );

    const auditBodies = calls
      .filter((call) => call.url === "http://log-service/v1/audit-events")
      .map((call) => call.body);

    expect(auditBodies).toEqual([
      {
        actor_id: "admin-a",
        action: "bot.create",
        target_type: "bot",
        target_id: "prd-bot",
        metadata: {
          runtime: "kiro",
          status: "draft",
          wecom_secret_configured: false,
        },
      },
      {
        actor_id: "admin-a",
        action: "admin.claim_code.create",
        target_type: "bot",
        target_id: "prd-bot",
        metadata: {},
      },
      {
        actor_id: "admin-a",
        action: "bot.ready",
        target_type: "bot",
        target_id: "prd-bot",
        metadata: {
          status: "ready",
        },
      },
      {
        actor_id: "admin-a",
        action: "admin.transfer",
        target_type: "bot",
        target_id: "prd-bot",
        metadata: {
          new_wecom_user_id: "admin-b",
        },
      },
    ]);
  });

  it("queries audit events through log-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json([{ event_id: "audit-1", action: "memory.upsert" }]);
      },
    });

    const response = await server.fetch(
      new Request(
        "http://localhost/v1/audit-events?target_type=bot&target_id=prd-bot",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { event_id: "audit-1", action: "memory.upsert" },
    ]);
    expect(calls).toEqual([
      "http://log-service/v1/audit-events?target_type=bot&target_id=prd-bot",
    ]);
  });

  it("renders links for global configuration and role management", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("全局配置");
    expect(html).toContain("角色管理");
    expect(html).toContain("/admin/global-documents");
    expect(html).toContain("/admin/roles");
  });

  it("proxies global documents list and create requests", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/global-documents" && request.method === "GET") {
          return Response.json([
            {
              document_id: "global-playground",
              title: "playground.md",
              slug: "playground",
              content: "# Playground",
              enabled: true,
              sort_order: 1,
            },
          ]);
        }
        if (request.url === "http://data-service/v1/global-documents" && request.method === "POST") {
          return Response.json({
            document_id: "global-playground",
            title: "playground.md",
            slug: "playground",
            content: "# Playground",
            enabled: true,
            sort_order: 1,
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const listResponse = await server.fetch(new Request("http://localhost/v1/global-documents"));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ slug: "playground" }),
    ]);

    const createResponse = await server.fetch(new Request("http://localhost/v1/global-documents", {
      method: "POST",
      body: JSON.stringify({
        actor_id: "admin-a",
        title: "playground.md",
        slug: "playground",
        content: "# Playground",
        enabled: true,
        sort_order: 1,
      }),
    }));
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      document_id: "global-playground",
      slug: "playground",
    });

    expect(calls).toEqual([
      {
        url: "http://data-service/v1/global-documents",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://data-service/v1/global-documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          title: "playground.md",
          slug: "playground",
          content: "# Playground",
          enabled: true,
          sort_order: 1,
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "global_document.upsert",
          target_type: "global_document",
          target_id: "global-playground",
          metadata: {
            slug: "playground",
            enabled: true,
            sort_order: 1,
            title: "playground.md",
          },
        },
      },
    ]);
  });

  it("proxies role list and create requests", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles" && request.method === "GET") {
          return Response.json([
            {
              role_id: "role-product-manager",
              name: "产品经理助手",
              slug: "product-manager",
              description: "产品经理角色",
              enabled: true,
              sort_order: 10,
            },
          ]);
        }
        if (request.url === "http://data-service/v1/roles" && request.method === "POST") {
          return Response.json({
            role_id: "role-product-manager",
            name: "产品经理助手",
            slug: "product-manager",
            description: "产品经理角色",
            enabled: true,
            sort_order: 10,
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const listResponse = await server.fetch(new Request("http://localhost/v1/roles"));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ slug: "product-manager" }),
    ]);

    const createResponse = await server.fetch(new Request("http://localhost/v1/roles", {
      method: "POST",
      body: JSON.stringify({
        actor_id: "admin-a",
        name: "产品经理助手",
        slug: "product-manager",
        description: "产品经理角色",
        enabled: true,
        sort_order: 10,
      }),
    }));
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      role_id: "role-product-manager",
      slug: "product-manager",
    });

    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://data-service/v1/roles",
        method: "POST",
        body: {
          actor_id: "admin-a",
          name: "产品经理助手",
          slug: "product-manager",
          description: "产品经理角色",
          enabled: true,
          sort_order: 10,
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role.upsert",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            slug: "product-manager",
            name: "产品经理助手",
            enabled: true,
            sort_order: 10,
          },
        },
      },
    ]);
  });

  it("proxies role documents list and create requests", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/documents" && request.method === "GET") {
          return Response.json([
            {
              role_document_id: "role-doc-1",
              role_id: "role-product-manager",
              title: "role.md",
              content: "# Role: Product Manager",
              enabled: true,
            },
          ]);
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/documents" && request.method === "POST") {
          return Response.json({
            role_document_id: "role-doc-1",
            role_id: "role-product-manager",
            title: "role.md",
            content: "# Role: Product Manager",
            enabled: true,
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const listResponse = await server.fetch(new Request("http://localhost/v1/roles/role-product-manager/documents"));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ title: "role.md" }),
    ]);

    const createResponse = await server.fetch(new Request("http://localhost/v1/roles/role-product-manager/documents", {
      method: "POST",
      body: JSON.stringify({
        actor_id: "admin-a",
        title: "role.md",
        content: "# Role: Product Manager",
        enabled: true,
      }),
    }));
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      role_document_id: "role-doc-1",
      role_id: "role-product-manager",
    });

    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/documents",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://data-service/v1/roles/role-product-manager/documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          title: "role.md",
          content: "# Role: Product Manager",
          enabled: true,
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role_document.upsert",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            role_document_id: "role-doc-1",
            title: "role.md",
            enabled: true,
          },
        },
      },
    ]);
  });

  it("proxies role questions list and create requests", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions" && request.method === "GET") {
          return Response.json([
            {
              question_id: "q-1",
              role_id: "role-product-manager",
              key: "interaction_mode",
              title: "你希望它用什么方式和你交互？",
              question_type: "single_choice",
              options_json: [],
              enabled: true,
              sort_order: 10,
            },
          ]);
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions" && request.method === "POST") {
          return Response.json({
            question_id: "q-1",
            role_id: "role-product-manager",
            key: "interaction_mode",
            title: "你希望它用什么方式和你交互？",
            question_type: "single_choice",
            options_json: [],
            enabled: true,
            sort_order: 10,
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const listResponse = await server.fetch(new Request("http://localhost/v1/roles/role-product-manager/questions"));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ key: "interaction_mode" }),
    ]);

    const createResponse = await server.fetch(new Request("http://localhost/v1/roles/role-product-manager/questions", {
      method: "POST",
      body: JSON.stringify({
        actor_id: "admin-a",
        key: "interaction_mode",
        title: "你希望它用什么方式和你交互？",
        description: "",
        question_type: "single_choice",
        options_json: [],
        required: true,
        enabled: true,
        sort_order: 10,
        depends_on_json: [],
      }),
    }));
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      question_id: "q-1",
      role_id: "role-product-manager",
    });

    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/questions",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://data-service/v1/roles/role-product-manager/questions",
        method: "POST",
        body: {
          actor_id: "admin-a",
          key: "interaction_mode",
          title: "你希望它用什么方式和你交互？",
          description: "",
          question_type: "single_choice",
          options_json: [],
          required: true,
          enabled: true,
          sort_order: 10,
          depends_on_json: [],
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role_question.upsert",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            question_id: "q-1",
            key: "interaction_mode",
            enabled: true,
            sort_order: 10,
          },
        },
      },
    ]);
  });

  it("upserts bot config documents through data-service", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n我是 PRD 助手",
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/v1/bot-config-documents", {
      method: "POST",
      body: JSON.stringify({
        actor_id: "admin-a",
        bot_id: "prd-bot",
        title: "soul",
        content: "# Soul\n我是 PRD 助手",
      }),
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      title: "soul",
    });
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bot-config-documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          bot_id: "prd-bot",
          title: "soul",
          content: "# Soul\n我是 PRD 助手",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "bot_config_document.upsert",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            title: "soul",
          },
        },
      },
    ]);
  });

  it("renders a role detail editor with role rule document and questions", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        if (request.url === "http://data-service/v1/roles/role-product-manager") {
          return Response.json({
            role_id: "role-product-manager",
            name: "产品经理助手",
            slug: "product-manager",
            description: "产品经理角色",
            enabled: true,
            sort_order: 10,
          });
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/documents") {
          return Response.json([
            {
              role_document_id: "role-doc-1",
              role_id: "role-product-manager",
              title: "role.md",
              content: "# Role: Product Manager",
              enabled: true,
            },
          ]);
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions") {
          return Response.json([
            {
              question_id: "q-1",
              role_id: "role-product-manager",
              key: "interaction_mode",
              title: "你希望它用什么方式和你交互？",
              question_type: "single_choice",
              options_json: [],
              enabled: true,
              sort_order: 10,
            },
          ]);
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/roles/role-product-manager"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("角色详情");
    expect(html).toContain("产品经理助手");
    expect(html).toContain("# Role: Product Manager");
    expect(html).toContain("你希望它用什么方式和你交互？");
    expect(html).toContain("/v1/roles/role-product-manager/documents");
    expect(html).toContain("/v1/roles/role-product-manager/questions");
    expect(calls).toEqual([
      "http://data-service/v1/roles/role-product-manager",
      "http://data-service/v1/roles/role-product-manager/documents",
      "http://data-service/v1/roles/role-product-manager/questions",
    ]);
  });

  it("renders a bot config editor for soul and agents", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        if (request.url === "http://data-service/v1/bots/prd-bot") {
          return Response.json({
            bot_id: "prd-bot",
            name: "PRD Bot",
            runtime: "kiro",
            status: "ready",
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([
            { title: "soul", content: "# Soul\n我是 PRD 助手" },
            { title: "agents.md", content: "# AGENTS\n按产品经理规则工作" },
          ]);
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/bots/prd-bot/config"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Bot 配置编辑");
    expect(html).toContain("PRD Bot");
    expect(html).toContain("# Soul");
    expect(html).toContain("# AGENTS");
    expect(html).toContain("保存 Soul");
    expect(html).toContain("保存 Agents");
    expect(html).toContain("/v1/bot-config-documents");
    expect(calls).toEqual([
      "http://data-service/v1/bots/prd-bot",
      "http://data-service/v1/bots/prd-bot/config-documents",
    ]);
  });

  it("saves role documents from the admin role page", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/documents") {
          return Response.json({
            role_document_id: "role-doc-1",
            role_id: "role-product-manager",
            title: "role.md",
            content: "# Role: Product Manager",
            enabled: true,
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/roles/role-product-manager/documents/save", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        title: "role.md",
        content: "# Role: Product Manager",
        enabled: "true",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/roles/role-product-manager");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          title: "role.md",
          content: "# Role: Product Manager",
          enabled: true,
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role_document.upsert",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            role_document_id: "role-doc-1",
            title: "role.md",
            enabled: true,
          },
        },
      },
    ]);
  });

  it("saves role questions from the admin role page", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions") {
          return Response.json({
            question_id: "q-1",
            role_id: "role-product-manager",
            key: "interaction_mode",
            title: "你希望它用什么方式和你交互？",
            description: "",
            question_type: "single_choice",
            options_json: [],
            required: true,
            enabled: true,
            sort_order: 10,
            depends_on_json: [],
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/roles/role-product-manager/questions/save", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        key: "interaction_mode",
        title: "你希望它用什么方式和你交互？",
        description: "",
        question_type: "single_choice",
        options_json: "[]",
        required: "true",
        enabled: "true",
        sort_order: "10",
        depends_on_json: "[]",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/roles/role-product-manager");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/questions",
        method: "POST",
        body: {
          actor_id: "admin-a",
          key: "interaction_mode",
          title: "你希望它用什么方式和你交互？",
          description: "",
          question_type: "single_choice",
          options_json: [],
          required: true,
          enabled: true,
          sort_order: 10,
          depends_on_json: [],
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role_question.upsert",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            question_id: "q-1",
            key: "interaction_mode",
            enabled: true,
            sort_order: 10,
          },
        },
      },
    ]);
  });

  it("saves soul from the bot config editor page", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n我是 PRD 助手",
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/bots/prd-bot/config/soul", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        content: "# Soul\n我是 PRD 助手",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/bots/prd-bot/config");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bot-config-documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          bot_id: "prd-bot",
          title: "soul",
          content: "# Soul\n我是 PRD 助手",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "bot_config_document.upsert",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            title: "soul",
          },
        },
      },
    ]);
  });

  it("saves agents from the bot config editor page", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            bot_id: "prd-bot",
            title: "agents.md",
            content: "# AGENTS\n按产品经理规则工作",
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/bots/prd-bot/config/agents", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        content: "# AGENTS\n按产品经理规则工作",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/bots/prd-bot/config");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bot-config-documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          bot_id: "prd-bot",
          title: "agents.md",
          content: "# AGENTS\n按产品经理规则工作",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "bot_config_document.upsert",
          target_type: "bot",
          target_id: "prd-bot",
          metadata: {
            title: "agents.md",
          },
        },
      },
    ]);
  });
});
