import type { IncomingWeComMessage, WeComClient } from "./wecomClient.js";

export interface BotHostConfig {
  dataServiceUrl: string;
  llmRunnerUrl: string;
  logServiceUrl?: string;
  fetch: typeof fetch;
}

export interface BotHostServer {
  fetch(request: Request): Promise<Response>;
}

export interface BotHostWorker {
  start(): Promise<void>;
  stop(): void;
  sync?(): Promise<void>;
  restartInitialization?(input: {
    botId: string;
    adminWeComUserId: string;
  }): Promise<RestartInitializationResult>;
}

export interface RestartInitializationResult {
  bot_id: string;
  admin_wecom_user_id: string;
  output: string;
}

export interface BotHostServerConfig extends BotHostConfig {
  initializationController?: {
    restartInitialization(input: {
      botId: string;
      adminWeComUserId: string;
    }): Promise<RestartInitializationResult>;
  };
  runtimeController?: {
    sync(): Promise<void>;
  };
}

export interface BotHostWorkerConfig extends BotHostConfig {
  botId: string;
  runtime: "mock" | "kiro";
  wecomClient: WeComClient;
}

export interface WeComRuntimeBotConfig {
  bot_id: string;
  runtime: "mock" | "kiro";
  wecom_bot_id: string;
  wecom_secret: string;
}

export interface BotHostSupervisorConfig extends BotHostConfig {
  pollIntervalMs: number;
  createWeComClient(input: {
    botId: string;
    secret: string;
  }): WeComClient;
}

interface WeComMessageInput {
  bot_id: string;
  wecom_user_id: string;
  text: string;
  runtime: "mock" | "kiro";
}

interface MemoryDocument {
  memory_doc_id?: string;
  title: string;
  version?: number;
  content: string;
}

interface ScopedMemoryDocument extends MemoryDocument {
  scope: string;
  owner_id: string;
}

interface ProcessedOutput {
  visibleOutput: string;
  configDocuments: ConfigDocument[];
}

interface ConfigDocument {
  title: "soul" | "agents.md";
  content: string;
}

interface WizardState {
  answers: string[];
}

const wizardStatesByConfig = new WeakMap<BotHostConfig, Map<string, WizardState>>();
const MISSING_GENERATED_DOCUMENTS_MESSAGE = "初始化文档生成失败：没有生成 soul 和 agents.md。请回复“确认”重新生成，或说明需要修改的配置。";
const INVALID_RUNTIME_OUTPUT_MESSAGE = "LLM 运行器没有生成有效回复，请稍后重试或检查 runtime 配置。";
const WECOM_STREAM_REFRESH_INTERVAL_MS = 500;

export function createBotHostServer(config: BotHostServerConfig): BotHostServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "bot-host",
          status: "ok",
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/wecom") {
        return handleWeComMessage(request, config);
      }

      if (request.method === "POST" && url.pathname === "/internal/wecom-runtime/sync") {
        if (!config.runtimeController) {
          return jsonResponse({ error: "runtime controller is not configured" }, 503);
        }
        try {
          await config.runtimeController.sync();
          return jsonResponse({ synced: true });
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : "failed to sync runtime",
          }, 500);
        }
      }

      const restartInitializationMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/initialization\/restart$/,
      );
      if (request.method === "POST" && restartInitializationMatch) {
        if (!config.initializationController) {
          return jsonResponse({ error: "initialization controller is not configured" }, 503);
        }
        try {
          const body = await request.json() as { admin_wecom_user_id?: unknown };
          const adminWeComUserId = requireText(
            body.admin_wecom_user_id,
            "admin_wecom_user_id",
          );
          return jsonResponse(
            await config.initializationController.restartInitialization({
              botId: restartInitializationMatch[1],
              adminWeComUserId,
            }),
          );
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : "failed to restart initialization",
          }, 400);
        }
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

