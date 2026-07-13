import { parseChatRequest, type ChatResponse } from "@my-agent-toolkit/contracts";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import {
  callMcpTool,
  fetchMcpToolManifest,
  formatMcpToolResult,
  injectMcpPromptSection,
  parseMcpToolCallRequest,
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

      return jsonResponse({ error: "not found" }, 404);
    },
  };
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
            if (!config.mcp) {
              await pipeRuntimeStream(runtimeResult.stream, controller, encoder);
              controller.enqueue(encoder.encode(ndjsonLine({ type: "done" })));
              controller.close();
              return;
            }
            const firstOutput = await collectRuntimeStream(runtimeResult.stream);
            const toolRequest = parseMcpToolCallRequest(firstOutput);
            if (toolRequest.status === "none") {
              enqueueChunk(controller, encoder, firstOutput);
            } else {
              const toolResult = toolRequest.status === "call"
                ? await executeMcpToolCall(config, chatRequest, toolRequest.call)
                : formatMcpToolResult(toolRequest.result);
              const secondRuntimeResult = await runRuntimeStreamResolved(config, {
                ...chatRequest,
                prompt: toolResult,
              });
              await pipeRuntimeStream(secondRuntimeResult.stream, controller, encoder);
            }
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

async function pipeRuntimeStream(
  stream: ReadableStream<string>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    enqueueChunk(controller, encoder, value);
  }
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
    const finalResult = await continueAfterMcpToolCall(config, chatRequest, runtimeResult);
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

async function continueAfterMcpToolCall(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runtimeResult: RuntimeResult,
): Promise<RuntimeResult> {
  if (!config.mcp) {
    return runtimeResult;
  }
  const toolRequest = parseMcpToolCallRequest(runtimeResult.output);
  if (toolRequest.status === "none") {
    return runtimeResult;
  }
  const toolResult = toolRequest.status === "call"
    ? await executeMcpToolCall(config, chatRequest, toolRequest.call)
    : formatMcpToolResult(toolRequest.result);
  return runRuntime(config, {
    ...chatRequest,
    prompt: toolResult,
  });
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
  if (!config.mcp) {
    return formatMcpToolResult({
      ok: false,
      error: "mcp is not configured",
    });
  }
  try {
    const result = await callMcpTool({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    }, toolCall);
    return formatMcpToolResult(result);
  } catch (error) {
    return formatMcpToolResult({
      ok: false,
      error: error instanceof Error ? error.message : "mcp tool call failed",
    });
  }
}

async function enrichChatRequest(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<ReturnType<typeof parseChatRequest>> {
  if (!config.mcp) {
    return chatRequest;
  }
  try {
    const manifest = await fetchMcpToolManifest({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    });
    return {
      ...chatRequest,
      prompt: injectMcpPromptSection(chatRequest.prompt, manifest),
    };
  } catch {
    return chatRequest;
  }
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
  return {
    ...config.kiro!,
    env: {
      ...(config.kiro?.env ?? {}),
      ...botEnv,
    },
  };
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
  return sessionLocks.acquire(buildRunnerSessionId(chatRequest.runtime, chatRequest));
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
