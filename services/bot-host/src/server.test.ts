import { describe, expect, it } from "vitest";
import {
  getActiveInitializationSession,
  upsertInitializationSession,
} from "./botStateClient.js";
import * as messageHandlerModule from "./messageHandler.js";
import { handleBotMessage } from "./messageHandler.js";
import {
  createBotHostServer,
  createBotHostSupervisor,
  createBotHostWorker,
} from "./server.js";

interface MockInitializationSession {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: "soul" | "role_select" | "agents";
  selected_role_id?: string;
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: "soul" | "agents";
  status: "active" | "completed" | "cancelled";
}

interface MockPendingGeneratedDocument {
  pending_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  status: "pending" | "confirmed" | "cancelled";
  created_by_bot_id: string;
  created_by_user_id: string;
}

function mockInitializationSessionResponse(
  request: Request,
  body: unknown,
  sessions: Map<string, MockInitializationSession>,
): Response | undefined {
  const url = new URL(request.url);
  if (url.origin !== "http://data-service") {
    return undefined;
  }

  if (url.pathname === "/internal/initialization-sessions/active") {
    const key = initializationSessionKey({
      bot_id: url.searchParams.get("bot_id") ?? "",
      wecom_user_id: url.searchParams.get("wecom_user_id") ?? "",
      conversation_id: url.searchParams.get("conversation_id") ?? "",
    });
    if (request.method === "GET") {
      return Response.json(sessions.get(key) ?? null);
    }
    if (request.method === "DELETE") {
      sessions.delete(key);
      return Response.json({ cleared: true });
    }
  }

  if (url.pathname === "/internal/initialization-sessions" && request.method === "PUT") {
    const input = body as Omit<MockInitializationSession, "session_id">;
    const key = initializationSessionKey(input);
    const existing = sessions.get(key);
    const session = {
      session_id: existing?.session_id ?? `init-${sessions.size + 1}`,
      ...input,
    };
    sessions.set(key, session);
    return Response.json(session);
  }

  return undefined;
}

function initializationSessionKey(input: {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}): string {
  return `${input.bot_id}:${input.wecom_user_id}:${input.conversation_id}`;
}

function noActiveInitializationSessionResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (
    url.origin === "http://data-service"
    && url.pathname === "/internal/initialization-sessions/active"
    && request.method === "GET"
  ) {
    return Response.json(null);
  }
  if (
    url.origin === "http://data-service"
    && url.pathname === "/internal/pending-generated-documents"
    && request.method === "GET"
  ) {
    return Response.json([]);
  }
  return undefined;
}

function mockEnabledRolesResponse(request: Request): Response | undefined {
  if (request.url === "http://data-service/v1/roles" && request.method === "GET") {
    return Response.json([
      {
        role_id: "role-product-manager",
        name: "产品经理",
        slug: "product-manager",
        description: "PM role",
        enabled: true,
        sort_order: 10,
      },
      {
        role_id: "role-qa-engineer",
        name: "测试工程师",
        slug: "qa-engineer",
        description: "QA role",
        enabled: true,
        sort_order: 20,
      },
      {
        role_id: "role-engineer",
        name: "研发工程师",
        slug: "engineer",
        description: "Engineer role",
        enabled: true,
        sort_order: 30,
      },
      {
        role_id: "role-marketing",
        name: "市场人员",
        slug: "marketing",
        description: "Marketing role",
        enabled: true,
        sort_order: 40,
      },
      {
        role_id: "role-operations",
        name: "运营人员",
        slug: "operations",
        description: "Operations role",
        enabled: true,
        sort_order: 50,
      },
    ]);
  }
  return undefined;
}