export function createBotHostWorker(config: BotHostWorkerConfig): BotHostWorker {
  const restartInitialization = async (input: {
    botId: string;
    adminWeComUserId: string;
  }): Promise<RestartInitializationResult> => {
    if (input.botId !== config.botId) {
      throw new Error(`bot worker not found: ${input.botId}`);
    }
    const messageInput = {
      bot_id: config.botId,
      wecom_user_id: input.adminWeComUserId,
      text: "",
      runtime: config.runtime,
    };
    resetWizardStateForUser(messageInput, config);
    let conversationId: string | undefined;
    try {
      const context = await resolveMessageContext(config, messageInput);
      conversationId = context.conversation?.conversation_id;
    } catch (_error) {
      conversationId = undefined;
    }
    const output = startInitializationWizard(messageInput, config, conversationId);
    await config.wecomClient.sendText(input.adminWeComUserId, output, { forceActive: true });
    return {
      bot_id: config.botId,
      admin_wecom_user_id: input.adminWeComUserId,
      output,
    };
  };

  const onMessage = async (message: IncomingWeComMessage) => {
    let result: Record<string, unknown>;
    try {
      const messageInput = {
        bot_id: config.botId,
        wecom_user_id: message.userId,
        text: message.text,
        runtime: config.runtime,
      };
      if (await shouldHandleWizardConfirmationAsync(config, messageInput)) {
        await config.wecomClient.sendText(
          message.conversationId,
          "配置已确认，正在生成 soul.md 和 agents.md。完成后我会主动通知你。",
        );
        void processWeComMessage(messageInput, config)
          .then(async (asyncResult) => {
            if ("output" in asyncResult && typeof asyncResult.output === "string") {
              await config.wecomClient.sendText(message.conversationId, asyncResult.output);
            }
          })
          .catch(async (error) => {
            console.error("[wecom] async initialization failed", error);
            await config.wecomClient.sendText(
              message.conversationId,
              "初始化文档生成失败，请稍后重试或在 WebUI 重置引导。",
            );
          });
        return;
      }
      if (await shouldStreamReply(config, messageInput)) {
        await config.wecomClient.sendText(message.conversationId, "正在思考...", {
          finish: false,
        });
        await streamAllowedWeComMessage(messageInput, config, message.conversationId);
        return;
      }
      result = await processWeComMessage(
        messageInput,
        config,
      );
    } catch (error) {
      await config.wecomClient.sendText(
        message.conversationId,
        "机器人处理失败，请稍后重试。",
      );
      return;
    }

    if ("output" in result && typeof result.output === "string") {
      await config.wecomClient.sendText(message.conversationId, result.output);
      return;
    }
    if ("claim_failed" in result && result.claim_failed) {
      await config.wecomClient.sendText(
        message.conversationId,
        "管理员认领失败，请确认验证码是否正确或是否过期。",
      );
      return;
    }
    if ("blocked" in result && result.blocked) {
      await config.wecomClient.sendText(
        message.conversationId,
        blockedReply(result.reason),
      );
      return;
    }
    if ("claimed" in result && result.claimed) {
      await config.wecomClient.sendText(message.conversationId, "管理员认领成功，开始初始化。");
      return;
    }
    if ("ready" in result && result.ready) {
      await config.wecomClient.sendText(message.conversationId, "机器人已启用。");
    }
  };

  return {
    async start() {
      config.wecomClient.onMessage(onMessage);
      await config.wecomClient.connect();
    },
    stop() {
      config.wecomClient.disconnect();
    },
    restartInitialization,
  };
}

