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

interface RememberCommand {
  scope: "bot" | "shared";
  content: string;
}

interface WizardState {
  phase: "soul" | "agents";
  soulAnswers: string[];
  agentsAnswers: string[];
  generationInProgress?: "soul" | "agents";
}

const wizardStatesByConfig = new WeakMap<BotHostConfig, Map<string, WizardState>>();
const MISSING_GENERATED_DOCUMENTS_MESSAGE = "初始化文档生成失败：没有生成 soul 和 agents.md。请回复“确认”重新生成，或说明需要修改的配置。";
const MISSING_SOUL_DOCUMENT_MESSAGE = "Soul 生成失败：没有生成 soul。请稍后重试或在 WebUI 重置引导。";
const MISSING_AGENTS_DOCUMENT_MESSAGE = "工作方式生成失败：没有生成 agents.md。请稍后重试或在 WebUI 重置引导。";
const INVALID_RUNTIME_OUTPUT_MESSAGE = "LLM 运行器没有生成有效回复，请稍后重试或检查 runtime 配置。";
const WECOM_STREAM_REFRESH_INTERVAL_MS = 500;
const DEFAULT_AGENTS_RULES_SECTION = [
  "## 默认规则背景",
  "- 默认使用中文回复，除非用户明确要求其他语言。",
  "- 优先遵守当前 bot 的 soul 与 agents.md；如有冲突，安全、合规和管理员规则优先。",
  "- 信息不足时一次只问一个最关键的问题，不要一次性抛出多个问题。",
  "- 不要请求、输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
  "- 只有用户明确要求记住、保存、沉淀，或管理员规则明确允许时，才写入长期记忆。",
].join("\n");

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
      const wizardGeneration = beginWizardGenerationIfReady(messageInput, config);
      if (wizardGeneration) {
        await config.wecomClient.sendText(message.conversationId, wizardGeneration.notice);
        if (wizardGeneration.shouldProcess) {
          void processWeComMessage(messageInput, config)
            .then(async (asyncResult) => {
              if ("output" in asyncResult && typeof asyncResult.output === "string") {
                await config.wecomClient.sendText(message.conversationId, asyncResult.output);
              }
            })
            .catch(async (error) => {
              clearWizardGenerationInProgress(messageInput, config);
              console.error("[wecom] async initialization failed", error);
              await config.wecomClient.sendText(
                message.conversationId,
                "初始化文档生成失败，请稍后重试或在 WebUI 重置引导。",
              );
            });
        }
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
  void config;
  void input;
  return false;
}

