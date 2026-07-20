import {
  blockedReply,
  beginWizardGenerationIfReady,
  clearWizardGenerationInProgress,
  clearWizardState,
  handleBotMessage,
  isProjectSyncCommand,
  resolveMessageContext,
  shouldDeferStreamingForWizardState,
  shouldHandleWizardConfirmationAsync,
  shouldStreamReply,
  startInitializationWizard,
  streamBotMessage,
  type BotHostConfig,
  type StreamBotMessageConfig,
  type WeComMessageInput,
} from "./messageHandler.js";
import type { IncomingWeComMessage, WeComClient } from "./wecomClient.js";
import { createSimpleTaskRouter, type SimpleTaskRouter } from "./simpleTaskRouter.js";

export type { BotHostConfig } from "./messageHandler.js";

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
  notify?(input: { botId?: string; userId: string; text: string }): Promise<void>;
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

export interface BotHostWorkerConfig extends StreamBotMessageConfig {
  botId: string;
  runtime: "mock" | "kiro" | "claude-code";
  simpleTaskRouter?: SimpleTaskRouter;
}

export interface WeComRuntimeBotConfig {
  bot_id: string;
  name: string;
  runtime: "mock" | "kiro" | "claude-code";
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
  // A stopped stream finishes asynchronously after the /stop command has been answered.
  // Keep this state local to one Bot worker so its terminal cancellation error is not sent.
  const workerConfig: BotHostWorkerConfig = {
    ...config,
    runtimeCancellationState: new Set<string>(),
  };
  const restartInitialization = async (input: {
    botId: string;
    adminWeComUserId: string;
  }): Promise<RestartInitializationResult> => {
    if (input.botId !== config.botId) {
      throw new Error(`bot worker not found: ${input.botId}`);
    }
    const messageInput: WeComMessageInput = {
      bot_id: config.botId,
      wecom_user_id: input.adminWeComUserId,
      conversation_id: input.adminWeComUserId,
      text: "",
      runtime: config.runtime,
    };
    let conversationId: string | undefined;
    try {
      const context = await resolveMessageContext(workerConfig, messageInput);
      conversationId = context.conversation?.conversation_id;
    } catch (_error) {
      conversationId = input.adminWeComUserId;
    }
    conversationId ??= input.adminWeComUserId;
    await clearWizardState(workerConfig, messageInput, conversationId);
    const output = await startInitializationWizard(messageInput, workerConfig, conversationId);
    await workerConfig.wecomClient.sendText(input.adminWeComUserId, output, { forceActive: true });
    return {
      bot_id: config.botId,
      admin_wecom_user_id: input.adminWeComUserId,
      output,
    };
  };

  const onMessage = async (message: IncomingWeComMessage) => {
    try {
      const messageInput: WeComMessageInput = {
        bot_id: config.botId,
        wecom_user_id: message.userId,
        conversation_id: message.conversationId,
        text: message.text,
        runtime: config.runtime,
      };
      const taskAction = await workerConfig.simpleTaskRouter?.handle({ botId: config.botId, userId: message.userId, text: message.text });
      if (taskAction?.reply) { await workerConfig.wecomClient.sendText(message.conversationId, taskAction.reply); return; }
      if (taskAction?.continueText) messageInput.text = taskAction.continueText;
      if (await shouldHandleWizardConfirmationAsync(workerConfig, messageInput)) {
        await workerConfig.wecomClient.sendText(
          message.conversationId,
          "配置已确认，正在生成 soul.md 和 agents.md。完成后我会主动通知你。",
        );
        void handleBotMessage(messageInput, workerConfig)
          .then(async (asyncResult) => {
            if ("output" in asyncResult && typeof asyncResult.output === "string") {
              await workerConfig.wecomClient.sendText(message.conversationId, asyncResult.output);
            }
          })
          .catch(async (error) => {
            console.error("[wecom] async initialization failed", error);
            await workerConfig.wecomClient.sendText(
              message.conversationId,
              "初始化文档生成失败，请稍后重试或在 WebUI 重置引导。",
            );
          });
        return;
      }

      let wizardGeneration: { notice: string; shouldProcess: boolean } | undefined;
      try {
        wizardGeneration = await beginWizardGenerationIfReady(messageInput, workerConfig);
      } catch (_error) {
        await workerConfig.wecomClient.sendText(
          message.conversationId,
          "初始化状态读取失败，请稍后重试。",
        );
        return;
      }
      if (wizardGeneration) {
        await workerConfig.wecomClient.sendText(message.conversationId, wizardGeneration.notice);
        if (wizardGeneration.shouldProcess) {
          void handleBotMessage(messageInput, workerConfig)
            .then(async (asyncResult) => {
              if ("output" in asyncResult && typeof asyncResult.output === "string") {
                await workerConfig.wecomClient.sendText(message.conversationId, asyncResult.output);
              }
            })
            .catch(async (error) => {
              await clearWizardGenerationInProgress(messageInput, workerConfig);
              console.error("[wecom] async initialization failed", error);
              await workerConfig.wecomClient.sendText(
                message.conversationId,
                "初始化文档生成失败，请稍后重试或在 WebUI 重置引导。",
              );
            });
        }
        return;
      }

      const wizardLookup = await shouldDeferStreamingForWizardState(workerConfig, messageInput);
      if (wizardLookup.failed) {
        await workerConfig.wecomClient.sendText(
          message.conversationId,
          "初始化状态读取失败，请稍后重试。",
        );
        return;
      }

      // `/sync` can spend noticeable time recreating the project checkout. It
      // needs a passive reply stream of its own so the user sees progress
      // immediately, while the other capability commands remain non-streaming.
      if (!wizardLookup.hasWizardState && isProjectSyncCommand(message.text)) {
        await streamBotMessage(messageInput, workerConfig, message.conversationId);
        return;
      }

      if (!wizardLookup.hasWizardState && await shouldStreamReply(workerConfig, messageInput)) {
        await workerConfig.wecomClient.sendText(message.conversationId, "正在思考...", {
          finish: false,
        });
        await streamBotMessage(messageInput, workerConfig, message.conversationId);
        return;
      }

      const result = await handleBotMessage(messageInput, workerConfig);
      await sendWorkerResult(workerConfig.wecomClient, message.conversationId, result);
    } catch (error) {
      console.error("[wecom] message handling failed", {
        botId: config.botId,
        conversationId: message.conversationId,
        error: error instanceof Error ? error.message : "unknown error",
      });
      await workerConfig.wecomClient.sendText(
        message.conversationId,
        "任务执行或回复通道异常。若已生成代码或报告，请发送“读取当前会话报告”获取结果；否则请重试。",
        { forceActive: true },
      );
    }
  };

