import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDefaultMcpCapabilityConfig } from "@my-agent-toolkit/contracts";
import { ADMIN_CLAIM_TTL_MS, createDataStore, seedDefaultRoleConfig } from "./store.js";

describe("data-service store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("models one personal agent per user and isolated work stages", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "bot-a", name: "Alice Bot", runtime: "claude-code" });
    store.createBot({ bot_id: "bot-b", name: "Bob Bot", runtime: "claude-code" });
    const alice = store.createPlatformUser({
      user_id: "user-a",
      wecom_user_id: "wecom-a",
      display_name: "Alice",
    });
    const bob = store.createPlatformUser({
      user_id: "user-b",
      wecom_user_id: "wecom-b",
      display_name: "Bob",
    });
    const agentA = store.createPersonalAgent({
      agent_id: "agent-a",
      name: "Alice Agent",
      runtime: "claude-code",
    });
    const agentB = store.createPersonalAgent({
      agent_id: "agent-b",
      name: "Bob Agent",
      runtime: "claude-code",
    });

    expect(store.bindUserAgent({ user_id: alice.user_id, agent_id: agentA.agent_id }))
      .toMatchObject({ binding_type: "personal" });
    store.bindUserAgent({ user_id: bob.user_id, agent_id: agentB.agent_id });
    store.bindAgentBot({ agent_id: agentA.agent_id, bot_id: "bot-a" });
    store.bindAgentBot({ agent_id: agentB.agent_id, bot_id: "bot-b" });
    expect(() => store.bindUserAgent({ user_id: alice.user_id, agent_id: agentB.agent_id }))
      .toThrow("already has");

    const work = store.createWorkItem({
      work_id: "work-1",
      title: "生成技术方案",
      created_by_user_id: alice.user_id,
      assigned_user_id: bob.user_id,
      assigned_agent_id: agentB.agent_id,
      priority: "high",
    });
    const stage = store.createWorkStage({
      stage_id: "stage-1",
      work_id: work.work_id,
      name: "HLD 设计",
      intent: "根据已确认的 PRD 生成完整 HLD 设计",
    });

    expect(stage).toMatchObject({
      status: "pending",
      position: 1,
      assigned_user_id: bob.user_id,
      assigned_agent_id: agentB.agent_id,
    });
    expect(stage.conversation_id).toMatch(/^work_conv_/);
    expect(stage.workspace_ref).toBe("workspaces/work-1/stage-1/files");
    expect(store.getWorkConversation(stage.stage_id)).toMatchObject({
      conversation_id: stage.conversation_id,
      assigned_user_id: bob.user_id,
      assigned_agent_id: agentB.agent_id,
    });
    const runtimeSession = store.createWorkRuntimeSession({
      stage_id: stage.stage_id,
      agent_id: agentB.agent_id,
      runtime: "claude-code",
    });
    expect(runtimeSession).toMatchObject({
      conversation_id: stage.conversation_id,
      workspace_ref: stage.workspace_ref,
    });
    const published = store.createArtifact({
      artifact_id: "artifact-hld",
      stage_id: stage.stage_id,
      artifact_type: "architecture.hld",
      title: "HLD",
      content_ref: "docs/HLD.md",
      integrity_sha256: "a".repeat(64),
      summary: "初版设计",
      created_by_type: "agent",
      created_by_id: agentB.agent_id,
    });
    expect(published.version).toMatchObject({
      version: 1,
      content_ref: "workspaces/work-1/stage-1/files/docs/HLD.md",
    });
    expect(store.publishArtifactVersion("artifact-hld", {
      content_ref: "docs/HLD-v2.md",
      integrity_sha256: "b".repeat(64),
      summary: "根据评审意见修订",
      created_by_type: "agent",
      created_by_id: agentB.agent_id,
    }).version).toBe(2);
    expect(store.getArtifact("artifact-hld")?.latest_version).toBe(2);
    expect(() => store.publishArtifactVersion("artifact-hld", {
      content_ref: "../other-work/private.md",
      integrity_sha256: "c".repeat(64),
      summary: "越界引用",
      created_by_type: "agent",
    })).toThrow("content_ref is invalid");
    expect(store.transitionWorkStage(stage.stage_id, {
      status: "queued",
      actor_type: "user",
    }).status).toBe("queued");
    expect(store.transitionWorkStage(stage.stage_id, {
      status: "running",
      actor_type: "system",
    }).status).toBe("running");
    expect(store.transitionWorkStage(stage.stage_id, {
      status: "waiting_user",
      actor_type: "agent",
      actor_id: agentB.agent_id,
      summary: "缺少技术约束",
    }).status).toBe("waiting_user");
    expect(store.getWorkItem(work.work_id)?.status).toBe("waiting");
    expect(store.listWorkEvents(work.work_id).map((event) => event.event_type)).toEqual([
      "work.created",
      "stage.created",
      "runtime_session.created",
      "artifact.published",
      "artifact.version_published",
      "stage.status_changed",
      "stage.status_changed",
      "stage.status_changed",
    ]);
    expect(() => store.transitionWorkStage(stage.stage_id, {
      status: "succeeded",
      actor_type: "system",
    })).toThrow("invalid stage transition");
    store.transitionWorkStage(stage.stage_id, { status: "queued", actor_type: "user" });
    store.transitionWorkStage(stage.stage_id, { status: "running", actor_type: "system" });
    store.transitionWorkStage(stage.stage_id, { status: "succeeded", actor_type: "agent" });
    expect(store.getWorkItem(work.work_id)?.status).toBe("completed");
  });

  it("leases at most one execution per Personal Agent and writes results back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    const store = createDataStore();
    store.createBot({ bot_id: "bot-a", name: "Agent Bot", runtime: "claude-code" });
    store.createPlatformUser({ user_id: "user-a", wecom_user_id: "wecom-a", display_name: "Alice" });
    store.createPersonalAgent({ agent_id: "agent-a", name: "Alice Agent", runtime: "claude-code" });
    store.bindUserAgent({ user_id: "user-a", agent_id: "agent-a" });
    store.bindAgentBot({ agent_id: "agent-a", bot_id: "bot-a" });

    for (const number of [1, 2]) {
      store.createWorkItem({
        work_id: `work-${number}`,
        title: `任务 ${number}`,
        created_by_user_id: "user-a",
        assigned_user_id: "user-a",
        assigned_agent_id: "agent-a",
      });
      store.createWorkStage({
        stage_id: `stage-${number}`,
        work_id: `work-${number}`,
        name: "执行",
        intent: `完成任务 ${number}`,
      });
    }

    const firstQueue = store.enqueueWorkStage({ stage_id: "stage-1", actor_id: "user-a" });
    expect(store.enqueueWorkStage({ stage_id: "stage-1", actor_id: "user-a" }).queue_id)
      .toBe(firstQueue.queue_id);
    store.enqueueWorkStage({ stage_id: "stage-2", actor_id: "user-a" });

    const firstLease = store.leaseNextExecution({ worker_id: "worker-a" });
    expect(firstLease).toMatchObject({
      queue_item: { stage_id: "stage-1", attempt: 1 },
      execution: { status: "running" },
      runtime_request: {
        bot_id: "bot-a",
        user_id: "wecom-a",
        runtime: "claude-code",
      },
    });
    expect(store.leaseNextExecution({ worker_id: "worker-b" })).toBeUndefined();

    vi.advanceTimersByTime(1_201_000);
    const retryLease = store.leaseNextExecution({ worker_id: "worker-b" });
    expect(retryLease).toMatchObject({
      queue_item: { stage_id: "stage-1", attempt: 2 },
      execution: { status: "running" },
    });
    expect(store.listWorkExecutions("work-1").find((run) => run.attempt === 1)).toMatchObject({
      status: "failed",
      error_code: "lease_expired",
    });
    store.completeExecution(retryLease!.execution.execution_id, {
      status: "succeeded",
      runner_session_id: "claude:bot-a:wecom-a:stage-1",
      output: "任务一完成",
    });
    expect(store.getWorkItem("work-1")?.status).toBe("completed");

    const secondLease = store.leaseNextExecution({ worker_id: "worker-b" });
    expect(secondLease?.queue_item.stage_id).toBe("stage-2");
    store.completeExecution(secondLease!.execution.execution_id, {
      status: "failed",
      error_code: "runtime_exit",
      error_message: "CLI exited",
    });
    expect(store.getWorkItem("work-2")?.status).toBe("failed");
    expect(store.listWorkExecutions("work-1").find((run) => run.status === "succeeded")).toMatchObject({
      status: "succeeded",
      output: "任务一完成",
    });
  });

  it("passes a versioned Artifact through a Gate and hands off minimal context", () => {
    const store = createDataStore();
    for (const suffix of ["a", "b"]) {
      store.createBot({ bot_id: `bot-${suffix}`, name: `Bot ${suffix}`, runtime: "claude-code" });
      store.createPlatformUser({ user_id: `user-${suffix}`, wecom_user_id: `wecom-${suffix}`, display_name: `User ${suffix}` });
      store.createPersonalAgent({ agent_id: `agent-${suffix}`, name: `Agent ${suffix}`, runtime: "claude-code" });
      store.bindUserAgent({ user_id: `user-${suffix}`, agent_id: `agent-${suffix}` });
      store.bindAgentBot({ agent_id: `agent-${suffix}`, bot_id: `bot-${suffix}` });
    }
    store.createWorkItem({ work_id: "work-gate", title: "功能交付", description: "实现已批准需求",
      created_by_user_id: "user-a", assigned_user_id: "user-a", assigned_agent_id: "agent-a" });
    store.createWorkStage({ stage_id: "stage-design", work_id: "work-gate", name: "HLD", intent: "输出可实施设计" });
    store.enqueueWorkStage({ stage_id: "stage-design", actor_id: "user-a" });
    const lease = store.leaseNextExecution({ worker_id: "worker-a" })!;
    store.completeExecution(lease.execution.execution_id, { status: "succeeded", output: "内部完整输出不应交接" });
    const published = store.createArtifact({ stage_id: "stage-design", artifact_type: "architecture.hld", title: "HLD",
      content_ref: "docs/HLD.md", integrity_sha256: "a".repeat(64), summary: "已覆盖核心接口",
      created_by_type: "agent", created_by_id: "agent-a" });
    const gate = store.createGateDefinition({ stage_id: "stage-design", name: "设计门禁", kind: "human_review",
      criteria: "接口、异常与回滚设计完整", reviewer_user_id: "user-a", reviewer_agent_id: "agent-a", actor_id: "user-a" });
    expect(() => store.createGateResult({ gate_id: gate.gate_id,
      artifact_version_id: published.version.artifact_version_id, outcome: "revision_required", evidence: "缺少回滚",
      actor_type: "user", actor_id: "user-a" })).toThrow("revision_required needs");
    const result = store.createGateResult({ gate_id: gate.gate_id,
      artifact_version_id: published.version.artifact_version_id, outcome: "passed", evidence: "评审通过",
      actor_type: "user", actor_id: "user-a" });
    const revised = store.publishArtifactVersion(published.artifact.artifact_id, {
      content_ref: "docs/HLD-v2.md", integrity_sha256: "b".repeat(64), summary: "补充回滚设计",
      created_by_type: "agent", created_by_id: "agent-a",
    });
    const handoffInput = {
      work_id: "work-gate", source_stage_id: "stage-design", target_user_id: "user-b", target_agent_id: "agent-b",
      target_stage_name: "代码实现", target_stage_intent: "根据 HLD 完成代码和测试",
      acceptance_criteria: "构建和单元测试通过", constraints: "不得修改无关模块",
      expected_output: "源码、测试与验证摘要", created_by_user_id: "user-a",
    };
    expect(() => store.createHandoff({ ...handoffInput, gate_result_id: result.gate_result_id }))
      .toThrow("approval is stale");
    const currentResult = store.createGateResult({ gate_id: gate.gate_id,
      artifact_version_id: revised.artifact_version_id, outcome: "passed", evidence: "最新版评审通过",
      actor_type: "user", actor_id: "user-a" });
    const completed = store.createHandoff({ work_id: "work-gate", source_stage_id: "stage-design",
      gate_result_id: currentResult.gate_result_id, target_user_id: "user-b", target_agent_id: "agent-b",
      target_stage_name: "代码实现", target_stage_intent: "根据 HLD 完成代码和测试",
      acceptance_criteria: "构建和单元测试通过", constraints: "不得修改无关模块",
      expected_output: "源码、测试与验证摘要", created_by_user_id: "user-a" });

    expect(completed).toMatchObject({ handoff: { status: "completed", target_user_id: "user-b" },
      stage: { status: "queued", assigned_agent_id: "agent-b" }, queue_item: { status: "queued", bot_id: "bot-b" } });
    expect(completed.handoff.context_snapshot.approved_artifacts).toMatchObject([{ version: 2, summary: "补充回滚设计" }]);
    expect(completed.queue_item.prompt_snapshot).toContain("Authorized minimal handoff context");
    expect(completed.queue_item.prompt_snapshot).not.toContain("内部完整输出不应交接");
    expect(store.getWorkItem("work-gate")).toMatchObject({ assigned_user_id: "user-b", current_stage_id: completed.stage.stage_id });
    expect(store.leaseNextExecution({ worker_id: "worker-b" })?.runtime_request).toMatchObject({ user_id: "wecom-b", bot_id: "bot-b" });
  });

  it("creates and reads bot records", () => {
    const store = createDataStore();

    const bot = store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    expect(bot).toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      status: "draft",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(bot)).not.toContain("super-secret-value");
    expect(store.getBot("prd-bot")).toEqual(bot);
  });

  it("stores, updates, and clears the Bot main project config", () => {
    const store = createDataStore();
    const created = store.createBot({
      bot_id: "qa-bot",
      name: "QA Bot",
      runtime: "kiro",
      project_key: "im-test-hub",
      project_repository_url: "https://github.com/example/im-test-hub.git",
      project_default_branch: "develop",
    });

    expect(created).toMatchObject({
      project_key: "im-test-hub",
      project_default_branch: "develop",
      project_directory: "im-test-hub",
    });
    expect(store.updateBot("qa-bot", { project_default_branch: "main" }))
      .toMatchObject({ project_default_branch: "main" });
    expect(store.updateBot("qa-bot", { project_repository_url: "" }).project_repository_url)
      .toBeUndefined();
  });

  it("derives project defaults when only a repository URL is supplied", () => {
    const store = createDataStore();
    expect(store.createBot({
      bot_id: "qa-bot",
      name: "QA Bot",
      runtime: "kiro",
      project_key: "",
      project_repository_url: "https://github.com/example/im-test-hub.git",
      project_default_branch: "",
      project_directory: "",
    })).toMatchObject({
      project_key: "im-test-hub",
      project_repository_url: "https://github.com/example/im-test-hub.git",
      project_default_branch: "main",
      project_directory: "im-test-hub",
    });
  });

  it("rejects project repository URLs containing credentials", () => {
    const store = createDataStore();
    expect(() => store.createBot({
      bot_id: "qa-bot",
      name: "QA Bot",
      runtime: "kiro",
      project_key: "im-test-hub",
      project_repository_url: "https://token@example.com/org/im-test-hub.git",
    })).toThrow("project_repository_url must not contain credentials");
  });

  it("gets and updates bot MCP capability config", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(store.getBotMcpCapabilityConfig("prd-bot")).toEqual(
      buildDefaultMcpCapabilityConfig(),
    );

    const updated = store.updateBotMcpCapabilityConfig("prd-bot", {
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

    expect(updated).toEqual({
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
    const resolved = store.getBotMcpCapabilityConfig("prd-bot");
    expect({
      ...resolved,
      tools: { ...resolved.tools, enabled: ["memory.search"] },
    }).toEqual(updated);
    expect(resolved.tools.enabled).toEqual(expect.arrayContaining([
      "handoff.draft.create",
      "handoff.draft.select_bot",
      "handoff.draft.confirm_send",
    ]));
    expect(() => store.getBotMcpCapabilityConfig("missing-bot"))
      .toThrow("bot not found: missing-bot");
    expect(() => store.updateBotMcpCapabilityConfig("prd-bot", {
      version: 1,
      memory: {
        enabled: true,
        readable_scopes: ["namespace"],
        writable_scopes: [],
      },
      documents: {
        enabled: true,
        writable_scopes: [],
      },
      tools: {
        enabled: [],
      },
      directory_refs: [],
    })).toThrow("scope must be system, shared, bot, user, or session");
  });

  it("stores bot runtime provider config independently from worker code", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const defaultConfig = store.getRuntimeConfig("prd-bot");
    expect(defaultConfig).toMatchObject({
      bot_id: "prd-bot",
      provider: "kiro",
      stream: true,
      options: {},
    });

    const updated = store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      stream: false,
      options: {
        model: "gpt-5",
        temperature: 0.2,
      },
    });

    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      provider: "codex",
      stream: false,
      options: {
        model: "gpt-5",
        temperature: 0.2,
      },
    });
    expect(store.getBot("prd-bot")).toMatchObject({
      runtime: "kiro",
    });
    expect(store.getRuntimeConfig("prd-bot")).toEqual(updated);

    const repeated = store.upsertRuntimeConfig("prd-bot", {
      provider: "kimi",
    });

    expect(repeated).toMatchObject({
      bot_id: "prd-bot",
      provider: "kimi",
      stream: true,
      options: {},
    });
    expect(repeated.created_at).toBe(updated.created_at);
    expect(repeated.updated_at).not.toBe(updated.updated_at);
    expect(() => store.upsertRuntimeConfig("prd-bot", {
      provider: "",
    })).toThrow("provider is required");
    expect(() => store.getRuntimeConfig("missing-bot"))
      .toThrow("bot not found: missing-bot");
  });

  it("stores runtime sessions by runner session id", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = store.upsertRuntimeSession({
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
      provider_session_id: "kiro-session-a",
    });

    expect(store.getRuntimeSession(created.runner_session_id)).toEqual(created);

    const updated = store.upsertRuntimeSession({
      runner_session_id: created.runner_session_id,
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
      provider_session_id: "kiro-session-b",
    });

    expect(updated).toMatchObject({
      runner_session_id: created.runner_session_id,
      provider_session_id: "kiro-session-b",
      created_at: created.created_at,
    });
    expect(updated.updated_at >= created.updated_at).toBe(true);
  });

  it("isolates runtime config options from nested caller mutations", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const inputOptions = {
      model: "gpt-5",
      nested: {
        temperature: 0.2,
      },
    };

    const created = store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      options: inputOptions,
    });
    inputOptions.nested.temperature = 0.8;
    created.options.nested = { temperature: 1 };

    expect(store.getRuntimeConfig("prd-bot").options).toEqual({
      model: "gpt-5",
      nested: {
        temperature: 0.2,
      },
    });
  });

  it("rejects non-json runtime config options", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      options: ["not-object"] as unknown as Record<string, unknown>,
    })).toThrow("options must be an object");

    expect(() => store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      options: {
        unsupported: undefined,
      },
    })).toThrow("options must be JSON-serializable");
  });

  it("rejects non-boolean runtime config stream values", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.upsertRuntimeConfig("prd-bot", {
      provider: "codex",
      stream: "false" as unknown as boolean,
    })).toThrow("stream must be a boolean");
  });

  it("upserts and clears active initialization sessions", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: [],
      generation_in_progress: "soul",
      status: "active",
    });

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: [],
      generation_in_progress: "soul",
      status: "active",
    });
    expect(created.session_id).toMatch(/^init_/);

    const updated = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });

    expect(updated.session_id).toBe(created.session_id);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated).toMatchObject({
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });
    expect(updated.generation_in_progress).toBeUndefined();
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual(updated);

    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "agents",
      soul_answers: ["第一题", "第二题"],
      agents_answers: ["写 PRD"],
      status: "completed",
    });
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toBeUndefined();

    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: [],
      agents_answers: [],
      status: "active",
    });
    store.clearInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toBeUndefined();
  });

  it("does not collide initialization session keys with delimiter-containing ids", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "bot:a", name: "Bot A", runtime: "kiro" });
    store.createBot({ bot_id: "bot", name: "Bot", runtime: "kiro" });

    const first = store.upsertInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
      phase: "soul",
      soul_answers: ["first"],
      agents_answers: [],
      status: "active",
    });
    const second = store.upsertInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
      phase: "agents",
      soul_answers: ["second"],
      agents_answers: ["agent"],
      status: "active",
    });

    expect(second.session_id).not.toBe(first.session_id);
    expect(store.getActiveInitializationSession({
      bot_id: "bot:a",
      wecom_user_id: "user",
      conversation_id: "conv",
    })).toEqual(first);
    expect(store.getActiveInitializationSession({
      bot_id: "bot",
      wecom_user_id: "a:user",
      conversation_id: "conv",
    })).toEqual(second);
  });

  it("isolates initialization session answer arrays from caller and reader mutation", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
      status: "active",
    });

    created.soul_answers.push("外部修改");
    created.agents_answers[0] = "被篡改";

    const fetched = store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });

    expect(fetched).toMatchObject({
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
    });

    fetched?.soul_answers.push("再次修改");
    if (fetched) {
      fetched.agents_answers[0] = "再次篡改";
    }

    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toMatchObject({
      soul_answers: ["第一题"],
      agents_answers: ["写 PRD"],
    });
  });

  it("rejects invalid initialization generation progress when provided", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      phase: "soul",
      soul_answers: [],
      agents_answers: [],
      generation_in_progress: "",
      status: "active",
    } as unknown as Parameters<typeof store.upsertInitializationSession>[0])).toThrow(
      "generation_in_progress is invalid",
    );
  });

  it("stores and confirms pending generated documents", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.createBot({ bot_id: "ops-bot", name: "Ops Bot", runtime: "mock" });

    const created = store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      conversation_id: "conv-a",
      title: "other user",
      content: "not returned",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-b",
    });
    store.createPendingGeneratedDocument({
      bot_id: "ops-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "other bot",
      content: "not returned",
      created_by_bot_id: "ops-bot",
      created_by_user_id: "admin-a",
    });

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      status: "pending",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    expect(created.pending_id).toMatch(/^pending_/);
    expect(store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([created]);

    const confirmed = store.confirmPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      pending_id: created.pending_id,
      status: "confirmed",
    });
    expect(confirmed[0].created_at).toBe(created.created_at);
    expect(confirmed[0].updated_at).not.toBe(created.updated_at);
    expect(store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
    expect(store.confirmPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
  });

  it("rejects pending generated documents without creator fields", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(() => store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0])).toThrow(
      "created_by_bot_id is required",
    );
    expect(() => store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "语音转文字 API PRD",
      content: "# v1",
      created_by_bot_id: "prd-bot",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0])).toThrow(
      "created_by_user_id is required",
    );
  });

  it("generates pending ids instead of accepting caller supplied ids", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createPendingGeneratedDocument({
      pending_id: "pending_client_supplied",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "First PRD",
      content: "# first",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0] & {
      pending_id: string;
    });
    const second = store.createPendingGeneratedDocument({
      pending_id: "pending_client_supplied",
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "Second PRD",
      content: "# second",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    } as Parameters<typeof store.createPendingGeneratedDocument>[0] & {
      pending_id: string;
    });

    expect(first.pending_id).toMatch(/^pending_/);
    expect(second.pending_id).toMatch(/^pending_/);
    expect(first.pending_id).not.toBe("pending_client_supplied");
    expect(second.pending_id).not.toBe("pending_client_supplied");
    expect(second.pending_id).not.toBe(first.pending_id);
    const listed = store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    });
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([first, second]));
  });

  it("creates versioned business documents and rejects bot config document titles", () => {
    const store = createDataStore();

    const document = store.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      content: "# v1",
      visibility: "bot",
      tier: "core",
      tags: ["prd", "asr"],
      created_by_bot_id: "prd-bot",
      created_by_user_id: "user-a",
    });

    expect(document).toMatchObject({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      version: 1,
      tier: "core",
      status: "active",
      tags: ["prd", "asr"],
    });
    expect(store.getBusinessDocument(document.document_id)).toMatchObject({
      document_id: document.document_id,
      version: 1,
      content: "# v1",
    });

    const updated = store.updateBusinessDocument({
      document_id: document.document_id,
      content: "# v2",
      change_summary: "补充计量计费",
    });

    expect(updated).toMatchObject({
      document_id: document.document_id,
      version: 2,
      content: "# v2",
      change_summary: "补充计量计费",
    });
    expect(store.getBusinessDocument(document.document_id, 1)).toMatchObject({
      version: 1,
      content: "# v1",
    });
    expect(store.getBusinessDocument(document.document_id)).toMatchObject({
      version: 2,
      content: "# v2",
    });
    expect(store.listBusinessDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toMatchObject([
      {
        document_id: document.document_id,
        title: "语音转文字 API PRD",
        version: 2,
      },
    ]);

    expect(() => store.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "agents.md",
      doc_type: "config",
      content: "not allowed",
    })).toThrow("bot config documents must use /v1/bot-config-documents");
  });

  it("stores per-Bot rules as ordered configuration and keeps them out of business documents", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "rules",
      content: "只在当前会话目录工作。",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "soul",
      content: "你是 PRD 助手。",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "agents.md",
      content: "按流程工作。",
    });

    expect(store.listBotConfigDocuments("prd-bot").map((document) => document.title)).toEqual([
      "soul",
      "agents.md",
      "rules.md",
    ]);
    expect(() => store.createBusinessDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "rules.md",
      doc_type: "config",
      content: "not allowed",
    })).toThrow("bot config documents must use /v1/bot-config-documents");
  });

  it("atomically applies and confirms pending generated documents exactly once", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/a.md",
      content: "# A",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });
    const second = store.createPendingGeneratedDocument({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      title: "prd/b.md",
      content: "# B",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });

    const applied = store.applyPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    });

    expect(applied).toEqual([
      { pending_id: first.pending_id, title: "prd/a.md", version: 1 },
      { pending_id: second.pending_id, title: "prd/b.md", version: 1 },
    ]);
    expect(store.listPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
    })).toEqual([]);
    expect(store.listBusinessDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "prd/a.md", version: 1 }),
      expect.objectContaining({ title: "prd/b.md", version: 1 }),
    ]));
    expect(store.applyPendingGeneratedDocuments({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "admin-a",
    })).toEqual([]);
  });

  it("stores memory metadata chunks assets and stats", () => {
    const store = createDataStore();

    const memory = store.createMemoryRecord({
      scope: "user",
      owner_id: "user-a",
      content: "用户关注环信 IM 产品和 PRD 质量。",
      tier: "core",
      source_type: "text",
      source_conversation_id: "conv-a",
      source_message_id: "msg-a",
      created_by_bot_id: "prd-bot",
      created_by_user_id: "user-a",
      tags: ["user-profile"],
    });

    expect(memory).toMatchObject({
      scope: "user",
      owner_id: "user-a",
      tier: "core",
      status: "active",
      tags: ["user-profile"],
    });

    const chunks = store.recordChunks({
      source_type: "memory",
      source_id: memory.memory_id,
      scope: "user",
      owner_id: "user-a",
      chunks: [
        {
          content: "用户关注环信 IM 产品。",
          chunk_index: 0,
          heading_path: "profile",
          location: "line:1",
          tier: "core",
        },
        {
          content: "用户关注 PRD 质量。",
          chunk_index: 1,
          heading_path: "profile",
          location: "line:2",
          tier: "core",
        },
      ],
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      source_type: "memory",
      source_id: memory.memory_id,
      scope: "user",
      owner_id: "user-a",
      chunk_index: 0,
    });

    const asset = store.recordAsset({
      source_type: "memory",
      source_id: memory.memory_id,
      filename: "profile.md",
      content_type: "text/markdown",
      storage_uri: "file:///data/profile.md",
      size_bytes: 128,
      content_hash: "hash-profile",
    });

    expect(asset).toMatchObject({
      source_type: "memory",
      source_id: memory.memory_id,
      filename: "profile.md",
      size_bytes: 128,
    });

    expect(store.getMemoryStats({
      scope: "user",
      owner_id: "user-a",
    })).toEqual({
      total_memories: 1,
      total_chunks: 2,
      by_tier: {
        core: 1,
        reference: 0,
        temp: 0,
      },
      disk_usage_bytes: 128,
    });
  });

  it("resetBot clears bot config documents and initialization state", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    store.claimAdmin({ bot_id: "prd-bot", wecom_user_id: "admin-a" });
    store.upsertInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
      phase: "agents",
      selected_role_id: "role-product-manager",
      soul_answers: ["旧 bot", "1"],
      agents_answers: ["interaction_mode=step_by_step"],
      status: "active",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "soul",
      content: "# Soul\n旧内容",
    });
    store.upsertBotConfigDocument({
      bot_id: "prd-bot",
      title: "agents.md",
      content: "# AGENTS\n旧内容",
    });

    const reset = store.resetBot("prd-bot");

    expect(reset.status).toBe("initializing");
    expect(store.listBotConfigDocuments("prd-bot")).toEqual([]);
    expect(store.getActiveInitializationSession({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      conversation_id: "conv-init",
    })).toBeUndefined();
  });

  it("lists and updates bot records", () => {
    const store = createDataStore();
    const prd = store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
    });
    store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "mock",
    });

    expect(store.listBots()).toMatchObject([
      { bot_id: "prd-bot" },
      { bot_id: "ops-bot" },
    ]);

    const updated = store.updateBot("prd-bot", {
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret: "new-secret-value",
    });

    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret_configured: true,
      created_at: prd.created_at,
    });
    expect(JSON.stringify(updated)).not.toContain("new-secret-value");
    expect(updated.updated_at).not.toBe(prd.updated_at);
    expect(store.getBot("prd-bot")).toEqual(updated);
  });

  it("rejects duplicate wecom bot bindings", () => {
    const store = createDataStore();
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    });

    expect(() => store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");

    store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-b",
    });

    expect(() => store.updateBot("ops-bot", {
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");
  });

  it("tests wecom connection configuration without exposing secrets", async () => {
    const store = createDataStore();
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    const configured = await store.testWeComConnection("prd-bot");

    expect(configured).toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(configured.checked_at).toMatch(/T/);
    expect(JSON.stringify(configured)).not.toContain("super-secret-value");

    store.createBot({
      bot_id: "missing-secret",
      name: "Missing Secret",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-b",
    });
    await expect(store.testWeComConnection("missing-secret")).resolves.toMatchObject({
      bot_id: "missing-secret",
      status: "missing_config",
      missing: ["wecom_secret"],
      wecom_secret_configured: false,
    });

    store.createBot({
      bot_id: "missing-bot-id",
      name: "Missing Bot ID",
      runtime: "kiro",
    });
    await expect(store.testWeComConnection("missing-bot-id")).resolves.toMatchObject({
      bot_id: "missing-bot-id",
      status: "missing_config",
      missing: ["wecom_bot_id", "wecom_secret"],
    });
  });

  it("verifies wecom credentials with an injected verifier", async () => {
    const store = createDataStore({
      wecomVerifier: {
        async verify(input) {
          expect(input).toEqual({
            bot_id: "wecom-bot-a",
            secret: "super-secret-value",
          });
          return { verified: true };
        },
      },
    });
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    await expect(store.testWeComConnection("prd-bot")).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "verified",
      missing: [],
    });
  });

  it("stores failed wecom verification without exposing secrets", async () => {
    const store = createDataStore({
      wecomVerifier: {
        async verify() {
          return { verified: false, error: "auth failed" };
        },
      },
    });
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    const result = await store.testWeComConnection("prd-bot");

    expect(result).toMatchObject({
      bot_id: "prd-bot",
      status: "failed",
      error: "auth failed",
    });
    expect(store.getBot("prd-bot")).toMatchObject({
      wecom_connection_status: "failed",
      last_wecom_error: "auth failed",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("creates claim code and verifies admin claim without storing plain code", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "admin_unclaimed",
    });

    const claim = store.createAdminClaim("prd-bot");
    expect(claim.code).toMatch(/^[0-9]{6}$/);
    expect(claim.code_hash).not.toBe(claim.code);
    expect(new Date(claim.expires_at).getTime() - new Date(claim.created_at).getTime())
      .toBe(ADMIN_CLAIM_TTL_MS);

    expect(() => store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: "000000",
    })).toThrow("invalid admin claim code");

    const admin = store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    expect(admin).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      role: "admin",
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "initializing",
      is_admin: true,
      conversation: {
        purpose: "init",
      },
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "initialization_required",
      is_admin: false,
    });

    store.markBotReady("prd-bot");
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "ready",
      is_admin: false,
    });
  });

  it("refreshes admin claim codes by replacing the pending code", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createAdminClaim("prd-bot");
    const second = store.createAdminClaim("prd-bot");

    expect(second.code).toMatch(/^[0-9]{6}$/);
    expect(second.code_hash).not.toBe(first.code_hash);
    expect(() => store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: first.code,
    })).toThrow("invalid admin claim code");
    expect(store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: second.code,
    })).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
    });
  });

  it("gets and transfers bot admin", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = store.createAdminClaim("prd-bot");
    const admin = store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });

    expect(store.getAdmin("prd-bot")).toEqual(admin);

    const transferred = store.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "admin-a",
      new_wecom_user_id: "admin-b",
    });

    expect(transferred).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      role: "admin",
    });
    expect(store.getAdmin("prd-bot")).toEqual(transferred);
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: false,
      reason: "initialization_required",
      is_admin: false,
    });
    expect(store.resolveMessageContext({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toMatchObject({
      allowed: true,
      reason: "initializing",
      is_admin: true,
    });
  });

  it("rejects admin transfer from non-current admins", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = store.createAdminClaim("prd-bot");
    store.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });

    expect(() => store.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "user-a",
      new_wecom_user_id: "admin-b",
    })).toThrow("current admin does not match");
    expect(store.getAdmin("prd-bot")).toMatchObject({
      wecom_user_id: "admin-a",
    });
  });

  it("resolves the same conversation for the same bot user channel and purpose", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    const second = store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });

    expect(second).toEqual(first);
    expect(first.conversation_id).toMatch(/^conv_/);
  });

  it("creates and switches between multiple conversations for the same scope", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.createConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
      display_name: "第一轮",
    });
    const second = store.createConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
      display_name: "第二轮",
    });

    expect(second.conversation_id).not.toBe(first.conversation_id);
    expect(first.sequence_no).toBe(1);
    expect(second.sequence_no).toBe(2);
    const beforeOpen = store.listConversations({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    expect(beforeOpen.map((conversation) => conversation.display_name)).toEqual([
      "第二轮",
      "第一轮",
    ]);
    expect(beforeOpen.map((conversation) => conversation.sequence_no)).toEqual([2, 1]);
    expect(store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    }).conversation_id).toBe(second.conversation_id);

    const opened = store.openConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      conversation_id: first.conversation_id,
    });

    expect(opened.conversation_id).toBe(first.conversation_id);
    expect(opened.sequence_no).toBe(1);
    expect(opened.is_active).toBe(true);
    const afterOpen = store.listConversations({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    expect(afterOpen.map((conversation) => conversation.sequence_no)).toEqual([2, 1]);
    expect(afterOpen.find((conversation) => conversation.sequence_no === 1)?.is_active).toBe(true);
    expect(afterOpen.find((conversation) => conversation.sequence_no === 2)?.is_active).toBe(false);
    expect(store.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    }).conversation_id).toBe(first.conversation_id);
  });

  it("creates a new memory document version on update", () => {
    const store = createDataStore();
    const first = store.upsertMemoryDocument({
      scope: "shared",
      owner_id: "platform",
      title: "Product Context",
      content: "v1",
    });
    const second = store.upsertMemoryDocument({
      memory_doc_id: first.memory_doc_id,
      scope: "shared",
      owner_id: "platform",
      title: "Product Context",
      content: "v2",
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.memory_doc_id).toBe(first.memory_doc_id);
    expect(store.listMemoryDocumentVersions(first.memory_doc_id)).toEqual([
      first,
      second,
    ]);
  });

  it("lists only current memory document versions for a scope owner", () => {
    const store = createDataStore();
    const guideline = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v1",
    });
    const currentGuideline = store.upsertMemoryDocument({
      memory_doc_id: guideline.memory_doc_id,
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v2",
    });
    const processDoc = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-process",
      content: "agent docs",
    });
    store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "other-bot",
      title: "prd-guideline",
      content: "other",
    });

    expect(store.listCurrentMemoryDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual([currentGuideline, processDoc]);
  });

  it("stores updates deletes and orders global documents", () => {
    const store = createDataStore();

    const playground = store.upsertGlobalDocument({
      title: "Playground",
      slug: "playground",
      content: "# Playground",
      enabled: true,
      sort_order: 20,
    });
    const safety = store.upsertGlobalDocument({
      title: "Safety",
      slug: "safety",
      content: "# Safety",
      enabled: false,
      sort_order: 10,
    });

    expect(store.listGlobalDocuments({ includeDisabled: true }).map((doc) => doc.slug)).toEqual([
      "safety",
      "playground",
    ]);
    expect(store.listGlobalDocuments().map((doc) => doc.slug)).toEqual(["playground"]);

    const updatedPlayground = store.upsertGlobalDocument({
      document_id: playground.document_id,
      title: "Playground Updated",
      slug: "playground",
      content: "# Playground v2",
      enabled: true,
      sort_order: 5,
    });

    expect(updatedPlayground.document_id).toBe(playground.document_id);
    expect(updatedPlayground.created_at).toBe(playground.created_at);
    expect(updatedPlayground.updated_at).not.toBe(playground.updated_at);
    expect(store.listGlobalDocuments({ includeDisabled: true }).map((doc) => doc.slug)).toEqual([
      "playground",
      "safety",
    ]);

    store.deleteGlobalDocument(safety.document_id);
    expect(store.listGlobalDocuments({ includeDisabled: true })).toEqual([
      updatedPlayground,
    ]);
  });

  it("rejects duplicate global document slugs when updating by explicit id", () => {
    const store = createDataStore();
    const playground = store.upsertGlobalDocument({
      title: "Playground",
      slug: "playground",
      content: "# Playground",
    });
    store.upsertGlobalDocument({
      title: "Safety",
      slug: "safety",
      content: "# Safety",
    });

    expect(() => store.upsertGlobalDocument({
      document_id: playground.document_id,
      title: "Playground",
      slug: "safety",
      content: "# Playground",
    })).toThrow("global document slug already exists: safety");
  });

  it("rejects stale explicit ids for global document upserts", () => {
    const store = createDataStore();

    expect(() => store.upsertGlobalDocument({
      document_id: "global_doc_missing",
      title: "Playground",
      slug: "playground",
      content: "# Playground",
    })).toThrow("global document not found: global_doc_missing");
  });

  it("seeds the five standard roles with documents and question sets", () => {
    const store = createDataStore();

    seedDefaultRoleConfig(store);

    expect(store.listRoles().map((role) => role.name)).toEqual([
      "产品经理",
      "测试工程师",
      "研发工程师",
      "市场人员",
      "运营人员",
    ]);

    const productManager = store.listRoles().find((role) => role.slug === "product-manager");
    expect(productManager).toBeDefined();

    const documents = store.listRoleDocuments(productManager!.role_id);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.title).toBe("role.md");
    expect(String(documents[0]?.content ?? "")).toContain("角色定位");
    expect(String(documents[0]?.content ?? "")).toContain("PRD 功能点清单");
    expect(String(documents[0]?.content ?? "")).toContain("优先级");
    expect(String(documents[0]?.content ?? "")).toContain("P0/P1/P2");

    const questions = store.listRoleQuestions(productManager!.role_id);
    expect(questions.length).toBeGreaterThanOrEqual(5);
    expect(questions.map((question) => question.title)).toContain("你希望它用什么方式和你交互？");
  });

  it("resets bot and role data but preserves playground", () => {
    const store = createDataStore();
    seedDefaultRoleConfig(store);
    const playgroundBefore = store.listGlobalDocuments().find((doc) => doc.slug === "playground");

    store.createBot({ bot_id: "bot-1", name: "old bot", runtime: "kiro" });
    store.resetToStandardRoleConfig();

    expect(store.listBots()).toEqual([]);
    expect(store.listRoles().map((role) => role.name)).toEqual([
      "产品经理",
      "测试工程师",
      "研发工程师",
      "市场人员",
      "运营人员",
    ]);
    expect(store.listGlobalDocuments().find((doc) => doc.slug === "playground")?.document_id).toBe(
      playgroundBefore?.document_id,
    );
  });

  it("seeds best-practice question sets for each standard role", () => {
    const store = createDataStore();
    seedDefaultRoleConfig(store);

    const rolesBySlug = new Map(store.listRoles().map((role) => [role.slug, role]));

    const qaQuestions = store.listRoleQuestions(rolesBySlug.get("qa-engineer")!.role_id);
    expect(qaQuestions.map((question) => question.title)).toContain("默认输出更偏向哪类内容？");
    expect(
      qaQuestions.flatMap((question) => question.options_json.map((option) => option.label)),
    ).toContain("测试用例");

    const engineeringDocument = store.listRoleDocuments(rolesBySlug.get("engineer")!.role_id)[0];
    expect(engineeringDocument.content).toContain("兼容性");
    expect(engineeringDocument.content).toContain("回滚");
  });

  it("stores roles with enabled filtering and sort order", () => {
    const store = createDataStore();

    const productManager = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
      enabled: true,
      sort_order: 20,
    });
    const architect = store.upsertRole({
      name: "架构师助手",
      slug: "architect",
      description: "架构师角色",
      enabled: false,
      sort_order: 10,
    });

    expect(store.listRoles({ includeDisabled: true }).map((role) => role.slug)).toEqual([
      "architect",
      "product-manager",
    ]);
    expect(store.listRoles().map((role) => role.slug)).toEqual(["product-manager"]);

    const updatedRole = store.upsertRole({
      role_id: productManager.role_id,
      name: "高级产品经理助手",
      slug: "product-manager",
      description: "高级产品经理角色",
      enabled: true,
      sort_order: 5,
    });

    expect(updatedRole.role_id).toBe(productManager.role_id);
    expect(updatedRole.created_at).toBe(productManager.created_at);
    expect(updatedRole.updated_at).not.toBe(productManager.updated_at);
    expect(store.listRoles({ includeDisabled: true }).map((role) => role.slug)).toEqual([
      "product-manager",
      "architect",
    ]);

    store.deleteRole(architect.role_id);
    expect(store.listRoles({ includeDisabled: true })).toEqual([updatedRole]);
  });

  it("rejects duplicate role slugs when updating by explicit id", () => {
    const store = createDataStore();
    const productManager = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });
    store.upsertRole({
      name: "架构师助手",
      slug: "architect",
      description: "架构师角色",
    });

    expect(() => store.upsertRole({
      role_id: productManager.role_id,
      name: "产品经理助手",
      slug: "architect",
      description: "产品经理角色",
    })).toThrow("role slug already exists: architect");
  });

  it("rejects stale explicit ids for role upserts", () => {
    const store = createDataStore();

    expect(() => store.upsertRole({
      role_id: "role_missing",
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    })).toThrow("role not found: role_missing");
  });

  it("stores role documents and role questions with enabled filtering cleanup and sort order", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
      enabled: true,
      sort_order: 10,
    });

    const roleDoc = store.upsertRoleDocument({
      role_id: role.role_id,
      title: "role.md",
      content: "# Role",
      enabled: true,
    });
    const disabledRoleDoc = store.upsertRoleDocument({
      role_id: role.role_id,
      title: "constraints.md",
      content: "# Constraints",
      enabled: false,
    });

    expect(store.listRoleDocuments(role.role_id).map((doc) => doc.title)).toEqual(["role.md"]);
    expect(store.listRoleDocuments(role.role_id, { includeDisabled: true }).map((doc) => doc.title))
      .toEqual(["role.md", "constraints.md"]);

    const updatedRoleDoc = store.upsertRoleDocument({
      role_document_id: roleDoc.role_document_id,
      role_id: role.role_id,
      title: "role.md",
      content: "# Role v2",
      enabled: true,
    });

    expect(updatedRoleDoc.role_document_id).toBe(roleDoc.role_document_id);
    expect(updatedRoleDoc.created_at).toBe(roleDoc.created_at);
    expect(updatedRoleDoc.updated_at).not.toBe(roleDoc.updated_at);

    const laterQuestion = store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "delivery_style",
      title: "你希望它如何输出结果？",
      question_type: "single_choice",
      options_json: [{ value: "structured", label: "结构化" }],
      required: true,
      enabled: true,
      sort_order: 20,
    });
    const firstQuestion = store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "interaction_mode",
      title: "你希望它用什么方式和你交互？",
      description: "用于决定后续问题是否需要细化",
      question_type: "single_choice",
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
      required: true,
      enabled: true,
      sort_order: 10,
    });
    const disabledQuestion = store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "tool_preference",
      title: "是否偏好特定工具？",
      description: "只有逐句引导模式下才继续追问",
      question_type: "free_text",
      depends_on_json: [{ key: "interaction_mode", equals: "step_by_step" }],
      required: false,
      enabled: false,
      sort_order: 5,
    });

    expect(firstQuestion).toMatchObject({
      description: "用于决定后续问题是否需要细化",
      question_type: "single_choice",
      depends_on_json: [],
    });
    expect(disabledQuestion).toMatchObject({
      description: "只有逐句引导模式下才继续追问",
      question_type: "free_text",
      options_json: [],
      depends_on_json: [{ key: "interaction_mode", equals: "step_by_step" }],
    });

    expect(store.listRoleQuestions(role.role_id).map((question) => question.key)).toEqual([
      "interaction_mode",
      "delivery_style",
    ]);
    expect(
      store.listRoleQuestions(role.role_id, { includeDisabled: true }).map((question) => ({
        key: question.key,
        description: question.description,
        question_type: question.question_type,
        depends_on_json: question.depends_on_json,
      })),
    ).toEqual([
      {
        key: "tool_preference",
        description: "只有逐句引导模式下才继续追问",
        question_type: "free_text",
        depends_on_json: [{ key: "interaction_mode", equals: "step_by_step" }],
      },
      {
        key: "interaction_mode",
        description: "用于决定后续问题是否需要细化",
        question_type: "single_choice",
        depends_on_json: [],
      },
      {
        key: "delivery_style",
        description: "",
        question_type: "single_choice",
        depends_on_json: [],
      },
    ]);

    const updatedQuestion = store.upsertRoleQuestion({
      question_id: laterQuestion.question_id,
      role_id: role.role_id,
      key: "delivery_style",
      title: "你希望它如何呈现结果？",
      description: "用于控制输出格式偏好",
      question_type: "single_choice",
      options_json: [{ value: "structured", label: "结构化" }],
      depends_on_json: [{ key: "interaction_mode", equals: "step_by_step" }],
      required: true,
      enabled: true,
      sort_order: 15,
    });

    expect(updatedQuestion.question_id).toBe(laterQuestion.question_id);
    expect(updatedQuestion.created_at).toBe(laterQuestion.created_at);
    expect(updatedQuestion.updated_at).not.toBe(laterQuestion.updated_at);
    expect(updatedQuestion).toMatchObject({
      description: "用于控制输出格式偏好",
      question_type: "single_choice",
      depends_on_json: [{ key: "interaction_mode", equals: "step_by_step" }],
    });
    expect(store.listRoleQuestions(role.role_id).map((question) => question.key)).toEqual([
      "interaction_mode",
      "delivery_style",
    ]);

    store.deleteRoleDocument(disabledRoleDoc.role_document_id);
    expect(store.listRoleDocuments(role.role_id, { includeDisabled: true })).toEqual([
      updatedRoleDoc,
    ]);

    store.deleteRoleQuestion(disabledQuestion.question_id);
    expect(
      store.listRoleQuestions(role.role_id, { includeDisabled: true }).map((question) =>
        question.key
      ),
    ).toEqual(["interaction_mode", "delivery_style"]);

    store.deleteRole(role.role_id);
    expect(store.listRoleDocuments(role.role_id, { includeDisabled: true })).toEqual([]);
    expect(store.listRoleQuestions(role.role_id, { includeDisabled: true })).toEqual([]);
    expect(firstQuestion.question_id).toMatch(/^question_/);
  });

  it("rejects duplicate role document titles when updating by explicit id", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });
    const roleDoc = store.upsertRoleDocument({
      role_id: role.role_id,
      title: "role.md",
      content: "# Role",
    });
    store.upsertRoleDocument({
      role_id: role.role_id,
      title: "constraints.md",
      content: "# Constraints",
    });

    expect(() => store.upsertRoleDocument({
      role_document_id: roleDoc.role_document_id,
      role_id: role.role_id,
      title: "constraints.md",
      content: "# Role",
    })).toThrow(
      `role document already exists for role ${role.role_id} and title constraints.md`,
    );
  });

  it("rejects stale explicit ids for role document upserts", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });

    expect(() => store.upsertRoleDocument({
      role_document_id: "role_doc_missing",
      role_id: role.role_id,
      title: "role.md",
      content: "# Role",
    })).toThrow("role document not found: role_doc_missing");
  });

  it("rejects duplicate role question keys when updating by explicit id", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });
    const interactionMode = store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "interaction_mode",
      title: "你希望它用什么方式和你交互？",
      question_type: "single_choice",
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
    });
    store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "delivery_style",
      title: "你希望它如何输出结果？",
      question_type: "single_choice",
      options_json: [{ value: "structured", label: "结构化" }],
    });

    expect(() => store.upsertRoleQuestion({
      question_id: interactionMode.question_id,
      role_id: role.role_id,
      key: "delivery_style",
      title: "你希望它用什么方式和你交互？",
      question_type: "single_choice",
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
    })).toThrow(
      `role question already exists for role ${role.role_id} and key delivery_style`,
    );
  });

  it("rejects stale explicit ids for role question upserts", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });

    expect(() => store.upsertRoleQuestion({
      question_id: "question_missing",
      role_id: role.role_id,
      key: "interaction_mode",
      title: "你希望它用什么方式和你交互？",
      question_type: "single_choice",
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
    })).toThrow("role question not found: question_missing");
  });

  it("isolates role question arrays from caller and reader mutation", () => {
    const store = createDataStore();
    const role = store.upsertRole({
      name: "产品经理助手",
      slug: "product-manager",
      description: "产品经理角色",
    });
    const inputOptions = [{ value: "step_by_step", label: "逐句引导" }];
    const inputDependencies = [{ key: "delivery_style", equals: "structured" }];

    const created = store.upsertRoleQuestion({
      role_id: role.role_id,
      key: "interaction_mode",
      title: "你希望它用什么方式和你交互？",
      question_type: "single_choice",
      options_json: inputOptions,
      depends_on_json: inputDependencies,
    });

    inputOptions[0].label = "已修改";
    inputDependencies[0].equals = "changed";
    created.options_json[0].label = "返回值已修改";
    created.depends_on_json[0].equals = "returned";

    const listed = store.listRoleQuestions(role.role_id, { includeDisabled: true });
    expect(listed[0]).toMatchObject({
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
      depends_on_json: [{ key: "delivery_style", equals: "structured" }],
    });

    listed[0].options_json[0].label = "列表返回值已修改";
    listed[0].depends_on_json[0].equals = "listed";

    expect(store.listRoleQuestions(role.role_id, { includeDisabled: true })[0]).toMatchObject({
      options_json: [{ value: "step_by_step", label: "逐句引导" }],
      depends_on_json: [{ key: "delivery_style", equals: "structured" }],
    });
  });

  it("gets default bot runtime policy and updates it", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const created = store.getOrCreateBotRuntimePolicy("prd-bot");
    const updated = store.updateBotRuntimePolicy("prd-bot", {
      skill_install_policy: "open",
    });

    expect(created).toMatchObject({
      bot_id: "prd-bot",
      skill_install_policy: "admin_only",
      mcp_manage_policy: "admin_only",
    });
    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      skill_install_policy: "open",
      mcp_manage_policy: "admin_only",
    });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
  });

  it("upserts lists and deletes bot env vars without exposing ciphertext", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const saved = store.upsertBotEnvVar("prd-bot", {
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v1",
      updated_by_wecom_user_id: "admin-a",
    });

    expect(saved).toMatchObject({
      bot_id: "prd-bot",
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v1",
      is_set: true,
      updated_by_wecom_user_id: "admin-a",
    });

    const listed = store.listBotEnvVars("prd-bot");
    expect(listed).toEqual([
      {
        bot_id: "prd-bot",
        key: "OPENAI_API_KEY",
        is_set: true,
        updated_at: saved.updated_at,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("ciphertext-v1");

    const updated = store.upsertBotEnvVar("prd-bot", {
      key: "OPENAI_API_KEY",
      value_ciphertext: "ciphertext-v2",
      updated_by_wecom_user_id: "admin-b",
    });
    expect(updated.updated_at).not.toBe(saved.updated_at);
    expect(store.listBotEnvVars("prd-bot")).toEqual([
      {
        bot_id: "prd-bot",
        key: "OPENAI_API_KEY",
        is_set: true,
        updated_at: updated.updated_at,
      },
    ]);

    store.deleteBotEnvVar("prd-bot", "OPENAI_API_KEY");
    expect(store.listBotEnvVars("prd-bot")).toEqual([]);
  });

  it("isolates user runtime env vars and keeps ciphertext out of metadata", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const saved = store.upsertUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      key: "HIM22187_AUTH_TOKEN",
      value_ciphertext: "ciphertext-user-a",
    });
    store.upsertUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-b",
      key: "HIM22187_AUTH_TOKEN",
      value_ciphertext: "ciphertext-user-b",
    });

    expect(store.listUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" })).toEqual([
      {
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        key: "HIM22187_AUTH_TOKEN",
        is_set: true,
        updated_at: saved.updated_at,
      },
    ]);
    expect(JSON.stringify(store.listUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" })))
      .not.toContain("ciphertext-user-a");
    expect(store.getUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-b" }))
      .toMatchObject([{ value_ciphertext: "ciphertext-user-b" }]);

    store.deleteUserEnvVar({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      key: "HIM22187_AUTH_TOKEN",
    });
    expect(store.getUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-a" })).toEqual([]);
    expect(store.getUserEnvVars({ bot_id: "prd-bot", wecom_user_id: "user-b" })).toHaveLength(1);
  });

  it("upserts lists and deletes bot skills", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.upsertBotSkill("prd-bot", {
      name: "repo-analyzer",
      source_type: "github",
      source_ref: "https://github.com/acme/repo-analyzer",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const second = store.upsertBotSkill("prd-bot", {
      name: "prompt-linter",
      source_type: "builtin",
      source_ref: "builtin:prompt-linter",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });

    expect(store.listBotSkills("prd-bot").map((skill) => skill.name)).toEqual([
      "prompt-linter",
      "repo-analyzer",
    ]);

    const updated = store.upsertBotSkill("prd-bot", {
      name: "repo-analyzer",
      source_type: "url",
      source_ref: "https://example.com/repo-analyzer.tgz",
      status: "failed",
      installed_by_wecom_user_id: "admin-b",
      last_error: "network timeout",
    });
    expect(updated.skill_id).toBe(first.skill_id);
    expect(updated.installed_at).not.toBe(first.installed_at);
    expect(store.listBotSkills("prd-bot")[0]).toMatchObject({
      name: "repo-analyzer",
      source_type: "url",
      status: "failed",
      last_error: "network timeout",
    });

    store.deleteBotSkill("prd-bot", "prompt-linter");
    expect(store.listBotSkills("prd-bot").map((skill) => skill.name)).toEqual([
      "repo-analyzer",
    ]);
    expect(second.skill_id).toMatch(/^skill_/);
  });

  it("upserts lists and deletes bot mcps", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.upsertBotMcp("prd-bot", {
      name: "search-mcp",
      mode: "config",
      source_ref: "http://localhost:9300",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });
    const second = store.upsertBotMcp("prd-bot", {
      name: "filesystem-mcp",
      mode: "package",
      source_ref: "@acme/filesystem-mcp",
      status: "installed",
      installed_by_wecom_user_id: "admin-a",
    });

    expect(store.listBotMcps("prd-bot").map((mcp) => mcp.name)).toEqual([
      "filesystem-mcp",
      "search-mcp",
    ]);

    const updated = store.upsertBotMcp("prd-bot", {
      name: "search-mcp",
      mode: "package",
      source_ref: "@acme/search-mcp",
      status: "failed",
      installed_by_wecom_user_id: "admin-b",
      last_error: "install failed",
    });
    expect(updated.mcp_id).toBe(first.mcp_id);
    expect(updated.installed_at).not.toBe(first.installed_at);
    expect(store.listBotMcps("prd-bot")[0]).toMatchObject({
      name: "search-mcp",
      mode: "package",
      status: "failed",
      last_error: "install failed",
    });

    store.deleteBotMcp("prd-bot", "filesystem-mcp");
    expect(store.listBotMcps("prd-bot").map((mcp) => mcp.name)).toEqual([
      "search-mcp",
    ]);
    expect(second.mcp_id).toMatch(/^mcp_/);
  });

  it("appends and lists bot capability audit logs newest first", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });

    const first = store.appendBotCapabilityAuditLog({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      display_name: "Alice",
      action_type: "env_set",
      target_name: "OPENAI_API_KEY",
      result: "success",
    });
    const second = store.appendBotCapabilityAuditLog({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
      action_type: "skill_install",
      target_name: "repo-analyzer",
      source_ref: "https://github.com/acme/repo-analyzer",
      result: "failed",
      error_message: "network timeout",
    });

    expect(first.log_id).toMatch(/^cap_audit_/);
    expect(store.listBotCapabilityAuditLogs("prd-bot")).toEqual([
      second,
      first,
    ]);
  });

  it("stores user credentials by bot user and provider and consumes binding tokens once", () => {
    const store = createDataStore();
    store.createBot({ bot_id: "jira-bot", name: "Jira Bot", runtime: "kiro" });
    const binding = store.createUserCredentialBinding({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      provider: "easemob_jira",
    });

    const metadata = store.completeUserCredentialBinding({
      token: binding.token,
      payload_ciphertext: "encrypted-payload-a",
    });
    expect(metadata).toMatchObject({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      provider: "easemob_jira",
      is_bound: true,
    });
    expect(store.getUserCredential({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      provider: "easemob_jira",
    })?.payload_ciphertext).toBe("encrypted-payload-a");
    expect(store.getUserCredentialMetadata({
      bot_id: "jira-bot",
      wecom_user_id: "user-b",
      provider: "easemob_jira",
    })).toBeUndefined();
    expect(() => store.createUserCredentialBinding({
      bot_id: "jira-bot",
      wecom_user_id: "user-a",
      provider: "easemob_jira",
    })).toThrow("already bound");
    expect(() => store.completeUserCredentialBinding({
      token: binding.token,
      payload_ciphertext: "second-value",
    })).toThrow("invalid or expired");
  });
});