async function shouldStreamReply(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<boolean> {
  if (parseClaimAdminCommand(input.text) || isMarkReadyCommand(input.text)) {
    return false;
  }
  if (hasWizardStateForUser(input, config)) {
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

    const rememberCommand = parseRememberCommand(input.text);
    if (rememberCommand) {
      return handleRememberCommand(input, config, context, rememberCommand);
    }

    if (context.reason === "initializing" || hasWizardStateForUser(input, config)) {
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
  getWizardStates(config).set(wizardKey(input, conversationId), {
    phase: "soul",
    soulAnswers: [],
    agentsAnswers: [],
  });
  return [
    "管理员认领成功，开始初始化。",
    "",
    SOUL_WIZARD_QUESTIONS[0],
  ].join("\n");
}

function hasWizardStateForUser(
  input: WeComMessageInput,
  config: BotHostConfig,
): boolean {
  const prefix = `${input.bot_id}:${input.wecom_user_id}:`;
  for (const key of getWizardStates(config).keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function findWizardKeyForUser(
  input: WeComMessageInput,
  config: BotHostConfig,
): string | undefined {
  const prefix = `${input.bot_id}:${input.wecom_user_id}:`;
  for (const key of getWizardStates(config).keys()) {
    if (key.startsWith(prefix)) {
      return key;
    }
  }
  return undefined;
}

function beginWizardGenerationIfReady(
  input: WeComMessageInput,
  config: BotHostConfig,
): { notice: string; shouldProcess: boolean } | undefined {
  const key = findWizardKeyForUser(input, config);
  if (!key) {
    return undefined;
  }
  const state = getWizardStates(config).get(key);
  if (!state) {
    return undefined;
  }
  if (state.generationInProgress === "soul") {
    return { notice: "Soul 正在生成，请稍等。", shouldProcess: false };
  }
  if (state.generationInProgress === "agents") {
    return { notice: "工作方式正在生成，请稍等。", shouldProcess: false };
  }
  if (state.phase === "soul" && state.soulAnswers.length === SOUL_WIZARD_QUESTIONS.length - 1) {
    state.generationInProgress = "soul";
    return { notice: "Soul 正在生成，请稍等。", shouldProcess: true };
  }
  if (state.phase === "agents" && state.agentsAnswers.length === AGENTS_WIZARD_QUESTIONS.length - 1) {
    state.generationInProgress = "agents";
    return { notice: "工作方式正在生成，请稍等。", shouldProcess: true };
  }
  return undefined;
}

function clearWizardGenerationInProgress(
  input: WeComMessageInput,
  config: BotHostConfig,
): void {
  const key = findWizardKeyForUser(input, config);
  if (!key) {
    return;
  }
  const state = getWizardStates(config).get(key);
  if (state) {
    delete state.generationInProgress;
  }
}

async function handleWizardMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const wizardStates = getWizardStates(config);
  const key = wizardStates.has(wizardKey(input, conversationId))
    ? wizardKey(input, conversationId)
    : findWizardKeyForUser(input, config) ?? wizardKey(input, conversationId);
  const state = wizardStates.get(key) ?? {
    phase: "soul" as const,
    soulAnswers: [],
    agentsAnswers: [],
  };
  const normalized = normalizeWizardAnswer(input.text);

  if (state.phase === "soul") {
    state.soulAnswers.push(normalized);
    wizardStates.set(key, state);
    if (state.soulAnswers.length < SOUL_WIZARD_QUESTIONS.length) {
      return {
        conversation_id: conversationId,
        output: SOUL_WIZARD_QUESTIONS[state.soulAnswers.length],
      };
    }
    const result = await generateSoulFromWizardAnswers(config, input, conversationId, state.soulAnswers);
    if (result.output.startsWith("初始化文档生成失败：") || result.output.startsWith("Soul 生成失败：")) {
      delete state.generationInProgress;
      return {
        conversation_id: conversationId,
        run_id: result.run_id,
        output: result.output,
      };
    }
    state.phase = "agents";
    delete state.generationInProgress;
    wizardStates.set(key, state);
    return {
      conversation_id: conversationId,
      run_id: result.run_id,
      output: [
        "Soul 配置已确认，正在生成 soul。",
        result.output,
        "开始配置工作方式。",
        AGENTS_WIZARD_QUESTIONS[0],
      ].filter(Boolean).join("\n\n"),
    };
  }

  if (state.agentsAnswers.length === 1 && isMultipleChoiceAnswer(normalized)) {
    return {
      conversation_id: conversationId,
      output: "核心工作只能选择一个。请重新回复一个选项编号，或直接说明一个核心工作。",
    };
  }

  state.agentsAnswers.push(normalized);
  wizardStates.set(key, state);
  if (state.agentsAnswers.length < AGENTS_WIZARD_QUESTIONS.length) {
    return {
      conversation_id: conversationId,
      output: AGENTS_WIZARD_QUESTIONS[state.agentsAnswers.length],
    };
  }

  const result = await generateAgentsFromWizardAnswers(
    config,
    input,
    conversationId,
    state.soulAnswers,
    state.agentsAnswers,
  );
  if (result.output.startsWith("工作方式生成失败：") || result.output.startsWith("初始化文档生成失败：")) {
    delete state.generationInProgress;
    return {
      conversation_id: conversationId,
      run_id: result.run_id,
      output: result.output,
    };
  }
  wizardStates.delete(key);
  return {
    conversation_id: conversationId,
    run_id: result.run_id,
    output: [
      "工作方式配置已确认，正在生成 agents.md。",
      result.output,
    ].filter(Boolean).join("\n\n"),
    initialized: true,
    ready: true,
    status: "ready",
  };
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

async function generateSoulFromWizardAnswers(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
  soulAnswers: string[],
): Promise<{ run_id: string; output: string }> {
  const result = await processAllowedWeComMessage(
    {
      ...input,
      text: buildSoulGenerationPrompt(soulAnswers),
    },
    config,
    conversationId,
  );
  if (result.output === MISSING_SOUL_DOCUMENT_MESSAGE) {
    const fallback = await initializeSoulFromWizardAnswers(config, input, soulAnswers);
    return {
      run_id: result.run_id,
      output: fallback.visibleOutput,
    };
  }
  return {
    run_id: result.run_id,
    output: result.output,
  };
}

async function generateAgentsFromWizardAnswers(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
  soulAnswers: string[],
  agentsAnswers: string[],
): Promise<{ run_id: string; output: string }> {
  const result = await processAllowedWeComMessage(
    {
      ...input,
      text: buildAgentsGenerationPrompt(soulAnswers, agentsAnswers),
    },
    config,
    conversationId,
  );
  if (result.output === MISSING_AGENTS_DOCUMENT_MESSAGE) {
    const fallback = await initializeAgentsFromWizardAnswers(config, input, soulAnswers, agentsAnswers);
    return {
      run_id: result.run_id,
      output: fallback.visibleOutput,
    };
  }
  return {
    run_id: result.run_id,
    output: result.output,
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

  if (titles.has("agents.md")) {
    return {
      ...parsed,
      visibleOutput: [
        parsed.visibleOutput,
        "初始化完成，可以开始工作。",
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
    const content = document.title === "agents.md"
      ? appendDefaultAgentsRules(document.content)
      : document.content;
    await postJson(config, `${config.dataServiceUrl}/v1/bot-config-documents`, {
      bot_id: input.bot_id,
      title: document.title,
      content,
    });
  }

  const titles = new Set(documents.map((document) => document.title));
  if (titles.has("agents.md")) {
    await postJson(
      config,
      `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(input.bot_id)}/ready`,
      undefined,
    );
  }
}

function appendDefaultAgentsRules(content: string): string {
  if (content.includes("## 默认规则背景")) {
    return content;
  }
  return [
    content.trimEnd(),
    "",
    DEFAULT_AGENTS_RULES_SECTION,
  ].join("\n");
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
  if (isSoulGenerationPrompt(inputText) && !processed.configDocuments.some((document) => document.title === "soul")) {
    if (processed.visibleOutput.startsWith("初始化文档生成失败：")) {
      return processed.visibleOutput;
    }
    return MISSING_SOUL_DOCUMENT_MESSAGE;
  }
  if (isAgentsGenerationPrompt(inputText) && !processed.configDocuments.some((document) => document.title === "agents.md")) {
    if (processed.visibleOutput.startsWith("初始化文档生成失败：")) {
      return processed.visibleOutput;
    }
    return MISSING_AGENTS_DOCUMENT_MESSAGE;
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

function parseRememberCommand(text: string): RememberCommand | undefined {
  const trimmed = text.trim();
  const slashMatch = trimmed.match(/^\/remember(?:\s+(--shared))?\s+([\s\S]+)$/);
  if (slashMatch) {
    return {
      scope: slashMatch[1] ? "shared" : "bot",
      content: slashMatch[2].trim(),
    };
  }

  const naturalMatch = trimmed.match(/^记住[：:\s]+([\s\S]+)$/);
  if (naturalMatch) {
    return {
      scope: "bot",
      content: naturalMatch[1].trim(),
    };
  }

  return undefined;
}

async function handleRememberCommand(
  input: WeComMessageInput,
  config: BotHostConfig,
  context: {
    is_admin?: boolean;
  },
  command: RememberCommand,
): Promise<Record<string, unknown>> {
  if (command.content === "") {
    return {
      blocked: true,
      reason: "empty_memory",
      output: "要记住的内容不能为空。",
    };
  }
  if (command.scope === "shared" && !context.is_admin) {
    return {
      blocked: true,
      reason: "shared_memory_requires_admin",
      output: "只有管理员可以写入共享记忆。",
    };
  }

  const ownerId = command.scope === "shared" ? "platform" : input.bot_id;
  const memory = await postJson<{
    memory_doc_id: string;
    scope: string;
    owner_id: string;
    version: number;
  }>(
    config,
    `${config.dataServiceUrl}/v1/memory-documents`,
    {
      scope: command.scope,
      owner_id: ownerId,
      title: "用户记忆",
      content: command.content,
    },
  );

  return {
    remembered: true,
    scope: memory.scope,
    owner_id: memory.owner_id,
    memory_doc_id: memory.memory_doc_id,
    output: `已记住：${command.content}`,
  };
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

function summarizeSoulAnswers(answers: string[]): Record<SoulWizardFieldKey, string> {
  return {
    identity: mapSingleChoice(answers[0], SOUL_IDENTITY_OPTIONS),
    personality: mapSingleChoice(answers[1], SOUL_PERSONALITY_OPTIONS),
    communication: mapSingleChoice(answers[2], SOUL_COMMUNICATION_OPTIONS),
  };
}

function summarizeAgentsAnswers(answers: string[]): Record<AgentsWizardFieldKey, string> {
  return {
    background: normalizeOptionalAnswer(answers[0]),
    core_work: mapSingleChoice(answers[1], AGENTS_CORE_WORK_OPTIONS),
    interaction: mapSingleChoice(answers[2], AGENTS_INTERACTION_OPTIONS),
    memory: mapSingleChoice(answers[3], AGENTS_MEMORY_OPTIONS),
    document_storage: mapSingleChoice(answers[4], AGENTS_DOCUMENT_STORAGE_OPTIONS),
    skills_mcp: normalizeOptionalAnswer(answers[5]),
    work_rules: normalizeOptionalAnswer(answers[6]),
  };
}

function buildSoulGenerationPrompt(answers: string[]): string {
  const summary = summarizeSoulAnswers(answers);
  return [
    "请根据以下 Soul 引导配置生成 soul 文档。",
    "",
    ...SOUL_WIZARD_FIELDS.map((field) => `${field.label}：${summary[field.key]}`),
    "",
    "输出要求：",
    "1. 只输出简短确认语和一个 document block。",
    "2. document block 必须严格使用文件名：private/soul.md。",
    "3. soul 只描述机器人是谁：身份、性格、沟通风格、价值观和人格边界。",
    "4. 不要写工作流程、工具规则、文档规则、职责清单、管理员流程或敏感信息。",
  ].join("\n");
}

function buildAgentsGenerationPrompt(soulAnswers: string[], agentsAnswers: string[]): string {
  const soul = summarizeSoulAnswers(soulAnswers);
  const agents = summarizeAgentsAnswers(agentsAnswers);
  return [
    "请根据以下 Agents 引导配置生成 agents.md 文档。",
    "",
    "Soul 摘要：",
    ...SOUL_WIZARD_FIELDS.map((field) => `${field.label}：${soul[field.key]}`),
    "",
    "工作方式配置：",
    ...AGENTS_WIZARD_FIELDS.map((field) => `${field.label}：${agents[field.key]}`),
    "",
    "硬性规则：",
    "1. agents.md 只描述机器人如何工作：核心工作、业务背景、交互规则、任务流程、文档生成规则、记忆策略、Skill/MCP 规则、禁止行为和管理员修改流程。",
    "2. 一个 bot 只能有一个核心工作，其他能力只能作为辅助，不要写成多主责列表。",
    "3. 当核心工作涉及 PRD，且管理员配置了 Console、IMM、计量计费等必须确认项时，必须逐项确认。",
    "4. 一次只能问一个管理员指定项。",
    "5. 不得要求用户使用组合格式一次回复多个确认项，例如 1a 2a 3a。",
    "6. Console、IMM、计量计费等项必须分别完成确认后，才能输出 PRD。",
    "7. 不要重复 soul 里的身份、性格和角色气质；不要写入敏感信息。",
    "",
    "输出要求：",
    "1. 只输出简短确认语和一个 document block。",
    "2. document block 必须严格使用文件名：instructions/AGENTS.md。",
  ].join("\n");
}

async function initializeSoulFromWizardAnswers(
  config: BotHostConfig,
  input: WeComMessageInput,
  answers: string[],
): Promise<ProcessedOutput> {
  const configDocuments = [buildFallbackSoulDocument(answers)];
  await persistConfigDocuments(config, input, configDocuments);
  return {
    visibleOutput: "Soul 已生成。",
    configDocuments,
  };
}

async function initializeAgentsFromWizardAnswers(
  config: BotHostConfig,
  input: WeComMessageInput,
  soulAnswers: string[],
  agentsAnswers: string[],
): Promise<ProcessedOutput> {
  const configDocuments = [buildFallbackAgentsDocument(soulAnswers, agentsAnswers)];
  await persistConfigDocuments(config, input, configDocuments);
  return {
    visibleOutput: "初始化完成，可以开始工作。",
    configDocuments,
  };
}

function buildFallbackSoulDocument(answers: string[]): ConfigDocument {
  const summary = summarizeSoulAnswers(answers);
  return {
    title: "soul",
    content: [
      "# Soul",
      "",
      "## 我是谁",
      `你是${summary.identity}。`,
      "",
      "## 性格",
      `你的性格是${summary.personality}。`,
      "",
      "## 沟通风格",
      `你的沟通风格是${summary.communication}。`,
      "",
      "## 人格边界",
      "不要输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
      "不要伪装成真人、系统管理员或企业微信官方客服。",
    ].join("\n"),
  };
}

function buildFallbackAgentsDocument(soulAnswers: string[], agentsAnswers: string[]): ConfigDocument {
  const soul = summarizeSoulAnswers(soulAnswers);
  const agents = summarizeAgentsAnswers(agentsAnswers);
  const prdRule = isPrdCoreWork(agents.core_work)
    ? [
      "- 生成 PRD 前必须逐项确认管理员指定项，例如 Console、IMM、计量计费。",
      "- 一次只能问一个管理员指定项，不得要求用户使用组合格式一次回复多个确认项，例如 1a 2a 3a。",
      "- Console、IMM、计量计费等项分别确认后，才能输出 PRD。",
    ]
    : [];
  return {
    title: "agents.md",
    content: [
      "# AGENTS",
      "",
      "## 核心工作",
      `核心工作：${agents.core_work}`,
      `业务背景：${agents.background}`,
      `机器人身份参考：${soul.identity}`,
      "",
      "## 交互规则",
      `交互方式：${agents.interaction}`,
      "- 信息不足时，一次只问当前最关键的问题。",
      "- 输出结论前要显式处理约束、风险、范围和待确认事项。",
      ...prdRule,
      "",
      "## 文档与记忆",
      `长期记忆：${agents.memory}`,
      `文档存储：${agents.document_storage}`,
      "确认后的业务规则、长期偏好和关键文档可以写入记忆；临时沟通只保留在会话上下文中。",
      "",
      "## Skill / MCP 使用规则",
      `Skill / MCP 约束：${agents.skills_mcp}`,
      "只有在任务需要且已授权时才调用外部工具；工具结果需要转化为可读结论再回复。",
      "",
      "## 工作规则",
      `管理员指定规则：${agents.work_rules}`,
      "",
      "## 禁止行为",
      "- 不得请求、输出或写入企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
      "- 不得在未确认的情况下把临时猜测写入长期记忆。",
      "- 不得绕过管理员流程修改 soul、AGENTS 或 channel 配置。",
      "",
      "## 管理员修改配置",
      "管理员可以通过控制台或重置引导流程修改 soul、AGENTS、skill、MCP 和初始化配置。",
    ].join("\n"),
  };
}

function isPrdCoreWork(coreWork: string): boolean {
  return /PRD|需求文档|产品需求/.test(coreWork);
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

function isSoulGenerationPrompt(text: string): boolean {
  return text.includes("请根据以下 Soul 引导配置生成 soul 文档。");
}

function isAgentsGenerationPrompt(text: string): boolean {
  return text.includes("请根据以下 Agents 引导配置生成 agents.md 文档。");
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

function isMultipleChoiceAnswer(answer: string): boolean {
  const tokens = tokenizeChoiceAnswer(answer, AGENTS_CORE_WORK_OPTIONS);
  return tokens.length > 1 && tokens.every((token) => /^\d+$/.test(token));
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

type SoulWizardFieldKey = "identity" | "personality" | "communication";
type AgentsWizardFieldKey =
  | "background"
  | "core_work"
  | "interaction"
  | "memory"
  | "document_storage"
  | "skills_mcp"
  | "work_rules";

const SOUL_WIZARD_FIELDS: Array<{ key: SoulWizardFieldKey; label: string }> = [
  { key: "identity", label: "我是谁" },
  { key: "personality", label: "性格" },
  { key: "communication", label: "沟通风格" },
];

const AGENTS_WIZARD_FIELDS: Array<{ key: AgentsWizardFieldKey; label: string }> = [
  { key: "background", label: "业务背景" },
  { key: "core_work", label: "核心工作" },
  { key: "interaction", label: "交互方式" },
  { key: "memory", label: "长期存储/长期记忆" },
  { key: "document_storage", label: "文档存储" },
  { key: "skills_mcp", label: "Skill / MCP 约束" },
  { key: "work_rules", label: "工作规则" },
];

const SOUL_WIZARD_QUESTIONS = [
  withWizardOptions("Soul 引导 1/3：你希望我扮演什么角色？", {
    "1": "产品经理助手",
    "2": "QA 测试助手",
    "3": "技术文档助手",
    "4": "项目管理助手",
    "5": "其他，请直接说明",
  }),
  withWizardOptions("Soul 引导 2/3：你希望我的性格是什么样的？", {
    "1": "冷静务实",
    "2": "严谨审慎",
    "3": "主动推进",
    "4": "友好耐心",
    "5": "其他，请直接说明",
  }),
  withWizardOptions("Soul 引导 3/3：你希望我的沟通风格是什么？", {
    "1": "简洁直接",
    "2": "严谨完整",
    "3": "先问清楚再回答",
    "4": "给出选项辅助决策",
    "5": "其他，请直接说明",
  }),
];

const AGENTS_WIZARD_QUESTIONS = [
  withWizardOptions("Agents 引导 1/7：业务背景是什么？公司/团队是做什么的？", {
    "1": "跳过，后续再补充",
    "2": "直接输入业务背景",
  }),
  withWizardOptions("Agents 引导 2/7：这个机器人只负责一类核心工作，你希望它的核心工作是什么？", {
    "1": "撰写/维护 PRD",
    "2": "竞品分析",
    "3": "需求评审与拆解",
    "4": "用户故事编写",
    "5": "数据指标定义",
    "6": "QA 测试",
    "7": "技术文档",
    "8": "项目管理",
    "9": "其他，请直接说明",
  }),
  withWizardOptions("Agents 引导 3/7：你希望它用什么方式和用户交互？", {
    "1": "逐句引导，一次只问一个问题",
    "2": "批量引导，一次列出多个待确认项",
    "3": "先给推荐方案，再让用户确认",
    "4": "其他，请直接说明",
  }),
  withWizardOptions("Agents 引导 4/7：是否使用长期存储或长期记忆？", {
    "1": "使用，确认后的业务规则和文档需要沉淀",
    "2": "不使用，只保留当前会话",
    "3": "待定",
  }),
  withWizardOptions("Agents 引导 5/7：是否需要保存它生成的文档？", {
    "1": "需要，生成的 PRD/方案/纪要要保存",
    "2": "不需要，只在对话中输出",
    "3": "待定",
  }),
  withWizardOptions("Agents 引导 6/7：是否有固定 Skill / MCP / 工具约束？", {
    "1": "跳过，暂不固定",
    "2": "直接输入 Skill / MCP / 工具约束",
  }),
  withWizardOptions("Agents 引导 7/7：有没有必须遵守的工作规则？", {
    "1": "跳过，暂无额外规则",
    "2": "直接输入必须遵守的工作规则",
  }),
];

function withWizardOptions(question: string, options: Record<string, string>): string {
  return [
    question,
    ...Object.entries(options).map(([key, label]) => `${key}. ${label}`),
    "",
    "回复编号或直接输入。",
  ].join("\n");
}

const SOUL_IDENTITY_OPTIONS: Record<string, string> = {
  "1": "产品经理助手",
  "2": "QA 测试助手",
  "3": "技术文档助手",
  "4": "项目管理助手",
};

const SOUL_PERSONALITY_OPTIONS: Record<string, string> = {
  "1": "冷静务实",
  "2": "严谨审慎",
  "3": "主动推进",
  "4": "友好耐心",
};

const SOUL_COMMUNICATION_OPTIONS: Record<string, string> = {
  "1": "简洁直接",
  "2": "严谨完整",
  "3": "先问清楚再回答",
  "4": "给出选项辅助决策",
};

const AGENTS_CORE_WORK_OPTIONS: Record<string, string> = {
  "1": "撰写/维护 PRD",
  "2": "竞品分析",
  "3": "需求评审与拆解",
  "4": "用户故事编写",
  "5": "数据指标定义",
  "6": "QA 测试",
  "7": "技术文档",
  "8": "项目管理",
};

const AGENTS_INTERACTION_OPTIONS: Record<string, string> = {
  "1": "逐句引导，一次只问一个问题",
  "2": "批量引导，一次列出多个待确认项",
  "3": "先给推荐方案，再让用户确认",
};

const AGENTS_MEMORY_OPTIONS: Record<string, string> = {
  "1": "使用，确认后的业务规则和文档需要沉淀",
  "2": "不使用，只保留当前会话",
  "3": "待定",
};

const AGENTS_DOCUMENT_STORAGE_OPTIONS: Record<string, string> = {
  "1": "需要，生成的 PRD/方案/纪要要保存",
  "2": "不需要，只在对话中输出",
  "3": "待定",
};

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
