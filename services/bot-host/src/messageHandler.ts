import {
  applyAndConfirmPendingGeneratedDocuments,
  getBotRuntimePolicy,
  cancelPendingGeneratedDocuments,
  clearInitializationSession,
  createPendingGeneratedDocument,
  deleteBotEnvVar,
  getActiveInitializationSession,
  type InitializationSessionDto,
  listBotCapabilityAuditLogs,
  listBotEnvVars,
  listBotMcps,
  listPendingGeneratedDocuments,
  listBotSkills,
  requestDeleteBotMcp,
  requestDeleteBotSkill,
  requestInstallBotMcp,
  requestInstallBotSkill,
  type BotCapabilityAuditLogDto,
  type BotEnvVarMetadataDto,
  type BotMcpDto,
  type BotRuntimePolicyDto,
  type BotSkillDto,
  upsertBotEnvVar,
  updateBotRuntimePolicy,
  upsertInitializationSession,
} from "./botStateClient.js";
import type { WeComClient } from "./wecomClient.js";

export interface BotHostConfig {
  dataServiceUrl: string;
  llmRunnerUrl: string;
  capabilityRunnerUrl?: string;
  logServiceUrl?: string;
  fetch: typeof fetch;
}

export interface WeComMessageInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id?: string;
  text: string;
  runtime: "mock" | "kiro";
}

export interface StreamBotMessageConfig extends BotHostConfig {
  wecomClient: WeComClient;
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
  pendingDocuments?: GeneratedMarkdownDocument[];
}

interface ConfigDocument {
  title: "soul" | "agents.md";
  content: string;
}

interface GeneratedMarkdownDocument {
  title: string;
  content: string;
}

interface RememberCommand {
  scope: "bot" | "shared";
  content: string;
}

interface CapabilityPolicyCommand {
  target: "skill" | "mcp";
  policy: "open" | "admin_only";
}

interface InstallSkillIntent {
  skillName: string;
  sourceRef?: string;
  sourceType?: string;
}

interface WizardState {
  phase: "soul" | "role_select" | "agents";
  soulAnswers: string[];
  agentsAnswers: string[];
  selectedRoleId?: string;
  generationInProgress?: "soul" | "agents";
}

interface LoadedWizardState {
  state: WizardState;
  conversationId: string;
}

interface RoleRecord {
  role_id: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  sort_order: number;
}

interface RoleQuestionOption {
  value: string;
  label: string;
}

interface RoleQuestionDependency {
  key: string;
  equals: string;
}

interface RoleQuestionRecord {
  question_id: string;
  role_id: string;
  key: string;
  title: string;
  description: string;
  question_type: "single_choice" | "multi_choice" | "free_text";
  options_json: RoleQuestionOption[];
  required: boolean;
  enabled: boolean;
  sort_order: number;
  depends_on_json: RoleQuestionDependency[];
}

interface GlobalDocumentRecord {
  document_id: string;
  title: string;
  slug: string;
  content: string;
  enabled: boolean;
  sort_order: number;
}

interface RoleDocumentRecord {
  role_document_id: string;
  role_id: string;
  title: string;
  content: string;
  enabled: boolean;
}

const MISSING_GENERATED_DOCUMENTS_MESSAGE = "初始化文档生成失败：没有生成 soul 和 agents.md。请回复“确认”重新生成，或说明需要修改的配置。";
const MISSING_SOUL_DOCUMENT_MESSAGE = "Soul 生成失败：没有生成 soul。请稍后重试或在 WebUI 重置引导。";
const MISSING_AGENTS_DOCUMENT_MESSAGE = "工作方式生成失败：没有生成 agents.md。请稍后重试或在 WebUI 重置引导。";
const INVALID_RUNTIME_OUTPUT_MESSAGE = "LLM 运行器没有生成有效回复，请稍后重试或检查 runtime 配置。";
const WECOM_STREAM_REFRESH_INTERVAL_MS = 500;
const DEFAULT_EASEMOB_BUSINESS_BACKGROUND = "环信是 IM 服务提供商，提供各种端的 SDK、REST API 等服务。";
const DEFAULT_AGENTS_RULES_SECTION = [
  "## 默认规则背景",
  `- ${DEFAULT_EASEMOB_BUSINESS_BACKGROUND}`,
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
].join("\n");

export async function handleBotMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
): Promise<Record<string, unknown>> {
  return processWeComMessage(input, config);
}

export async function streamBotMessage(
  input: WeComMessageInput,
  config: StreamBotMessageConfig,
  wecomConversationId: string,
): Promise<void> {
  return streamAllowedWeComMessage(input, config, wecomConversationId);
}

