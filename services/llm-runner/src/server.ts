import { parseChatRequest, type ChatResponse } from "@my-agent-toolkit/contracts";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import {
  callMcpTool,
  fetchMcpToolManifest,
  formatMcpToolResult,
  injectMcpPromptSection,
  parseMcpToolCallRequest,
  type McpToolResult,
} from "./mcpClient.js";
import { getRuntimeStatuses } from "./runtimeStatus.js";
import {
  RuntimeExecutionError,
  buildRunnerSessionId,
  runCliRuntime,
  runCliRuntimeStream,
  runMockRuntime,
  runMockRuntimeStream,
  type RuntimeResult,
  type RuntimeStreamResult,
} from "./runtimes.js";
import { redactText } from "./redact.js";

export interface LlmRunnerServer {
  fetch(request: Request): Promise<Response>;
}

export function createLlmRunnerServer(
  config: RunnerConfig = loadRunnerConfig(),
): LlmRunnerServer {
  const sessionLocks = createSessionLocks();
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(healthResponse("llm-runner"));
      }

      if (request.method === "GET" && url.pathname === "/v1/runtimes") {
        return jsonResponse({
          runtimes: await getRuntimeStatuses(config),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/chat") {
        return handleChat(request, config, sessionLocks);
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/stream") {
        return handleChatStream(request, config, sessionLocks);
      }

      if (request.method === "POST" && url.pathname === "/v1/runs/cancel") {
        return handleRuntimeCancellation(request, config);
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleRuntimeCancellation(
  request: Request,
  config: RunnerConfig,
): Promise<Response> {
  try {
    const payload = await request.json() as {
      bot_id?: unknown;
      user_id?: unknown;
      conversation_id?: unknown;
      runtime?: unknown;
    };
    const botId = requireCancellationText(payload.bot_id, "bot_id", 128);
    const userId = requireCancellationText(payload.user_id, "user_id", 256);
    const conversationId = requireCancellationText(payload.conversation_id, "conversation_id", 128);
    if (payload.runtime !== "kiro") {
      return jsonResponse({ cancelled: false });
    }
    if (!config.kiro_relay_cancel_url) {
      return jsonResponse({ error: "kiro relay cancellation is not configured" }, 503);
    }
    const response = await fetchWithConfig(config, new Request(config.kiro_relay_cancel_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.kiro_relay_auth_token
          ? { authorization: `Bearer ${config.kiro_relay_auth_token}` }
          : {}),
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: userId,
        conversation_id: conversationId,
      }),
    }));
    const result = await response.json() as { cancelled?: unknown; error?: unknown };
    if (!response.ok) {
      return jsonResponse({
        error: typeof result.error === "string" ? result.error : "kiro relay cancellation failed",
      }, response.status);
    }
    return jsonResponse({ cancelled: result.cancelled === true });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "invalid cancellation request",
    }, 400);
  }
}

function requireCancellationText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function healthResponse(service: string): {
  service: string;
  status: "ok";
  git_sha: string;
  build_time: string;
} {
  return {
    service,
    status: "ok",
    git_sha: process.env.APP_BUILD_SHA ?? "unknown",
    build_time: process.env.APP_BUILD_TIME ?? "unknown",
  };
}

async function handleChatStream(
  request: Request,
  config: RunnerConfig,
  sessionLocks: RuntimeSessionLocks,
): Promise<Response> {
  let releaseSessionLock: (() => void) | undefined;
  try {
    const chatRequest = parseChatRequest(await request.json());
    const runtimeRequest = await enrichChatRequest(config, chatRequest);
    releaseSessionLock = await acquireRuntimeSessionLock(sessionLocks, runtimeRequest);
    const runtimeResult = await runRuntimeStreamResolved(config, runtimeRequest);
    const runId = `run_${crypto.randomUUID()}`;
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(ndjsonLine({
            type: "run",
            run_id: runId,
            runner_session_id: runtimeResult.runner_session_id,
          })));

          try {
            // Buffer one runtime turn before forwarding it. This keeps an MCP
            // protocol block private even when MCP is temporarily misconfigured.
            const finalOutput = await continueAfterMcpToolCallsStream(
              config,
              chatRequest,
              runtimeResult,
            );
            enqueueChunk(controller, encoder, finalOutput);
            controller.enqueue(encoder.encode(ndjsonLine({ type: "done" })));
            controller.close();
          } catch (error) {
            controller.enqueue(encoder.encode(ndjsonLine(runtimeStreamErrorPayload(error))));
            controller.close();
          } finally {
            releaseSessionLock?.();
          }
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        },
      },
    );
  } catch (error) {
    releaseSessionLock?.();
    if (error instanceof UnavailableRuntimeError) {
      return jsonResponse({ error: error.message }, 501);
    }
    return jsonResponse(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  }
}