async function shouldHandleWizardConfirmationAsync(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<boolean> {
  if (!isConfirmAnswer(input.text)) {
    return false;
  }
  try {
    const context = await resolveMessageContext(config, input);
    if (!context.allowed || context.reason !== "initializing" || !context.conversation?.conversation_id) {
      return false;
    }
    const state = getWizardStates(config).get(wizardKey(input, context.conversation.conversation_id));
    return Boolean(state && state.answers.length >= WIZARD_FIELDS.length);
  } catch (_error) {
    return false;
  }
}

async function shouldStreamReply(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<boolean> {
  if (parseClaimAdminCommand(input.text) || isMarkReadyCommand(input.text)) {
    return false;
  }

  try {
    const context = await resolveMessageContext(config, input);
    return context.allowed && context.reason === "ready";
  } catch (_error) {
    return false;
  }
}

export function createBotHostSupervisor(
  config: BotHostSupervisorConfig,
): BotHostWorker {
  const workers = new Map<string, {
    signature: string;
    worker: BotHostWorker;
  }>();
  let timer: NodeJS.Timeout | undefined;
  let syncInFlight = false;
  let stopped = false;

  const sync = async () => {
    if (syncInFlight || stopped) {
      return;
    }
    syncInFlight = true;
    try {
      const runtimeBots = await getJson<WeComRuntimeBotConfig[]>(
        config,
        `${config.dataServiceUrl}/internal/wecom-runtime/bots`,
      );
      const activeBotIds = new Set(runtimeBots.map((bot) => bot.bot_id));

      for (const [botId, entry] of workers.entries()) {
        if (!activeBotIds.has(botId)) {
          entry.worker.stop();
          workers.delete(botId);
          console.info("[wecom-supervisor] stopped bot worker", { botId });
        }
      }

      for (const bot of runtimeBots) {
        if (!isSupportedRuntime(bot.runtime)) {
          console.warn("[wecom-supervisor] skipped unsupported runtime", {
            botId: bot.bot_id,
            runtime: bot.runtime,
          });
          continue;
        }

        const signature = [
          bot.runtime,
          bot.wecom_bot_id,
          bot.wecom_secret,
        ].join(":");
        const existing = workers.get(bot.bot_id);
        if (existing?.signature === signature) {
          continue;
        }
        existing?.worker.stop();

        const worker = createBotHostWorker({
          ...config,
          botId: bot.bot_id,
          runtime: bot.runtime,
          wecomClient: config.createWeComClient({
            botId: bot.wecom_bot_id,
            secret: bot.wecom_secret,
          }),
        });
        workers.set(bot.bot_id, { signature, worker });
        await worker.start();
        console.info("[wecom-supervisor] started bot worker", {
          botId: bot.bot_id,
          runtime: bot.runtime,
          wecomBotId: bot.wecom_bot_id,
        });
      }
    } catch (error) {
      console.error("[wecom-supervisor] sync failed", error);
    } finally {
      syncInFlight = false;
    }
  };

  return {
    async start() {
      stopped = false;
      await sync();
      timer = setInterval(() => {
        void sync();
      }, config.pollIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const entry of workers.values()) {
        entry.worker.stop();
      }
      workers.clear();
    },
    async sync() {
      await sync();
    },
    async restartInitialization(input) {
      await sync();
      const worker = workers.get(input.botId)?.worker;
      if (!worker?.restartInitialization) {
        throw new Error(`bot worker not found: ${input.botId}`);
      }
      return worker.restartInitialization(input);
    },
  };
}

async function handleWeComMessage(
  request: Request,
  config: BotHostConfig,
): Promise<Response> {
  try {
    const input = parseWeComMessageInput(await request.json());
    const result = await processWeComMessage(input, config);
    return jsonResponse(
      result,
      "blocked" in result && result.blocked || "claim_failed" in result && result.claim_failed
        ? 403
        : 200,
    );
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  }
}

async function processWeComMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
): Promise<Record<string, unknown>> {
    const claimCode = parseClaimAdminCommand(input.text);
    if (claimCode) {
      try {
        const admin = await postJson<{
          bot_id: string;
          wecom_user_id: string;
        }>(
          config,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(input.bot_id)}/admin/claim/verify`,
          {
            wecom_user_id: input.wecom_user_id,
            code: claimCode,
          },
        );

        return {
          claimed: true,
          bot_id: admin.bot_id,
          wecom_user_id: admin.wecom_user_id,
          status: "initializing",
          output: startInitializationWizard(input, config),
        };
      } catch (error) {
        return {
          claim_failed: true,
          bot_id: input.bot_id,
          wecom_user_id: input.wecom_user_id,
          reason: error instanceof Error ? error.message : "invalid admin claim",
        };
      }
    }

    if (isMarkReadyCommand(input.text)) {
      const context = await resolveMessageContext(config, input);
      if (!context.allowed || !context.is_admin) {
        return {
          blocked: true,
          reason: context.reason,
        };
      }

      const ready = await postJson<{
        bot_id: string;
        status: string;
      }>(
        config,
        `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(input.bot_id)}/ready`,
        undefined,
      );

      return {
        ready: true,
        bot_id: ready.bot_id,
        status: ready.status,
      };
    }

    const context = await resolveMessageContext(config, input);

    if (!context.allowed) {
      return {
        blocked: true,
        reason: context.reason,
      };
    }

    if (!context.conversation?.conversation_id) {
      throw new Error("conversation_id is required");
    }

    if (context.reason === "initializing") {
      return handleWizardMessage(input, config, context.conversation.conversation_id);
    }

    return processAllowedWeComMessage(
      input,
      config,
      context.conversation.conversation_id,
    );
}

function buildPrompt(
  text: string,
  memoryDocuments: ScopedMemoryDocument[],
): string {
  if (memoryDocuments.length === 0) {
    return text;
  }

  return [
    "<memory>",
    ...memoryDocuments.flatMap((document) => [
      document.version === undefined
        ? `[${document.scope}/${document.owner_id}] ${document.title}`
        : `[${document.scope}/${document.owner_id} v${document.version}] ${document.title}`,
      document.content,
    ]),
    "</memory>",
    "",
    "<message>",
    text,
    "</message>",
  ].join("\n");
}

function startInitializationWizard(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId?: string,
): string {
  getWizardStates(config).set(wizardKey(input, conversationId), { answers: [] });
  return [
    "管理员认领成功，开始初始化。",
    "",
    WIZARD_QUESTIONS[0],
  ].join("\n");
}

async function handleWizardMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const key = wizardKey(input, conversationId);
  const wizardStates = getWizardStates(config);
  const state = wizardStates.get(key) ?? { answers: [] };
  const normalized = normalizeWizardAnswer(input.text);

  if (state.answers.length < WIZARD_FIELDS.length) {
    state.answers.push(normalized);
    wizardStates.set(key, state);
    const output = state.answers.length < WIZARD_FIELDS.length
      ? WIZARD_QUESTIONS[state.answers.length]
      : buildWizardConfirmation(state.answers);
    return { conversation_id: conversationId, output };
  }

  if (!isConfirmAnswer(normalized)) {
    applyWizardConfirmationEdits(state.answers, normalized);
    wizardStates.set(key, state);
    return {
      conversation_id: conversationId,
      output: buildWizardConfirmation(state.answers),
    };
  }

  const result = await processAllowedWeComMessage(
    {
      ...input,
      text: buildWizardGenerationPrompt(state.answers),
    },
    config,
    conversationId,
  );
  if (result.ready) {
    wizardStates.delete(key);
    return result;
  }

  if (result.output === MISSING_GENERATED_DOCUMENTS_MESSAGE) {
    const fallback = await initializeFromWizardAnswers(config, input, state.answers);
    wizardStates.delete(key);
    return {
      conversation_id: conversationId,
      run_id: result.run_id,
      output: fallback.visibleOutput,
      initialized: true,
      ready: true,
      status: "ready",
    };
  }
  return result;
}

function wizardKey(input: WeComMessageInput, conversationId?: string): string {
  return `${input.bot_id}:${input.wecom_user_id}:${conversationId ?? "pending"}`;
}

function resetWizardStateForUser(input: WeComMessageInput, config: BotHostConfig): void {
  const prefix = `${input.bot_id}:${input.wecom_user_id}:`;
  const wizardStates = getWizardStates(config);
  for (const key of wizardStates.keys()) {
    if (key.startsWith(prefix)) {
      wizardStates.delete(key);
    }
  }
}

function getWizardStates(config: BotHostConfig): Map<string, WizardState> {
  const existing = wizardStatesByConfig.get(config);
  if (existing) {
    return existing;
  }
  const created = new Map<string, WizardState>();
  wizardStatesByConfig.set(config, created);
  return created;
}

async function processAllowedWeComMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId?: string,
): Promise<{
  conversation_id: string;
  run_id: string;
  output: string;
  initialized?: boolean;
  ready?: boolean;
  status?: string;
}> {
  const resolvedConversationId = conversationId ?? await resolveAllowedConversationId(config, input);
  const memoryDocuments = await listPromptMemoryDocuments(
    config,
    input,
    resolvedConversationId,
  );
  const prompt = buildPrompt(input.text, memoryDocuments);

  const result = await postJson<{
    run_id: string;
    output: string;
  }>(config, `${config.llmRunnerUrl}/v1/chat`, {
    bot_id: input.bot_id,
    user_id: input.wecom_user_id,
    conversation_id: resolvedConversationId,
    runtime: input.runtime,
    prompt,
  });

  const processed = await processAssistantOutput(config, input, result.output);
  const output = selectVisibleAssistantOutput(input.text, result.output, processed);
  await recordChatEvent(
    config,
    input,
    resolvedConversationId,
    { ...result, output },
    memoryDocuments,
  );

  return {
    conversation_id: resolvedConversationId,
    run_id: result.run_id,
    output,
    ...(processed.configDocuments.length === 2
      ? {
        initialized: true,
        ready: true,
        status: "ready",
      }
      : {}),
  };
}

async function streamAllowedWeComMessage(
  input: WeComMessageInput,
  config: BotHostWorkerConfig,
  wecomConversationId: string,
): Promise<void> {
  const resolvedConversationId = await resolveAllowedConversationId(config, input);
  const memoryDocuments = await listPromptMemoryDocuments(
    config,
    input,
    resolvedConversationId,
  );
  const prompt = buildPrompt(input.text, memoryDocuments);
  const response = await config.fetch(
    new Request(`${config.llmRunnerUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: input.bot_id,
        user_id: input.wecom_user_id,
        conversation_id: resolvedConversationId,
        runtime: input.runtime,
        prompt,
      }),
    }),
  );
  if (!response.ok || !response.body) {
    throw new Error("llm stream failed");
  }

  let runId = `stream_${crypto.randomUUID()}`;
  let output = "";
  let sentAnyChunk = false;
  const presentationStream = createCoalescedPresentationStream(
    config.wecomClient,
    wecomConversationId,
  );
  for await (const event of readNdjsonEvents(response.body)) {
    if (event.type === "run") {
      runId = typeof event.run_id === "string" ? event.run_id : runId;
      continue;
    }
    if (event.type === "chunk" && typeof event.content === "string") {
      const content = cleanupRuntimeStreamChunk(event.content);
      if (!content) {
        continue;
      }
      output += content;
      if (isPromptEchoOutput(output)) {
        output = INVALID_RUNTIME_OUTPUT_MESSAGE;
        await config.wecomClient.sendText(wecomConversationId, output, { finish: true });
        await recordChatEvent(
          config,
          input,
          resolvedConversationId,
          { run_id: runId, output },
          memoryDocuments,
        );
        return;
      }
      sentAnyChunk = true;
      presentationStream.push(output);
      continue;
    }
    if (event.type === "error") {
      throw new Error(typeof event.error === "string" ? event.error : "llm stream failed");
    }
    if (event.type === "done") {
      break;
    }
  }

  const finalOutput = sentAnyChunk ? output : INVALID_RUNTIME_OUTPUT_MESSAGE;
  await presentationStream.finish();
  await config.wecomClient.sendText(wecomConversationId, finalOutput, { finish: true });
  await recordChatEvent(
    config,
    input,
    resolvedConversationId,
    { run_id: runId, output: finalOutput },
    memoryDocuments,
  );
}