  return {
    async start() {
      workerConfig.wecomClient.onMessage(onMessage);
      await workerConfig.wecomClient.connect();
    },
    stop() {
      workerConfig.wecomClient.disconnect();
    },
    restartInitialization,
    async notify(input) {
      await workerConfig.wecomClient.sendText(input.userId, input.text, { forceActive: true });
    },
  };
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
  const taskRouter = createSimpleTaskRouter(async (input) => {
    const worker = workers.get(input.botId)?.worker;
    if (!worker?.notify) throw new Error(`target Bot is not connected: ${input.botId}`);
    await worker.notify({ userId: input.userId, text: input.text });
  }, config.dataServiceUrl);

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
      taskRouter.registerBots(runtimeBots.map((bot) => ({ botId: bot.bot_id, name: bot.name })));
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
          simpleTaskRouter: taskRouter,
        });
        workers.set(bot.bot_id, { signature, worker });
        await worker.start();
        console.info("[wecom-supervisor] started bot worker", {
          botId: bot.bot_id,
          runtime: bot.runtime,
          wecomBotId: bot.wecom_bot_id,
        });
      }
      // Handoff delivery is backend-owned. A failed active WeCom send leaves the
      // notification pending, so a later supervisor sync retries it.
      const pending = await getJson<{ notifications?: Array<{ notification_id: string; bot_id: string; user_id: string; text: string }> }>(config, `${config.dataServiceUrl}/internal/handoff/notifications/pending`);
      for (const notification of pending.notifications ?? []) {
        const target = workers.get(notification.bot_id)?.worker;
        if (!target?.notify) continue;
        try {
          await target.notify({ userId: notification.user_id, text: notification.text });
          await postJson(config, `${config.dataServiceUrl}/internal/handoff/notifications/${encodeURIComponent(notification.notification_id)}/delivered`, {});
        } catch (error) { console.warn("[wecom-supervisor] handoff notification pending", { notificationId: notification.notification_id, error: error instanceof Error ? error.message : "unknown" }); }
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
    async notify(input) {
      await sync();
      if (!input.botId) throw new Error("botId is required for supervisor notifications");
      const worker = workers.get(input.botId)?.worker;
      if (!worker?.notify) throw new Error(`bot worker not found: ${input.botId}`);
      await worker.notify({ userId: input.userId, text: input.text });
    },
  };
}

async function handleWeComMessage(
  request: Request,
  config: BotHostConfig,
): Promise<Response> {
  try {
    const input = parseWeComMessageInput(await request.json());
    const result = await handleBotMessage(input, config);
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

async function sendWorkerResult(
  wecomClient: WeComClient,
  conversationId: string,
  result: Record<string, unknown>,
): Promise<void> {
  if ("output" in result && typeof result.output === "string") {
    await wecomClient.sendText(conversationId, result.output);
    return;
  }
  if ("claim_failed" in result && result.claim_failed) {
    await wecomClient.sendText(
      conversationId,
      "管理员认领失败，请确认验证码是否正确或是否过期。",
    );
    return;
  }
  if ("blocked" in result && result.blocked) {
    await wecomClient.sendText(
      conversationId,
      blockedReply(result.reason),
    );
    return;
  }
  if ("claimed" in result && result.claimed) {
    await wecomClient.sendText(conversationId, "管理员认领成功，开始初始化。");
    return;
  }
  if ("ready" in result && result.ready) {
    await wecomClient.sendText(conversationId, "机器人已启用。");
  }
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

async function postJson(config: BotHostConfig, url: string, body: unknown): Promise<void> {
  const response = await config.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  if (!response.ok) throw new Error(`upstream POST failed: ${response.status}`);
}

function parseWeComMessageInput(value: unknown): WeComMessageInput {
  if (!value || typeof value !== "object") {
    throw new Error("message must be an object");
  }

  const record = value as Record<string, unknown>;
  const runtime = record.runtime;
  if (runtime !== "mock" && runtime !== "kiro" && runtime !== "claude-code") {
    throw new Error("runtime must be mock, kiro, or claude-code");
  }

  return {
    bot_id: requireText(record.bot_id, "bot_id"),
    wecom_user_id: requireText(record.wecom_user_id, "wecom_user_id"),
    ...(typeof record.conversation_id === "string"
      ? { conversation_id: record.conversation_id }
      : {}),
    text: requireText(record.text, "text"),
    runtime,
  };
}

function isSupportedRuntime(value: string): value is "mock" | "kiro" | "claude-code" {
  return value === "mock" || value === "kiro" || value === "claude-code";
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