export async function shouldHandleWizardConfirmationAsync(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<boolean> {
  void config;
  void input;
  return false;
}

export async function shouldStreamReply(
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

export async function shouldDeferStreamingForWizardState(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<{ failed: boolean; hasWizardState: boolean }> {
  if (parseClaimAdminCommand(input.text) || isMarkReadyCommand(input.text)) {
    return { failed: false, hasWizardState: false };
  }

  const context = await resolveMessageContext(config, input);
  if (context.reason !== "ready") {
    return { failed: false, hasWizardState: false };
  }
  try {
    return {
      failed: false,
      hasWizardState: await hasWizardStateForUser(input, config, context.conversation?.conversation_id),
    };
  } catch (_error) {
    return { failed: true, hasWizardState: false };
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
          output: await startInitializationWizard(input, config),
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

    const capabilityCommand = parseCapabilityCommand(input.text);
    if (capabilityCommand) {
      return handleCapabilityCommand(input, config, context, capabilityCommand);
    }

    if (!context.conversation?.conversation_id) {
      throw new Error("conversation_id is required");
    }

    const rememberCommand = parseRememberCommand(input.text);
    if (rememberCommand) {
      return handleRememberCommand(input, config, context, rememberCommand);
    }

    if (
      context.reason === "initializing"
      || await hasWizardStateForUser(input, config, context.conversation.conversation_id)
    ) {
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

export async function startInitializationWizard(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId?: string,
): Promise<string> {
  await saveWizardState(config, input, conversationId, {
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

async function hasWizardStateForUser(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId?: string,
): Promise<boolean> {
  const candidateIds = wizardConversationCandidates(input, conversationId);
  if (candidateIds.length === 0) {
    return false;
  }
  for (const candidateId of candidateIds) {
    if (await loadWizardState(config, input, candidateId)) {
      return true;
    }
  }
  return false;
}

export async function beginWizardGenerationIfReady(
  input: WeComMessageInput,
  config: BotHostConfig,
): Promise<{ notice: string; shouldProcess: boolean } | undefined> {
  if (parseClaimAdminCommand(input.text) || isMarkReadyCommand(input.text)) {
    return undefined;
  }
  const context = await resolveMessageContext(config, input);
  if (context.reason !== "ready" && context.reason !== "initializing") {
    return undefined;
  }
  const conversationId = context.conversation?.conversation_id ?? input.conversation_id;
  const loaded = conversationId
    ? await loadWizardState(config, input, conversationId)
    : undefined;
  const state = loaded?.state;
  if (!state) {
    return undefined;
  }
  if (loaded.conversationId !== conversationId) {
    await saveWizardState(config, input, conversationId, state);
    await clearInitializationSession(config, {
      bot_id: input.bot_id,
      wecom_user_id: input.wecom_user_id,
      conversation_id: loaded.conversationId,
    });
  }
  if (state.generationInProgress === "soul") {
    return { notice: "Soul 正在生成，请稍等。", shouldProcess: false };
  }
  if (state.generationInProgress === "agents") {
    return { notice: "工作方式正在生成，请稍等。", shouldProcess: false };
  }
  if (state.phase === "soul" && state.soulAnswers.length === SOUL_WIZARD_QUESTIONS.length - 1) {
    state.generationInProgress = "soul";
    await saveWizardState(config, input, conversationId, state);
    return { notice: "Soul 正在生成，请稍等。", shouldProcess: true };
  }
  if (state.phase === "agents" && state.selectedRoleId) {
    const roleQuestions = await listEnabledRoleQuestions(config, state.selectedRoleId);
    const answerMap = decodeAgentsAnswerMap(state.agentsAnswers);
    const currentQuestion = findNextRoleQuestion(roleQuestions, answerMap);
    if (!currentQuestion) {
      state.generationInProgress = "agents";
      await saveWizardState(config, input, conversationId, state);
      return { notice: "工作方式正在生成，请稍等。", shouldProcess: true };
    }
  }
  return undefined;
}

export async function clearWizardGenerationInProgress(
  input: WeComMessageInput,
  config: BotHostConfig,
): Promise<void> {
  const conversationId = await resolveWizardConversationId(config, input);
  const loaded = conversationId ? await loadWizardState(config, input, conversationId) : undefined;
  const state = loaded?.state;
  if (state) {
    delete state.generationInProgress;
    await saveWizardState(config, input, conversationId, state);
  }
}

async function handleWizardMessage(
  input: WeComMessageInput,
  config: BotHostConfig,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const loaded = await loadWizardState(config, input, conversationId);
  const state = loaded?.state ?? {
    phase: "soul" as const,
    soulAnswers: [],
    agentsAnswers: [],
    selectedRoleId: undefined,
  };
  const fallbackConversationId = loaded && loaded.conversationId !== conversationId
    ? loaded.conversationId
    : undefined;
  const clearFallbackAfterSave = async () => {
    if (!fallbackConversationId) {
      return;
    }
    await clearInitializationSession(config, {
      bot_id: input.bot_id,
      wecom_user_id: input.wecom_user_id,
      conversation_id: fallbackConversationId,
    });
  };
  const normalized = normalizeWizardAnswer(input.text);

  if (state.phase === "soul") {
    if (state.soulAnswers.length < SOUL_WIZARD_QUESTIONS.length) {
      state.soulAnswers.push(normalized);
      await saveWizardState(config, input, conversationId, state);
      await clearFallbackAfterSave();
      if (state.soulAnswers.length < SOUL_WIZARD_QUESTIONS.length) {
        return {
          conversation_id: conversationId,
          output: SOUL_WIZARD_QUESTIONS[state.soulAnswers.length],
        };
      }
    } else if (fallbackConversationId) {
      await saveWizardState(config, input, conversationId, state);
      await clearFallbackAfterSave();
    }
    const result = await generateSoulFromWizardAnswers(config, input, conversationId, state.soulAnswers);
    if (result.output.startsWith("初始化文档生成失败：") || result.output.startsWith("Soul 生成失败：")) {
      delete state.generationInProgress;
      await saveWizardState(config, input, conversationId, state);
      return {
        conversation_id: conversationId,
        run_id: result.run_id,
        output: result.output,
      };
    }
    const enabledRoles = await listEnabledRoles(config);
    state.phase = "role_select";
    delete state.generationInProgress;
    await saveWizardState(config, input, conversationId, state);
    return {
      conversation_id: conversationId,
      run_id: result.run_id,
      output: [
        "Soul 配置已确认，正在生成 soul。",
        result.output,
        buildRoleSelectionPrompt(enabledRoles),
      ].filter(Boolean).join("\n\n"),
    };
  }

  if (state.phase === "role_select") {
    const roles = await listEnabledRoles(config);
    const selectedRole = resolveSelectedRole(normalized, roles);
    if (!selectedRole) {
      return {
        conversation_id: conversationId,
        output: roles.length === 0
          ? "当前没有可选角色。请先在 WebUI 或 data-service 中启用角色。"
          : [
            "未识别到有效角色，请重新选择。",
            buildRoleSelectionPrompt(roles),
          ].join("\n\n"),
      };
    }
    state.selectedRoleId = selectedRole.role_id;
    state.phase = "agents";
    await saveWizardState(config, input, conversationId, state);
    await clearFallbackAfterSave();
    const roleQuestions = await listEnabledRoleQuestions(config, selectedRole.role_id);
    const firstQuestion = findNextRoleQuestion(roleQuestions, new Map());
    return {
      conversation_id: conversationId,
      output: firstQuestion
        ? buildRoleQuestionPrompt(firstQuestion)
        : "当前角色没有可用引导问题，将直接生成工作方式。",
    };
  }

  const roleQuestions = state.selectedRoleId
    ? await listEnabledRoleQuestions(config, state.selectedRoleId)
    : [];
  const answerMap = decodeAgentsAnswerMap(state.agentsAnswers);
  const currentQuestion = findNextRoleQuestion(roleQuestions, answerMap);

  if (currentQuestion) {
    answerMap.set(currentQuestion.key, normalizeRoleQuestionAnswer(currentQuestion, normalized));
    state.agentsAnswers = encodeAgentsAnswerMap(answerMap);
    await saveWizardState(config, input, conversationId, state);
    await clearFallbackAfterSave();
    const nextQuestion = findNextRoleQuestion(roleQuestions, answerMap);
    if (nextQuestion) {
      return {
        conversation_id: conversationId,
        output: buildRoleQuestionPrompt(nextQuestion),
      };
    }
  } else if (fallbackConversationId) {
    await saveWizardState(config, input, conversationId, state);
    await clearFallbackAfterSave();
  }

  const result = await generateAgentsFromWizardAnswers(
    config,
    input,
    conversationId,
    state.soulAnswers,
    state.selectedRoleId,
    roleQuestions,
    decodeAgentsAnswerMap(state.agentsAnswers),
  );
  if (result.output.startsWith("工作方式生成失败：") || result.output.startsWith("初始化文档生成失败：")) {
    delete state.generationInProgress;
    await saveWizardState(config, input, conversationId, state);
    return {
      conversation_id: conversationId,
      run_id: result.run_id,
      output: result.output,
    };
  }
  await clearWizardState(config, input, conversationId);
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

async function loadWizardState(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
): Promise<LoadedWizardState | undefined> {
  const candidateIds = wizardConversationCandidates(input, conversationId);
  for (const candidateId of candidateIds) {
    const session = await getActiveInitializationSession(config, {
      bot_id: input.bot_id,
      wecom_user_id: input.wecom_user_id,
      conversation_id: candidateId,
    });
    if (session) {
      return {
        state: wizardStateFromDto(session),
        conversationId: candidateId,
      };
    }
  }
  return undefined;
}

async function saveWizardState(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string | undefined,
  state: WizardState,
): Promise<void> {
  await upsertInitializationSession(config, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: conversationId ?? input.conversation_id ?? "pending",
    phase: state.phase,
    selected_role_id: state.selectedRoleId,
    soul_answers: state.soulAnswers,
    agents_answers: state.agentsAnswers,
    generation_in_progress: state.generationInProgress,
    status: "active",
  });
}

export async function clearWizardState(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
): Promise<void> {
  for (const candidateId of wizardConversationCandidates(input, conversationId)) {
    await clearInitializationSession(config, {
      bot_id: input.bot_id,
      wecom_user_id: input.wecom_user_id,
      conversation_id: candidateId,
    });
  }
}

function wizardConversationCandidates(
  input: WeComMessageInput,
  conversationId?: string,
): string[] {
  return [
    conversationId,
    input.conversation_id,
    "pending",
  ].filter((candidate, index, candidates): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 && candidates.indexOf(candidate) === index
  );
}

function wizardStateFromDto(session: InitializationSessionDto): WizardState {
  return {
    phase: session.phase,
    soulAnswers: [...session.soul_answers],
    agentsAnswers: [...session.agents_answers],
    selectedRoleId: session.selected_role_id,
    generationInProgress: session.generation_in_progress,
  };
}

async function resolveWizardConversationId(
  config: BotHostConfig,
  input: WeComMessageInput,
): Promise<string | undefined> {
  try {
    const context = await resolveMessageContext(config, input);
    return context.conversation?.conversation_id ?? input.conversation_id;
  } catch (_error) {
    return input.conversation_id;
  }
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
  const pendingDocumentResult = await handlePendingBusinessDocumentConfirmation(
    config,
    input,
    resolvedConversationId,
  );
  if (pendingDocumentResult) {
    return pendingDocumentResult;
  }

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

  const processed = await processAssistantOutput(config, input, result.output, resolvedConversationId);
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

async function handlePendingBusinessDocumentConfirmation(
  config: BotHostConfig,
  input: WeComMessageInput,
  conversationId: string,
): Promise<{
  conversation_id: string;
  run_id: string;
    output: string;
} | undefined> {
  if (!isConfirmAnswer(input.text)) {
    return undefined;
  }

  const documents = (await listPendingGeneratedDocuments(config, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: conversationId,
  })).filter((document) => document.status === "pending");
  if (!documents || documents.length === 0) {
    return undefined;
  }

  const saved = await applyAndConfirmPendingGeneratedDocuments(config, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: conversationId,
    created_by_bot_id: input.bot_id,
    created_by_user_id: input.wecom_user_id,
  });

  return {
    conversation_id: conversationId,
    run_id: `document_save_${crypto.randomUUID()}`,
    output: saved
      .map((document) => `已保存到长期文档存储：${document.title} v${document.version}。`)
      .join("\n"),
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
  selectedRoleId: string | undefined,
  roleQuestions: RoleQuestionRecord[],
  agentsAnswers: Map<string, string>,
): Promise<{ run_id: string; output: string }> {
  const [globalDocuments, roleDocuments] = await Promise.all([
    listEnabledGlobalDocuments(config),
    selectedRoleId ? listEnabledRoleDocuments(config, selectedRoleId) : Promise.resolve([]),
  ]);
  const result = await processAllowedWeComMessage(
    {
      ...input,
      text: buildAgentsGenerationPrompt(
        soulAnswers,
        selectedRoleId,
        roleQuestions,
        agentsAnswers,
        globalDocuments,
        roleDocuments,
      ),
    },
    config,
    conversationId,
  );
  if (result.output === MISSING_AGENTS_DOCUMENT_MESSAGE) {
    const fallback = await initializeAgentsFromWizardAnswers(
      config,
      input,
      soulAnswers,
      selectedRoleId,
      roleQuestions,
      agentsAnswers,
    );
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
  config: StreamBotMessageConfig,
  wecomConversationId: string,
): Promise<void> {
  const resolvedConversationId = await resolveAllowedConversationId(config, input);
  const pendingDocumentResult = await handlePendingBusinessDocumentConfirmation(
    config,
    input,
    resolvedConversationId,
  );
  if (pendingDocumentResult) {
    await config.wecomClient.sendText(wecomConversationId, pendingDocumentResult.output, { finish: true });
    return;
  }

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

  const rawFinalOutput = sentAnyChunk ? output : INVALID_RUNTIME_OUTPUT_MESSAGE;
  const processed = await processAssistantOutput(config, input, rawFinalOutput, resolvedConversationId);
  const finalOutput = selectVisibleAssistantOutput(input.text, rawFinalOutput, processed);
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

async function listEnabledRoles(config: BotHostConfig): Promise<RoleRecord[]> {
  return getJson<RoleRecord[]>(
    config,
    `${config.dataServiceUrl}/v1/roles`,
  );
}

async function listEnabledGlobalDocuments(config: BotHostConfig): Promise<GlobalDocumentRecord[]> {
  return getJson<GlobalDocumentRecord[]>(
    config,
    `${config.dataServiceUrl}/v1/global-documents`,
  );
}

async function listEnabledRoleDocuments(
  config: BotHostConfig,
  roleId: string,
): Promise<RoleDocumentRecord[]> {
  return getJson<RoleDocumentRecord[]>(
    config,
    `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleId)}/documents`,
  );
}

async function listEnabledRoleQuestions(
  config: BotHostConfig,
  roleId: string,
): Promise<RoleQuestionRecord[]> {
  return getJson<RoleQuestionRecord[]>(
    config,
    `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleId)}/questions`,
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
  conversationId?: string,
): Promise<ProcessedOutput> {
  const parsed = extractConfigDocuments(output);
  if (parsed.pendingDocuments && parsed.pendingDocuments.length > 0) {
    await persistPendingGeneratedDocuments(config, input, parsed.pendingDocuments, conversationId);
  }
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

async function persistPendingGeneratedDocuments(
  config: BotHostConfig,
  input: WeComMessageInput,
  documents: GeneratedMarkdownDocument[],
  conversationId?: string,
): Promise<void> {
  const resolvedConversationId = conversationId ?? input.conversation_id ?? await resolveAllowedConversationId(config, input);
  await cancelPendingGeneratedDocuments(config, {
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: resolvedConversationId,
  });
  for (const document of documents) {
    await createPendingGeneratedDocument(config, {
      bot_id: input.bot_id,
      wecom_user_id: input.wecom_user_id,
      conversation_id: resolvedConversationId,
      title: document.title,
      content: document.content,
      created_by_bot_id: input.bot_id,
      created_by_user_id: input.wecom_user_id,
    });
  }
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
  const pendingDocuments: GeneratedMarkdownDocument[] = [];
  const visibleParts: string[] = [];
  const documentPattern = /~document:(.+?\.md)\s*\n([\s\S]*?)\n?~\/document/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = documentPattern.exec(output)) !== null) {
    visibleParts.push(output.slice(cursor, match.index));
    const filename = match[1].trim();
    const content = match[2].trim();
    const title = mapConfigDocumentTitle(filename);
    if (title) {
      configDocuments.push({
        title,
        content,
      });
    } else {
      pendingDocuments.push({
        title: filename,
        content,
      });
      visibleParts.push(content);
    }
    cursor = match.index + match[0].length;
  }

  visibleParts.push(output.slice(cursor));
  const confirmationPrompt = pendingDocuments.length > 0
    ? [
      "",
      pendingDocuments.length === 1
        ? `已生成 Markdown 文档：${pendingDocuments[0].title}。回复“确认”后保存到长期文档存储；如需修改，请直接说明修改内容。`
        : `已生成 ${pendingDocuments.length} 个 Markdown 文档。回复“确认”后保存到长期文档存储；如需修改，请直接说明修改内容。`,
    ].join("\n")
    : "";
  return {
    visibleOutput: cleanupVisibleOutput(
      [
        visibleParts.map((part) => part.trim()).filter(Boolean).join("\n"),
        confirmationPrompt,
      ].filter(Boolean).join("\n"),
    ),
    configDocuments,
    pendingDocuments,
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

function parseCapabilityCommand(
  text: string,
):
  | { kind: "env" }
  | { kind: "env_set"; key: string; valueCiphertext: string }
  | { kind: "env_delete"; key: string }
  | { kind: "policy"; command: CapabilityPolicyCommand }
  | { kind: "skills_summary" }
  | { kind: "skill_install"; intent: InstallSkillIntent }
  | { kind: "skill_delete"; name: string }
  | { kind: "mcps_summary" }
  | { kind: "mcp_install"; name: string }
  | { kind: "mcp_delete"; name: string }
  | { kind: "capability_summary" }
  | { kind: "install_skill"; intent: InstallSkillIntent }
  | undefined {
  const trimmed = text.trim();
  if (trimmed === "/env") {
    return { kind: "env" };
  }
  const envSetMatch = trimmed.match(/^\/env\s+set\s+([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/);
  if (envSetMatch) {
    return {
      kind: "env_set",
      key: envSetMatch[1],
      valueCiphertext: envSetMatch[2].trim(),
    };
  }
  const envDeleteMatch = trimmed.match(/^\/env\s+delete\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envDeleteMatch) {
    return {
      kind: "env_delete",
      key: envDeleteMatch[1],
    };
  }
  if (trimmed === "/skill") {
    return { kind: "skills_summary" };
  }
  const skillInstallMatch = trimmed.match(/^\/skill\s+install\s+([A-Za-z0-9._-]+)$/);
  if (skillInstallMatch) {
    return {
      kind: "skill_install",
      intent: {
        skillName: skillInstallMatch[1],
      },
    };
  }
  const skillDeleteMatch = trimmed.match(/^\/skill\s+delete\s+([A-Za-z0-9._-]+)$/);
  if (skillDeleteMatch) {
    return {
      kind: "skill_delete",
      name: skillDeleteMatch[1],
    };
  }
  if (trimmed === "/mcp") {
    return { kind: "mcps_summary" };
  }
  const mcpInstallMatch = trimmed.match(/^\/mcp\s+install\s+([A-Za-z0-9._-]+)$/);
  if (mcpInstallMatch) {
    return {
      kind: "mcp_install",
      name: mcpInstallMatch[1],
    };
  }
  const mcpDeleteMatch = trimmed.match(/^\/mcp\s+delete\s+([A-Za-z0-9._-]+)$/);
  if (mcpDeleteMatch) {
    return {
      kind: "mcp_delete",
      name: mcpDeleteMatch[1],
    };
  }
  if (trimmed === "/capability") {
    return { kind: "capability_summary" };
  }

  const policyMatch = trimmed.match(/^\/policy\s+(skill|mcp)\s+(open|admin_only)$/);
  if (policyMatch) {
    return {
      kind: "policy",
      command: {
        target: policyMatch[1] as "skill" | "mcp",
        policy: policyMatch[2] as "open" | "admin_only",
      },
    };
  }

  const urlInstallMatch = trimmed.match(
    /安装(?:这个)?\s+skill[:：\s]+(https:\/\/github\.com\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+))/i,
  );
  if (urlInstallMatch) {
    return {
      kind: "install_skill",
      intent: {
        skillName: urlInstallMatch[2],
        sourceRef: urlInstallMatch[1],
        sourceType: "github",
      },
    };
  }

  const naturalInstallMatch = trimmed.match(/安装\s+skill\s+([A-Za-z0-9._-]+)/i);
  if (naturalInstallMatch) {
    return {
      kind: "install_skill",
      intent: {
        skillName: naturalInstallMatch[1],
      },
    };
  }

  return undefined;
}

async function handleCapabilityCommand(
  input: WeComMessageInput,
  config: BotHostConfig,
  context: {
    is_admin?: boolean;
  },
  command:
    | { kind: "env" }
    | { kind: "env_set"; key: string; valueCiphertext: string }
    | { kind: "env_delete"; key: string }
    | { kind: "policy"; command: CapabilityPolicyCommand }
    | { kind: "skills_summary" }
    | { kind: "skill_install"; intent: InstallSkillIntent }
    | { kind: "skill_delete"; name: string }
    | { kind: "mcps_summary" }
    | { kind: "mcp_install"; name: string }
    | { kind: "mcp_delete"; name: string }
    | { kind: "capability_summary" }
    | { kind: "install_skill"; intent: InstallSkillIntent },
): Promise<Record<string, unknown>> {
  if (
    command.kind === "env"
    || command.kind === "env_set"
    || command.kind === "env_delete"
    || command.kind === "policy"
  ) {
    if (!context.is_admin) {
      return {
        blocked: true,
        reason: "capability_admin_required",
        output: "只有管理员可以查看环境变量和管理 capability。",
      };
    }
  }

  if (command.kind === "env_set") {
    const item = await upsertBotEnvVar(config, input.bot_id, {
      key: command.key,
      value_ciphertext: command.valueCiphertext,
      updated_by_wecom_user_id: input.wecom_user_id,
    });
    return {
      output: `已设置环境变量：${item.key}。`,
    };
  }

  if (command.kind === "env_delete") {
    await deleteBotEnvVar(config, input.bot_id, command.key);
    return {
      output: `已删除环境变量：${command.key}。`,
    };
  }

  if (command.kind === "env") {
    const items = await listBotEnvVars(config, input.bot_id);
    return {
      output: buildEnvSummary(items),
    };
  }

  if (command.kind === "policy") {
    const updated = await updateBotRuntimePolicy(
      config,
      input.bot_id,
      command.command.target === "skill"
        ? { skill_install_policy: command.command.policy }
        : { mcp_manage_policy: command.command.policy },
    );
    return {
      output: command.command.target === "skill"
        ? `已更新 skill 安装策略：${updated.skill_install_policy}。`
        : `已更新 MCP 管理策略：${updated.mcp_manage_policy}。`,
    };
  }

  if (command.kind === "skills_summary") {
    const skills = await listBotSkills(config, input.bot_id);
    return {
      output: buildSkillSummary(skills),
    };
  }

  if (command.kind === "mcps_summary") {
    const mcps = await listBotMcps(config, input.bot_id);
    return {
      output: buildMcpSummary(mcps),
    };
  }

  if (command.kind === "capability_summary") {
    const [policy, skills, mcps, logs] = await Promise.all([
      getBotRuntimePolicy(config, input.bot_id),
      listBotSkills(config, input.bot_id),
      listBotMcps(config, input.bot_id),
      listBotCapabilityAuditLogs(config, input.bot_id),
    ]);
    return {
      output: buildCapabilitySummary(policy, skills, mcps, logs),
    };
  }

  if (command.kind === "mcp_install" || command.kind === "mcp_delete") {
    if (!context.is_admin) {
      const policy = await getBotRuntimePolicy(config, input.bot_id);
      if (policy.mcp_manage_policy === "admin_only") {
        return {
          blocked: true,
          reason: "capability_admin_required",
          output: "只有管理员可以查看环境变量和管理 capability。",
        };
      }
    }

    if (command.kind === "mcp_install") {
      const accepted = await requestInstallBotMcp(config, input.bot_id, {
        name: command.name,
      });
      return {
        accepted: accepted.accepted,
        output: `已受理 MCP 安装：${command.name}。`,
      };
    }

    const accepted = await requestDeleteBotMcp(config, input.bot_id, {
      name: command.name,
    });
    return {
      accepted: accepted.accepted,
      output: `已受理 MCP 删除：${command.name}。`,
    };
  }

  if (command.kind === "skill_delete") {
    if (!context.is_admin) {
      const policy = await getBotRuntimePolicy(config, input.bot_id);
      if (policy.skill_install_policy === "admin_only") {
        return {
          blocked: true,
          reason: "capability_admin_required",
          output: "只有管理员可以查看环境变量和管理 capability。",
        };
      }
    }

    const accepted = await requestDeleteBotSkill(config, input.bot_id, {
      name: command.name,
    });
    return {
      accepted: accepted.accepted,
      output: `已受理 skill 删除：${command.name}。`,
    };
  }

  if (!context.is_admin) {
    const policy = await getBotRuntimePolicy(config, input.bot_id);
    if (policy.skill_install_policy === "admin_only") {
      return {
        blocked: true,
        reason: "capability_admin_required",
        output: "只有管理员可以查看环境变量和管理 capability。",
      };
    }
  }

  const accepted = await requestInstallBotSkill(config, input.bot_id, {
    name: command.kind === "skill_install" ? command.intent.skillName : command.intent.skillName,
    source_ref: command.kind === "install_skill" ? command.intent.sourceRef : command.intent.sourceRef,
    source_type: command.kind === "install_skill" ? command.intent.sourceType : command.intent.sourceType,
  });
  return {
    accepted: accepted.accepted,
    output: `已受理 skill 安装：${command.intent.skillName}。`,
  };
}

function buildEnvSummary(items: BotEnvVarMetadataDto[]): string {
  if (items.length === 0) {
    return "当前没有已配置的环境变量。";
  }
  return [
    "环境变量：",
    ...items.map((item) => `- ${item.key}：${item.is_set ? "已设置" : "未设置"}（${item.updated_at}）`),
  ].join("\n");
}

function buildSkillSummary(skills: BotSkillDto[]): string {
  if (skills.length === 0) {
    return "当前没有已安装的 skill。";
  }
  return [
    "Skills：",
    ...skills.map((skill) => `- ${skill.name}（${skill.source_type}，${skill.status}）`),
  ].join("\n");
}

function buildMcpSummary(mcps: BotMcpDto[]): string {
  if (mcps.length === 0) {
    return "当前没有已配置的 MCP。";
  }
  return [
    "MCPs：",
    ...mcps.map((mcp) => `- ${mcp.name}（${mcp.mode}，${mcp.status}）`),
  ].join("\n");
}

function buildCapabilitySummary(
  policy: BotRuntimePolicyDto,
  skills: BotSkillDto[],
  mcps: BotMcpDto[],
  logs: BotCapabilityAuditLogDto[],
): string {
  return [
    `skill 安装策略：${policy.skill_install_policy}`,
    `MCP 管理策略：${policy.mcp_manage_policy}`,
    "",
    buildSkillSummary(skills),
    "",
    buildMcpSummary(mcps),
    "",
    logs.length === 0
      ? "最近没有 capability 审计记录。"
      : [
        "最近 capability 审计：",
        ...logs.slice(0, 3).map((log) => `- ${log.action_type} ${log.target_name}：${log.result}`),
      ].join("\n"),
  ].join("\n");
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
    identity: mapSingleChoice(answers[0], LEGACY_SOUL_IDENTITY_OPTIONS),
    communication: mapSingleChoice(answers[1], SOUL_COMMUNICATION_OPTIONS),
  };
}

function summarizeAgentsAnswers(answers: string[]): Record<AgentsWizardFieldKey, string> {
  return {
    core_work: mapSingleChoice(answers[0], AGENTS_CORE_WORK_OPTIONS),
    interaction: mapSingleChoice(answers[1], AGENTS_INTERACTION_OPTIONS),
    memory: mapSingleChoice(answers[2], AGENTS_MEMORY_OPTIONS),
    document_storage: mapSingleChoice(answers[3], AGENTS_DOCUMENT_STORAGE_OPTIONS),
    skills_mcp: normalizeOptionalAnswer(answers[4]),
    work_rules: normalizeOptionalAnswer(answers[5]),
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
    "3. soul 只描述机器人是谁：身份、沟通风格、价值观和人格边界。",
    "4. 不要写工作流程、工具规则、文档规则、职责清单、管理员流程或敏感信息。",
  ].join("\n");
}

function buildRoleSelectionPrompt(roles: RoleRecord[]): string {
  if (roles.length === 0) {
    return "Soul 已生成，但当前没有可选角色。请先在 data-service 配置启用角色。";
  }

  return [
    "请选择角色。",
    withWizardOptions("角色选择 1/1：你希望我承担哪个角色？", Object.fromEntries(
      roles.map((role, index) => [`${index + 1}`, role.name]),
    )),
  ].join("\n\n");
}

function buildRoleQuestionPrompt(question: RoleQuestionRecord): string {
  const options = Array.isArray(question.options_json) ? question.options_json : [];
  if (question.question_type === "free_text" || options.length === 0) {
    return [
      question.title,
      question.description ? `\n${question.description}` : "",
      "\n请直接输入。",
    ].join("");
  }
  return withWizardOptions(
    question.title,
    Object.fromEntries(options.map((option, index) => [`${index + 1}`, option.label])),
  );
}

function resolveSelectedRole(answer: string, roles: RoleRecord[]): RoleRecord | undefined {
  const byIndex = /^\d+$/.test(answer) ? roles[Number(answer) - 1] : undefined;
  if (byIndex) {
    return byIndex;
  }
  return roles.find((role) => role.name === answer || role.slug === answer || role.role_id === answer);
}

function findNextRoleQuestion(
  questions: RoleQuestionRecord[],
  answers: Map<string, string>,
): RoleQuestionRecord | undefined {
  return questions.find((question) =>
    !answers.has(question.key) && question.depends_on_json.every((dependency) =>
      answers.get(dependency.key) === dependency.equals
    )
  );
}

function normalizeRoleQuestionAnswer(question: RoleQuestionRecord, answer: string): string {
  const options = Array.isArray(question.options_json) ? question.options_json : [];
  if (question.question_type === "free_text" || options.length === 0) {
    return answer;
  }
  const optionsByIndex = options.map((option, index) => [`${index + 1}`, option] as const);
  const matchedByIndex = optionsByIndex.find(([index]) => index === answer);
  if (matchedByIndex) {
    return matchedByIndex[1].value;
  }
  const matchedByValue = options.find((option) => option.value === answer || option.label === answer);
  return matchedByValue?.value ?? answer;
}

function encodeAgentsAnswerMap(answers: Map<string, string>): string[] {
  return [...answers.entries()].map(([key, value]) => `${key}=${value}`);
}

function decodeAgentsAnswerMap(answers: string[]): Map<string, string> {
  const entries = answers
    .map((entry) => {
      const index = entry.indexOf("=");
      if (index <= 0) {
        return undefined;
      }
      return [entry.slice(0, index), entry.slice(index + 1)] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));
  return new Map(entries);
}

function buildAgentsGenerationPrompt(
  soulAnswers: string[],
  selectedRoleId: string | undefined,
  roleQuestions: RoleQuestionRecord[],
  agentsAnswers: Map<string, string>,
  globalDocuments: GlobalDocumentRecord[],
  roleDocuments: RoleDocumentRecord[],
): string {
  const soul = summarizeSoulAnswers(soulAnswers);
  const roleSummary = summarizeRoleQuestionAnswers(roleQuestions, agentsAnswers);
  const enabledGlobalDocuments = globalDocuments.filter((document) => document.enabled);
  const enabledRoleDocuments = roleDocuments.filter((document) => document.enabled);
  return [
    "请根据以下 Agents 引导配置生成 agents.md 文档。",
    "",
    "公共背景文档：",
    ...(enabledGlobalDocuments.length > 0
      ? enabledGlobalDocuments.flatMap((document) => [
        `--- ${document.title} ---`,
        document.content,
      ])
      : ["- 无"]),
    "",
    "角色默认规则文档：",
    ...(enabledRoleDocuments.length > 0
      ? enabledRoleDocuments.flatMap((document) => [
        `--- ${document.title} ---`,
        document.content,
      ])
      : ["- 无"]),
    "",
    "Soul 摘要：",
    ...SOUL_WIZARD_FIELDS.map((field) => `${field.label}：${soul[field.key]}`),
    "",
    `角色：${selectedRoleId ?? "未指定"}`,
    "工作方式配置：",
    ...roleSummary,
    `业务背景：${DEFAULT_EASEMOB_BUSINESS_BACKGROUND}`,
    "",
    "硬性规则：",
    "1. agents.md 只描述机器人如何工作：核心工作、默认业务背景、交互规则、任务流程、文档生成规则、记忆策略、Skill/MCP 规则、禁止行为和管理员修改流程。",
    "2. 一个 bot 只能有一个核心工作，其他能力只能作为辅助，不要写成多主责列表。",
    "3. 澄清需求时，一次只问一个问题，不得一次抛出多个问题。",
    "4. 每次提问应优先给出 2 到 4 个候选选项；如果能够判断，应明确给出推荐项。",
    "5. 在给出候选项时，必须允许用户直接自由回答，不能把用户限制成只能选编号。",
    "6. 当核心工作涉及 PRD，且管理员配置了 Console、IMM、计量计费等必须确认项时，必须逐项确认。",
    "7. 一次只能问一个管理员指定项。",
    "8. 不得要求用户使用组合格式一次回复多个确认项，例如 1a 2a 3a。",
    "9. Console、IMM、计量计费等项必须分别完成确认后，才能输出 PRD。",
    "10. 不要重复 soul 里的身份、性格和角色气质；不要写入敏感信息。",
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
  selectedRoleId: string | undefined,
  roleQuestions: RoleQuestionRecord[],
  agentsAnswers: Map<string, string>,
): Promise<ProcessedOutput> {
  const configDocuments = [buildFallbackAgentsDocument(soulAnswers, selectedRoleId, roleQuestions, agentsAnswers)];
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
      "## 沟通风格",
      `你的沟通风格是${summary.communication}。`,
      "",
      "## 人格边界",
      "不要输出或保存企业微信 Secret、API Key、管理员认领码、认证文件路径等敏感信息。",
      "不要伪装成真人、系统管理员或企业微信官方客服。",
    ].join("\n"),
  };
}

function buildFallbackAgentsDocument(
  soulAnswers: string[],
  selectedRoleId: string | undefined,
  roleQuestions: RoleQuestionRecord[],
  agentsAnswers: Map<string, string>,
): ConfigDocument {
  const soul = summarizeSoulAnswers(soulAnswers);
  const roleAnswerMap = Object.fromEntries(agentsAnswers.entries());
  const interaction = resolveRoleQuestionLabel(roleQuestions, "interaction_mode", roleAnswerMap.interaction_mode);
  const memoryStorage = resolveRoleQuestionLabel(roleQuestions, "memory_storage", roleAnswerMap.memory_storage);
  const workRules = resolveRoleQuestionLabel(roleQuestions, "work_rules", roleAnswerMap.work_rules);
  const prdRule = selectedRoleId === "role-product-manager" || selectedRoleId === "product-manager"
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
      "## 角色",
      `角色：${selectedRoleId ?? "未指定"}`,
      `业务背景：${DEFAULT_EASEMOB_BUSINESS_BACKGROUND}`,
      `机器人身份参考：${soul.identity}`,
      "",
      "## 交互规则",
      `交互方式：${interaction}`,
      "- 信息不足时，一次只问当前最关键的问题。",
      "- 澄清需求时，一次只问一个问题，不要一次抛出多个问题。",
      "- 每次提问优先给出 2 到 4 个候选选项，方便用户直接选择。",
      "- 能够判断时先给推荐项，再让用户确认或修正。",
      "- 用户也可以直接自由回答，不得强制用户只能回复编号。",
      "- 输出结论前要显式处理约束、风险、范围和待确认事项。",
      ...prdRule,
      "",
      "## 文档与记忆",
      `长期沉淀与文档保存：${memoryStorage}`,
      "确认后的业务规则、长期偏好和关键文档可以写入记忆；临时沟通只保留在会话上下文中。",
      "",
      "## 工作规则",
      `管理员指定规则：${workRules}`,
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

function summarizeRoleQuestionAnswers(
  roleQuestions: RoleQuestionRecord[],
  answers: Map<string, string>,
): string[] {
  return roleQuestions
    .filter((question) => answers.has(question.key))
    .map((question) => `${question.title}：${resolveRoleQuestionLabel(roleQuestions, question.key, answers.get(question.key))}`);
}

function resolveRoleQuestionLabel(
  roleQuestions: RoleQuestionRecord[],
  key: string,
  value: string | undefined,
): string {
  if (!value) {
    return "未指定";
  }
  const question = roleQuestions.find((item) => item.key === key);
  const option = (Array.isArray(question?.options_json) ? question.options_json : []).find((item) => item.value === value);
  return option?.label ?? value;
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

export function blockedReply(reason: unknown): string {
  if (reason === "admin_unclaimed") {
    return "机器人尚未完成管理员认领，请发送页面上的 /claim_admin <验证码>。";
  }
  if (reason === "initialization_required") {
    return "机器人已认领但尚未启用，请等待管理员完成启用。";
  }
  return "机器人暂不可用。";
}

export async function resolveMessageContext(
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
  method = "POST",
): Promise<T> {
  const response = await config.fetch(
    new Request(url, {
      method,
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

type WizardFieldKey =
  | "background"
  | "role"
  | "duties"
  | "interaction"
  | "option_guidance"
  | "memory"
  | "skills_mcp"
  | "constraints";

type SoulWizardFieldKey = "identity" | "communication";
type AgentsWizardFieldKey =
  | "core_work"
  | "interaction"
  | "memory"
  | "document_storage"
  | "skills_mcp"
  | "work_rules";

const SOUL_WIZARD_FIELDS: Array<{ key: SoulWizardFieldKey; label: string }> = [
  { key: "identity", label: "我是谁" },
  { key: "communication", label: "沟通风格" },
];

const AGENTS_WIZARD_FIELDS: Array<{ key: AgentsWizardFieldKey; label: string }> = [
  { key: "core_work", label: "核心工作" },
  { key: "interaction", label: "交互方式" },
  { key: "memory", label: "长期存储/长期记忆" },
  { key: "document_storage", label: "文档存储" },
  { key: "skills_mcp", label: "Skill / MCP 约束" },
  { key: "work_rules", label: "工作规则" },
];

const SOUL_WIZARD_QUESTIONS = [
  [
    "我是谁？",
    "",
    "请直接输入。",
  ].join("\n"),
  withWizardOptions("你希望我的沟通风格是什么？", {
    "1": "简洁直接",
    "2": "严谨完整",
    "3": "先问清楚再回答",
    "4": "给出选项辅助决策",
    "5": "其他，请直接说明",
  }),
];

const AGENTS_WIZARD_QUESTIONS = [
  withWizardOptions("Agents 引导 1/6：这个机器人只负责一类核心工作，你希望它的核心工作是什么？", {
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
  withWizardOptions("Agents 引导 2/6：你希望它用什么方式和用户交互？", {
    "1": "逐句引导，一次只问一个问题",
    "2": "批量引导，一次列出多个待确认项",
    "3": "先给推荐方案，再让用户确认",
    "4": "其他，请直接说明",
  }),
  withWizardOptions("Agents 引导 3/6：是否使用长期存储或长期记忆？", {
    "1": "使用，确认后的业务规则和文档需要沉淀",
    "2": "不使用，只保留当前会话",
    "3": "待定",
  }),
  withWizardOptions("Agents 引导 4/6：是否需要保存它生成的文档？", {
    "1": "需要，生成的 PRD/方案/纪要要保存",
    "2": "不需要，只在对话中输出",
    "3": "待定",
  }),
  withWizardOptions("Agents 引导 5/6：是否有固定 Skill / MCP / 工具约束？", {
    "1": "跳过，暂不固定",
    "2": "直接输入 Skill / MCP / 工具约束",
  }),
  withWizardOptions("Agents 引导 6/6：有没有必须遵守的工作规则？", {
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

const SOUL_COMMUNICATION_OPTIONS: Record<string, string> = {
  "1": "简洁直接",
  "2": "严谨完整",
  "3": "先问清楚再回答",
  "4": "给出选项辅助决策",
};

const LEGACY_SOUL_IDENTITY_OPTIONS: Record<string, string> = {
  "1": "产品经理助手",
  "2": "QA 测试助手",
  "3": "研发助理",
  "4": "技术文档助手",
  "5": "项目管理助手",
  "6": "市场分析助手",
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