async function* readNdjsonEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        yield JSON.parse(trimmed) as Record<string, unknown>;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield JSON.parse(buffer.trim()) as Record<string, unknown>;
  }
}

function cleanupRuntimeStreamChunk(content: string): string {
  return content
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^>\s*/, "");
}

function createCoalescedPresentationStream(
  wecomClient: WeComClient,
  conversationId: string,
): {
  push(text: string): void;
  finish(): Promise<void>;
} {
  let latestText: string | undefined;
  let lastSentText: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let activeSend = Promise.resolve();
  let finishing = false;

  const clearRefreshTimer = () => {
    if (!refreshTimer) {
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const scheduleRefresh = () => {
    if (finishing || refreshTimer) {
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const text = latestText;
      if (finishing || text === undefined || text === lastSentText) {
        return;
      }
      lastSentText = text;
      activeSend = activeSend.then(() => wecomClient.sendText(conversationId, text, { finish: false }));
      if (latestText !== lastSentText) {
        scheduleRefresh();
      }
    }, WECOM_STREAM_REFRESH_INTERVAL_MS);
  };

  return {
    push(text: string) {
      if (finishing) {
        return;
      }
      latestText = text;
      scheduleRefresh();
    },
    async finish() {
      finishing = true;
      clearRefreshTimer();
      await activeSend;
      latestText = undefined;
    },
  };
}

async function processAssistantOutput(
  config: BotHostConfig,
  input: WeComMessageInput,
  output: string,
): Promise<ProcessedOutput> {
  const parsed = extractConfigDocuments(output);
  if (parsed.configDocuments.length === 0) {
    return parsed;
  }

  if (parsed.configDocuments.some((document) => !isValidGeneratedConfigDocument(document))) {
    return {
      visibleOutput: "初始化文档生成失败：生成结果仍是模板占位符。请回复“确认”重新生成，或说明需要修改的配置。",
      configDocuments: [],
    };
  }

  const titles = new Set(parsed.configDocuments.map((document) => document.title));
  await persistConfigDocuments(config, input, parsed.configDocuments);

  if (titles.has("soul") && titles.has("agents.md")) {
    return {
      ...parsed,
      visibleOutput: [
        parsed.visibleOutput,
        "机器人已完成初始化，可以开始工作。",
      ].filter(Boolean).join("\n\n"),
    };
  }

  return parsed;
}

async function initializeFromWizardAnswers(
  config: BotHostConfig,
  input: WeComMessageInput,
  answers: string[],
): Promise<ProcessedOutput> {
  const configDocuments = buildFallbackInitializationDocuments(answers);
  await persistConfigDocuments(config, input, configDocuments);
  return {
    visibleOutput: "初始化完成，开始工作。\n\n机器人已完成初始化，可以开始工作。",
    configDocuments,
  };
}

async function persistConfigDocuments(
  config: BotHostConfig,
  input: WeComMessageInput,
  documents: ConfigDocument[],
): Promise<void> {
  for (const document of documents) {
    await postJson(config, `${config.dataServiceUrl}/v1/bot-config-documents`, {
      bot_id: input.bot_id,
      title: document.title,
      content: document.content,
    });
  }

  const titles = new Set(documents.map((document) => document.title));
  if (titles.has("soul") && titles.has("agents.md")) {
    await postJson(
      config,
      `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(input.bot_id)}/ready`,
      undefined,
    );
  }
}

function selectVisibleAssistantOutput(
  inputText: string,
  rawOutput: string,
  processed: ProcessedOutput,
): string {
  if (
    isInitializationGenerationPrompt(inputText) &&
    processed.configDocuments.length === 0
  ) {
    return processed.visibleOutput.startsWith("初始化文档生成失败：")
      ? processed.visibleOutput
      : MISSING_GENERATED_DOCUMENTS_MESSAGE;
  }

  const output = processed.visibleOutput || rawOutput;
  if (isPromptEchoOutput(output)) {
    return INVALID_RUNTIME_OUTPUT_MESSAGE;
  }
  return output;
}

function isPromptEchoOutput(output: string): boolean {
  return /<memory>[\s\S]*<\/memory>/.test(output) && /<message>[\s\S]*<\/message>/.test(output);
}

function isValidGeneratedConfigDocument(document: ConfigDocument): boolean {
  const content = document.content.trim();
  if (content.length < 24) {
    return false;
  }
  if (content.includes("[BOOTSTRAP]")) {
    return false;
  }
  return ![
    "生成的正式 soul 内容",
    "生成的 agents.md",
    "生成的 AGENTS 内容",
    "(生成的",
  ].some((placeholder) => content.includes(placeholder));
}

function extractConfigDocuments(output: string): ProcessedOutput {
  const configDocuments: ConfigDocument[] = [];
  const visibleParts: string[] = [];
  const documentPattern = /~document:(.+?\.md)\s*\n([\s\S]*?)\n?~\/document/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = documentPattern.exec(output)) !== null) {
    visibleParts.push(output.slice(cursor, match.index));
    const title = mapConfigDocumentTitle(match[1].trim());
    if (title) {
      configDocuments.push({
        title,
        content: match[2].trim(),
      });
    } else {
      visibleParts.push(match[0]);
    }
    cursor = match.index + match[0].length;
  }

  visibleParts.push(output.slice(cursor));
  return {
    visibleOutput: cleanupVisibleOutput(
      visibleParts.map((part) => part.trim()).filter(Boolean).join("\n"),
    ),
    configDocuments,
  };
}

