import { describe, expect, it } from "vitest";
import { createBotHostServer } from "./server.js";

describe("bot initialization integration", () => {
  it("initializes a bot against real data-service and persists soul and agents before normal chat", async () => {
    const dataServiceModulePath = "../../data-service/src/server.js";
    const { createDataServiceServer } = await import(dataServiceModulePath) as {
      createDataServiceServer: (store?: {
        listRoles(options?: { includeDisabled?: boolean }): unknown[];
      }) => {
        fetch(request: Request): Promise<Response>;
      };
    };
    const storeModulePath = "../../data-service/src/store.js";
    const { createDataStore, seedDefaultRoleConfig } = await import(storeModulePath) as {
      createDataStore: () => {
        listRoles(options?: { includeDisabled?: boolean }): unknown[];
      };
      seedDefaultRoleConfig: (store: {
        listRoles(options?: { includeDisabled?: boolean }): unknown[];
      }) => void;
    };
    const seededStore = createDataStore();
    seedDefaultRoleConfig(seededStore);
    const dataService = createDataServiceServer(seededStore);
    const llmCalls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        if (request.url.startsWith("http://data-service/")) {
          return dataService.fetch(
            new Request(request.url.replace("http://data-service", "http://localhost"), request),
          );
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        llmCalls.push({ url: request.url, body });
        if (request.url === "http://llm-runner/v1/chat") {
          const prompt = String((body as { prompt?: unknown })?.prompt || "");
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
          if (prompt.includes("请根据以下 Agents 引导配置生成 agents.md 文档。")) {
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
          return Response.json({
            run_id: "run-chat",
            output: "语音转文字 API 可以先按 PRD 方式澄清场景、调用方和计费范围。",
          });
        }
        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    await dataService.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "mock",
        }),
      }),
    );

    const blocked = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "hi",
          runtime: "mock",
        }),
      }),
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      blocked: true,
      reason: "admin_unclaimed",
    });

    const claimResponse = await dataService.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
      }),
    );
    const claim = await claimResponse.json() as { code: string };
    const claimed = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: `/claim_admin ${claim.code}`,
          runtime: "mock",
        }),
      }),
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      claimed: true,
      status: "initializing",
      output: expect.stringContaining("我是谁？"),
    });

    let lastInitializationPayload: { output?: string; initialized?: boolean; ready?: boolean; status?: string } | undefined;
    for (const step of [
      { text: "1", expectOutput: "你希望我的沟通风格是什么？" },
      { text: "1", expectOutput: "角色选择 1/1" },
      { text: "1", expectOutput: "你希望它用什么方式和你交互？" },
      { text: "1", expectOutput: "是否需要长期沉淀规则和文档？" },
      { text: "1", expectOutput: "默认输出更偏向哪类内容？" },
      { text: "1", expectOutput: "是否强调结构化结论？" },
      { text: "1", expectOutput: "是否需要优先给推荐方案？" },
      { text: "1", expectOutput: "是否有额外工作规则？" },
      { text: "2", expectOutput: "工作方式配置已确认，正在生成 agents.md。" },
    ]) {
      const response = await server.fetch(
        new Request("http://localhost/v1/messages/wecom", {
          method: "POST",
          body: JSON.stringify({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            text: step.text,
            runtime: "mock",
          }),
        }),
      );
      const payload = await response.json() as { output?: string; error?: string };
      expect(response.status, JSON.stringify({ step, payload })).toBe(200);
      expect(payload.output).toContain(step.expectOutput);
      lastInitializationPayload = payload as typeof lastInitializationPayload;
    }

    expect(lastInitializationPayload).toMatchObject({
      output: expect.stringContaining("初始化完成，可以开始工作。"),
      initialized: true,
      ready: true,
      status: "ready",
    });

    const finalInitialization = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "PRD 需要确认是否涉及 console、计量计费、IMM 开关",
          runtime: "mock",
        }),
      }),
    );
    expect(finalInitialization.status).toBe(200);
    await expect(finalInitialization.json()).resolves.toMatchObject({
      output: expect.stringContaining("语音转文字"),
    });

    const bot = await dataService.fetch(new Request("http://localhost/v1/bots/prd-bot"));
    await expect(bot.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "ready",
    });
    const configDocuments = await dataService.fetch(
      new Request("http://localhost/v1/bots/prd-bot/config-documents"),
    );
    await expect(configDocuments.json()).resolves.toEqual([
      expect.objectContaining({
        title: "soul",
        content: expect.stringContaining("产品经理机器人"),
      }),
      expect.objectContaining({
        title: "agents.md",
        content: expect.stringContaining("行为规则"),
      }),
    ]);

    const chat = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "我需要一个语音转文字的api",
          runtime: "mock",
        }),
      }),
    );
    expect(chat.status).toBe(200);
    await expect(chat.json()).resolves.toMatchObject({
      output: expect.stringContaining("语音转文字"),
    });
    expect(llmCalls.at(-1)?.body).toMatchObject({
      bot_id: "prd-bot",
      user_id: "admin-a",
      runtime: "mock",
    });
    expect((llmCalls.at(-1)?.body as { prompt: string }).prompt).toContain("[bot-config/prd-bot] soul");
    expect((llmCalls.at(-1)?.body as { prompt: string }).prompt).toContain("[bot-config/prd-bot] agents.md");
  });
});
