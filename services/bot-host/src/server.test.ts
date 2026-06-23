import { describe, expect, it } from "vitest";
import {
  createBotHostServer,
  createBotHostSupervisor,
  createBotHostWorker,
} from "./server.js";

describe("bot-host server", () => {
  it("responds to health checks", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("not used", { status: 500 }),
    });

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "bot-host",
      status: "ok",
    });
  });

  it("resolves conversation and sends prompt to llm-runner", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: body.bot_id,
            wecom_user_id: body.wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
              bot_id: body.bot_id,
              wecom_user_id: body.wecom_user_id,
              channel: body.channel,
              purpose: body.purpose,
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-1",
            runner_session_id: "mock:prd-bot:user-a:conv-1",
            output: "mock: hello",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "hello",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: "run-1",
      output: "mock: hello",
    });
    expect(calls[0]).toEqual(
      {
        url: "http://data-service/v1/message-context/resolve",
        body: {
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          channel: "wecom_direct",
          purpose: "normal_chat",
        },
      },
    );
    expect(calls.slice(1, 7).map((call) => call.url)).toEqual([
      "http://data-service/v1/bots/prd-bot/config-documents",
      "http://data-service/v1/memory-documents/current?scope=system&owner_id=platform",
      "http://data-service/v1/memory-documents/current?scope=shared&owner_id=platform",
      "http://data-service/v1/memory-documents/current?scope=bot&owner_id=prd-bot",
      "http://data-service/v1/memory-documents/current?scope=user&owner_id=user-a",
      "http://data-service/v1/memory-documents/current?scope=session&owner_id=conv-1",
    ]);
    expect(calls[7]).toEqual(
      {
        url: "http://llm-runner/v1/chat",
        body: {
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: "hello",
        },
      },
    );
  });

  it("injects current memory documents into the llm prompt", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: body.bot_id,
            wecom_user_id: body.wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=system&owner_id=platform") {
          return Response.json([
            {
              title: "platform",
              version: 1,
              content: "Use concise Chinese.",
            },
          ]);
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=shared&owner_id=platform") {
          return Response.json([
            {
              title: "product",
              version: 2,
              content: "Shared product context.",
            },
          ]);
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([
            {
              title: "soul",
              content: "You are a PRD bot.",
            },
          ]);
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=user&owner_id=user-a") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=bot&owner_id=prd-bot") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=session&owner_id=conv-1") {
          return Response.json([
            {
              title: "session",
              version: 1,
              content: "Earlier discussion.",
            },
          ]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-1",
            output: "mock: answer",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "hello",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const llmCall = calls.find((call) => call.url === "http://llm-runner/v1/chat");
    expect(llmCall?.body).toMatchObject({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
    });
    expect((llmCall?.body as { prompt: string }).prompt).toBe([
      "<memory>",
      "[bot-config/prd-bot] soul",
      "You are a PRD bot.",
      "[system/platform v1] platform",
      "Use concise Chinese.",
      "[shared/platform v2] product",
      "Shared product context.",
      "[session/conv-1 v1] session",
      "Earlier discussion.",
      "</memory>",
      "",
      "<message>",
      "hello",
      "</message>",
    ].join("\n"));
  });

  it("does not expose memory prompt when runtime echoes the full prompt", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: body.bot_id,
            wecom_user_id: body.wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "你是产品经理助手。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-echo",
            output: `fake-kiro: ${(body as { prompt: string }).prompt}`,
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "我需要一个语音转文字的api",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toBe("LLM 运行器没有生成有效回复，请稍后重试或检查 runtime 配置。");
    expect(payload.output).not.toContain("<memory>");
    expect(payload.output).not.toContain("<message>");
    expect(payload.output).not.toContain("你是产品经理助手");
    expect(payload.output).not.toContain("我需要一个语音转文字的api");
  });

  it("records successful chat events with memory refs", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              memory_doc_id: "mem-soul",
              title: "soul",
              content: "You are a PRD bot.",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-1",
            output: "mock: answer",
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ event_id: "evt-1" }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "hello",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const logCall = calls.find((call) => call.url === "http://log-service/v1/chat-events");
    expect(logCall?.body).toEqual({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "hello",
      output: "mock: answer",
      run_id: "run-1",
      memory_refs: [
        {
          scope: "bot-config",
          owner_id: "prd-bot",
          memory_doc_id: "mem-soul",
          title: "soul",
        },
      ],
    });
  });

  it("blocks messages when data-service says bot is not ready", async () => {
    const calls: string[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({
          allowed: false,
          reason: "admin_unclaimed",
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "hello",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "admin_unclaimed",
    });
    expect(calls).toEqual(["http://data-service/v1/message-context/resolve"]);
  });

  it("verifies admin claim commands before normal message routing", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = await request.json();
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/bots/prd-bot/admin/claim/verify") {
          return Response.json({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            role: "admin",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/claim_admin 123456",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload).toMatchObject({
      claimed: true,
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      status: "initializing",
    });
    expect(payload.output).toContain("Soul 引导 1/3：你希望我扮演什么角色？");
    expect(payload.output).toContain("1. 产品经理助手");
    expect(payload.output).toContain("回复编号或直接输入。");
    expect(calls).toEqual([
      {
        url: "http://data-service/v1/bots/prd-bot/admin/claim/verify",
        body: {
          wecom_user_id: "admin-a",
          code: "123456",
        },
      },
    ]);
  });

  it("starts server-owned initialization wizard immediately after a successful admin claim", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/bots/prd-bot/admin/claim/verify") {
          return Response.json({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            role: "admin",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/claim_admin 123456",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload).toMatchObject({
      claimed: true,
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      status: "initializing",
    });
    expect(payload.output).toContain("Soul 引导 1/3：你希望我扮演什么角色？");
    expect(payload.output).toContain("1. 产品经理助手");
    expect(payload.output).toContain("回复编号或直接输入。");
    expect(calls).toHaveLength(1);
  });

  it("guides soul first, then agents, before marking the bot ready", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          const prompt = (body as { prompt: string }).prompt;
          if (prompt.includes("请根据以下 Soul 引导配置生成 soul 文档。")) {
            return Response.json({
              run_id: "run-soul-done",
              output: [
                "Soul 已生成。",
                "~document:private/soul.md",
                "# Soul",
                "你是产品经理助手，性格冷静务实，沟通简洁直接。",
                "~/document",
              ].join("\n"),
            });
          }
          return Response.json({
            run_id: "run-agents-done",
            output: [
              "~document:instructions/AGENTS.md",
              "# AGENTS",
              "核心工作：撰写/维护 PRD。PRD 交付前必须逐项确认 Console、IMM、计量计费；一次只能问一个确认项；不得要求用户使用 1a 2a 3a 这种组合格式。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: `mem-${(body as { title: string }).title}`,
            ...(body as object),
          }, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = [
      "1",
      "1",
      "1",
      "环信，即时通讯云服务商，提供 IM SDK 和 REST API",
      "1",
      "1",
      "1",
      "1",
      "固定使用 bot-memory，MCP 只能写业务文档和长期记忆",
      "PRD 生成前必须逐项确认 Console、IMM、计量计费",
    ];
    const outputs: string[] = [];
    for (const text of messages) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      const payload = await response.json() as { output: string };
      expect(response.status, JSON.stringify(payload)).toBe(200);
      outputs.push(payload.output);
    }

    expect(outputs).toEqual([
      "Soul 引导 2/3：你希望我的性格是什么样的？\n1. 冷静务实\n2. 严谨审慎\n3. 主动推进\n4. 友好耐心\n5. 其他，请直接说明\n\n回复编号或直接输入。",
      "Soul 引导 3/3：你希望我的沟通风格是什么？\n1. 简洁直接\n2. 严谨完整\n3. 先问清楚再回答\n4. 给出选项辅助决策\n5. 其他，请直接说明\n\n回复编号或直接输入。",
      "Soul 配置已确认，正在生成 soul。\n\nSoul 已生成。\n\n开始配置工作方式。\n\nAgents 引导 1/7：业务背景是什么？公司/团队是做什么的？\n1. 跳过，后续再补充\n2. 直接输入业务背景\n\n回复编号或直接输入。",
      "Agents 引导 2/7：这个机器人只负责一类核心工作，你希望它的核心工作是什么？\n1. 撰写/维护 PRD\n2. 竞品分析\n3. 需求评审与拆解\n4. 用户故事编写\n5. 数据指标定义\n6. QA 测试\n7. 技术文档\n8. 项目管理\n9. 其他，请直接说明\n\n回复编号或直接输入。",
      "Agents 引导 3/7：你希望它用什么方式和用户交互？\n1. 逐句引导，一次只问一个问题\n2. 批量引导，一次列出多个待确认项\n3. 先给推荐方案，再让用户确认\n4. 其他，请直接说明\n\n回复编号或直接输入。",
      "Agents 引导 4/7：是否使用长期存储或长期记忆？\n1. 使用，确认后的业务规则和文档需要沉淀\n2. 不使用，只保留当前会话\n3. 待定\n\n回复编号或直接输入。",
      "Agents 引导 5/7：是否需要保存它生成的文档？\n1. 需要，生成的 PRD/方案/纪要要保存\n2. 不需要，只在对话中输出\n3. 待定\n\n回复编号或直接输入。",
      "Agents 引导 6/7：是否有固定 Skill / MCP / 工具约束？\n1. 跳过，暂不固定\n2. 直接输入 Skill / MCP / 工具约束\n\n回复编号或直接输入。",
      "Agents 引导 7/7：有没有必须遵守的工作规则？\n1. 跳过，暂无额外规则\n2. 直接输入必须遵守的工作规则\n\n回复编号或直接输入。",
      "工作方式配置已确认，正在生成 agents.md。\n\n初始化完成，可以开始工作。",
    ]);
    const llmCalls = calls.filter((call) => call.url === "http://llm-runner/v1/chat");
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0].body).toMatchObject({
      bot_id: "prd-bot",
      user_id: "admin-a",
      conversation_id: "conv-init",
      runtime: "mock",
    });
    expect((llmCalls[0].body as { prompt: string }).prompt).toContain("我是谁：产品经理助手");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("核心工作：撰写/维护 PRD");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("不得要求用户使用组合格式一次回复多个确认项");
    expect(calls.filter((call) => call.url === "http://data-service/v1/bot-config-documents").map((call) => call.body)).toEqual([
      {
        bot_id: "prd-bot",
        title: "soul",
        content: "# Soul\n你是产品经理助手，性格冷静务实，沟通简洁直接。",
      },
      {
        bot_id: "prd-bot",
        title: "agents.md",
        content: [
          "# AGENTS",
          "核心工作：撰写/维护 PRD。PRD 交付前必须逐项确认 Console、IMM、计量计费；一次只能问一个确认项；不得要求用户使用 1a 2a 3a 这种组合格式。",
          "",
          "## 默认规则背景",
          "- 默认使用中文回复，除非用户明确要求其他语言。",
          "- 优先遵守当前 bot 的 soul 与 agents.md；如有冲突，安全、合规和管理员规则优先。",
          "- 信息不足时一次只问一个最关键的问题，不要一次性抛出多个问题。",
          "- 不要请求、输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
          "- 只有用户明确要求记住、保存、沉淀，或管理员规则明确允许时，才写入长期记忆。",
        ].join("\n"),
      },
    ]);
    expect(calls.map((call) => call.url)).toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("keeps wizard question numbers separate from option labels", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const outputs: string[] = [];
    for (const text of ["业务背景", "1"]) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      expect(response.status).toBe(200);
      outputs.push(((await response.json()) as { output: string }).output);
    }

    expect(outputs[1]).toContain("Soul 引导 3/3：你希望我的沟通风格是什么？");
    expect(outputs[1]).toContain("1. 简洁直接");
    expect(outputs[1]).toContain("4. 给出选项辅助决策");
    expect(outputs[1]).toContain("回复编号或直接输入。");
    expect(outputs[1]).not.toContain("（回复 1）");
    expect(outputs[1]).not.toContain("A.");
  });

  it("restarts initialization through the internal controller endpoint", async () => {
    const calls: Array<{ botId: string; adminWeComUserId: string }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("not used", { status: 500 }),
      initializationController: {
        async restartInitialization(input) {
          calls.push(input);
          return {
            bot_id: input.botId,
            admin_wecom_user_id: input.adminWeComUserId,
            output: "问题 1/8：先了解一下业务背景",
          };
        },
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/prd-bot/initialization/restart", {
        method: "POST",
        body: JSON.stringify({
          admin_wecom_user_id: "admin-a",
        }),
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
        botId: "prd-bot",
        adminWeComUserId: "admin-a",
      },
    ]);
  });

  it("syncs supervised workers through the internal runtime endpoint", async () => {
    let runtimeBots = [
      {
        bot_id: "prd-bot",
        runtime: "mock" as const,
        wecom_bot_id: "wecom-bot-a",
        wecom_secret: "secret-a",
      },
    ];
    const connected: string[] = [];
    const disconnected: string[] = [];
    const supervisor = createBotHostSupervisor({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      pollIntervalMs: 60_000,
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/internal/wecom-runtime/bots") {
          return Response.json(runtimeBots);
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      createWeComClient(input) {
        return {
          async connect() {
            connected.push(input.botId);
          },
          disconnect() {
            disconnected.push(input.botId);
          },
          onMessage() {},
          async sendText() {},
        };
      },
    });
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("not used", { status: 500 }),
      runtimeController: {
        sync() {
          return supervisor.sync!();
        },
      },
    });

    await supervisor.start();
    runtimeBots = [];
    const response = await server.fetch(
      new Request("http://localhost/internal/wecom-runtime/sync", {
        method: "POST",
      }),
    );
    supervisor.stop();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synced: true });
    expect(connected).toEqual(["wecom-bot-a"]);
    expect(disconnected).toEqual(["wecom-bot-a"]);
  });

  it("requires a single core work choice during agents guidance", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-soul",
            output: [
              "Soul 已生成。",
              "~document:private/soul.md",
              "# Soul",
              "你是产品经理助手，性格冷静务实，沟通简洁直接，负责把模糊需求澄清成可执行结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "环信，即时通讯运营商", "1,2", "1"];
    const outputs: string[] = [];
    for (const text of messages) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      const payload = await response.json() as { output: string };
      expect(response.status, JSON.stringify(payload)).toBe(200);
      outputs.push(payload.output);
    }

    expect(outputs[4]).toBe("核心工作只能选择一个。请重新回复一个选项编号，或直接说明一个核心工作。");
    expect(outputs[5]).toContain("Agents 引导 3/7：你希望它用什么方式和用户交互？");
  });

  it("allows natural core work text that contains a slash", async () => {
    const calls: string[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-soul",
            output: [
              "Soul 已生成。",
              "~document:private/soul.md",
              "# Soul",
              "你是产品经理助手，性格冷静务实，沟通简洁直接。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "环信，即时通讯运营商", "撰写/维护 PRD"];
    const outputs: string[] = [];
    for (const text of messages) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      const payload = await response.json() as { output: string };
      expect(response.status, JSON.stringify({ payload, calls })).toBe(200);
      outputs.push(payload.output);
    }

    expect(outputs.at(-1)).toContain("Agents 引导 3/7：你希望它用什么方式和用户交互？");
  });

  it("rejects placeholder initialization documents without marking ready", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: { conversation_id: "conv-init", purpose: "init" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-placeholder",
            output: [
              "~document:private/soul.md",
              "(生成的正式 soul 内容，不包含 [BOOTSTRAP] 标记)",
              "~/document",
            ].join("\n"),
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1"];
    let last: { output: string; ready?: boolean } | undefined;
    for (const text of messages) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      expect(response.status).toBe(200);
      last = await response.json() as { output: string; ready?: boolean };
    }

    expect(last).toMatchObject({
      output: "初始化文档生成失败：生成结果仍是模板占位符。请回复“确认”重新生成，或说明需要修改的配置。",
    });
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/v1/bot-config-documents");
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("falls back to deterministic initialization documents when document generation returns plain text", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: { conversation_id: "conv-init", purpose: "init" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-plain-text",
            output: "fake-kiro: 请根据以下管理员初始化配置生成两个文档块：soul 和 agents.md。",
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: `mem-${(body as { title: string }).title}`,
            ...(body as object),
          }, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "背景", "1", "1", "1", "1", "跳过", "PRD 需要逐项确认 Console、IMM、计量计费"];
    let last: { output: string; ready?: boolean } | undefined;
    for (const text of messages) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text,
            runtime: "mock",
          }),
        }),
      );
      expect(response.status).toBe(200);
      last = await response.json() as { output: string; ready?: boolean };
    }

    expect(last).toMatchObject({
      output: "工作方式配置已确认，正在生成 agents.md。\n\n初始化完成，可以开始工作。",
      ready: true,
      initialized: true,
      status: "ready",
    });
    expect(last?.output).not.toContain("请根据以下管理员初始化配置");
    expect(calls.filter((call) => call.url === "http://data-service/v1/bot-config-documents").map((call) => call.body)).toEqual([
      expect.objectContaining({
        bot_id: "prd-bot",
        title: "soul",
        content: expect.stringContaining("## 我是谁"),
      }),
      expect.objectContaining({
        bot_id: "prd-bot",
        title: "agents.md",
        content: expect.stringContaining("## 核心工作"),
      }),
    ]);
    const configWrites = calls
      .filter((call) => call.url === "http://data-service/v1/bot-config-documents")
      .map((call) => call.body as { title: string; content: string });
    const soul = configWrites.find((document) => document.title === "soul")?.content || "";
    const agents = configWrites.find((document) => document.title === "agents.md")?.content || "";
    expect(soul).toContain("产品经理助手");
    expect(soul).toContain("性格");
    expect(soul).not.toContain("核心职责：");
    expect(soul).not.toContain("Skill / MCP");
    expect(agents).toContain("撰写/维护 PRD");
    expect(agents).toContain("交互规则");
    expect(agents).toContain("## 默认规则背景");
    expect(agents).toContain("默认使用中文回复");
    expect(agents).not.toContain("角色定位：");
    expect(agents).toContain("业务背景：背景");
    expect(calls.map((call) => call.url)).toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("returns claim failure when admin claim code is invalid", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        return Response.json({ error: "invalid admin claim code" }, { status: 400 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/claim_admin 000000",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      claim_failed: true,
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      reason: "invalid admin claim code",
    });
  });

  it("routes allowed initializing admin messages through init conversation", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-init",
            output: "mock: init answer",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "初始化回答",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { conversation_id: string; output: string };
    expect(payload).toMatchObject({
      conversation_id: "conv-init",
    });
    expect(payload.output).toContain("Soul 引导 2/3：你希望我的性格是什么样的？");
    expect(payload.output).toContain("1. 冷静务实");
    expect(payload.output).toContain("回复编号或直接输入。");
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
    ]);
  });

  it("stores bot memory when a user sends a remember command", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: false,
            conversation: {
              conversation_id: "conv-chat",
            },
          });
        }

        if (request.url === "http://data-service/v1/memory-documents") {
          return Response.json({
            memory_doc_id: "mem-1",
            scope: "bot",
            owner_id: "prd-bot",
            title: "用户记忆",
            version: 1,
          }, { status: 201 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "记住 PRD 生成前必须确认 Console、IMM、计量计费。",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      remembered: true,
      scope: "bot",
      owner_id: "prd-bot",
      memory_doc_id: "mem-1",
      output: "已记住：PRD 生成前必须确认 Console、IMM、计量计费。",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/memory-documents",
    ]);
    expect(calls[1].body).toMatchObject({
      scope: "bot",
      owner_id: "prd-bot",
      title: "用户记忆",
      content: "PRD 生成前必须确认 Console、IMM、计量计费。",
    });
  });

  it("requires admin permission for shared memory writes", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: false,
            conversation: {
              conversation_id: "conv-chat",
            },
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/remember --shared 所有机器人都要先澄清范围。",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "shared_memory_requires_admin",
      output: "只有管理员可以写入共享记忆。",
    });
  });

  it("injects remembered bot memory into the next normal chat", async () => {
    let rememberedContent = "";
    const prompts: string[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: false,
            conversation: {
              conversation_id: "conv-chat",
            },
          });
        }

        if (request.url === "http://data-service/v1/memory-documents") {
          rememberedContent = (body as { content: string }).content;
          return Response.json({
            memory_doc_id: "mem-1",
            scope: "bot",
            owner_id: "prd-bot",
            title: "用户记忆",
            version: 1,
          }, { status: 201 });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/memory-documents/current?scope=bot&owner_id=prd-bot") {
          return Response.json(rememberedContent
            ? [{
              memory_doc_id: "mem-1",
              title: "用户记忆",
              version: 1,
              content: rememberedContent,
            }]
            : []);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          prompts.push((body as { prompt: string }).prompt);
          return Response.json({
            run_id: "run-chat",
            output: "mock: ok",
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/remember PRD 生成前必须确认 Console。",
          runtime: "mock",
        }),
      }),
    );
    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "开始写 PRD",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(prompts[0]).toContain("[bot/prd-bot v1] 用户记忆");
    expect(prompts[0]).toContain("PRD 生成前必须确认 Console。");
    expect(prompts[0]).toContain("<message>\n开始写 PRD\n</message>");
  });

  it("marks bot ready when initializing admin sends mark_ready command", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({
            bot_id: "prd-bot",
            status: "ready",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/mark_ready",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ready: true,
      bot_id: "prd-bot",
      status: "ready",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/ready",
    ]);
  });

  it("blocks mark_ready from non-admin users", async () => {
    const calls: string[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        return Response.json({
          allowed: false,
          reason: "initialization_required",
          is_admin: false,
        });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/mark_ready",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "initialization_required",
    });
    expect(calls).toEqual(["http://data-service/v1/message-context/resolve"]);
  });

  it("starts a wecom worker and replies to incoming text messages", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const calls: Array<{ url: string; body: unknown }> = [];
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json() : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({ type: "chunk", content: "mock: hello" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text, options) {
          sent.push({
            conversationId,
            text: `${text}:${options?.finish ?? true}`,
          });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hello",
    });

    expect(calls[0]).toEqual({
      url: "http://data-service/v1/message-context/resolve",
      body: {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        channel: "wecom_direct",
        purpose: "normal_chat",
      },
    });
    expect(sent[0]).toEqual({
      conversationId: "conversation-a",
      text: "正在思考...:false",
    });
    expect(sent.slice(1, -1).map((item) => item.text)).toEqual([]);
    expect(sent.at(-1)).toEqual({
      conversationId: "conversation-a",
      text: "mock: hello:true",
    });
  });

  it("streams llm chunks to real wecom messages", async () => {
    const sent: Array<{ conversationId: string; text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          expect(body).toMatchObject({
            bot_id: "prd-bot",
            user_id: "user-a",
            conversation_id: "conv-1",
            runtime: "kiro",
          });
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1", runner_session_id: "kiro:prd-bot:user-a:conv-1" }),
            JSON.stringify({ type: "chunk", content: "he" }),
            JSON.stringify({ type: "chunk", content: "llo" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      logServiceUrl: "http://log-service",
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text, options) {
          sent.push({ conversationId, text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hello",
    });

    expect(sent[0]).toEqual({ conversationId: "conversation-a", text: "正在思考...", finish: false });
    expect(sent.slice(1, -1).map((item) => item.text)).toEqual([]);
    expect(sent.at(-1)).toEqual({ conversationId: "conversation-a", text: "hello", finish: true });
  });

  it("presentation-streams a single upstream chunk without per-character wecom updates", async () => {
    const sent: Array<{ text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          expect(body).toMatchObject({ runtime: "kiro" });
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({ type: "chunk", content: "\u001b[m> \u001b[0m这是一个需要被拆开展示的完整回答。" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      logServiceUrl: "http://log-service",
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(_conversationId, text, options) {
          sent.push({ text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hello",
    });

    expect(sent[0]).toEqual({ text: "正在思考...", finish: false });
    expect(sent.slice(1, -1).map((item) => item.text)).toEqual([]);
    expect(sent.slice(1, -1).every((item) => item.finish === false)).toBe(true);
    expect(sent.at(-1)).toEqual({
      text: "这是一个需要被拆开展示的完整回答。",
      finish: true,
    });
  });

  it("refreshes pending wecom stream updates on a fixed interval", async () => {
    const sent: Array<{ text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({ type: "chunk", content: "a" }),
            JSON.stringify({ type: "chunk", content: "b" }),
            JSON.stringify({ type: "chunk", content: "c" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      logServiceUrl: "http://log-service",
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(_conversationId, text, options) {
          sent.push({ text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hello",
    });

    expect(sent).toEqual([
      { text: "正在思考...", finish: false },
      { text: "abc", finish: true },
    ]);
  });

  it("sends the latest accumulated stream content during long running replies", async () => {
    const sent: Array<{ text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "run", run_id: "run-1" })}\n`));
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "chunk", content: "hello" })}\n`));
              await new Promise((resolve) => setTimeout(resolve, 700));
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "chunk", content: " world" })}\n`));
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      logServiceUrl: "http://log-service",
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(_conversationId, text, options) {
          sent.push({ text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hello",
    });

    expect(sent).toEqual([
      { text: "正在思考...", finish: false },
      { text: "hello", finish: false },
      { text: "hello world", finish: true },
    ]);
  });

  it("replies with claim instructions when real wecom message arrives before admin claim", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () =>
        Response.json({
          allowed: false,
          reason: "admin_unclaimed",
        }),
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text) {
          sent.push({ conversationId, text });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hi",
    });

    expect(sent).toEqual([
      {
        conversationId: "conversation-a",
        text: "机器人尚未完成管理员认领，请发送页面上的 /claim_admin <验证码>。",
      },
    ]);
  });

  it("replies with claim failure when real wecom claim command is wrong", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => Response.json({ error: "invalid admin claim code" }, { status: 400 }),
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text) {
          sent.push({ conversationId, text });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "/claim_admin 000000",
    });

    expect(sent).toEqual([
      {
        conversationId: "conversation-a",
        text: "管理员认领失败，请确认验证码是否正确或是否过期。",
      },
    ]);
  });

  it("runs the full real wecom worker flow from admin claim through initialization and normal chat", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const sent: Array<{ conversationId: string; text: string; finish: boolean }> = [];
    let botStatus: "unclaimed" | "initializing" | "ready" = "unclaimed";
    let configDocumentWrites = 0;
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;

    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      logServiceUrl: "http://log-service",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/bots/prd-bot/admin/claim/verify") {
          expect(body).toEqual({
            wecom_user_id: "admin-a",
            code: "123456",
          });
          botStatus = "initializing";
          return Response.json({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            role: "admin",
          });
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          if (botStatus === "unclaimed") {
            return Response.json({ allowed: false, reason: "admin_unclaimed" });
          }
          if (botStatus === "initializing") {
            return Response.json({
              allowed: body?.wecom_user_id === "admin-a",
              reason: body?.wecom_user_id === "admin-a" ? "initializing" : "initialization_required",
              is_admin: body?.wecom_user_id === "admin-a",
              conversation: {
                conversation_id: "conv-init",
                purpose: "init",
              },
            });
          }
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: body?.wecom_user_id === "admin-a",
            conversation: {
              conversation_id: "conv-chat-admin-a",
              purpose: "normal_chat",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json(configDocumentWrites === 2
            ? [
              {
                scope: "bot",
                owner_id: "prd-bot",
                title: "soul",
                version: 1,
                content: "你是环信业务的产品经理机器人，性格直接、严谨，负责需求澄清。",
              },
              {
                scope: "bot",
                owner_id: "prd-bot",
                title: "agents.md",
                version: 1,
                content: "行为规则：先澄清范围，再输出 PRD；需要检查 console、计量计费和 IMM 开关。",
              },
            ]
            : []);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          expect(body).toMatchObject({
            bot_id: "prd-bot",
            user_id: "admin-a",
            conversation_id: "conv-init",
            runtime: "kiro",
          });
          const prompt = (body as { prompt: string }).prompt;
          if (prompt.includes("请根据以下 Soul 引导配置生成 soul 文档。")) {
            return Response.json({
              run_id: "run-soul-doc",
              output: [
                "Soul 已生成。",
                "~document:private/soul.md",
                "# Soul",
                "你是环信业务的产品经理机器人，性格直接、严谨，负责需求澄清。",
                "~/document",
              ].join("\n"),
            });
          }
          return Response.json({
            run_id: "run-agents-doc",
            output: [
              "~document:instructions/AGENTS.md",
              "# AGENTS",
              "行为规则：先澄清范围，再输出 PRD；需要检查 console、计量计费和 IMM 开关。",
              "~/document",
              "初始化完成，开始工作。",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          configDocumentWrites += 1;
          return Response.json({
            memory_doc_id: `config-${configDocumentWrites}`,
            ...(body as object),
          }, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          botStatus = "ready";
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          expect(body).toMatchObject({
            bot_id: "prd-bot",
            user_id: "admin-a",
            conversation_id: "conv-chat-admin-a",
            runtime: "kiro",
          });
          expect((body as { prompt: string }).prompt).toContain("<memory>");
          expect((body as { prompt: string }).prompt).toContain("[bot/prd-bot v1] soul");
          expect((body as { prompt: string }).prompt).toContain("[bot/prd-bot v1] agents.md");
          expect((body as { prompt: string }).prompt).toContain("<message>\n我需要一个语音转文字的api\n</message>");
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-chat", runner_session_id: "kiro:prd-bot:admin-a:conv-chat-admin-a" }),
            JSON.stringify({ type: "chunk", content: "先确认定位：" }),
            JSON.stringify({ type: "chunk", content: "这是 PRD 还是接口设计？" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text, options) {
          sent.push({ conversationId, text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    const waitForSentText = async (text: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (sent.some((message) => message.text.includes(text))) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`timed out waiting for sent text: ${text}; sent=${JSON.stringify(sent)}`);
    };
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hi",
    });
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "admin-a",
      text: "/claim_admin 123456",
    });

    for (const text of ["1", "2", "2"]) {
      await messageHandler?.({
        conversationId: "conversation-a",
        userId: "admin-a",
        text,
      });
    }
    await waitForSentText("Agents 引导 1/7");

    for (const text of [
      "环信，即时通讯云服务商，提供 IM SDK 和 REST API",
      "1",
      "1",
      "1",
      "1",
      "固定使用 bot-memory，MCP 只能写业务文档和长期记忆",
      "PRD 需要确认是否涉及 console、计量计费、IMM 开关",
    ]) {
      await messageHandler?.({
        conversationId: "conversation-a",
        userId: "admin-a",
        text,
      });
    }
    await waitForSentText("初始化完成，可以开始工作。");

    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "admin-a",
      text: "我需要一个语音转文字的api",
    });

    expect(sent[0]).toEqual({
      conversationId: "conversation-a",
      text: "机器人尚未完成管理员认领，请发送页面上的 /claim_admin <验证码>。",
      finish: true,
    });
    expect(sent[1].text).toContain("管理员认领成功，开始初始化。");
    expect(sent[1].text).toContain("Soul 引导 1/3：");
    const soulWaitingIndex = sent.findIndex((message) => message.text.includes("Soul 正在生成，请稍等。"));
    const soulDoneIndex = sent.findIndex((message) => message.text.includes("Soul 已生成。"));
    const agentsWaitingIndex = sent.findIndex((message) => message.text.includes("工作方式正在生成，请稍等。"));
    const initializedIndex = sent.findIndex((message) => message.text.includes("初始化完成，可以开始工作。"));
    expect(soulWaitingIndex).toBeGreaterThan(-1);
    expect(soulDoneIndex).toBeGreaterThan(soulWaitingIndex);
    expect(agentsWaitingIndex).toBeGreaterThan(soulDoneIndex);
    expect(initializedIndex).toBeGreaterThan(agentsWaitingIndex);
    expect(sent.at(-2)).toEqual({
      conversationId: "conversation-a",
      text: "正在思考...",
      finish: false,
    });
    expect(sent.at(-1)).toEqual({
      conversationId: "conversation-a",
      text: "先确认定位：这是 PRD 还是接口设计？",
      finish: true,
    });
    expect(calls.filter((call) => call.url === "http://data-service/v1/bot-config-documents").map((call) => call.body)).toEqual([
      expect.objectContaining({
        bot_id: "prd-bot",
        title: "soul",
        content: expect.stringContaining("产品经理机器人"),
      }),
      expect.objectContaining({
        bot_id: "prd-bot",
        title: "agents.md",
        content: expect.stringContaining("行为规则"),
      }),
    ]);
    expect(calls.map((call) => call.url)).toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("actively sends initialization wizard to the admin when restarted", async () => {
    const sent: Array<{
      conversationId: string;
      text: string;
      options?: { forceActive?: boolean };
    }> = [];
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("not used", { status: 500 }),
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage() {},
        async sendText(conversationId, text, options) {
          sent.push({ conversationId, text, options });
        },
      },
    });

    const result = await worker.restartInitialization?.({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });

    expect(result).toMatchObject({
      bot_id: "prd-bot",
      admin_wecom_user_id: "admin-a",
    });
    expect(result?.output).toContain("Soul 引导 1/3：你希望我扮演什么角色？");
    expect(result?.output).toContain("1. 产品经理助手");
    expect(result?.output).toContain("回复编号或直接输入。");
    expect(result?.output).not.toContain(" / ");
    expect(sent).toEqual([
      {
        conversationId: "admin-a",
        text: result?.output,
        options: { forceActive: true },
      },
    ]);
  });

  it("clears existing wizard progress when initialization is restarted", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "init",
            },
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text) {
          sent.push({ conversationId, text });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "admin-a",
      userId: "admin-a",
      text: "旧业务背景",
    });
    expect(sent.at(-1)?.text).toContain("Soul 引导 2/3");

    await worker.restartInitialization?.({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });
    expect(sent.at(-1)?.text).toContain("Soul 引导 1/3");

    await messageHandler?.({
      conversationId: "admin-a",
      userId: "admin-a",
      text: "新业务背景",
    });
    expect(sent.at(-1)?.text).toContain("Soul 引导 2/3");
  });

  it("continues an in-memory initialization wizard before ready streaming", async () => {
    const sent: Array<{ conversationId: string; text: string; finish?: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-chat",
              purpose: "normal_chat",
            },
          });
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) {
          messageHandler = handler;
        },
        async sendText(conversationId, text, options) {
          sent.push({ conversationId, text, finish: options?.finish });
        },
      },
    });

    await worker.start();
    await worker.restartInitialization?.({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });
    sent.length = 0;

    await messageHandler?.({
      conversationId: "admin-a",
      userId: "admin-a",
      text: "产品经理",
    });

    expect(sent).toEqual([
      {
        conversationId: "admin-a",
        text: "Soul 引导 2/3：你希望我的性格是什么样的？\n1. 冷静务实\n2. 严谨审慎\n3. 主动推进\n4. 友好耐心\n5. 其他，请直接说明\n\n回复编号或直接输入。",
        finish: undefined,
      },
    ]);
  });

  it("supervises wecom workers from data-service runtime config", async () => {
    const connected: string[] = [];
    const disconnected: string[] = [];
    const clients: Record<string, {
      handler?: (message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>;
      sent: Array<{ conversationId: string; text: string }>;
    }> = {};

    const supervisor = createBotHostSupervisor({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      pollIntervalMs: 60_000,
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url === "http://data-service/internal/wecom-runtime/bots") {
          return Response.json([
            {
              bot_id: "prd-bot",
              runtime: "mock",
              wecom_bot_id: "wecom-bot-a",
              wecom_secret: "secret-a",
            },
          ]);
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: false,
            reason: "admin_unclaimed",
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      createWeComClient(input) {
        const state = {
          sent: [] as Array<{ conversationId: string; text: string }>,
          handler: undefined as
            | ((message: {
              conversationId: string;
              userId: string;
              text: string;
            }) => Promise<void>)
            | undefined,
        };
        clients[input.botId] = state;
        return {
          async connect() {
            connected.push(input.botId);
          },
          disconnect() {
            disconnected.push(input.botId);
          },
          onMessage(handler) {
            state.handler = handler;
          },
          async sendText(conversationId, text) {
            state.sent.push({ conversationId, text });
          },
        };
      },
    });

    await supervisor.start();
    await clients["wecom-bot-a"].handler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "hi",
    });
    supervisor.stop();

    expect(connected).toEqual(["wecom-bot-a"]);
    expect(clients["wecom-bot-a"].sent).toEqual([
      {
        conversationId: "conversation-a",
        text: "机器人尚未完成管理员认领，请发送页面上的 /claim_admin <验证码>。",
      },
    ]);
    expect(disconnected).toEqual(["wecom-bot-a"]);
  });
});
