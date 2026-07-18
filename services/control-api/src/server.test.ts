import { describe, expect, it } from "vitest";
import { createControlApiServer } from "./server.js";

describe("control-api server", () => {
  it("responds to health checks", async () => {
    const previousSha = process.env.APP_BUILD_SHA;
    const previousBuildTime = process.env.APP_BUILD_TIME;
    process.env.APP_BUILD_SHA = "sha-control";
    process.env.APP_BUILD_TIME = "2026-06-24T12:00:00.000Z";
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
      git_sha: "sha-control",
      build_time: "2026-06-24T12:00:00.000Z",
    });
    process.env.APP_BUILD_SHA = previousSha;
    process.env.APP_BUILD_TIME = previousBuildTime;
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
    expect(html).toContain("renderClaimCard");
    expect(html).toContain("已同步");
    expect(html).toContain("机器人配置");
    expect(html).toContain("运行能力");
    expect(html).toContain("编辑运行能力");
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

  it("renders a focused plaintext test environment editor", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const html = await (await server.fetch(new Request("http://localhost/"))).text();

    expect(html).toContain('data-action="edit-project"');
    expect(html).toContain("测试环境");
    expect(html).toContain("Python 解释器");
    expect(html).toContain("环境变量（.env）");
    expect(html).toContain("保存后可直接查看和编辑");
    expect(html).toContain("splitProjectEnvContent(projectEnv.content)");
    expect(html).not.toContain("项目 .env 已加密保存");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script ?? "")).not.toThrow();
    expect(html).toContain('id="projectEnvForm"');
    expect(html).toContain("/github bind");
    expect(html).not.toContain('id="projectForm"');
    expect(html).not.toContain("Git 仓库地址");
    expect(html).toContain('requestJson("/v1/bots/" + botId + "/project-env")');
  });

  it("proxies project dotenv management without auditing its content", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" || request.method === "DELETE"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/bots/qa-bot/project-env" && request.method === "GET") {
          return Response.json({ configured: false });
        }
        if (request.url === "http://data-service/v1/bots/qa-bot/project-env" && request.method === "PUT") {
          return Response.json({ configured: true, updated_at: "2026-07-14T00:00:00.000Z" });
        }
        if (request.url === "http://data-service/v1/bots/qa-bot/project-env" && request.method === "DELETE") {
          return Response.json({ configured: false });
        }
        if (request.url === "http://log-service/v1/audit-events" && request.method === "POST") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const listResponse = await server.fetch(new Request("http://localhost/v1/bots/qa-bot/project-env"));
    const saveResponse = await server.fetch(new Request("http://localhost/v1/bots/qa-bot/project-env", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor_id: "admin-a",
        content: "CLIENT_SECRET=private-value\n",
        updated_by_wecom_user_id: "admin-a",
      }),
    }));
    const deleteResponse = await server.fetch(new Request("http://localhost/v1/bots/qa-bot/project-env", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_id: "admin-a" }),
    }));

    expect(listResponse.status).toBe(200);
    expect(saveResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(expect.arrayContaining([
      "GET http://data-service/v1/bots/qa-bot/project-env",
      "PUT http://data-service/v1/bots/qa-bot/project-env",
      "DELETE http://data-service/v1/bots/qa-bot/project-env",
    ]));
    expect(calls.filter((call) => call.url === "http://log-service/v1/audit-events")).toHaveLength(2);
    expect(JSON.stringify(calls.filter((call) => call.url === "http://log-service/v1/audit-events")))
      .not.toContain("private-value");
  });

  it("exposes a prominent bot private capability management entry", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("编辑 Soul / Agents / rules");
    expect(html).toContain("edit-bot-config");
    expect(html).toContain("管理 Env / Skills / MCP");
    expect(html).toContain("manage-bot-capabilities");
    expect(html).toContain('window.location.href = "/admin/bots/"');
  });

  it("renders pending admin claim from channel detail data", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("pending_admin_claim");
    expect(html).toContain("function renderClaimCard(claim)");
    expect(html).toContain("renderClaimCard(detail.pending_admin_claim)");
    expect(html).toContain("认领码已被使用");
    expect(html).toContain("认领码已过期");
    expect(html).toContain("点击刷新");
  });

  it("renders global documents admin page", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/global-documents") {
          return Response.json([
            {
              document_id: "global_doc_1",
              title: "playground.md",
              slug: "playground",
              content: "# Playground",
              enabled: true,
              sort_order: 10,
            },
          ]);
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/global-documents"));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("全局配置");
    expect(html).toContain("playground.md");
    expect(html).toContain("/v1/global-documents");
    expect(html).toContain("/admin/global-documents/save");
    expect(html).toContain("保存");
    expect(html).not.toContain("/admin/global-documents/delete");
    expect(html).not.toContain('name="slug"');
    expect(html).not.toContain('name="sort_order"');
    expect(html).not.toContain('name="enabled"');
  });

  it("renders roles admin page", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/roles") {
          return Response.json([
            {
              role_id: "role_1",
              name: "产品经理",
              slug: "product-manager",
              description: "产品经理角色",
              enabled: true,
              sort_order: 10,
            },
          ]);
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/roles"));

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("角色管理");
    expect(html).toContain("产品经理");
    expect(html).toContain("/admin/roles/role_1");
    expect(html).toContain("/admin/roles/save");
    expect(html).toContain("/admin/roles/delete");
    expect(html).toContain("保存");
    expect(html).toContain("删除");
    expect(html).toContain("新增角色");
    expect(html).toContain('data-role-create');
    expect(html).toContain('data-role-card');
    expect(html).toContain("创建角色");
    expect(html).toContain("角色基础信息");
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain('name="slug"');
    expect(html).not.toContain('name="sort_order"');
    expect(html).toContain('type="radio" name="enabled" value="true"');
    expect(html).toContain('type="radio" name="enabled" value="false"');
  });

  it("saves global documents through admin forms", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" || request.method === "PUT"
          ? await request.text()
          : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/global-documents/global_doc_1" && request.method === "PUT") {
          return Response.json({ document_id: "global_doc_1", slug: "playground" });
        }
        if (request.url === "http://log-service/v1/audit-events" && request.method === "POST") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected", url: request.url, method: request.method }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/global-documents/save", {
      method: "POST",
      body: new URLSearchParams({
        actor_id: "admin-a",
        document_id: "global_doc_1",
        title: "playground.md",
        slug: "playground",
        content: "# Playground",
        enabled: "true",
        sort_order: "10",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/global-documents");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(expect.arrayContaining([
      "PUT http://data-service/v1/global-documents/global_doc_1",
    ]));
  });

  it("saves and deletes roles through admin forms", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" || request.method === "PUT"
          ? await request.text()
          : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles" && request.method === "POST") {
          return Response.json({ role_id: "role_new", slug: "new-role" }, { status: 201 });
        }
        if (request.url === "http://data-service/v1/roles/role_1" && request.method === "GET") {
          return Response.json({
            role_id: "role_1",
            name: "产品经理",
            slug: "product-manager",
            description: "产品经理角色",
            enabled: true,
            sort_order: 10,
          });
        }
        if (request.url === "http://data-service/v1/roles/role_1" && request.method === "PUT") {
          return Response.json({ role_id: "role_1", slug: "product-manager" });
        }
        if (request.url === "http://data-service/v1/roles/role_1" && request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (request.url === "http://log-service/v1/audit-events" && request.method === "POST") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected", url: request.url, method: request.method }, { status: 500 });
      },
    });

    const responses = await Promise.all([
      server.fetch(new Request("http://localhost/admin/roles/save", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          name: "新角色",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/roles/save", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          role_id: "role_1",
          name: "产品经理",
          enabled: "true",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/roles/delete", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          role_id: "role_1",
        }),
      })),
    ]);

    expect(responses[0].status).toBe(303);
    expect(responses[0].headers.get("location")).toBe("/admin/roles/role_new");
    expect(responses[1].status).toBe(303);
    expect(responses[1].headers.get("location")).toBe("/admin/roles");
    expect(responses[2].status).toBe(303);
    expect(responses[2].headers.get("location")).toBe("/admin/roles");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(expect.arrayContaining([
      "POST http://data-service/v1/roles",
      "PUT http://data-service/v1/roles/role_1",
      "DELETE http://data-service/v1/roles/role_1",
    ]));
    expect(calls.find((call) => call.url === "http://data-service/v1/roles" && call.method === "POST")).toEqual({
      url: "http://data-service/v1/roles",
      method: "POST",
      body: {
        actor_id: "admin-a",
        name: "新角色",
        slug: expect.any(String),
        description: "",
        enabled: true,
        sort_order: expect.any(Number),
      },
    });
    expect(calls.find((call) => call.url === "http://data-service/v1/roles/role_1" && call.method === "PUT")).toEqual({
      url: "http://data-service/v1/roles/role_1",
      method: "PUT",
      body: {
        actor_id: "admin-a",
        name: "产品经理",
        slug: "product-manager",
        description: "产品经理角色",
        enabled: true,
        sort_order: 10,
      },
    });
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
      capabilityRunnerUrl: "http://capability-runner",
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

  it("renders bot capability management sections with masked env metadata", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/bots/prd-bot") {
          return Response.json({
            bot_id: "prd-bot",
            name: "PRD Bot",
            runtime: "kiro",
            status: "ready",
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/env") {
          return Response.json({
            items: [
              {
                bot_id: "prd-bot",
                key: "OPENAI_API_KEY",
                is_set: true,
                updated_at: "2026-06-24T00:00:00.000Z",
              },
            ],
          });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/skills") {
          return Response.json([
            {
              bot_id: "prd-bot",
              name: "repo-analyzer",
              source_type: "github",
              source_ref: "https://github.com/acme/repo-analyzer",
              status: "installed",
            },
          ]);
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/mcps") {
          return Response.json([
            {
              bot_id: "prd-bot",
              name: "search-mcp",
              mode: "config",
              source_ref: "http://localhost:9300",
              status: "installed",
            },
          ]);
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/runtime-policy") {
          return Response.json({
            bot_id: "prd-bot",
            skill_install_policy: "admin_only",
            mcp_manage_policy: "open",
          });
        }
        if (request.url === "http://capability-runner/internal/skills/catalog") {
          return Response.json({
            items: [
              {
                name: "easemob-jira-testcase",
                description: "Analyze Jira for QA",
                source_type: "builtin",
                source_ref: "easemob-jira-testcase",
              },
            ],
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/admin/bots/prd-bot/capabilities"),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("环境变量");
    expect(html).toContain("Skills");
    expect(html).toContain("MCP");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("已设置");
    expect(html).toContain("****");
    expect(html).toContain("repo-analyzer");
    expect(html).toContain("easemob-jira-testcase");
    expect(html).toContain("安装 Skill");
    expect(html).toContain("/admin/bots/prd-bot/capabilities/skills/install");
    expect(html).toContain("添加 Skill");
    expect(html).toContain("目录名会自动作为 Skill 名称");
    expect(html).toContain("/admin/bots/prd-bot/capabilities/skills/upload");
    expect(html).toContain("/admin/bots/prd-bot/capabilities/skills/delete");
    expect(html).toContain("search-mcp");
    expect(html).toContain("skill_install_policy");
    expect(html).toContain("mcp_manage_policy");
    expect(html).not.toContain("sk-live-secret");
  });

  it("proxies bot capability save and delete actions then redirects back", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });

        if (request.url === "http://data-service/v1/bots/prd-bot/env" && request.method === "POST") {
          return Response.json({
            bot_id: "prd-bot",
            key: "OPENAI_API_KEY",
            is_set: true,
            updated_at: "2026-06-24T00:00:00.000Z",
          }, { status: 201 });
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/env/OPENAI_API_KEY" && request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install" && request.method === "POST") {
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/delete" && request.method === "POST") {
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (request.url === "http://capability-runner/internal/bots/prd-bot/mcps/install" && request.method === "POST") {
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (request.url === "http://capability-runner/internal/bots/prd-bot/mcps/delete" && request.method === "POST") {
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (request.url === "http://log-service/v1/audit-events" && request.method === "POST") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected", url: request.url, method: request.method }, { status: 500 });
      },
    } as Parameters<typeof createControlApiServer>[0]);

    const responses = await Promise.all([
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/env/save", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          key: "OPENAI_API_KEY",
          value_ciphertext: "ciphertext-secret",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/env/delete", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          key: "OPENAI_API_KEY",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/skills/install", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          name: "repo-analyzer",
          source_ref: "https://github.com/acme/repo-analyzer",
          source_type: "github",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/skills/delete", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          name: "repo-analyzer",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/mcps/install", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          name: "search-mcp",
          mode: "config",
          source_ref: "http://localhost:9300",
        }),
      })),
      server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/mcps/delete", {
        method: "POST",
        body: new URLSearchParams({
          actor_id: "admin-a",
          name: "search-mcp",
        }),
      })),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin/bots/prd-bot/capabilities");
    }

    const callUrls = calls.map((call) => `${call.method} ${call.url}`);
    expect(callUrls).toEqual(expect.arrayContaining([
      "POST http://data-service/v1/bots/prd-bot/env",
      "DELETE http://data-service/v1/bots/prd-bot/env/OPENAI_API_KEY",
      "POST http://capability-runner/internal/bots/prd-bot/skills/install",
      "POST http://capability-runner/internal/bots/prd-bot/skills/delete",
      "POST http://capability-runner/internal/bots/prd-bot/mcps/install",
      "POST http://capability-runner/internal/bots/prd-bot/mcps/delete",
    ]));
    expect(callUrls.filter((url) => url === "POST http://log-service/v1/audit-events")).toHaveLength(6);
  });

  it("uploads a local skill directory through the capability runner", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) throw new Error("expected Request");
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined;
        calls.push({ url: request.url, body });
        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });
    const form = new FormData();
    form.set("actor_id", "admin-a");
    form.append("files", new Blob(["---\nname: local-review\ndescription: Local review\n---\n"]), "SKILL.md");
    form.append("paths", "local-review/SKILL.md");

    const response = await server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/skills/upload", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/bots/prd-bot/capabilities");
    expect(calls[0]).toMatchObject({
      url: "http://capability-runner/internal/bots/prd-bot/skills/install",
      body: {
        name: "local-review",
        source_ref: "webui-local-upload",
        source_type: "local_upload",
        actor_id: "admin-a",
        files: [{ path: "local-review/SKILL.md" }],
      },
    });
  });

  it("surfaces env save failures instead of redirecting", async () => {
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/bots/prd-bot/env" && request.method === "POST") {
          return Response.json({ error: "invalid env value" }, { status: 400 });
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/bots/prd-bot/capabilities/env/save", {
      method: "POST",
      body: new URLSearchParams({
        actor_id: "admin-a",
        key: "OPENAI_API_KEY",
        value_ciphertext: "",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid env value",
    });
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

  it("queries message traces and trace spans through log-service", async () => {
    const calls: string[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) throw new Error("expected Request");
        calls.push(request.url);
        return Response.json([]);
      },
    });

    await server.fetch(new Request("http://localhost/v1/message-traces?bot_id=prd-bot&wecom_user_id=user-a"));
    await server.fetch(new Request("http://localhost/v1/trace-spans?bot_id=prd-bot&trace_id=trace-1"));

    expect(calls).toEqual([
      "http://log-service/internal/message-traces?bot_id=prd-bot&wecom_user_id=user-a",
      "http://log-service/internal/trace-spans?bot_id=prd-bot&trace_id=trace-1",
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

  it("does not crash when channel deletion succeeds but wecom runtime sync fails", async () => {
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

        if (request.url === "http://data-service/v1/bots/prd-bot") {
          return Response.json({
            bot_id: "prd-bot",
            name: "PRD Bot",
            runtime: "kiro",
            status: "ready",
            wecom_bot_id: "wecom-a",
            wecom_secret_configured: false,
            wecom_connection_status: "unchecked",
          });
        }
        if (request.url === "http://data-service/v1/bot-channels/wecom:prd-bot" && request.method === "DELETE") {
          return Response.json({
            channel_id: "wecom:prd-bot",
            bot_id: "prd-bot",
            runtime_status: "missing_secret",
            runtime_enabled: false,
          });
        }
        if (request.url === "http://bot-api/internal/wecom-runtime/sync" && request.method === "POST") {
          return Response.json({ error: "sync failed" }, { status: 500 });
        }
        if (request.url === "http://log-service/v1/audit-events" && request.method === "POST") {
          return Response.json({ ok: true }, { status: 201 });
        }
        return Response.json({ error: "unexpected", url: request.url, method: request.method }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/bot-channels/wecom:prd-bot", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      runtime_status: "missing_secret",
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(expect.arrayContaining([
      "DELETE http://data-service/v1/bot-channels/wecom:prd-bot",
      "POST http://bot-api/internal/wecom-runtime/sync",
      "POST http://log-service/v1/audit-events",
    ]));
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
              name: "产品经理",
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
            name: "产品经理",
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
        name: "产品经理",
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
          name: "产品经理",
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
            name: "产品经理",
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
            name: "产品经理",
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
              options_json: [
                { value: "step", label: "逐句引导" },
                { value: "batch", label: "批量引导" },
                { value: "recommend", label: "推荐优先" },
                              ],
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
    expect(html).toContain("产品经理");
    expect(html).toContain("基础信息");
    expect(html).toContain("角色规则");
    expect(html).toContain("引导问题");
    expect(html).toContain("初始化时会逐题询问管理员");
    expect(html).toContain("# Role: Product Manager");
    expect(html).toContain("你希望它用什么方式和你交互？");
    expect(html).toContain("/v1/roles/role-product-manager/documents");
    expect(html).toContain("/v1/roles/role-product-manager/questions");
    expect(html).toContain("/admin/roles/role-product-manager/documents/save");
    expect(html).toContain("/admin/roles/role-product-manager/questions/save");
    expect(html).toContain("/admin/roles/role-product-manager/questions/delete");
    expect(html).toContain('data-add-question');
    expect(html).toContain("添加问题");
    expect(html).toContain("新增选项");
    expect(html).toContain('data-add-option');
    expect(html).toContain("question-list");
    expect(html).toContain("question-options");
    expect(html).toContain("是否默认添加其他");
    expect(html).toContain("删除问题");
    expect(html).not.toContain("选项 JSON");
    expect(html).not.toContain("条件 JSON");
    expect(html).toContain('name="option_label_0"');
    expect(html).toContain('name="option_label_2"');
    expect(html).not.toContain('name="option_value_0"');
    expect(html).not.toContain('name="option_value_2"');
    expect(html).not.toContain('name="key"');
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain('name="question_type"');
    expect(html).not.toContain('name="sort_order"');
    expect(html).not.toContain('name="depends_on_question_key"');
    expect(html).not.toContain('name="depends_on_option_value"');
    expect(html).not.toContain('name="required"');
    expect(html).toContain('type="radio" name="enabled" value="true"');
    expect(html).toContain('type="radio" name="enabled" value="false"');
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
            { title: "rules.md", content: "# Rules\n只在当前会话目录中工作" },
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
    expect(html).toContain("# Rules");
    expect(html).toContain("保存 Soul");
    expect(html).toContain("保存 Agents");
    expect(html).toContain("运行规则（rules.md）");
    expect(html).toContain("保存 rules.md");
    expect(html).toContain("/admin/bots/prd-bot/config/rules");
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

  it("updates role documents from the admin role page when role_document_id is present", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" || request.method === "PUT" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/documents/role-doc-1") {
          return Response.json({
            role_document_id: "role-doc-1",
            role_id: "role-product-manager",
            title: "role.md",
            content: "# Updated Role",
            enabled: true,
          }, { status: 200 });
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
        role_document_id: "role-doc-1",
        title: "role.md",
        content: "# Updated Role",
        enabled: "true",
      }),
    }));

    expect(response.status).toBe(303);
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/documents/role-doc-1",
        method: "PUT",
        body: {
          actor_id: "admin-a",
          title: "role.md",
          content: "# Updated Role",
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
        const bodyText = request.method === "POST" || request.method === "PUT" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions" && request.method === "GET") {
          return Response.json([]);
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions" && request.method === "POST") {
          return Response.json({
            question_id: "q-1",
            role_id: "role-product-manager",
            key: "interaction_mode",
            title: "你希望它用什么方式和你交互？",
            description: "",
            question_type: "single_choice",
            options_json: [
              { value: "step", label: "逐句引导" },
              { value: "batch", label: "批量引导" },
            ],
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
        title: "你希望它用什么方式和你交互？",
        option_label_0: "逐句引导",
        option_label_1: "批量引导",
        append_other_option: "true",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/roles/role-product-manager");
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
          key: expect.any(String),
          title: "你希望它用什么方式和你交互？",
          description: "",
          question_type: "single_choice",
          options_json: [
            { value: "option_1", label: "逐句引导" },
            { value: "option_2", label: "批量引导" },
            { value: "other", label: "其他，可直接描述" },
          ],
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

  it("updates role questions from the admin role page when question_id is present", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const bodyText = request.method === "POST" || request.method === "PUT" ? await request.text() : "";
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        calls.push({ url: request.url, method: request.method, body });
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions" && request.method === "GET") {
          return Response.json([
            {
              question_id: "q-1",
              role_id: "role-product-manager",
              key: "interaction_mode",
              title: "旧问题",
              description: "",
              question_type: "single_choice",
              options_json: [
                { value: "step", label: "逐句引导" },
                { value: "batch", label: "批量引导" },
              ],
              required: true,
              enabled: true,
              sort_order: 10,
              depends_on_json: [{ question_key: "role_type", option_value: "pm" }],
            },
          ]);
        }
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions/q-1") {
          return Response.json({
            question_id: "q-1",
            role_id: "role-product-manager",
            key: "interaction_mode",
            title: "更新后的问题",
            description: "",
            question_type: "single_choice",
            options_json: [
              { value: "step", label: "逐句引导" },
              { value: "batch", label: "批量引导" },
            ],
            required: true,
            enabled: true,
            sort_order: 10,
            depends_on_json: [{ question_key: "role_type", option_value: "pm" }],
          }, { status: 200 });
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
        question_id: "q-1",
        title: "更新后的问题",
        option_label_0: "逐句引导",
        option_label_1: "批量引导",
        append_other_option: "true",
      }),
    }));

    expect(response.status).toBe(303);
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/questions",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://data-service/v1/roles/role-product-manager/questions/q-1",
        method: "PUT",
        body: {
          actor_id: "admin-a",
          key: "interaction_mode",
          title: "更新后的问题",
          description: "",
          question_type: "single_choice",
          options_json: [
            { value: "option_1", label: "逐句引导" },
            { value: "option_2", label: "批量引导" },
            { value: "other", label: "其他，可直接描述" },
          ],
          required: true,
          enabled: true,
          sort_order: 10,
          depends_on_json: [{ question_key: "role_type", option_value: "pm" }],
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

  it("deletes role questions from the admin role page", async () => {
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
        if (request.url === "http://data-service/v1/roles/role-product-manager/questions/q-1" && request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/roles/role-product-manager/questions/delete", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        question_id: "q-1",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/roles/role-product-manager");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/roles/role-product-manager/questions/q-1",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "role_question.delete",
          target_type: "role",
          target_id: "role-product-manager",
          metadata: {
            question_id: "q-1",
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

  it("saves rules.md from the bot config editor page", async () => {
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
            bot_id: "test-jira-bot",
            title: "rules.md",
            content: "只在当前会话目录中工作。",
          }, { status: 201 });
        }
        if (request.url === "http://log-service/v1/audit-events") {
          return Response.json({ event_id: "audit-1" }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(new Request("http://localhost/admin/bots/test-jira-bot/config/rules", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        actor_id: "admin-a",
        content: "只在当前会话目录中工作。",
      }),
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/bots/test-jira-bot/config");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bot-config-documents",
        method: "POST",
        body: {
          actor_id: "admin-a",
          bot_id: "test-jira-bot",
          title: "rules.md",
          content: "只在当前会话目录中工作。",
        },
      },
      {
        url: "http://log-service/v1/audit-events",
        method: "POST",
        body: {
          actor_id: "admin-a",
          action: "bot_config_document.upsert",
          target_type: "bot",
          target_id: "test-jira-bot",
          metadata: {
            title: "rules.md",
          },
        },
      },
    ]);
  });

  it("renders and submits the ordinary-user Jira credential binding page", async () => {
    const forwardedBodies: unknown[] = [];
    const server = createControlApiServer({
      dataServiceUrl: "http://data-service",
      logServiceUrl: "http://log-service",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === "GET") {
          return Response.json({
            provider: "easemob_jira",
            expires_at: "2026-07-13T18:00:00.000Z",
          });
        }
        forwardedBodies.push(await request.json());
        return Response.json({ provider: "easemob_jira", is_bound: true });
      },
    });

    const page = await server.fetch(new Request(
      "http://localhost/bind/jira?token=one-time-token",
    ));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("绑定 Jira 账号");
    expect(html).toContain("one-time-token");
    expect(html).not.toContain("管理员配置");

    const submitted = await server.fetch(new Request("http://localhost/bind/jira", {
      method: "POST",
      body: new URLSearchParams({
        token: "one-time-token",
        username: "jira-user-a",
        password: "jira-password-a",
        use_same_credentials: "on",
      }),
    }));
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain("Jira 账号绑定成功");
    expect(forwardedBodies).toEqual([{
      username: "jira-user-a",
      password: "jira-password-a",
      redirect_username: "jira-user-a",
      redirect_password: "jira-password-a",
    }]);
  });
});