function mockGlobalDocumentsResponse(request: Request): Response | undefined {
  if (request.url === "http://data-service/v1/global-documents" && request.method === "GET") {
    return Response.json([
      {
        document_id: "global-playground",
        title: "playground.md",
        slug: "playground",
        content: [
          "# Playground",
          "",
          "- 所有回复使用中文，文档使用 Markdown 格式。",
          "- 一次只问一个关键问题。",
        ].join("\n"),
        enabled: true,
        sort_order: 1,
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ]);
  }
  return undefined;
}

function mockRoleDocumentsResponse(
  request: Request,
  roleId = "role-product-manager",
): Response | undefined {
  const url = new URL(request.url);
  if (url.origin === "http://data-service" && url.pathname === `/v1/roles/${roleId}/documents` && request.method === "GET") {
    return Response.json([
      {
        role_document_id: `role-doc-${roleId}`,
        role_id: roleId,
        title: "role.md",
        content: [
          "# Role: Product Manager",
          "",
          "- 生成 PRD 前默认补齐背景、目标用户、核心问题。",
          "- 涉及环信需求时默认检查 Console、IMM、计量计费、集群范围。",
        ].join("\n"),
        enabled: true,
        created_at: "2026-06-23T00:00:00.000Z",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ]);
  }
  return undefined;
}

function mockRoleQuestionsResponse(
  request: Request,
  roleId = "role-product-manager",
): Response | undefined {
  const url = new URL(request.url);
  if (url.origin === "http://data-service" && url.pathname === `/v1/roles/${roleId}/questions` && request.method === "GET") {
    const questions = [
      {
        question_id: "q-interaction-mode",
        role_id: roleId,
        key: "interaction_mode",
        title: "你希望它用什么方式和你交互？",
        description: "",
        question_type: "single_choice",
        options_json: [
          { value: "step_by_step", label: "逐句引导，一次只问一个问题" },
          { value: "batch", label: "批量引导，一次列出多个待确认项" },
          { value: "recommend_first", label: "先给推荐方案，再让用户确认" },
          { value: "other", label: "其他，请直接说明" },
        ],
        required: true,
        enabled: true,
        sort_order: 10,
        depends_on_json: [],
      },
      {
        question_id: "q-memory-storage",
        role_id: roleId,
        key: "memory_storage",
        title: "是否需要长期沉淀规则和文档？",
        description: "",
        question_type: "single_choice",
        options_json: [
          { value: "option_1", label: "需要" },
          { value: "option_2", label: "不需要" },
                  ],
        required: true,
        enabled: true,
        sort_order: 20,
        depends_on_json: [],
      },
      {
        question_id: "q-output-shape",
        role_id: roleId,
        key: "output_shape",
        title: "默认输出更偏向哪类内容？",
        description: "",
        question_type: "single_choice",
        options_json: [
          { value: "option_1", label: "PRD" },
          { value: "option_2", label: "需求评审" },
          { value: "option_3", label: "用户故事" },
          { value: "option_4", label: "拆解清单" },
                  ],
        required: true,
        enabled: true,
        sort_order: 30,
        depends_on_json: [],
      },
      {
        question_id: "q-disabled",
        role_id: roleId,
        key: "disabled_question",
        title: "这题应该被跳过",
        description: "",
        question_type: "single_choice",
        options_json: [
          { value: "1", label: "不会出现" },
        ],
        required: false,
        enabled: false,
        sort_order: 35,
        depends_on_json: [],
      },
      {
        question_id: "q-work-rules",
        role_id: roleId,
        key: "work_rules",
        title: "是否有额外工作规则？",
        description: "",
        question_type: "single_choice",
        options_json: [
          { value: "option_1", label: "没有" },
          { value: "option_2", label: "直接补充" },
                  ],
        required: true,
        enabled: true,
        sort_order: 60,
        depends_on_json: [],
      },
    ];
    if (url.searchParams.get("include_disabled") === "true") {
      return Response.json(questions);
    }
    return Response.json(questions.filter((question) => question.enabled));
  }
  return undefined;
}

function mockPendingGeneratedDocumentsResponse(
  request: Request,
  body: unknown,
  documents: MockPendingGeneratedDocument[],
): Response | undefined {
  const url = new URL(request.url);
  if (url.origin !== "http://data-service") {
    return undefined;
  }

  if (url.pathname === "/internal/pending-generated-documents" && request.method === "POST") {
    const input = body as Omit<MockPendingGeneratedDocument, "pending_id" | "status">;
    const record: MockPendingGeneratedDocument = {
      pending_id: `pending-${documents.length + 1}`,
      status: "pending",
      ...input,
    };
    documents.push(record);
    return Response.json(record, { status: 201 });
  }

  if (url.pathname === "/internal/pending-generated-documents" && request.method === "GET") {
    return Response.json(documents.filter((document) =>
      document.bot_id === (url.searchParams.get("bot_id") ?? "")
      && document.wecom_user_id === (url.searchParams.get("wecom_user_id") ?? "")
      && document.conversation_id === (url.searchParams.get("conversation_id") ?? "")
    ));
  }

  if (url.pathname === "/internal/pending-generated-documents/confirm" && request.method === "POST") {
    const input = body as {
      bot_id: string;
      wecom_user_id: string;
      conversation_id: string;
    };
    const updated = documents
      .filter((document) =>
        document.bot_id === input.bot_id
        && document.wecom_user_id === input.wecom_user_id
        && document.conversation_id === input.conversation_id
        && document.status === "pending"
      )
      .map((document) => {
        document.status = "confirmed";
        return { ...document };
      });
    return Response.json(updated);
  }

  if (url.pathname === "/internal/pending-generated-documents/cancel" && request.method === "POST") {
    const input = body as {
      bot_id: string;
      wecom_user_id: string;
      conversation_id: string;
    };
    const updated = documents
      .filter((document) =>
        document.bot_id === input.bot_id
        && document.wecom_user_id === input.wecom_user_id
        && document.conversation_id === input.conversation_id
        && document.status === "pending"
      )
      .map((document) => {
        document.status = "cancelled";
        return { ...document };
      });
    return Response.json(updated);
  }

  return undefined;
}

describe("bot-host server", () => {
  it("reports non-json initialization session lookup errors", async () => {
    await expect(getActiveInitializationSession({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("upstream unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    }, {
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
    })).rejects.toThrow("failed to get active initialization session: 503 Service Unavailable");
  });

  it("reports non-json initialization session upsert errors", async () => {
    await expect(upsertInitializationSession({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async () => new Response("bad gateway", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    }, {
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "pending",
      phase: "soul",
      soul_answers: [],
      agents_answers: [],
      status: "active",
    })).rejects.toThrow("failed to upsert initialization session: 502 Bad Gateway");
  });

  it("responds to health checks", async () => {
    const previousSha = process.env.APP_BUILD_SHA;
    const previousBuildTime = process.env.APP_BUILD_TIME;
    process.env.APP_BUILD_SHA = "sha-bot-host";
    process.env.APP_BUILD_TIME = "2026-06-24T12:00:03.000Z";
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
      git_sha: "sha-bot-host",
      build_time: "2026-06-24T12:00:03.000Z",
    });
    process.env.APP_BUILD_SHA = previousSha;
    process.env.APP_BUILD_TIME = previousBuildTime;
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url === "http://data-service/v1/global-documents") {
          return Response.json([
            {
              document_id: "global-playground",
              title: "playground.md",
              slug: "playground",
              content: [
                "# Playground",
                "",
                "- 所有回复使用中文，文档使用 Markdown 格式。",
                "- 一次只问一个关键问题。",
              ].join("\n"),
              enabled: true,
              sort_order: 1,
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ]);
        }

        if (request.url === "http://data-service/v1/roles/role-product-manager/documents") {
          return Response.json([
            {
              role_document_id: "role-doc-product-manager",
              role_id: "role-product-manager",
              title: "role.md",
              content: [
                "# Role: Product Manager",
                "",
                "- 生成 PRD 前默认补齐背景、目标用户、核心问题。",
                "- 涉及环信需求时默认检查 Console、IMM、计量计费、集群范围。",
              ].join("\n"),
              enabled: true,
              created_at: "2026-06-23T00:00:00.000Z",
              updated_at: "2026-06-23T00:00:00.000Z",
            },
          ]);
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
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([
      "http://data-service/v1/bots/prd-bot/config-documents",
      "http://data-service/v1/memory-documents/current?scope=system&owner_id=platform",
      "http://data-service/v1/memory-documents/current?scope=shared&owner_id=platform",
      "http://data-service/v1/memory-documents/current?scope=bot&owner_id=prd-bot",
      "http://data-service/v1/memory-documents/current?scope=user&owner_id=user-a",
      "http://data-service/v1/memory-documents/current?scope=session&owner_id=conv-1",
    ]));
    expect(calls.find((call) => call.url === "http://llm-runner/v1/chat")).toEqual(
      {
        url: "http://llm-runner/v1/chat",
        body: {
          bot_id: "prd-bot",
          user_id: "user-a",
          conversation_id: "conv-1",
          runtime: "mock",
          prompt: [
            "<memory>",
            "[bot-config/prd-bot] soul",
            "# Soul",
            "",
            "你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            "</memory>",
            "",
            "<user-message>",
            "hello",
            "</user-message>",
          ].join("\n"),
        },
      },
    );
  });

  it("lists conversations without calling llm-runner", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: body.bot_id,
            wecom_user_id: body.wecom_user_id,
            conversation: {
              conversation_id: "conv-2",
              bot_id: body.bot_id,
              wecom_user_id: body.wecom_user_id,
              channel: body.channel,
              purpose: body.purpose,
            },
          });
        }

        if (request.url === "http://data-service/v1/conversations?bot_id=prd-bot&wecom_user_id=user-a&channel=wecom_direct&purpose=normal_chat") {
          return Response.json([
            {
              conversation_id: "conv-2",
              sequence_no: 2,
              bot_id: "prd-bot",
              wecom_user_id: "user-a",
              channel: "wecom_direct",
              purpose: "normal_chat",
              display_name: "第二轮",
              is_active: true,
              created_at: "2026-06-25T00:00:00.000Z",
              updated_at: "2026-06-25T00:00:00.000Z",
            },
            {
              conversation_id: "conv-1",
              sequence_no: 1,
              bot_id: "prd-bot",
              wecom_user_id: "user-a",
              channel: "wecom_direct",
              purpose: "normal_chat",
              display_name: "第一轮",
              is_active: false,
              created_at: "2026-06-24T00:00:00.000Z",
              updated_at: "2026-06-24T00:00:00.000Z",
            },
          ]);
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
          text: "/history",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("| 序号 | 会话 | 状态 | 更新时间 |");
    expect(payload.output).toContain("第二轮");
    expect(payload.output).toContain("第一轮");
    expect(calls.map((call) => call.url)).not.toContain("http://llm-runner/v1/chat");
  });

  it("creates a new conversation and renames the active conversation without calling llm-runner", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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

        if (request.url === "http://data-service/v1/conversations" && request.method === "POST") {
          return Response.json({
            conversation_id: "conv-2",
            sequence_no: 2,
            bot_id: "prd-bot",
            wecom_user_id: "user-a",
            channel: "wecom_direct",
            purpose: "normal_chat",
            display_name: "",
            is_active: true,
            created_at: "2026-06-25T00:00:00.000Z",
            updated_at: "2026-06-25T00:00:00.000Z",
          }, { status: 201 });
        }

        if (request.url === "http://data-service/v1/conversations/name" && request.method === "POST") {
          return Response.json({
            conversation_id: "conv-1",
            bot_id: "prd-bot",
            wecom_user_id: "user-a",
            channel: "wecom_direct",
            purpose: "normal_chat",
            display_name: "会议记录",
            is_active: true,
            created_at: "2026-06-24T00:00:00.000Z",
            updated_at: "2026-06-25T00:00:00.000Z",
          });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const created = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "/new",
        runtime: "mock",
      }),
    }));
    expect(created.status).toBe(200);
    const createdPayload = await created.json() as { output: string };
    expect(createdPayload.output).toContain("已创建并切换到新会话");
    expect(createdPayload.output).toContain("会话 2");
    expect(createdPayload.output).toContain("conv-2");

    const renamed = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "/name 会议记录",
        runtime: "mock",
      }),
    }));
    expect(renamed.status).toBe(200);
    const renamedPayload = await renamed.json() as { output: string };
    expect(renamedPayload.output).toContain("会议记录");
    expect(calls.map((call) => call.url)).not.toContain("http://llm-runner/v1/chat");
  });

  it("opens conversations by stable sequence number and keeps history numbering stable", async () => {
    let activeSequence = 5;
    const openBodies: unknown[] = [];
    const conversation = (sequenceNo: number) => ({
      conversation_id: `conv-${sequenceNo}`,
      sequence_no: sequenceNo,
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
      is_active: activeSequence === sequenceNo,
      created_at: `2026-06-${20 + sequenceNo}T00:00:00.000Z`,
      updated_at: `2026-06-${20 + sequenceNo}T00:00:00.000Z`,
    });
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST"
          ? await request.json().catch(() => undefined)
          : undefined;
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: conversation(activeSequence),
          });
        }
        if (request.url === "http://data-service/v1/conversations?bot_id=prd-bot&wecom_user_id=user-a&channel=wecom_direct&purpose=normal_chat") {
          return Response.json([conversation(5), conversation(4), conversation(3)]);
        }
        if (request.url === "http://data-service/v1/conversations/open") {
          openBodies.push(body);
          activeSequence = 4;
          return Response.json(conversation(4));
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const opened = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "/open 4",
        runtime: "mock",
      }),
    }));
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({
      output: "已切换到会话：会话 4。",
    });
    expect(openBodies).toEqual([{
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-4",
    }]);

    const history = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "/history",
        runtime: "mock",
      }),
    }));
    const historyPayload = await history.json() as { output: string };
    expect(historyPayload.output).toContain("4 | 会话 4 | 当前");
    expect(historyPayload.output).toContain("5 | 会话 5 | 历史");
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
      "<user-message>",
      "hello",
      "</user-message>",
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
              content: "你是产品经理。",
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
    expect(payload.output).not.toContain("<user-message>");
    expect(payload.output).not.toContain("你是产品经理");
    expect(payload.output).not.toContain("我需要一个语音转文字的api");
  });

  it("asks for confirmation before storing generated non-config markdown documents", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH" ? await request.json() : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-doc",
            output: [
              "PRD 已生成。",
              "~document:prd/asr-api.md",
              "# 语音转文字 API PRD",
              "## 背景",
              "提供 ASR 能力。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm") {
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: pendingDocuments[0].pending_id, title: "prd/asr-api.md", version: 1 },
          ]);
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const first = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "生成 PRD",
          runtime: "mock",
        }),
      }),
    );

    expect(first.status).toBe(200);
    const firstPayload = await first.json() as { output: string };
    expect(firstPayload.output).toContain("PRD 已生成。");
    expect(firstPayload.output).toContain("# 语音转文字 API PRD");
    expect(firstPayload.output).toContain("回复“确认”后保存到长期文档存储");
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "pending",
      }),
    ]);
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/internal/documents");

    const second = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "确认",
          runtime: "mock",
        }),
      }),
    );

    expect(second.status).toBe(200);
    const secondPayload = await second.json() as { output: string };
    expect(secondPayload.output).toBe("已保存到长期文档存储：prd/asr-api.md v1。");
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "confirmed",
      }),
    ]);
    expect(calls.find((call) => call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm")).toMatchObject({
      method: "POST",
      body: {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
    });
  });

  it("updates an existing generated markdown document version after confirmation", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH" ? await request.json() : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-doc",
            output: [
              "~document:prd/asr-api.md",
              "# 语音转文字 API PRD",
              "第二版内容。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm") {
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: pendingDocuments[0].pending_id, title: "prd/asr-api.md", version: 2 },
          ]);
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "更新 PRD",
          runtime: "mock",
        }),
      }),
    );
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "pending",
      }),
    ]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "确认",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toBe("已保存到长期文档存储：prd/asr-api.md v2。");
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "confirmed",
      }),
    ]);
    expect(calls.find((call) => call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm")).toMatchObject({
      method: "POST",
      body: {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
    });
  });

  it("confirms generated markdown documents from data-service state across bot-host instances", async () => {
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const makeServer = () => createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: (body as { bot_id: string }).bot_id,
            wecom_user_id: (body as { wecom_user_id: string }).wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-doc",
            output: [
              "PRD 已生成。",
              "~document:prd/asr-api.md",
              "# 跨实例 PRD",
              "共享待确认内容。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm") {
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: pendingDocuments[0].pending_id, title: "prd/asr-api.md", version: 1 },
          ]);
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const firstServer = makeServer();
    const secondServer = makeServer();

    const first = await firstServer.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "生成跨实例 PRD",
          runtime: "mock",
        }),
      }),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      output: expect.stringContaining("回复“确认”后保存到长期文档存储"),
    });
    expect(pendingDocuments).toHaveLength(1);
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/internal/documents");

    const second = await secondServer.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "确认",
          runtime: "mock",
        }),
      }),
    );

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: expect.stringMatching(/^document_save_/),
      output: "已保存到长期文档存储：prd/asr-api.md v1。",
    });
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "confirmed",
      }),
    ]);
  });

  it("keeps pending generated documents when business document save fails so confirm can retry", async () => {
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let failApply = true;
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: (body as { bot_id: string }).bot_id,
            wecom_user_id: (body as { wecom_user_id: string }).wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-doc",
            output: [
              "PRD 已生成。",
              "~document:prd/asr-api.md",
              "# 可重试 PRD",
              "第一次确认时模拟保存失败。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm" && request.method === "POST") {
          if (failApply) {
            return Response.json({ error: "document store unavailable" }, { status: 503 });
          }
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: pendingDocuments[0].pending_id, title: "prd/asr-api.md", version: 1 },
          ]);
        }

        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "生成可重试 PRD",
        runtime: "mock",
      }),
    }));

    const failedConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(failedConfirm.status).toBe(400);
    await expect(failedConfirm.json()).resolves.toEqual({
      error: "failed to apply pending generated documents: 503 : document store unavailable",
    });
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "pending",
      }),
    ]);

    failApply = false;

    const retryConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(retryConfirm.status).toBe(200);
    await expect(retryConfirm.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: expect.stringMatching(/^document_save_/),
      output: "已保存到长期文档存储：prd/asr-api.md v1。",
    });
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "confirmed",
      }),
    ]);
    expect(calls.filter((call) => call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm")).toHaveLength(2);
  });

  it("replaces prior pending generated documents in the same conversation before saving new ones", async () => {
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let generation = 0;
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: (body as { bot_id: string }).bot_id,
            wecom_user_id: (body as { wecom_user_id: string }).wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          generation += 1;
          return Response.json({
            run_id: `run-doc-${generation}`,
            output: [
              `第 ${generation} 次生成。`,
              "~document:prd/asr-api.md",
              "# 同标题 PRD",
              generation === 1 ? "旧内容。" : "新内容。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm" && request.method === "POST") {
          const currentPending = pendingDocuments.find((document) => document.status === "pending");
          if (!currentPending) {
            return Response.json([]);
          }
          currentPending.status = "confirmed";
          return Response.json([
            { pending_id: currentPending.pending_id, title: "prd/asr-api.md", version: 1 },
          ]);
        }

        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    for (const text of ["第一次生成", "第二次生成"]) {
      const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text,
          runtime: "mock",
        }),
      }));
      expect(response.status).toBe(200);
    }

    expect(pendingDocuments.filter((document) => document.status === "pending")).toHaveLength(1);
    expect(pendingDocuments.filter((document) => document.status === "cancelled")).toHaveLength(1);

    const confirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(confirm.status).toBe(200);
    await expect(confirm.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: expect.stringMatching(/^document_save_/),
      output: "已保存到长期文档存储：prd/asr-api.md v1。",
    });
    expect(calls.find((call) =>
      call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm"
    )).toMatchObject({
      body: expect.objectContaining({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
      }),
    });
  });

  it("retries multi-document confirmation without creating an extra version for already-saved pending docs", async () => {
    const pendingDocuments: MockPendingGeneratedDocument[] = [
      {
        pending_id: "pending-1",
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        title: "prd/doc-1.md",
        content: "# 文档一\n第一次成功。",
        status: "pending",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
      {
        pending_id: "pending-2",
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        title: "prd/doc-2.md",
        content: "# 文档二\n第一次失败。",
        status: "pending",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
    ];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let applyAttempt = 0;
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });

        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: (body as { bot_id: string }).bot_id,
            wecom_user_id: (body as { wecom_user_id: string }).wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm" && request.method === "POST") {
          applyAttempt += 1;
          if (applyAttempt === 1) {
            return Response.json({ error: "document store unavailable" }, { status: 503 });
          }
          pendingDocuments.forEach((document) => {
            document.status = "confirmed";
          });
          return Response.json([
            { pending_id: "pending-1", title: "prd/doc-1.md", version: 1 },
            { pending_id: "pending-2", title: "prd/doc-2.md", version: 1 },
          ]);
        }

        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    const firstConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(firstConfirm.status).toBe(400);
    await expect(firstConfirm.json()).resolves.toEqual({
      error: "failed to apply pending generated documents: 503 : document store unavailable",
    });
    expect(pendingDocuments.filter((document) => document.status === "pending")).toHaveLength(2);

    const retryConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(retryConfirm.status).toBe(200);
    await expect(retryConfirm.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: expect.stringMatching(/^document_save_/),
      output: [
        "已保存到长期文档存储：prd/doc-1.md v1。",
        "已保存到长期文档存储：prd/doc-2.md v1。",
      ].join("\n"),
    });
    expect(calls.filter((call) =>
      call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm"
    )).toHaveLength(2);
  });

  it("does not create extra document versions when apply-and-confirm retries after an upstream failure", async () => {
    const pendingDocuments: MockPendingGeneratedDocument[] = [
      {
        pending_id: "pending-1",
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        title: "prd/asr-api.md",
        content: "# PRD\n确认状态失败后重试。",
        status: "pending",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
    ];
    let applyShouldFail = true;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm" && request.method === "POST") {
          if (applyShouldFail) {
            return Response.json({ error: "apply pending generated documents unavailable" }, { status: 503 });
          }
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: "pending-1", title: "prd/asr-api.md", version: 1 },
          ]);
        }

        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            bot_id: (body as { bot_id: string }).bot_id,
            wecom_user_id: (body as { wecom_user_id: string }).wecom_user_id,
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    const firstConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(firstConfirm.status).toBe(400);
    await expect(firstConfirm.json()).resolves.toEqual({ error: "failed to apply pending generated documents: 503 : apply pending generated documents unavailable" });

    applyShouldFail = false;

    const retryConfirm = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "确认",
        runtime: "mock",
      }),
    }));

    expect(retryConfirm.status).toBe(200);
    await expect(retryConfirm.json()).resolves.toEqual({
      conversation_id: "conv-1",
      run_id: expect.stringMatching(/^document_save_/),
      output: "已保存到长期文档存储：prd/asr-api.md v1。",
    });
    expect(calls.filter((call) =>
      call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm"
    )).toHaveLength(2);
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
    expect(logCall?.body).toMatchObject({
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
    expect((logCall?.body as { trace_id?: string }).trace_id).toMatch(/^trace_/);
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
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = await request.json().catch(() => undefined);
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

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
    expect(payload.output).toContain("我是谁？");
    expect(calls[0]).toEqual({
      url: "http://data-service/v1/bots/prd-bot/admin/claim/verify",
      body: {
        wecom_user_id: "admin-a",
        code: "123456",
      },
    });
    expect(calls[1]).toMatchObject({
      url: "http://data-service/internal/initialization-sessions",
      body: {
        bot_id: "prd-bot",
        wecom_user_id: "admin-a",
        conversation_id: "pending",
        phase: "soul",
        soul_answers: [],
        agents_answers: [],
        status: "active",
      },
    });
  });

  it("starts server-owned initialization wizard immediately after a successful admin claim", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json() : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

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
    expect(payload.output).toContain("我是谁？");
    expect(calls).toHaveLength(2);
  });

  it("guides soul first, then agents, before marking the bot ready", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
                "你是产品经理，性格冷静务实，沟通简洁直接。",
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
      "1",
      "1",
      "2",
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
      "你希望我的沟通风格是什么？\n1. 简洁直接\n2. 严谨完整\n3. 先问清楚再回答\n4. 给出选项辅助决策\n5. 其他，请直接说明\n\n回复编号或直接输入。",
      "Soul 配置已确认，正在生成 soul。\n\nSoul 已生成。\n\n请选择角色。\n\n角色选择 1/1：你希望我承担哪个角色？\n1. 产品经理\n2. 测试工程师\n3. 研发工程师\n4. 市场人员\n5. 运营人员\n\n回复编号或直接输入。",
      "你希望它用什么方式和你交互？\n1. 逐句引导，一次只问一个问题\n2. 批量引导，一次列出多个待确认项\n3. 先给推荐方案，再让用户确认\n4. 其他，请直接说明\n\n回复编号或直接输入。",
      "是否需要长期沉淀规则和文档？\n1. 需要\n2. 不需要\n\n回复编号或直接输入。",
      "默认输出更偏向哪类内容？\n1. PRD\n2. 需求评审\n3. 用户故事\n4. 拆解清单\n\n回复编号或直接输入。",
      "是否有额外工作规则？\n1. 没有\n2. 直接补充\n\n回复编号或直接输入。",
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
    expect((llmCalls[0].body as { prompt: string }).prompt).toContain("我是谁：产品经理");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("角色：role-product-manager");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("你希望它用什么方式和你交互？：逐句引导，一次只问一个问题");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("# Playground");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("所有回复使用中文，文档使用 Markdown 格式。");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("# Role: Product Manager");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("生成 PRD 前默认补齐背景、目标用户、核心问题。");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("业务背景：环信是 IM 服务提供商，提供各种端的 SDK、REST API 等服务");
    expect((llmCalls[1].body as { prompt: string }).prompt).toContain("不得要求用户使用组合格式一次回复多个确认项");
    expect(calls.filter((call) => call.url === "http://data-service/v1/bot-config-documents").map((call) => call.body)).toEqual([
      {
        bot_id: "prd-bot",
        title: "soul",
        content: "# Soul\n你是产品经理，性格冷静务实，沟通简洁直接。",
      },
      {
        bot_id: "prd-bot",
        title: "agents.md",
        content: [
          "# AGENTS",
          "核心工作：撰写/维护 PRD。PRD 交付前必须逐项确认 Console、IMM、计量计费；一次只能问一个确认项；不得要求用户使用 1a 2a 3a 这种组合格式。",
          "",
          "## 默认规则背景",
          "- 环信是 IM 服务提供商，提供各种端的 SDK、REST API 等服务。",
          "- 默认使用中文回复，除非用户明确要求其他语言。",
          "- 优先遵守当前 bot 的 soul 与 agents.md；如有冲突，安全、合规和管理员规则优先。",
          "- 信息不足时一次只问一个最关键的问题，不要一次性抛出多个问题。",
          "- 不要请求、输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
          "- 只有用户明确要求记住、保存、沉淀，或管理员规则明确允许时，才写入长期记忆。",
          "- Jira 任务平台：https://j1.private.easemob.com/。",
          "- Confluence 文档平台：https://c1.private.easemob.com/。",
          "- Console 用户管理平台：https://console.easemob.com/，用于套餐/功能开通、组织与 appkey 创建、统计能力等用户侧管理。",
          "- 官方文档站：https://doc.easemob.com/。",
          "- IMM 是环信对内管理平台，主要面向运营，支持比 Console 更丰富的功能开通和内部管理。",
          "- 环信提供 REST API、Webhook、敏感词审核、翻译等能力。",
          "- IM SDK 覆盖 Android、iOS、鸿蒙、Windows、Web、Flutter、React Native、Unity、uni-app、小程序等端。",
          "- 环信有国内、海外等多个集群，涉及方案或 PRD 时需要确认目标集群。",
          "- 引导询问需要包含 6 个以上且 20 个以下的问题。",
          "- 所有回复使用中文，文档使用 Markdown 格式。",
        ].join("\n"),
      },
    ]);
    expect(calls.map((call) => call.url)).toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("generates soul after two soul answers, then enters role selection from data-service without writing agents.md", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
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

        if (request.url === "http://data-service/v1/bots/prd-bot/admin/claim/verify") {
          return Response.json({
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
          });
        }

        if (request.url === "http://data-service/v1/roles") {
          return Response.json([
            {
              role_id: "role-product-manager",
              name: "产品经理",
              slug: "product-manager",
              description: "PM role",
              enabled: true,
              sort_order: 10,
            },
            {
              role_id: "role-qa",
              name: "测试工程师",
              slug: "qa",
              description: "QA role",
              enabled: true,
              sort_order: 20,
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-soul-done",
            output: [
              "Soul 已生成。",
              "~document:private/soul.md",
              "# Soul",
              "你是一个熟悉团队上下文的助手，沟通风格简洁直接，擅长把复杂协作事项整理成清晰结论。",
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

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const startResponse = await server.fetch(
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
    const startPayload = await startResponse.json() as { output: string };
    expect(startResponse.status).toBe(200);
    expect(startPayload.output).toContain("我是谁？");

    const firstAnswer = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "一个懂产品和研发协作的助手",
          runtime: "mock",
        }),
      }),
    );
    const firstPayload = await firstAnswer.json() as { output: string };
    expect(firstAnswer.status).toBe(200);
    expect(firstPayload.output).toContain("你希望我的沟通风格是什么？");

    const secondAnswer = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "1",
          runtime: "mock",
        }),
      }),
    );
    const secondPayload = await secondAnswer.json() as { output: string };
    expect(secondAnswer.status).toBe(200);
    expect(secondPayload.output).toBe([
      "Soul 配置已确认，正在生成 soul。",
      "Soul 已生成。",
      "请选择角色。",
      "角色选择 1/1：你希望我承担哪个角色？\n1. 产品经理\n2. 测试工程师\n3. 研发工程师\n4. 市场人员\n5. 运营人员\n\n回复编号或直接输入。",
    ].join("\n\n"));

    expect(calls.filter((call) => call.url === "http://llm-runner/v1/chat")).toHaveLength(1);
    expect((calls.find((call) => call.url === "http://llm-runner/v1/chat")?.body as { prompt: string }).prompt).toContain("我是谁：一个懂产品和研发协作的助手");
    expect((calls.find((call) => call.url === "http://llm-runner/v1/chat")?.body as { prompt: string }).prompt).toContain("沟通风格：简洁直接");
    expect(calls.filter((call) => call.url === "http://data-service/v1/bot-config-documents").map((call) => call.body)).toEqual([
      {
        bot_id: "prd-bot",
        title: "soul",
        content: "# Soul\n你是一个熟悉团队上下文的助手，沟通风格简洁直接，擅长把复杂协作事项整理成清晰结论。",
      },
    ]);
    expect(calls.map((call) => call.url)).toContain("http://data-service/v1/roles");
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/v1/bots/prd-bot/ready");
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).toMatchObject({
      phase: "role_select",
      soul_answers: ["一个懂产品和研发协作的助手", "1"],
      agents_answers: [],
    });
  });

  it("continues initialization wizard from data-service state across bot-api instances", async () => {
    const sessions = new Map<string, MockInitializationSession>();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const makeServer = () => createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, sessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
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
              "你是产品经理，沟通风格简洁直接，擅长把模糊需求澄清成结构化结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const first = makeServer();
    const start = await first.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
    }));
    await expect(start.json()).resolves.toMatchObject({
      output: expect.stringContaining("你希望我的沟通风格是什么？"),
    });

    const second = makeServer();
    const next = await second.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
    }));
    await expect(next.json()).resolves.toMatchObject({
      output: expect.stringContaining("Soul 配置已确认，正在生成 soul。"),
    });
  });

  it("continues a pending initialization session after conversation is resolved", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-soul",
            output: [
              "Soul 已生成。",
              "~document:private/soul.md",
              "# Soul",
              "你是产品经理，沟通风格简洁直接，擅长把模糊需求澄清成结构化结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:pending", {
      session_id: "init-pending",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "pending",
      phase: "soul",
      soul_answers: ["产品经理"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: expect.stringContaining("Soul 配置已确认，正在生成 soul。"),
    });
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).toMatchObject({
      soul_answers: ["产品经理", "1"],
    });
    expect(initializationSessions.has("prd-bot:admin-a:pending")).toBe(false);
  });

  it("does not clear pending wizard state when resolved promotion save fails", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const url = new URL(request.url);
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;

        if (url.pathname === "/internal/initialization-sessions" && request.method === "PUT") {
          if ((body as { conversation_id?: string })?.conversation_id === "conv-init") {
            return Response.json({ error: "write failed" }, { status: 500 });
          }
        }
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:pending", {
      session_id: "init-pending",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "pending",
      phase: "soul",
      soul_answers: ["产品经理"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
    }));

    expect(response.status).toBe(400);
    expect(initializationSessions.has("prd-bot:admin-a:pending")).toBe(true);
  });

  it("routes ready HTTP messages to active initialization wizard state", async () => {
    const calls: string[] = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: { conversation_id: "conv-init", purpose: "normal_chat" },
          });
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
              "你是产品经理，沟通风格简洁直接，擅长把模糊需求澄清成结构化结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:pending", {
      session_id: "init-pending",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "pending",
      phase: "soul",
      soul_answers: ["产品经理"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "1", runtime: "mock" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: expect.stringContaining("Soul 配置已确认，正在生成 soul。"),
    });
    expect(calls).toContain("http://llm-runner/v1/chat");
  });

  it("keeps wizard question numbers separate from option labels", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
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
              "你是产品经理，沟通风格简洁直接，擅长把模糊需求澄清成结构化结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
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

    expect(outputs[1]).toContain("角色选择 1/1：你希望我承担哪个角色？");
    expect(outputs[1]).toContain("1. 产品经理");
    expect(outputs[1]).toContain("2. 测试工程师");
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

  it("shows the conditional work rules question only after selecting step-by-step interaction", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
              "你是产品经理，性格冷静务实，沟通简洁直接，负责把模糊需求澄清成可执行结论。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "1", "1"];
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

    expect(outputs[2]).toContain("你希望它用什么方式和你交互？");
    expect(outputs[3]).toContain("是否需要长期沉淀规则和文档？");
    expect(outputs[4]).toContain("默认输出更偏向哪类内容？");
  });

  it("skips the conditional work rules question when interaction mode does not match depends_on", async () => {
    const calls: string[] = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
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
              "你是产品经理，性格冷静务实，沟通简洁直接。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "2"];
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

    expect(outputs.at(-1)).toContain("是否需要长期沉淀规则和文档？");
    const finalResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "1",
          runtime: "mock",
        }),
      }),
    );
    expect(finalResponse.status).toBe(200);
    const finalPayload = await finalResponse.json() as { output: string };
    expect(finalPayload.output).toContain("默认输出更偏向哪类内容？");
  });

  it("rejects placeholder initialization documents without marking ready", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: "doc-soul",
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
          });
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

    expect(last?.output).toContain("你希望它用什么方式和你交互？");
    expect(calls.find((call) => call.url === "http://data-service/v1/bot-config-documents")).toMatchObject({
      body: expect.objectContaining({
        title: "soul",
        content: expect.stringContaining("你是产品经理助手。"),
      }),
    });
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/v1/bots/prd-bot/ready");
  });

  it("retries failed soul generation without appending retry text", async () => {
    const prompts: string[] = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: "doc-soul",
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
          });
        }

        if (request.url === "http://llm-runner/v1/chat") {
          prompts.push((body as { prompt: string }).prompt);
          return Response.json({
            run_id: "run-retry",
            output: [
              "~document:private/soul.md",
              "(生成的正式 soul 内容，不包含 [BOOTSTRAP] 标记)",
              "~/document",
            ].join("\n"),
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:conv-init", {
      session_id: "init-soul",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "soul",
      soul_answers: ["产品经理", "1"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "确认", runtime: "mock" }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("Soul 配置已确认，正在生成 soul。");
    expect(payload.output).toContain("Soul 已生成。");
    expect(payload.output).toContain("请选择角色。");
    expect(prompts[0]).toContain("沟通风格：简洁直接");
  });

  it("falls back to local soul generation when the runtime exits", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => undefined)
          : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
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
            error: "runtime exited with code 1",
            code: "runtime_exit",
            details: "fetch failed",
          }, { status: 502 });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: "doc-soul",
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n\n你是产品经理机器人。",
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:conv-init", {
      session_id: "init-soul",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "soul",
      soul_answers: ["产品经理机器人", "1"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "确认", runtime: "kiro" }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("Soul 配置已确认，正在生成 soul。");
    expect(payload.output).toContain("Soul 已生成。");
    expect(payload.output).toContain("请选择角色。");
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).toMatchObject({
      phase: "role_select",
    });
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).not.toHaveProperty("generation_in_progress");
  });

  it("accepts generated soul output and advances to role selection", async () => {
    const prompts: string[] = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT"
          ? await request.json().catch(() => undefined)
          : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: "doc-soul",
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat") {
          prompts.push((body as { prompt?: string } | undefined)?.prompt ?? "");
          return Response.json({
            run_id: "run-soul",
            output: [
              "Soul 已生成。",
              "~document:private/soul.md",
              "# Soul",
              "我是 PRD 助手。",
              "~/document",
            ].join("\n"),
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    initializationSessions.set("prd-bot:admin-a:conv-init", {
      session_id: "init-soul",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "soul",
      soul_answers: ["产品经理", "1"],
      agents_answers: [],
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "确认", runtime: "mock" }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("Soul 配置已确认，正在生成 soul。");
    expect(payload.output).toContain("Soul 已生成。");
    expect(payload.output).toContain("请选择角色。");
    expect(payload.output).not.toContain("初始化文档生成失败：");
    expect(prompts[0]).toContain("请根据以下 Soul 引导配置生成 soul 文档。");
  });

  it("retries failed agents generation without appending retry text", async () => {
    const prompts: string[] = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: "mem-soul",
            bot_id: "prd-bot",
            title: "soul",
            content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
          });
        }

        if (request.url === "http://llm-runner/v1/chat") {
          prompts.push((body as { prompt: string }).prompt);
          return Response.json({
            run_id: "run-agents-retry",
            output: [
              "~document:instructions/AGENTS.md",
              "(生成的正式 agents 内容，不包含 [BOOTSTRAP] 标记)",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });
    const agentsAnswers = [
      "interaction_mode=step_by_step",
      "memory_storage=yes",
      "output_shape=PRD",
      "work_rules=PRD 前确认 Console、IMM、计量计费",
    ];
    initializationSessions.set("prd-bot:admin-a:conv-init", {
      session_id: "init-agents",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "agents",
      selected_role_id: "role-product-manager",
      soul_answers: ["产品经理", "1"],
      agents_answers: agentsAnswers,
      status: "active",
    });

    const response = await server.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({ bot_id: "prd-bot", wecom_user_id: "admin-a", text: "确认", runtime: "mock" }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("工作方式配置已确认，正在生成 agents.md。");
    expect(payload.output).toContain("初始化完成，可以开始工作。");
    expect(prompts[0]).toContain("角色：role-product-manager");
  });

  it("falls back to deterministic initialization documents when document generation returns plain text", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "initializing",
            bot_id: "prd-bot",
            wecom_user_id: "admin-a",
            conversation: {
              conversation_id: "conv-init",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "init",
            },
            is_admin: true,
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
          return Response.json([]);
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({
            memory_doc_id: `mem-${(body as { title: string }).title}`,
            ...(body as object),
          }, { status: 201 });
        }

        if (request.url === "http://llm-runner/v1/chat") {
          return Response.json({
            run_id: "run-plain-text",
            output: "fake-kiro: 请根据以下管理员初始化配置生成两个文档块：soul 和 agents.md。",
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/ready") {
          return Response.json({ bot_id: "prd-bot", status: "ready" });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const messages = ["1", "1", "1", "1", "1", "PRD 需要逐项确认 Console、IMM、计量计费", "确认"];
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
        content: expect.stringContaining("## 角色"),
      }),
    ]);
    const configWrites = calls
      .filter((call) => call.url === "http://data-service/v1/bot-config-documents")
      .map((call) => call.body as { title: string; content: string });
    const soul = configWrites.find((document) => document.title === "soul")?.content || "";
    const agents = configWrites.find((document) => document.title === "agents.md")?.content || "";
    expect(soul).toContain("产品经理");
        expect(soul).not.toContain("核心职责：");
    expect(soul).not.toContain("Skill / MCP");
    expect(agents).toContain("角色：role-product-manager");
    expect(agents).toContain("交互规则");
    expect(agents).toContain("## 默认规则背景");
    expect(agents).toContain("默认使用中文回复");
    expect(agents).toContain("https://console.easemob.com/");
    expect(agents).toContain("REST API、Webhook");
    expect(agents).toContain("引导询问需要包含 6 个以上且 20 个以下的问题");
    expect(agents).toContain("一次只问一个问题");
    expect(agents).toContain("优先给出 2 到 4 个候选选项");
    expect(agents).toContain("能够判断时先给推荐项");
    expect(agents).toContain("用户也可以直接自由回答");
    expect(agents).not.toContain("角色定位：");
    expect(agents).toContain("业务背景：环信是 IM 服务提供商，提供各种端的 SDK、REST API 等服务");
    expect(agents).not.toContain("业务背景：背景");
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
    const initializationSessions = new Map<string, MockInitializationSession>();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" || request.method === "PUT" ? await request.json() : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
    expect(payload.output).toContain("你希望我的沟通风格是什么？");
        expect(payload.output).toContain("回复编号或直接输入。");
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/internal/initialization-sessions/active?bot_id=prd-bot&wecom_user_id=admin-a&conversation_id=conv-init",
      "http://data-service/internal/initialization-sessions/active?bot_id=prd-bot&wecom_user_id=admin-a&conversation_id=pending",
      "http://data-service/internal/initialization-sessions",
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

  it("handles /help as a platform command and returns a table instead of calling llm", async () => {
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
            is_admin: true,
            conversation: {
              conversation_id: "conv-help",
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
          wecom_user_id: "admin-a",
          text: "/help",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("| 指令 | 功能 |");
    expect(payload.output).toContain("| `/stop` | 中断当前任务 |");
    expect(payload.output).toContain("| `/skill` | 查看当前已安装的技能 |");
    expect(payload.output).toContain("| `/skill_list` | 已装技能列表 |");
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
    ]);
  });

  it("handles /history as a platform command and returns stored conversations instead of calling llm", async () => {
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
            is_admin: true,
            conversation: {
              conversation_id: "conv-active",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "normal_chat",
              is_active: true,
              created_at: "2026-06-24T00:00:00.000Z",
              updated_at: "2026-06-24T00:00:00.000Z",
            },
          });
        }

        if (request.url === "http://data-service/v1/conversations?bot_id=prd-bot&wecom_user_id=admin-a&channel=wecom_direct&purpose=normal_chat") {
          return Response.json([
            {
              conversation_id: "conv-2",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "normal_chat",
              display_name: "第二轮",
              is_active: true,
              created_at: "2026-06-24T02:00:00.000Z",
              updated_at: "2026-06-24T02:00:00.000Z",
            },
            {
              conversation_id: "conv-1",
              bot_id: "prd-bot",
              wecom_user_id: "admin-a",
              channel: "wecom_direct",
              purpose: "normal_chat",
              display_name: "第一轮",
              is_active: false,
              created_at: "2026-06-24T01:00:00.000Z",
              updated_at: "2026-06-24T01:00:00.000Z",
            },
          ]);
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    });

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/history",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { output: string };
    expect(payload.output).toContain("历史会话");
    expect(payload.output).toContain("| 序号 | 会话 | 状态 | 更新时间 |");
    expect(payload.output).toContain("第二轮");
    expect(payload.output).toContain("第一轮");
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/conversations?bot_id=prd-bot&wecom_user_id=admin-a&channel=wecom_direct&purpose=normal_chat",
    ]);
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
    expect(prompts[0]).toContain("<user-message>\n开始写 PRD\n</user-message>");
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

  it("shows env metadata only for admins", async () => {
    const calls: string[] = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push(request.url);

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
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

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/env",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      output: expect.stringContaining("OPENAI_API_KEY"),
    });
    expect(payload.output).toContain("已设置");
    expect(calls).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/env",
    ]);
  });

  it("allows admins to set env vars through the env command", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/env") {
          return Response.json({
            bot_id: "prd-bot",
            key: "OPENAI_API_KEY",
            is_set: true,
            updated_at: "2026-06-24T00:00:00.000Z",
          }, { status: 201 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/env set OPENAI_API_KEY ciphertext-secret",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: "已设置环境变量：OPENAI_API_KEY。",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/env",
    ]);
    expect(calls[1].body).toEqual({
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-secret",
      updated_by_wecom_user_id: "admin-a",
    });
  });

  it("allows admins to delete env vars through the env command", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        calls.push({ url: request.url, method: request.method });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/env/OPENAI_API_KEY") {
          return new Response(null, { status: 204 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/env delete OPENAI_API_KEY",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: "已删除环境变量：OPENAI_API_KEY。",
    });
    expect(calls).toEqual([
      { url: "http://data-service/v1/message-context/resolve", method: "POST" },
      { url: "http://data-service/v1/bots/prd-bot/env/OPENAI_API_KEY", method: "DELETE" },
    ]);
  });

  it("rejects env inspection for non-admin users with a clear message", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
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
              conversation_id: "conv-user",
            },
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/env",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "capability_admin_required",
      output: "只有管理员可以查看环境变量和管理 capability。",
    });
  });

  it("allows admins to update skill and mcp policy", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/runtime-policy") {
          const update = body as Record<string, unknown>;
          return Response.json({
            bot_id: "prd-bot",
            skill_install_policy: update.skill_install_policy ?? "admin_only",
            mcp_manage_policy: update.mcp_manage_policy ?? "admin_only",
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const skillResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/policy skill open",
          runtime: "mock",
        }),
      }),
    );
    expect(skillResponse.status).toBe(200);
    await expect(skillResponse.json()).resolves.toMatchObject({
      output: "已更新 skill 安装策略：open。",
    });

    const mcpResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/policy mcp admin_only",
          runtime: "mock",
        }),
      }),
    );
    expect(mcpResponse.status).toBe(200);
    await expect(mcpResponse.json()).resolves.toMatchObject({
      output: "已更新 MCP 管理策略：admin_only。",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/runtime-policy",
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/runtime-policy",
    ]);
    expect(calls[1].body).toEqual({ skill_install_policy: "open" });
    expect(calls[3].body).toEqual({ mcp_manage_policy: "admin_only" });
  });

  it("returns capability summaries for slash and natural-language skill queries", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
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

        if (request.url === "http://data-service/v1/bots/prd-bot/skills") {
          return Response.json([
            {
              bot_id: "prd-bot",
              name: "repo-analyzer",
              source_type: "github",
              source_ref: "https://github.com/acme/repo-analyzer",
              status: "installed",
            },
            {
              bot_id: "prd-bot",
              name: "broken-skill",
              source_type: "builtin",
              source_ref: "broken-skill",
              status: "failed",
              last_error: "invalid package",
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

        if (request.url === "http://data-service/v1/bots/prd-bot/capability-audit-logs") {
          return Response.json([
            {
              bot_id: "prd-bot",
              action_type: "skill_install",
              target_name: "repo-analyzer",
              result: "success",
              created_at: "2026-06-24T00:00:00.000Z",
            },
          ]);
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const skillResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/skill",
          runtime: "mock",
        }),
      }),
    );
    expect(skillResponse.status).toBe(200);
    await expect(skillResponse.json()).resolves.toMatchObject({
      output: expect.stringContaining("当前 bot 已安装的 Skills"),
    });
    const skillPayload = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/skill",
          runtime: "mock",
        }),
      }),
    ).then((response) => response.json());
    expect(skillPayload.output).toContain("repo-analyzer");
    expect(skillPayload.output).not.toContain("broken-skill");

    const naturalSkillResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "我安装了 grill-me ，但是 bot 给我的内容中没看到这个skill，我当前有哪些 skill？",
          runtime: "mock",
        }),
      }),
    );
    expect(naturalSkillResponse.status).toBe(200);
    await expect(naturalSkillResponse.json()).resolves.toMatchObject({
      output: expect.stringContaining("当前 bot 已安装的 Skills"),
    });

    const longNaturalSkillResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "我安装了 grill-me ，但是 bot 给我的内容中没看到这个skill",
          runtime: "mock",
        }),
      }),
    );
    expect(longNaturalSkillResponse.status).toBe(200);
    await expect(longNaturalSkillResponse.json()).resolves.toMatchObject({
      output: expect.stringContaining("当前 bot 已安装的 Skills"),
    });

    const mcpResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/mcp",
          runtime: "mock",
        }),
      }),
    );
    expect(mcpResponse.status).toBe(200);
    await expect(mcpResponse.json()).resolves.toMatchObject({
      output: expect.stringContaining("当前 bot 已配置的 MCP"),
    });

    const capabilityResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/capability",
          runtime: "mock",
        }),
      }),
    );
    expect(capabilityResponse.status).toBe(200);
    const capabilityPayload = await capabilityResponse.json();
    expect(capabilityPayload.output).toContain("skill 安装策略：admin_only");
    expect(capabilityPayload.output).toContain("MCP 管理策略：open");
    expect(capabilityPayload.output).toContain("repo-analyzer");
    expect(capabilityPayload.output).toContain("search-mcp");
    expect(capabilityPayload.output).toContain("skill_install");
  });

  it("accepts a natural-language skill install request from admins", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "请帮我安装 skill repo-analyzer",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 skill 安装：repo-analyzer。",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/skills/install",
    ]);
    expect(calls[1].body).toEqual({
      name: "repo-analyzer",
    });
  });

  it("supports slash skill install and delete commands for admins", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/delete") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const installResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/skill install repo-analyzer",
          runtime: "mock",
        }),
      }),
    );
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 skill 安装：repo-analyzer。",
    });

    const deleteResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/skill delete repo-analyzer",
          runtime: "mock",
        }),
      }),
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 skill 删除：repo-analyzer。",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/skills/install",
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/skills/delete",
    ]);
    expect(calls[1].body).toEqual({ name: "repo-analyzer" });
    expect(calls[3].body).toEqual({ name: "repo-analyzer" });
  });

  it("supports slash mcp install and delete commands for admins", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/mcps/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/mcps/delete") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const installResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/mcp install search-mcp",
          runtime: "mock",
        }),
      }),
    );
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 MCP 安装：search-mcp。",
    });

    const deleteResponse = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "/mcp delete search-mcp",
          runtime: "mock",
        }),
      }),
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 MCP 删除：search-mcp。",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/mcps/install",
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/mcps/delete",
    ]);
    expect(calls[1].body).toEqual({ name: "search-mcp" });
    expect(calls[3].body).toEqual({ name: "search-mcp" });
  });

  it("accepts a natural-language skill install request with a github url", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-admin",
            },
          });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "admin-a",
          text: "安装这个 skill：https://github.com/acme/repo-analyzer",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 skill 安装：repo-analyzer。",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://capability-runner/internal/bots/prd-bot/skills/install",
    ]);
    expect(calls[1].body).toEqual({
      name: "repo-analyzer",
      source_ref: "https://github.com/acme/repo-analyzer",
      source_type: "github",
    });
  });

  it("allows non-admin users to install skills when policy is open", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: false,
            conversation: {
              conversation_id: "conv-user",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/runtime-policy") {
          return Response.json({
            bot_id: "prd-bot",
            skill_install_policy: "open",
            mcp_manage_policy: "admin_only",
          });
        }

        if (request.url === "http://capability-runner/internal/bots/prd-bot/skills/install") {
          return Response.json({ accepted: true }, { status: 202 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "请帮我安装 skill repo-analyzer",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      output: "已受理 skill 安装：repo-analyzer。",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://data-service/v1/message-context/resolve",
      "http://data-service/v1/bots/prd-bot/runtime-policy",
      "http://capability-runner/internal/bots/prd-bot/skills/install",
    ]);
  });

  it("rejects non-admin skill installs when policy is admin_only", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
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
              conversation_id: "conv-user",
            },
          });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/runtime-policy") {
          return Response.json({
            bot_id: "prd-bot",
            skill_install_policy: "admin_only",
            mcp_manage_policy: "admin_only",
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "请帮我安装 skill repo-analyzer",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "capability_admin_required",
      output: "只有管理员可以查看环境变量和管理 capability。",
    });
  });

  it("rejects restricted capability management actions for non-admin users", async () => {
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
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
              conversation_id: "conv-user",
            },
          });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
    } as Parameters<typeof createBotHostServer>[0]);

    const response = await server.fetch(
      new Request("http://localhost/v1/messages/wecom", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          text: "/policy skill open",
          runtime: "mock",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      reason: "capability_admin_required",
      output: "只有管理员可以查看环境变量和管理 capability。",
    });
  });

  it("routes /stop without starting a stream and confirms immediate cancellation", async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    let messageHandler:
      | ((message: { conversationId: string; userId: string; text: string }) => Promise<void>)
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
        calls.push(request.url);
        const wizardResponse = noActiveInitializationSessionResponse(request);
        if (wizardResponse) {
          return wizardResponse;
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }
        if (request.url === "http://llm-runner/v1/runs/cancel") {
          return Response.json({ cancelled: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage(handler) { messageHandler = handler; },
        async sendText(_conversationId, text) { sent.push(text); },
      },
    });

    await worker.start();
    await messageHandler?.({ conversationId: "conversation-a", userId: "user-a", text: "/stop" });

    expect(sent).toEqual(["已停止当前任务。"]);
    expect(calls).toContain("http://llm-runner/v1/runs/cancel");
    expect(calls).not.toContain("http://llm-runner/v1/chat/stream");
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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

  it("does not stream normal chat when wizard state lookup fails", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    const calls: string[] = [];
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
        calls.push(request.url);

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/internal/initialization-sessions/active?")) {
          return Response.json({ error: "data-service unavailable" }, { status: 500 });
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return Response.json({ error: "should not stream" }, { status: 500 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
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
      conversationId: "conversation-a",
      userId: "admin-a",
      text: "hello",
    });

    expect(sent).toEqual([
      {
        conversationId: "conversation-a",
        text: "初始化状态读取失败，请稍后重试。",
      },
    ]);
    expect(calls).not.toContain("http://llm-runner/v1/chat/stream");
  });

  it("streams the /sync project context with llm chunks to real wecom messages", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
            project_key: "im-test-hub",
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
          expect(body).toMatchObject({
            prompt: expect.stringContaining("<root>../../projects/im-test-hub</root>"),
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

  it("does not stream capability skill queries to llm and returns the bot skill summary", async () => {
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

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: {
              conversation_id: "conv-1",
            },
          });
        }

        if (request.url.startsWith("http://data-service/internal/initialization-sessions/active?")) {
          return Response.json({ error: "data-service unavailable" }, { status: 500 });
        }

        if (request.url === "http://data-service/v1/bots/prd-bot/skills") {
          return Response.json([
            {
              bot_id: "prd-bot",
              name: "grill-me",
              source_type: "github",
              source_ref: "https://github.com/mattpocock/skills",
              status: "installed",
            },
          ]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return Response.json({ error: "should not stream capability queries" }, { status: 500 });
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
          sent.push({ conversationId, text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "我当前有哪些 skill",
    });

    expect(sent).toEqual([
      {
        conversationId: "conversation-a",
        text: expect.stringContaining("当前 bot 已安装的 Skills"),
        finish: true,
      },
    ]);
  });

  it("keeps the WeCom reply stream open while /sync clones the project", async () => {
    const sent: Array<{ conversationId: string; text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: { conversationId: string; userId: string; text: string }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      capabilityRunnerUrl: "http://capability-runner",
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
        if (request.url === "http://capability-runner/internal/bots/prd-bot/projects/sync") {
          return Response.json({
            project_key: "im-test-hub",
            path: "projects/im-test-hub",
            branch: "dev",
            base_commit: "1234567890abcdef",
            reused: false,
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
          sent.push({ conversationId, text, finish: options?.finish ?? true });
        },
      },
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "/sync",
    });

    expect(sent).toEqual([
      { conversationId: "conversation-a", text: "正在同步项目，请稍候…", finish: false },
      {
        conversationId: "conversation-a",
        text: expect.stringContaining("项目已同步"),
        finish: true,
      },
    ]);
  });

  it("asks for confirmation before storing generated markdown documents from streaming workers", async () => {
    const sent: Array<{ conversationId: string; text: string; finish: boolean }> = [];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const pendingDocuments: MockPendingGeneratedDocument[] = [];
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
        const body = request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
        calls.push({ url: request.url, method: request.method, body });
        const pendingGeneratedDocuments = mockPendingGeneratedDocumentsResponse(
          request,
          body,
          pendingDocuments,
        );
        if (pendingGeneratedDocuments) {
          return pendingGeneratedDocuments;
        }

        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

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
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({ type: "chunk", content: "PRD 已生成。\n" }),
            JSON.stringify({ type: "chunk", content: "~document:prd/asr-api.md\n# ASR PRD\n内容。\n~/document" }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm") {
          pendingDocuments[0].status = "confirmed";
          return Response.json([
            { pending_id: pendingDocuments[0].pending_id, title: "prd/asr-api.md", version: 1 },
          ]);
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
      text: "生成 PRD",
    });

    expect(sent.at(-1)?.text).toContain("# ASR PRD");
    expect(sent.at(-1)?.text).toContain("回复“确认”后保存到长期文档存储");
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "pending",
      }),
    ]);
    expect(calls.map((call) => call.url)).not.toContain("http://data-service/internal/documents");

    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "确认",
    });

    expect(sent.at(-1)).toEqual({
      conversationId: "conversation-a",
      text: "已保存到长期文档存储：prd/asr-api.md v1。",
      finish: true,
    });
    expect(pendingDocuments).toEqual([
      expect.objectContaining({
        title: "prd/asr-api.md",
        status: "confirmed",
      }),
    ]);
    expect(calls.find((call) => call.url === "http://data-service/internal/pending-generated-documents/apply-and-confirm")).toMatchObject({
      method: "POST",
      body: {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-1",
        created_by_bot_id: "prd-bot",
        created_by_user_id: "user-a",
      },
    });
  });

  it("hides Kiro tool diagnostics from a streamed WeCom reply", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          expect(body).toMatchObject({ runtime: "kiro" });
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({
              type: "chunk",
              content: [
                "\u001b[m> \u001b[0mI will run the following command: [PATH] --root HIM-22356 (using tool: shell)",
                "Purpose: Run easemob-jira-testcase for HIM-22356",
                "Traceback (most recent call last):",
                'File "[PATH]", line 117, in load_config',
                "jira_login_probe.LoginError: Jira credentials are not bound for the current WeCom user and Bot.",
                "- Completed in 2.945s",
                "Jira 凭证未绑定，请发送 /jira bind 后重试。",
              ].join("\n"),
            }),
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
      text: "Jira 凭证未绑定，请发送 /jira bind 后重试。",
      finish: true,
    });
  });

  it("normalizes glued numbered options in streamed replies", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-1" }),
            JSON.stringify({
              type: "chunk",
              content: [
                "这个语音转文字主要用在什么场景？\n",
                "1. IM聊天内语音消息转文字——最贴合环信 IM 主场景，推荐2. 实时音视频通话/会议的字幕转写\n",
                "3. 音频文件离线批量转写\n",
                "4.其他场景（你直接描述）",
              ].join(""),
            }),
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
      text: "语音转文字的PRD",
    });

    expect(sent.at(-1)).toEqual({
      text: [
        "这个语音转文字主要用在什么场景？",
        "1. IM聊天内语音消息转文字——最贴合环信 IM 主场景，推荐",
        "2. 实时音视频通话/会议的字幕转写",
        "3. 音频文件离线批量转写",
        "4. 其他场景（你直接描述）",
      ].join("\n"),
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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

  it("reports runtime stream errors without falling back to generic worker failure", async () => {
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
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-1" },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
        }

        if (request.url.startsWith("http://data-service/v1/memory-documents/current?")) {
          return Response.json([]);
        }

        if (request.url === "http://llm-runner/v1/chat/stream") {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "run", run_id: "run-1" })}\n`));
              controller.enqueue(encoder.encode(`${JSON.stringify({
                type: "error",
                error: "runtime exited with code 1",
                code: "runtime_exit",
                details: "fetch failed",
              })}\n`));
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/x-ndjson" },
          });
        }

        if (request.url === "log-service/v1/chat-events") {
          return Response.json({ ok: true }, { status: 201 });
        }

        return Response.json({ error: "unexpected" }, { status: 500 });
      },
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
      { text: "LLM 运行器暂不可用：runtime exited with code 1。请检查 Kiro relay 或 runtime 配置后重试。", finish: true },
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
    const initializationSessions = new Map<string, MockInitializationSession>();
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
        const body = request.method === "POST" || request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        calls.push({ url: request.url, body });
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        const roleQuestionsResponse = mockRoleQuestionsResponse(request);
        if (roleQuestionsResponse) {
          return roleQuestionsResponse;
        }
        const globalDocumentsResponse = mockGlobalDocumentsResponse(request);
        if (globalDocumentsResponse) {
          return globalDocumentsResponse;
        }
        const roleDocumentsResponse = mockRoleDocumentsResponse(request);
        if (roleDocumentsResponse) {
          return roleDocumentsResponse;
        }

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
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
          expect((body as { prompt: string }).prompt).toContain("<user-message>\n我需要一个语音转文字的api\n</user-message>");
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

    for (const text of ["1", "2", "1"]) {
      await messageHandler?.({
        conversationId: "conversation-a",
        userId: "admin-a",
        text,
      });
    }
    await waitForSentText("角色选择 1/1");
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "admin-a",
      text: "1",
    });
    await waitForSentText("你希望它用什么方式和你交互？");

    for (const text of [
      "1",
      "1",
      "1",
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
    expect(sent[1].text).toContain("我是谁？");
    const soulWaitingIndex = sent.findIndex((message) => message.text.includes("Soul 正在生成，请稍等。"));
    const soulDoneIndex = sent.findIndex((message) => message.text.includes("Soul 已生成。"));
    const initializedIndex = sent.findIndex((message) => message.text.includes("初始化完成，可以开始工作。"));
    expect(soulWaitingIndex).toBeGreaterThan(-1);
    expect(soulDoneIndex).toBeGreaterThan(soulWaitingIndex);
    expect(initializedIndex).toBeGreaterThan(soulDoneIndex);
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
    const initializationSessions = new Map<string, MockInitializationSession>();
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
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
    expect(result?.output).toContain("我是谁？");
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
    const initializationSessions = new Map<string, MockInitializationSession>();
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
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
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
      text: "旧角色",
    });
    expect(sent.at(-1)?.text).toContain("你希望我的沟通风格是什么？");

    await worker.restartInitialization?.({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });
    expect(sent.at(-1)?.text).toContain("我是谁？");

    await messageHandler?.({
      conversationId: "admin-a",
      userId: "admin-a",
      text: "新角色",
    });
    expect(sent.at(-1)?.text).toContain("你希望我的沟通风格是什么？");
  });

  it("clears pending and known initialization sessions before restart", async () => {
    const initializationSessions = new Map<string, MockInitializationSession>();
    const cleared: string[] = [];
    let upsertedAfterClears = false;
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (request) => {
        if (!(request instanceof Request)) {
          throw new Error("expected Request");
        }
        const url = new URL(request.url);
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;

        if (url.pathname === "/internal/initialization-sessions/active" && request.method === "DELETE") {
          const key = initializationSessionKey({
            bot_id: url.searchParams.get("bot_id") ?? "",
            wecom_user_id: url.searchParams.get("wecom_user_id") ?? "",
            conversation_id: url.searchParams.get("conversation_id") ?? "",
          });
          cleared.push(key);
        }

        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          if (request.method === "PUT") {
            upsertedAfterClears = [
              "prd-bot:admin-a:conv-init",
              "prd-bot:admin-a:admin-a",
              "prd-bot:admin-a:pending",
            ].every((key) => cleared.includes(key));
          }
          return initializationSessionResponse;
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
        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
      },
      wecomClient: {
        async connect() {},
        disconnect() {},
        onMessage() {},
        async sendText() {},
      },
    });
    for (const conversationId of ["conv-init", "admin-a", "pending"]) {
      initializationSessions.set(`prd-bot:admin-a:${conversationId}`, {
        session_id: `init-${conversationId}`,
        bot_id: "prd-bot",
        wecom_user_id: "admin-a",
        conversation_id: conversationId,
        phase: "soul",
        soul_answers: ["旧角色"],
        agents_answers: [],
        status: "active",
      });
    }

    await worker.restartInitialization?.({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });

    expect(cleared).toEqual([
      "prd-bot:admin-a:conv-init",
      "prd-bot:admin-a:admin-a",
      "prd-bot:admin-a:pending",
    ]);
    expect(upsertedAfterClears).toBe(true);
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).toMatchObject({
      soul_answers: [],
    });
    expect(initializationSessions.has("prd-bot:admin-a:pending")).toBe(false);
  });

  it("promotes pending wizard session before generation starts", async () => {
    const sent: Array<{ conversationId: string; text: string }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
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
        const body = request.method === "PUT" || request.method === "POST"
          ? await request.json().catch(() => undefined)
          : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
        }

        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: true,
            conversation: {
              conversation_id: "conv-init",
              purpose: "normal_chat",
            },
          });
        }

        if (request.url.startsWith("http://data-service/v1/bots/") && request.url.endsWith("/config-documents")) {
          return Response.json([
            {
              title: "soul",
              content: "# Soul\n\n你是一个熟悉团队上下文的助手，沟通风格简洁直接。",
            },
          ]);
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
              "你是产品经理。",
              "~/document",
            ].join("\n"),
          });
        }

        if (request.url === "http://data-service/v1/bot-config-documents") {
          return Response.json({}, { status: 201 });
        }

        return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
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
    initializationSessions.set("prd-bot:admin-a:pending", {
      session_id: "init-pending",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "pending",
      phase: "soul",
      soul_answers: ["产品经理"],
      agents_answers: [],
      status: "active",
    });

    await worker.start();
    await messageHandler?.({
      conversationId: "admin-a",
      userId: "admin-a",
      text: "简洁直接",
    });

    expect(sent.at(0)?.text).toBe("Soul 正在生成，请稍等。");
    expect(initializationSessions.get("prd-bot:admin-a:conv-init")).toMatchObject({
      soul_answers: ["产品经理"],
      generation_in_progress: "soul",
    });
    expect(initializationSessions.has("prd-bot:admin-a:pending")).toBe(false);
  });

  it("continues an in-memory initialization wizard before ready streaming", async () => {
    const sent: Array<{ conversationId: string; text: string; finish?: boolean }> = [];
    const initializationSessions = new Map<string, MockInitializationSession>();
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
        const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
        const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
        if (initializationSessionResponse) {
          return initializationSessionResponse;
        }
        const enabledRolesResponse = mockEnabledRolesResponse(request);
        if (enabledRolesResponse) {
          return enabledRolesResponse;
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
        text: "你希望我的沟通风格是什么？\n1. 简洁直接\n2. 严谨完整\n3. 先问清楚再回答\n4. 给出选项辅助决策\n5. 其他，请直接说明\n\n回复编号或直接输入。",
        finish: undefined,
      },
    ]);
  });

  it("uses the shared ready message handler for both api and worker paths", async () => {
    const sent: Array<{ conversationId: string; text: string; finish?: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const createFetch = (initializationSessions: Map<string, MockInitializationSession>): typeof fetch => async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = request.method === "PUT" ? await request.json().catch(() => undefined) : undefined;
      const initializationSessionResponse = mockInitializationSessionResponse(request, body, initializationSessions);
      if (initializationSessionResponse) {
        return initializationSessionResponse;
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
      if (request.url === "http://data-service/v1/bots/prd-bot/config-documents") {
        return Response.json([]);
      }
      if (request.url.startsWith("http://data-service/v1/memory-documents/current")) {
        return Response.json([]);
      }
      const enabledRolesResponse = mockEnabledRolesResponse(request);
      if (enabledRolesResponse) {
        return enabledRolesResponse;
      }
      if (request.url === "http://llm-runner/v1/chat") {
        return Response.json({
          run_id: "run-soul",
          output: [
            "Soul 已生成。",
            "~document:private/soul.md",
            "# Soul",
            "你是产品经理，沟通风格简洁直接，擅长把模糊需求澄清成结构化结论。",
            "~/document",
          ].join("\n"),
        });
      }
      if (request.url === "http://data-service/v1/bot-config-documents") {
        return Response.json({}, { status: 201 });
      }
      if (request.url.startsWith("http://data-service/internal/pending-generated-documents")) {
        return Response.json([]);
      }
      return Response.json({ error: "unexpected", url: request.url }, { status: 500 });
    };

    const seedSessions = () => {
      const initializationSessions = new Map<string, MockInitializationSession>();
      initializationSessions.set("prd-bot:user-a:conv-chat", {
        session_id: "init-shared",
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conv-chat",
        phase: "soul",
        soul_answers: ["产品经理"],
        agents_answers: [],
        status: "active",
      });
      return initializationSessions;
    };

    const sharedSessions = seedSessions();
    const sharedFetch = createFetch(sharedSessions);

    const shared = await handleBotMessage(
      {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conversation-a",
        text: "冷静务实",
        runtime: "mock",
      },
      {
        dataServiceUrl: "http://data-service",
        llmRunnerUrl: "http://llm-runner",
        fetch: sharedFetch,
      },
    );

    const apiSessions = seedSessions();
    const server = createBotHostServer({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: createFetch(apiSessions),
    });
    const apiResponse = await server.fetch(new Request("http://bot-host/v1/messages/wecom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        conversation_id: "conversation-a",
        text: "冷静务实",
        runtime: "mock",
      }),
    }));

    const workerSessions = seedSessions();
    const worker = createBotHostWorker({
      botId: "prd-bot",
      runtime: "mock",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: createFetch(workerSessions),
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
    await messageHandler?.({
      conversationId: "conversation-a",
      userId: "user-a",
      text: "冷静务实",
    });

    expect(shared).toMatchObject({
      conversation_id: "conv-chat",
      output: "Soul 配置已确认，正在生成 soul。\n\nSoul 已生成。\n\n请选择角色。\n\n角色选择 1/1：你希望我承担哪个角色？\n1. 产品经理\n2. 测试工程师\n3. 研发工程师\n4. 市场人员\n5. 运营人员\n\n回复编号或直接输入。",
    });
    expect(await apiResponse.json()).toMatchObject(shared);
    expect(sent).toEqual([
      {
        conversationId: "conversation-a",
        text: "Soul 正在生成，请稍等。",
        finish: undefined,
      },
    ]);
    expect(sharedSessions.get("prd-bot:user-a:conv-chat")).toMatchObject({
      soul_answers: ["产品经理", "冷静务实"],
    });
    expect(apiSessions.get("prd-bot:user-a:conv-chat")).toMatchObject({
      soul_answers: ["产品经理", "冷静务实"],
    });
    expect(workerSessions.get("prd-bot:user-a:conv-chat")).toMatchObject({
      soul_answers: ["产品经理"],
    });
  });

  it("keeps messageHandler limited to shared handler exports", () => {
    expect(messageHandlerModule).not.toHaveProperty("createBotHostServer");
    expect(messageHandlerModule).not.toHaveProperty("createBotHostWorker");
    expect(messageHandlerModule).not.toHaveProperty("createBotHostSupervisor");
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

  it("creates a user-scoped Jira binding link without invoking the llm", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const result = await handleBotMessage({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      conversation_id: "wecom-conversation-a",
      text: "/jira bind",
      runtime: "kiro",
    }, {
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      credentialBindPublicUrl: "https://bot.example.com",
      credentialInternalToken: "internal-token",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            is_admin: false,
            conversation: { conversation_id: "conv-a" },
          });
        }
        if (request.url.startsWith("http://data-service/internal/user-credentials?")) {
          return Response.json({
            bot_id: "jira-bot",
            wecom_user_id: "user-a",
            provider: "easemob_jira",
            is_bound: false,
          });
        }
        if (request.url === "http://data-service/internal/user-credential-bindings") {
          return Response.json({
            token: "one-time-token",
            provider: "easemob_jira",
            expires_at: "2026-07-13T18:00:00.000Z",
          }, { status: 201 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    expect(result.output).toContain(
      "https://bot.example.com/bind/jira?token=one-time-token",
    );
    expect(calls).toContainEqual({
      url: "http://data-service/internal/user-credential-bindings",
      authorization: "Bearer internal-token",
    });
    expect(calls.some((call) => call.url.includes("llm-runner"))).toBe(false);
  });

  it("does not create another Jira binding link for an already-bound user", async () => {
    const calls: string[] = [];
    const result = await handleBotMessage({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      conversation_id: "wecom-conversation-a",
      text: "/jira bind",
      runtime: "kiro",
    }, {
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      credentialBindPublicUrl: "https://bot.example.com",
      credentialInternalToken: "internal-token",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request.url);
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-a" },
          });
        }
        if (request.url.startsWith("http://data-service/internal/user-credentials?")) {
          return Response.json({
            bot_id: "jira-bot",
            wecom_user_id: "user-a",
            provider: "easemob_jira",
            is_bound: true,
            updated_at: "2026-07-13T18:00:00.000Z",
          });
        }
        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    expect(result.output).toBe(
      "你在当前 Bot 中的 Jira 账号已绑定。如需更换账号，请先发送 /jira unbind，再发送 /jira bind。",
    );
    expect(calls).not.toContain("http://data-service/internal/user-credential-bindings");
    expect(calls.some((url) => url.includes("llm-runner"))).toBe(false);
  });

  it("describes Jira unbinding as scoped to the current user and bot", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await handleBotMessage({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      conversation_id: "wecom-conversation-a",
      text: "/jira unbind",
      runtime: "kiro",
    }, {
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      credentialInternalToken: "internal-token",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: request.url, method: request.method });
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-a" },
          });
        }
        if (
          request.method === "DELETE"
          && request.url.startsWith("http://data-service/internal/user-credentials?")
        ) {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    expect(result.output).toBe(
      "已解除你在当前 Bot 中的 Jira 账号绑定。历史 Jira Cookie 将不再被复用。",
    );
    expect(calls).toContainEqual({
      url: "http://data-service/internal/user-credentials?bot_id=jira-bot&wecom_user_id=user-a&provider=easemob_jira",
      method: "DELETE",
    });
    expect(calls.some((call) => call.url.includes("llm-runner"))).toBe(false);
  });

  it("passes Jira messages to Kiro without hard-coded Jira routing", async () => {
    const calls: string[] = [];
    let llmPrompt = "";
    const result = await handleBotMessage({
      bot_id: "jira-bot",
      wecom_user_id: "user-b",
      conversation_id: "wecom-conversation-b",
      text: "HIM-22356，帮我判断是否可以提测",
      runtime: "kiro",
    }, {
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request.url);
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-b" },
          });
        }
        if (request.url.startsWith("http://data-service/internal/initialization-sessions/active?")) {
          return Response.json(null);
        }
        if (
          request.url.includes("/config-documents")
          || request.url.includes("/memory-documents/current")
        ) {
          return Response.json(request.url.includes("/config-documents")
            ? [{ title: "soul", content: "You are a QA bot." }]
            : []);
        }
        if (request.url === "http://llm-runner/v1/chat") {
          const body = await request.json() as { prompt: string };
          llmPrompt = body.prompt;
          return Response.json({ run_id: "run-jira", output: "Jira analysis" });
        }
        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
    });

    expect(result.output).toBe("Jira analysis");
    expect(calls).toContain("http://llm-runner/v1/chat");
    expect(calls.some((url) => url.includes("/internal/user-credentials"))).toBe(false);
    expect(llmPrompt).not.toContain("runtime-guidance");
    expect(llmPrompt).not.toContain("easemob-jira-testcase");
    expect(llmPrompt).toContain("<memory>\n[bot-config/jira-bot] soul\nYou are a QA bot.\n</memory>");
    expect(llmPrompt).toContain(
      "<user-message>\nHIM-22356，帮我判断是否可以提测\n</user-message>",
    );
    expect(llmPrompt.indexOf("<memory>")).toBeLessThan(
      llmPrompt.indexOf("<user-message>"),
    );
  });

  it("lets the selected Kiro Skill return the Jira bind instruction", async () => {
    const calls: string[] = [];
    const sent: Array<{ text: string; finish: boolean }> = [];
    let messageHandler:
      | ((message: {
        conversationId: string;
        userId: string;
        text: string;
      }) => Promise<void>)
      | undefined;
    const worker = createBotHostWorker({
      botId: "jira-bot",
      runtime: "kiro",
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request.url);
        const noActiveInitializationSession = noActiveInitializationSessionResponse(request);
        if (noActiveInitializationSession) {
          return noActiveInitializationSession;
        }
        if (request.url === "http://data-service/v1/message-context/resolve") {
          return Response.json({
            allowed: true,
            reason: "ready",
            conversation: { conversation_id: "conv-b" },
          });
        }
        if (
          request.url.includes("/config-documents")
          || request.url.includes("/memory-documents/current")
        ) {
          return Response.json([]);
        }
        if (request.url === "http://llm-runner/v1/chat/stream") {
          return new Response([
            JSON.stringify({ type: "run", run_id: "run-jira" }),
            JSON.stringify({
              type: "chunk",
              content: "Jira 账号尚未绑定，请先发送 /jira bind，绑定完成后重新发送 Jira 编号。",
            }),
            JSON.stringify({ type: "done" }),
          ].join("\n") + "\n", {
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        return Response.json({ error: `unexpected ${request.url}` }, { status: 500 });
      },
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
      conversationId: "wecom-conversation-b",
      userId: "user-b",
      text: "HIM-22356",
    });

    expect(sent).toEqual([
      { text: "正在思考...", finish: false },
      {
        text: "Jira 账号尚未绑定，请先发送 /jira bind，绑定完成后重新发送 Jira 编号。",
        finish: true,
      },
    ]);
    expect(calls).toContain("http://llm-runner/v1/chat/stream");
    expect(calls.some((url) => url.includes("/internal/user-credentials"))).toBe(false);
  });
});