async function collectRuntimeStream(stream: ReadableStream<string>): Promise<string> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  return chunks.join("");
}

function enqueueChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  controller.enqueue(encoder.encode(ndjsonLine({
    type: "chunk",
    content: redactText(value),
  })));
}

async function handleChat(
  request: Request,
  config: RunnerConfig,
  sessionLocks: RuntimeSessionLocks,
): Promise<Response> {
  let releaseSessionLock: (() => void) | undefined;
  try {
    const chatRequest = parseChatRequest(await request.json());
    const runtimeRequest = await enrichChatRequest(config, chatRequest);
    releaseSessionLock = await acquireRuntimeSessionLock(sessionLocks, runtimeRequest);
    const runtimeResult = await runRuntime(config, runtimeRequest);
    const finalResult = await continueAfterMcpToolCalls(config, chatRequest, runtimeResult);
    const response: ChatResponse = {
      run_id: `run_${crypto.randomUUID()}`,
      runner_session_id: finalResult.runner_session_id,
      output: redactText(finalResult.output),
    };

    return jsonResponse(response);
  } catch (error) {
    if (error instanceof UnavailableRuntimeError) {
      return jsonResponse({ error: error.message }, 501);
    }

    if (error instanceof RuntimeExecutionError) {
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    }

    return jsonResponse(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  } finally {
    releaseSessionLock?.();
  }
}

async function continueAfterMcpToolCalls(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runtimeResult: RuntimeResult,
): Promise<RuntimeResult> {
  if (!config.mcp) {
    return replaceUnavailableMcpCall(runtimeResult);
  }
  let currentResult = runtimeResult;
  for (let round = 0; round < getMaxMcpToolRounds(config); round += 1) {
    const completedOutput = outputAfterMcpToolCall(currentResult.output);
    if (completedOutput) {
      return { ...currentResult, output: completedOutput };
    }
    const toolRequest = parseMcpToolCallRequest(currentResult.output);
    if (toolRequest.status === "none") {
      if (containsMcpProtocolMarkup(currentResult.output)) {
        currentResult = await runRuntime(config, {
          ...chatRequest,
          prompt: invalidMcpMarkupFeedback(),
        });
        continue;
      }
      return currentResult;
    }
    if (toolRequest.status === "call" && toolRequest.call.tool === "project.publish") {
      return {
        ...currentResult,
        output: formatProjectPublishOutcome(
          await executeMcpToolCallResult(config, chatRequest, toolRequest.call),
        ),
      };
    }
    currentResult = await runRuntime(config, {
      ...chatRequest,
      prompt: await resolveMcpToolResult(config, chatRequest, toolRequest),
    });
  }
  const finalResult = await runRuntime(config, {
    ...chatRequest,
    prompt: formatMcpToolResult({
      ok: false,
      error: {
        code: "tool_call_limit_reached",
        message: "The runner reached the MCP tool-call limit. Do not call more tools; provide the best available answer now.",
      },
    }),
  });
  return withoutLeakedMcpToolCall(finalResult);
}

async function continueAfterMcpToolCallsStream(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runtimeResult: RuntimeStreamResult,
): Promise<string> {
  if (!config.mcp) {
    return replaceUnavailableMcpCallOutput(await collectRuntimeStream(runtimeResult.stream));
  }
  let currentResult = runtimeResult;
  for (let round = 0; round < getMaxMcpToolRounds(config); round += 1) {
    const output = await collectRuntimeStream(currentResult.stream);
    const completedOutput = outputAfterMcpToolCall(output);
    if (completedOutput) {
      return completedOutput;
    }
    const toolRequest = parseMcpToolCallRequest(output);
    if (toolRequest.status === "none") {
      if (containsMcpProtocolMarkup(output)) {
        currentResult = await runRuntimeStreamResolved(config, {
          ...chatRequest,
          prompt: invalidMcpMarkupFeedback(),
        });
        continue;
      }
      return output;
    }
    if (toolRequest.status === "call" && toolRequest.call.tool === "project.publish") {
      return formatProjectPublishOutcome(
        await executeMcpToolCallResult(config, chatRequest, toolRequest.call),
      );
    }
    currentResult = await runRuntimeStreamResolved(config, {
      ...chatRequest,
      prompt: await resolveMcpToolResult(config, chatRequest, toolRequest),
    });
  }
  const finalResult = await runRuntimeStreamResolved(config, {
    ...chatRequest,
    prompt: formatMcpToolResult({
      ok: false,
      error: {
        code: "tool_call_limit_reached",
        message: "The runner reached the MCP tool-call limit. Do not call more tools; provide the best available answer now.",
      },
    }),
  });
  return withoutLeakedMcpToolCallOutput(
    await collectRuntimeStream(finalResult.stream),
  );
}

function outputAfterMcpToolCall(output: string): string | undefined {
  const matches = [...output.matchAll(/<mcp_tool_call>\s*[\s\S]*?\s*<\/mcp_tool_call>/g)];
  if (matches.length !== 1) {
    return undefined;
  }
  const match = matches[0];
  const trailingOutput = output.slice((match.index ?? 0) + match[0].length).trim();
  return trailingOutput || undefined;
}

function replaceUnavailableMcpCall(runtimeResult: RuntimeResult): RuntimeResult {
  return {
    ...runtimeResult,
    output: replaceUnavailableMcpCallOutput(runtimeResult.output),
  };
}

function replaceUnavailableMcpCallOutput(output: string): string {
  return parseMcpToolCallRequest(output).status === "none" && !containsMcpProtocolMarkup(output)
    ? output
    : "项目工具当前未正确配置，任务尚未执行。请联系管理员检查 MCP Runner 配置。";
}

function getMaxMcpToolRounds(config: RunnerConfig): number {
  return config.mcp?.max_tool_rounds ?? 4;
}

function withoutLeakedMcpToolCall(result: RuntimeResult): RuntimeResult {
  return {
    ...result,
    output: withoutLeakedMcpToolCallOutput(result.output),
  };
}

function withoutLeakedMcpToolCallOutput(output: string): string {
  return parseMcpToolCallRequest(output).status === "none" && !containsMcpProtocolMarkup(output)
    ? output
    : "当前任务需要的工具调用次数过多，已停止继续调用。请缩小问题范围后重试。";
}

function containsMcpProtocolMarkup(output: string): boolean {
  return /<\/?mcp_tool_(?:call|result)\b/i.test(output);
}

function invalidMcpMarkupFeedback(): string {
  return formatMcpToolResult({
    ok: false,
    error: {
      code: "invalid_mcp_result_markup",
      message: [
        "You emitted fabricated MCP result markup, so no tool was executed.",
        "Do not write a result attribute or claim success.",
        "Retry with exactly one real request block:",
        '<mcp_tool_call>{"tool":"project.publish","input":{"project_key":"...","branch":"bot/meaningful-task-name","commit_message":"..."}}</mcp_tool_call>',
      ].join(" "),
    },
  });
}

async function resolveMcpToolResult(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  toolRequest: ReturnType<typeof parseMcpToolCallRequest>,
): Promise<string> {
  if (toolRequest.status === "call") {
    return executeMcpToolCall(config, chatRequest, toolRequest.call);
  }
  if (toolRequest.status === "error") {
    return formatMcpToolResult(toolRequest.result);
  }
  throw new Error("MCP tool result requested without a tool call");
}

interface RuntimeSessionRecord {
  runner_session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  runtime: string;
  provider_session_id?: string;
}

async function executeMcpToolCall(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  toolCall: { tool: string; input: unknown },
): Promise<string> {
  return formatMcpToolResult(await executeMcpToolCallResult(config, chatRequest, toolCall));
}

async function executeMcpToolCallResult(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  toolCall: { tool: string; input: unknown },
): Promise<McpToolResult> {
  if (!config.mcp) {
    return {
      ok: false,
      error: "mcp is not configured",
    };
  }
  try {
    return await callMcpTool({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    }, toolCall);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "mcp tool call failed",
    };
  }
}