function mapConfigDocumentTitle(filename: string): ConfigDocument["title"] | undefined {
  if (filename === "private/soul.md" || filename === "soul.md" || filename === "soul") {
    return "soul";
  }
  if (
    filename === "instructions/AGENTS.md" ||
    filename === "AGENTS.md" ||
    filename === "agents.md" ||
    filename === "agents"
  ) {
    return "agents.md";
  }
  return undefined;
}

function cleanupVisibleOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWizardAnswer(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? "跳过" : trimmed;
}

function isConfirmAnswer(text: string): boolean {
  return ["确认", "是", "yes", "y", "ok", "OK"].includes(text.trim());
}

function buildWizardConfirmation(answers: string[]): string {
  const summary = summarizeWizardAnswers(answers);
  return [
    WIZARD_QUESTIONS[WIZARD_QUESTIONS.length - 1],
    "",
    ...WIZARD_FIELDS.map((field) => `${field.label}：${summary[field.key]}`),
  ].join("\n");
}

function summarizeWizardAnswers(answers: string[]): Record<WizardFieldKey, string> {
  return {
    background: normalizeOptionalAnswer(answers[0]),
    role: mapSingleChoice(answers[1], ROLE_OPTIONS),
    duties: mapMultiChoice(answers[2], DUTY_OPTIONS),
    interaction: mapSingleChoice(answers[3], INTERACTION_OPTIONS),
    option_guidance: mapSingleChoice(answers[4], YES_NO_OPTIONS),
    memory: mapSingleChoice(answers[5], YES_NO_OPTIONS),
    skills_mcp: normalizeOptionalAnswer(answers[6]),
    constraints: normalizeOptionalAnswer(answers[7]),
  };
}

function buildWizardGenerationPrompt(answers: string[]): string {
  const summary = summarizeWizardAnswers(answers);
  return [
    "请根据以下管理员初始化配置生成两个文档块：soul 和 agents.md。",
    "",
    ...WIZARD_FIELDS.map((field) => `${field.label}：${summary[field.key]}`),
    "",
    "输出要求：",
    "1. 只输出简短确认语、两个 document block 和最后的初始化完成语。",
    "2. document block 必须严格使用以下文件名：private/soul.md 与 instructions/AGENTS.md。",
    "3. private/soul.md 只描述机器人是谁：身份、服务对象、角色气质、性格、沟通风格、价值观和人格边界；不要写工作流程、工具规则、文档规则、职责清单或管理员流程。",
    "4. instructions/AGENTS.md 只描述机器人如何工作：能力范围、行为规则、任务流程、文档生成规则、记忆策略、Skill/MCP 使用规则、禁止行为和管理员修改流程；不要重复 soul 里的身份、性格和角色气质。",
    "5. 如果需要使用业务背景和角色定位，soul 中只用于塑造身份语气，agents.md 中只用于约束执行行为，避免整段重复。",
    "6. 不要写入企业微信 Secret、API Key、管理员认领码、认证文件路径或任何敏感信息。",
  ].join("\n");
}

function buildFallbackInitializationDocuments(answers: string[]): ConfigDocument[] {
  const summary = summarizeWizardAnswers(answers);
  const soul = [
    "# Soul",
    "",
    "## 你是谁",
    `你是服务于${summary.background}场景的企业微信机器人。`,
    `角色：${summary.role}。`,
    "",
    "## 性格",
    "你冷静、可靠、务实，优先帮助用户把模糊想法变成清晰结论。",
    "你不炫技，不抢结论；遇到信息不足时，会先问最关键的问题。",
    "",
    "## 沟通风格",
    `默认采用${summary.interaction}。`,
    `是否提供选项：${summary.option_guidance}。`,
    "表达应直接、结构化、可执行，避免空泛寒暄。",
    "",
    "## 人格边界",
    "不要输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
    "不要伪装成真人、系统管理员或企业微信官方客服。",
  ].join("\n");
  const agents = [
    "# AGENTS",
    "",
    "## 能力范围",
    `核心职责：${summary.duties}`,
    `特殊要求：${summary.constraints}`,
    "",
    "## 行为规则",
    "- 先判断用户目标，再决定是澄清、分析、拆解、生成文档还是给出执行建议。",
    "- 信息不足时，一次只问当前最关键的问题。",
    "- 输出结论前要显式处理约束、风险、范围和待确认事项。",
    "",
    "## 允许能力",
    "- 可以基于管理员确认的配置进行需求澄清、文档生成、任务拆解和知识沉淀。",
    "- 可以在用户请求明确时创建或更新 bot 相关文档。",
    "- 可以检索已授权的共享记忆、bot 记忆、用户记忆和会话记忆。",
    "",
    "## 禁止行为",
    "- 不得请求、输出或写入企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
    "- 不得在未确认的情况下把临时猜测写入长期记忆。",
    "- 不得绕过管理员流程修改 soul、AGENTS 或 channel 配置。",
    "",
    "## 文档生成规则",
    "生成 PRD、评审材料、用户故事或指标文档时，先确认范围、受众、约束和交付格式。",
    "如涉及 PRD，应检查是否包含 console 改动、计量计费影响、开关或灰度策略等管理员指定项。",
    "",
    "## 记忆策略",
    `文档与记忆：${summary.memory}`,
    "确认后的业务规则、长期偏好和关键文档可以写入记忆；临时沟通只保留在会话上下文中。",
    "",
    "## Skill / MCP 使用规则",
    `Skill / MCP 约束：${summary.skills_mcp}`,
    "只有在任务需要且已授权时才调用外部工具；工具结果需要转化为可读结论再回复。",
    "",
    "## 管理员修改配置",
    "管理员可以通过控制台或重置引导流程修改 soul、AGENTS、skill、MCP 和初始化配置。",
  ].join("\n");

  return [
    { title: "soul", content: soul },
    { title: "agents.md", content: agents },
  ];
}