function formatProjectPublishOutcome(toolResult: McpToolResult): string {
  if (!toolResult.ok || !toolResult.result || typeof toolResult.result !== "object") {
    return `提交和 Push 失败：${mcpErrorMessage(toolResult.error)}`;
  }
  const result = toolResult.result as Record<string, unknown>;
  const branch = typeof result.branch === "string" ? result.branch : "";
  const commit = typeof result.commit === "string" ? result.commit : "";
  const changedPaths = Array.isArray(result.changed_paths)
    ? result.changed_paths.filter((item): item is string => typeof item === "string")
    : [];
  const githubUrl = typeof result.github_url === "string" ? result.github_url : "";
  if (!branch || !/^[0-9a-f]{40}$/i.test(commit) || changedPaths.length === 0) {
    return "提交和 Push 失败：project.publish 返回了无效结果。";
  }
  return [
    "提交并 Push 成功。",
    `- 分支：${branch}`,
    `- Commit：${commit}`,
    `- 变更文件：${changedPaths.join("、")}`,
    ...(githubUrl ? [`- GitHub：${githubUrl}`] : []),
  ].join("\n");
}

function mcpErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  }
  return "project.publish 未成功执行。";
}

async function enrichChatRequest(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<ReturnType<typeof parseChatRequest>> {
  if (!config.mcp) {
    return chatRequest;
  }
  try {
    const trustedContext = {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    } as const;
    const manifest = await fetchMcpToolManifest({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, trustedContext);
    const projectResult = chatRequest.runtime === "kiro"
      && manifest.tools.some((tool) => tool.name === "project.ensure")
      ? await callMcpTool({
        ...config.mcp,
        ...(config.fetch ? { fetch: config.fetch } : {}),
      }, trustedContext, {
        tool: "project.ensure",
        input: {},
      })
      : undefined;
    const modelManifest = {
      ...manifest,
      tools: manifest.tools.filter((tool) => tool.name !== "project.ensure"),
    };
    const prompt = projectResult?.ok
      ? injectPreparedProjectContext(chatRequest.prompt, projectResult.result)
      : chatRequest.prompt;
    return {
      ...chatRequest,
      prompt: injectMcpPromptSection(prompt, modelManifest),
    };
  } catch {
    return chatRequest;
  }
}

function injectPreparedProjectContext(prompt: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prompt;
  const result = value as Record<string, unknown>;
  const projectKey = typeof result.project_key === "string" ? result.project_key : "";
  const path = typeof result.path === "string" ? result.path : "";
  const branch = typeof result.branch === "string" ? result.branch : "";
  const baseCommit = typeof result.base_commit === "string" ? result.base_commit : "";
  if (!projectKey || !path || !branch || !/^[0-9a-f]{40}$/i.test(baseCommit)) return prompt;
  return [
    "<project_context>",
    `The runner already prepared the current user's ${projectKey} repository.`,
    `Project root: ${path}`,
    `Current branch: ${branch}`,
    `Current commit: ${baseCommit}`,
    "Use native CLI file, search, edit, Git status, Python, and test commands only inside this project root.",
    "Do not call project.ensure, clone another repository, scan parent directories, or infer a host path.",
    "</project_context>",
    "",
    prompt,
  ].join("\n");
}

async function runRuntime(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<RuntimeResult> {
  if (!config.enabled_runtimes.includes(chatRequest.runtime)) {
    throw new UnavailableRuntimeError("runtime is not available yet");
  }

  if (chatRequest.runtime === "mock") {
    return runMockRuntime(chatRequest);
  }

  if (chatRequest.runtime === "kiro" && config.kiro) {
    const runtimeSession = await getPersistedRuntimeSession(config, chatRequest);
    const runtimeResult = await runCliRuntime(
      {
        ...(await withBotEnv(config, chatRequest)),
        ...(runtimeSession?.provider_session_id
          ? { provider_session_id: runtimeSession.provider_session_id }
          : {}),
      },
      chatRequest,
    );
    await persistRuntimeSession(
      config,
      chatRequest,
      runtimeResult.runner_session_id,
      runtimeResult.provider_session_id,
    );
    return runtimeResult;
  }

  throw new UnavailableRuntimeError("runtime is not available yet");
}

function runRuntimeStream(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): RuntimeStreamResult {
  if (!config.enabled_runtimes.includes(chatRequest.runtime)) {
    throw new UnavailableRuntimeError("runtime is not available yet");
  }

  if (chatRequest.runtime === "mock") {
    return runMockRuntimeStream(chatRequest);
  }

  if (chatRequest.runtime === "kiro" && config.kiro) {
    throw new Error("stream runtime requires env-enriched path");
  }

  throw new UnavailableRuntimeError("runtime is not available yet");
}

async function runRuntimeStreamResolved(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<RuntimeStreamResult> {
  if (!config.enabled_runtimes.includes(chatRequest.runtime)) {
    throw new UnavailableRuntimeError("runtime is not available yet");
  }

  if (chatRequest.runtime === "mock") {
    return runMockRuntimeStream(chatRequest);
  }

  if (chatRequest.runtime === "kiro" && config.kiro) {
    const runtimeSession = await getPersistedRuntimeSession(config, chatRequest);
    const runtimeResult = runCliRuntimeStream(
      {
        ...(await withBotEnv(config, chatRequest)),
        ...(runtimeSession?.provider_session_id
          ? { provider_session_id: runtimeSession.provider_session_id }
          : {}),
      },
      chatRequest,
    );
    return persistRuntimeSessionAfterStream(config, chatRequest, runtimeResult);
  }

  throw new UnavailableRuntimeError("runtime is not available yet");
}

async function withBotEnv(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
) {
  const botEnv = config.resolveBotEnvVars
    ? await config.resolveBotEnvVars(chatRequest.bot_id)
    : {};
  const userEnv = config.resolveUserEnvVars
    ? await config.resolveUserEnvVars(chatRequest.bot_id, chatRequest.user_id)
    : await resolveUserCredentialEnv(config, chatRequest.bot_id, chatRequest.user_id);
  const projectEnv = await resolveProjectRuntimeEnv(config, chatRequest.bot_id);
  return {
    ...config.kiro!,
    env: {
      ...(config.kiro?.env ?? {}),
      ...botEnv,
      ...userEnv,
      ...projectEnv,
      KIRO_RELAY_BOT_ID: chatRequest.bot_id,
      KIRO_RELAY_USER_ID: chatRequest.user_id,
      KIRO_RELAY_CONVERSATION_ID: chatRequest.conversation_id,
    },
  };
}

async function resolveProjectRuntimeEnv(
  config: RunnerConfig,
  botId: string,
): Promise<Record<string, string>> {
  if (!config.data_service_url || !config.credential_internal_token) return {};
  const response = await fetchWithConfig(config, new Request(
    `${config.data_service_url}/internal/bots/${encodeURIComponent(botId)}/project-env`,
    { headers: { authorization: `Bearer ${config.credential_internal_token}` } },
  ));
  const payload = await response.json().catch(() => undefined) as
    | { configured?: boolean; content?: string; error?: string }
    | undefined;
  if (!response.ok) throw new Error(payload?.error ?? "project environment lookup failed");
  if (payload?.configured !== true) return {};
  if (typeof payload.content !== "string" || payload.content.trim() === "") {
    throw new Error("configured project environment is empty");
  }
  return {
    ...parseProjectDotenv(payload.content),
    MY_AGENT_PROJECT_DOTENV_B64: Buffer.from(payload.content, "utf8").toString("base64"),
  };
}

function parseProjectDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`project .env line ${index + 1} is invalid`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

async function resolveUserCredentialEnv(
  config: RunnerConfig,
  botId: string,
  userId: string,
): Promise<Record<string, string>> {
  if (!config.data_service_url || !config.credential_internal_token) {
    return {};
  }
  const query = new URLSearchParams({
    bot_id: botId,
    wecom_user_id: userId,
    provider: "easemob_jira",
  });
  const response = await fetchWithConfig(config, new Request(
    `${config.data_service_url}/internal/user-credentials/runtime-env?${query}`,
    {
      headers: {
        authorization: `Bearer ${config.credential_internal_token}`,
      },
    },
  ));
  const payload = await response.json().catch(() => undefined) as
    | { env?: Record<string, unknown>; error?: string }
    | undefined;
  if (!response.ok) {
    throw new Error(payload?.error ?? "user credential lookup failed");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload?.env ?? {})) {
    if (isAllowedUserCredentialEnvKey(key) && typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function isAllowedUserCredentialEnvKey(key: string): boolean {
  return [
    "EASEMOB_JIRA_USERNAME",
    "EASEMOB_JIRA_PASSWORD",
    "EASEMOB_JIRA_REDIRECT_USERNAME",
    "EASEMOB_JIRA_REDIRECT_PASSWORD",
    "MY_AGENT_JIRA_CREDENTIAL_VERSION",
  ].includes(key);
}

async function getPersistedRuntimeSession(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<RuntimeSessionRecord | undefined> {
  if (!config.data_service_url) {
    return undefined;
  }

  const runnerSessionId = buildRunnerSessionId(chatRequest.runtime, chatRequest);
  const response = await fetchWithConfig(config, new Request(
    `${config.data_service_url}/internal/runtime-sessions/${encodeURIComponent(runnerSessionId)}`,
  ));
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error("runtime session lookup failed");
  }
  return await response.json() as RuntimeSessionRecord;
}

async function persistRuntimeSession(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runnerSessionId: string,
  providerSessionId?: string,
): Promise<void> {
  if (!config.data_service_url) {
    return;
  }
  if (chatRequest.runtime === "kiro" && !providerSessionId) {
    throw new RuntimeExecutionError(
      "runtime_session_error",
      502,
      "kiro runtime did not provide a session id",
    );
  }

  const response = await fetchWithConfig(config, new Request(
    `${config.data_service_url}/internal/runtime-sessions`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runner_session_id: runnerSessionId,
        bot_id: chatRequest.bot_id,
        wecom_user_id: chatRequest.user_id,
        conversation_id: chatRequest.conversation_id,
        runtime: chatRequest.runtime,
        ...(providerSessionId
          ? { provider_session_id: providerSessionId }
          : {}),
      }),
    },
  ));
  if (!response.ok) {
    throw new Error("runtime session persistence failed");
  }
}

function persistRuntimeSessionAfterStream(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runtimeResult: RuntimeStreamResult,
): RuntimeStreamResult {
  return {
    runner_session_id: runtimeResult.runner_session_id,
    provider_session_id: runtimeResult.provider_session_id,
    stream: new ReadableStream<string>({
      async start(controller) {
        const reader = runtimeResult.stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          }
          const providerSessionId = await runtimeResult.provider_session_id;
          await persistRuntimeSession(
            config,
            chatRequest,
            runtimeResult.runner_session_id,
            providerSessionId,
          );
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
  };
}

interface RuntimeSessionLocks {
  acquire(key: string): Promise<() => void>;
}

function createSessionLocks(): RuntimeSessionLocks {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(key) {
      const previous = tails.get(key) ?? Promise.resolve();
      let releaseTicket!: () => void;
      const ticket = new Promise<void>((resolve) => {
        releaseTicket = resolve;
      });
      const tail = previous.then(() => ticket);
      tails.set(key, tail);
      await previous;

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        releaseTicket();
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      };
    },
  };
}

async function acquireRuntimeSessionLock(
  sessionLocks: RuntimeSessionLocks,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<() => void> {
  if (chatRequest.runtime !== "kiro") {
    return () => {};
  }
  return sessionLocks.acquire([
    chatRequest.runtime,
    chatRequest.bot_id,
    chatRequest.user_id,
  ].join(":"));
}

async function fetchWithConfig(config: RunnerConfig, request: Request): Promise<Response> {
  return config.fetch ? config.fetch(request) : fetch(request);
}

function ndjsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function runtimeStreamErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof RuntimeExecutionError) {
    return {
      type: "error",
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    type: "error",
    error: error instanceof Error ? error.message : "runtime stream failed",
  };
}

class UnavailableRuntimeError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