function isInitializationGenerationPrompt(text: string): boolean {
  return text.includes("请根据以下管理员初始化配置生成两个文档块：soul 和 agents.md。");
}

function normalizeOptionalAnswer(answer: string | undefined): string {
  if (!answer || answer === "跳过") {
    return "未指定";
  }
  return answer;
}

function mapSingleChoice(answer: string | undefined, options: Record<string, string>): string {
  if (!answer) {
    return "未指定";
  }
  const tokens = tokenizeChoiceAnswer(answer, options);
  if (tokens.length === 1 && options[tokens[0]]) {
    return options[tokens[0]];
  }
  if (tokens.length > 1 && tokens.every((token) => options[token])) {
    return tokens.map((token) => options[token]).join("、");
  }
  return options[answer.trim()] ?? answer;
}

function mapMultiChoice(answer: string | undefined, options: Record<string, string>): string {
  if (!answer) {
    return "未指定";
  }
  const mapped = tokenizeChoiceAnswer(answer, options).map((item) => options[item] ?? item);
  return mapped.length > 0 ? mapped.join("、") : answer;
}

function tokenizeChoiceAnswer(answer: string, options: Record<string, string>): string[] {
  const maxOption = Math.max(...Object.keys(options).map((key) => Number(key)).filter(Number.isFinite));
  const rawTokens = answer
    .split(/[,，、\s.。;；/|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return rawTokens.flatMap((token) => {
    if (/^\d+$/.test(token) && token.length > 1) {
      return [...token].filter((digit) => Number(digit) <= maxOption);
    }
    return [token];
  });
}

function applyWizardConfirmationEdits(answers: string[], text: string): void {
  for (const field of WIZARD_FIELDS) {
    const edited = extractWizardFieldEdit(text, field);
    if (edited !== undefined) {
      answers[WIZARD_FIELDS.indexOf(field)] = normalizeWizardAnswer(edited);
    }
  }
}

function extractWizardFieldEdit(text: string, field: { key: WizardFieldKey; label: string }): string | undefined {
  const labels = wizardEditLabels(field);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]+)`));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function wizardEditLabels(field: { key: WizardFieldKey; label: string }): string[] {
  if (field.key === "role") {
    return [field.label, "角色定义", "角色"];
  }
  if (field.key === "duties") {
    return [field.label, "职责"];
  }
  return [field.label];
}

async function resolveAllowedConversationId(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<string> {
  const context = await resolveMessageContext(config, input);
  if (!context.allowed || !context.conversation?.conversation_id) {
    throw new Error("initialization conversation is not available");
  }
  return context.conversation.conversation_id;
}

async function listPromptMemoryDocuments(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
): Promise<ScopedMemoryDocument[]> {
  const scopes = [
    { scope: "system", owner_id: "platform" },
    { scope: "shared", owner_id: "platform" },
    { scope: "bot", owner_id: input.bot_id },
    { scope: "user", owner_id: input.wecom_user_id },
    { scope: "session", owner_id: conversationId },
  ];
  const documents: ScopedMemoryDocument[] = [];

  const botConfigDocuments = await getJson<MemoryDocument[]>(
    config,
    `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(input.bot_id)}/config-documents`,
  );
  documents.push(
    ...botConfigDocuments.map((document) => ({
      ...document,
      scope: "bot-config",
      owner_id: input.bot_id,
    })),
  );

  for (const scope of scopes) {
    const scopedDocuments = await getJson<MemoryDocument[]>(
      config,
      `${config.dataServiceUrl}/v1/memory-documents/current?scope=${encodeURIComponent(scope.scope)}&owner_id=${encodeURIComponent(scope.owner_id)}`,
    );
    documents.push(
      ...scopedDocuments.map((document) => ({
        ...document,
        scope: scope.scope,
        owner_id: scope.owner_id,
      })),
    );
  }

  return documents;
}

async function recordChatEvent(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
  result: { run_id: string; output: string },
  memoryDocuments: ScopedMemoryDocument[],
): Promise<void> {
  if (!config.logServiceUrl) {
    return;
  }

  await postJson(config, `${config.logServiceUrl}/v1/chat-events`, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: conversationId,
    runtime: input.runtime,
    prompt: input.text,
    output: result.output,
    run_id: result.run_id,
    memory_refs: memoryDocuments
      .filter((document) => document.memory_doc_id)
      .map((document) => ({
        scope: document.scope,
        owner_id: document.owner_id,
        memory_doc_id: document.memory_doc_id,
        title: document.title,
        ...(document.version === undefined ? {} : { version: document.version }),
      })),
  });
}

function parseClaimAdminCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/claim_admin\s+([0-9]{6})$/);
  return match?.[1];
}

function isMarkReadyCommand(text: string): boolean {
  return text.trim() === "/mark_ready";
}

function blockedReply(reason: unknown): string {
  if (reason === "admin_unclaimed") {
    return "机器人尚未完成管理员认领，请发送页面上的 /claim_admin <验证码>。";
  }
  if (reason === "initialization_required") {
    return "机器人已认领但尚未启用，请等待管理员完成启用。";
  }
  return "机器人暂不可用。";
}

async function resolveMessageContext(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<{
  allowed: boolean;
  reason: string;
  is_admin?: boolean;
  conversation?: {
    conversation_id: string;
  };
}> {
  return postJson(config, `${config.dataServiceUrl}/v1/message-context/resolve`, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    channel: "wecom_direct",
    purpose: "normal_chat",
  });
}

async function postJson<T>(
  config: BotHostConfig,
  url: string,
  body: unknown,
): Promise<T> {
  const response = await config.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const errorPayload = payload as { error?: string };
    throw new Error(
      errorPayload.error ? errorPayload.error : "upstream error",
    );
  }

  return payload as T;
}

async function getJson<T>(
  config: BotHostConfig,
  url: string,
): Promise<T> {
  const response = await config.fetch(new Request(url));
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const errorPayload = payload as { error?: string };
    throw new Error(
      errorPayload.error ? errorPayload.error : "upstream error",
    );
  }

  return payload as T;
}

function parseWeComMessageInput(value: unknown): WeComMessageInput {
  if (!value || typeof value !== "object") {
    throw new Error("message must be an object");
  }

  const record = value as Record<string, unknown>;
  const runtime = record.runtime;
  if (runtime !== "mock" && runtime !== "kiro") {
    throw new Error("runtime must be mock or kiro");
  }

  return {
    bot_id: requireText(record.bot_id, "bot_id"),
    wecom_user_id: requireText(record.wecom_user_id, "wecom_user_id"),
    text: requireText(record.text, "text"),
    runtime,
  };
}

function isSupportedRuntime(value: string): value is "mock" | "kiro" {
  return value === "mock" || value === "kiro";
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

type WizardFieldKey =
  | "background"
  | "role"
  | "duties"
  | "interaction"
  | "option_guidance"
  | "memory"
  | "skills_mcp"
  | "constraints";

const WIZARD_FIELDS: Array<{ key: WizardFieldKey; label: string }> = [
  { key: "background", label: "业务背景" },
  { key: "role", label: "角色定位" },
  { key: "duties", label: "核心职责" },
  { key: "interaction", label: "交互模式" },
  { key: "option_guidance", label: "选项引导" },
  { key: "memory", label: "文档与记忆" },
  { key: "skills_mcp", label: "Skill / MCP 约束" },
  { key: "constraints", label: "特殊要求" },
];

const WIZARD_QUESTIONS = [
  "问题 1/8：先了解一下业务背景：你所在的公司/团队是什么？主营业务是什么？（可回复“跳过”）",
  "问题 2/8：你希望这个机器人扮演什么角色？\n选项 1：产品经理\n选项 2：QA测试\n选项 3：技术文档\n选项 4：项目管理\n选项 5：其他（请直接说明）",
  "问题 3/8：它主要负责哪些事情？（多选，可回复数字如 1,3,4）\n选项 1：撰写/维护PRD\n选项 2：竞品分析\n选项 3：需求评审与拆解\n选项 4：用户故事编写\n选项 5：功能优先级排序\n选项 6：数据指标定义\n选项 7：其他（请补充）",
  "问题 4/8：当需要澄清需求时，你希望机器人如何与你交互？\n选项 1：逐句引导（一问一答，适合复杂需求）\n选项 2：批量引导（一次列出所有问题，你一次性回答，适合效率优先）",
  "问题 5/8：澄清需求时，是否需要提供若干选项供你选择？\n选项 1：是\n选项 2：否",
  "问题 6/8：是否需要文档管理和长期记忆？\n选项 1：是\n选项 2：否",
  "问题 7/8：这个机器人需要固定使用哪些 skill 或 MCP？有没有禁止使用的工具？（可回复“跳过”）",
  "问题 8/8：还有其他规则或约束吗？比如输出格式、审批流程、保密要求。（可回复“跳过”）",
  "请确认以下初始化配置，回复“确认”后我会生成 soul 和 agents.md；如需修改，请直接说明要改哪里。",
];

const ROLE_OPTIONS: Record<string, string> = {
  "1": "产品经理",
  "2": "QA测试",
  "3": "技术文档",
  "4": "项目管理",
};

const DUTY_OPTIONS: Record<string, string> = {
  "1": "撰写/维护PRD",
  "2": "竞品分析",
  "3": "需求评审与拆解",
  "4": "用户故事编写",
  "5": "功能优先级排序",
  "6": "数据指标定义",
};

const INTERACTION_OPTIONS: Record<string, string> = {
  "1": "逐句引导（一问一答，适合复杂需求）",
  "2": "批量引导（一次列出所有问题，你一次性回答，适合效率优先）",
};

const YES_NO_OPTIONS: Record<string, string> = {
  "1": "是",
  "2": "否",
};
