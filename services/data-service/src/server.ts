import {
  createDataStore,
  requireMemoryScope,
  type DataStore,
  type MemoryScope,
  type RoleQuestionDependency,
  type RoleQuestionOption,
  type UpdateBusinessDocumentInput,
} from "./store.js";
import type { CredentialVault, UserCredentialPayload } from "./credentialVault.js";
import { timingSafeEqual } from "node:crypto";

const PROJECT_DOTENV_ENV_KEY = "__PROJECT_DOTENV_FILE__";
const MAX_PROJECT_DOTENV_BYTES = 256 * 1024;

export interface DataServiceServer {
  fetch(request: Request): Promise<Response>;
}

export interface DataServiceServerConfig {
  credentialVault?: CredentialVault;
  credentialInternalToken?: string;
}

export function createDataServiceServer(
  store: DataStore = createDataStore(),
  config: DataServiceServerConfig = {},
): DataServiceServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(healthResponse("data-service"));
      }

      if (
        request.method === "POST"
        && url.pathname === "/internal/user-credential-bindings"
      ) {
        return handleCreateUserCredentialBinding(request, store, config);
      }

      const publicCredentialBindingMatch = url.pathname.match(
        /^\/v1\/credential-bindings\/([^/]+)$/,
      );
      if (request.method === "GET" && publicCredentialBindingMatch) {
        return handleGetUserCredentialBinding(store, publicCredentialBindingMatch[1]);
      }
      if (request.method === "POST" && publicCredentialBindingMatch) {
        return handleCompleteUserCredentialBinding(
          request,
          store,
          config,
          publicCredentialBindingMatch[1],
        );
      }

      if (
        url.pathname === "/internal/user-credentials"
        && (request.method === "GET" || request.method === "DELETE")
      ) {
        return handleUserCredential(request, url, store, config);
      }

      if (
        request.method === "GET"
        && url.pathname === "/internal/user-credentials/runtime-env"
      ) {
        return handleGetUserCredentialRuntimeEnv(request, url, store, config);
      }

      if (
        request.method === "GET"
        && url.pathname === "/internal/user-credentials/project-git"
      ) {
        return handleGetUserCredentialProjectGit(request, url, store, config);
      }

      const internalProjectEnvMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/project-env$/,
      );
      if (request.method === "GET" && internalProjectEnvMatch) {
        return withDecodedBotId(internalProjectEnvMatch[1], (botId) =>
          handleGetInternalBotProjectEnv(request, store, config, botId),
        );
      }

      const projectEnvMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/project-env$/);
      if (request.method === "GET" && projectEnvMatch) {
        return withDecodedBotId(projectEnvMatch[1], (botId) =>
          handleGetBotProjectEnvMetadata(store, botId),
        );
      }
      if (request.method === "PUT" && projectEnvMatch) {
        return withDecodedBotId(projectEnvMatch[1], (botId) =>
          handlePutBotProjectEnv(request, store, config, botId),
        );
      }
      if (request.method === "DELETE" && projectEnvMatch) {
        return withDecodedBotId(projectEnvMatch[1], (botId) =>
          handleDeleteBotProjectEnv(store, botId),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/bots") {
        return handleCreateBot(request, store);
      }

      if (request.method === "GET" && url.pathname === "/v1/bots") {
        return handleListBots(store);
      }

      if (request.method === "GET" && url.pathname === "/v1/bot-channels") {
        return handleListBotChannels(url, store);
      }

      const channelRoute = parseWeComChannelRoute(url.pathname);
      if (request.method === "GET" && channelRoute) {
        return handleGetBotChannelDetail(store, channelRoute.botId);
      }
      if (request.method === "DELETE" && channelRoute) {
        return handleDeleteBotChannel(store, channelRoute.botId);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/internal/wecom-runtime/bots"
      ) {
        return handleListWeComRuntimeBots(store);
      }

      if (request.method === "POST" && url.pathname === "/internal/reset-standard-role-config") {
        store.resetToStandardRoleConfig();
        return Response.json({
          ok: true,
          roles: store.listRoles().map((role) => role.name),
        });
      }

      if (request.method === "POST" && url.pathname === "/internal/documents") {
        return handleCreateBusinessDocument(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/documents") {
        return handleListBusinessDocuments(url, store);
      }

      const internalDocumentMatch = url.pathname.match(
        /^\/internal\/documents\/([^/]+)$/,
      );
      if (request.method === "GET" && internalDocumentMatch) {
        return handleGetBusinessDocument(url, store, internalDocumentMatch[1]);
      }
      if (request.method === "PATCH" && internalDocumentMatch) {
        return handleUpdateBusinessDocument(
          request,
          store,
          internalDocumentMatch[1],
        );
      }

      if (request.method === "POST" && url.pathname === "/internal/memories") {
        return handleCreateMemoryRecord(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/memories") {
        return handleListMemories(url, store);
      }

      if (request.method === "POST" && url.pathname === "/internal/chunks") {
        return handleRecordChunks(request, store);
      }

      if (request.method === "POST" && url.pathname === "/internal/assets") {
        return handleRecordAsset(request, store);
      }

      if (
        request.method === "PUT" &&
        url.pathname === "/internal/initialization-sessions"
      ) {
        return handleUpsertInitializationSession(request, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/internal/initialization-sessions/active"
      ) {
        return handleGetActiveInitializationSession(url, store);
      }

      if (
        request.method === "DELETE" &&
        url.pathname === "/internal/initialization-sessions/active"
      ) {
        return handleClearInitializationSession(url, store);
      }

      if (
        request.method === "PUT" &&
        url.pathname === "/internal/runtime-sessions"
      ) {
        return handleUpsertRuntimeSession(request, store);
      }

      const runtimeSessionMatch = url.pathname.match(/^\/internal\/runtime-sessions\/([^/]+)$/);
      if (request.method === "GET" && runtimeSessionMatch) {
        return handleGetRuntimeSession(store, runtimeSessionMatch[1]);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/pending-generated-documents"
      ) {
        return handleCreatePendingGeneratedDocument(request, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/internal/pending-generated-documents"
      ) {
        return handleListPendingGeneratedDocuments(url, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/pending-generated-documents/confirm"
      ) {
        return handleConfirmPendingGeneratedDocuments(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/pending-generated-documents/cancel"
      ) {
        return handleCancelPendingGeneratedDocuments(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/pending-generated-documents/apply-and-confirm"
      ) {
        return handleApplyPendingGeneratedDocuments(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/memory-stats") {
        return handleGetMemoryStats(url, store);
      }

      const runtimeConfigMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/runtime-config$/,
      );
      if (request.method === "GET" && runtimeConfigMatch) {
        return withDecodedBotId(runtimeConfigMatch[1], (botId) =>
          handleGetRuntimeConfig(store, botId),
        );
      }
      if (request.method === "PUT" && runtimeConfigMatch) {
        return withDecodedBotId(runtimeConfigMatch[1], (botId) =>
          handleUpsertRuntimeConfig(
            request,
            store,
            botId,
          ),
        );
      }

      const botMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)$/);
      if (request.method === "GET" && botMatch) {
        return handleGetBot(store, botMatch[1]);
      }
      if (request.method === "PATCH" && botMatch) {
        return handleUpdateBot(request, store, botMatch[1]);
      }

      const botMcpCapabilityConfigMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/mcp-capabilities\/config$/,
      );
      if (request.method === "GET" && botMcpCapabilityConfigMatch) {
        return handleGetBotMcpCapabilityConfig(store, botMcpCapabilityConfigMatch[1]);
      }
      if (request.method === "PUT" && botMcpCapabilityConfigMatch) {
        return handleUpdateBotMcpCapabilityConfig(
          request,
          store,
          botMcpCapabilityConfigMatch[1],
        );
      }

      const botConfigDocumentsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/config-documents$/,
      );
      if (request.method === "GET" && botConfigDocumentsMatch) {
        return handleListBotConfigDocuments(store, botConfigDocumentsMatch[1]);
      }

      const botRuntimePolicyMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/runtime-policy$/,
      );
      if (request.method === "GET" && botRuntimePolicyMatch) {
        return withDecodedBotId(botRuntimePolicyMatch[1], (botId) =>
          handleGetBotRuntimePolicy(store, botId),
        );
      }
      if (request.method === "POST" && botRuntimePolicyMatch) {
        return withDecodedBotId(botRuntimePolicyMatch[1], (botId) =>
          handleUpdateBotRuntimePolicy(
            request,
            store,
            botId,
          ),
        );
      }

      const botEnvMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/env$/);
      if (request.method === "GET" && botEnvMatch) {
        return withDecodedBotId(botEnvMatch[1], (botId) =>
          handleListBotEnvVars(store, botId),
        );
      }
      if (request.method === "POST" && botEnvMatch) {
        return withDecodedBotId(botEnvMatch[1], (botId) =>
          handleUpsertBotEnvVar(request, store, botId),
        );
      }

      const botEnvDeleteMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/env\/([^/]+)$/,
      );
      if (request.method === "DELETE" && botEnvDeleteMatch) {
        return withDecodedBotId(botEnvDeleteMatch[1], (botId) =>
          handleDeleteBotEnvVar(
            store,
            botId,
            botEnvDeleteMatch[2],
          ),
        );
      }

      const botSkillsMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/skills$/);
      if (request.method === "GET" && botSkillsMatch) {
        return withDecodedBotId(botSkillsMatch[1], (botId) =>
          handleListBotSkills(store, botId),
        );
      }
      if (request.method === "POST" && botSkillsMatch) {
        return withDecodedBotId(botSkillsMatch[1], (botId) =>
          handleUpsertBotSkill(request, store, botId),
        );
      }

      const botSkillDeleteMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/skills\/([^/]+)$/);
      if (request.method === "DELETE" && botSkillDeleteMatch) {
        return withDecodedBotId(botSkillDeleteMatch[1], (botId) =>
          handleDeleteBotSkill(store, botId, botSkillDeleteMatch[2]),
        );
      }

      const botMcpsMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/mcps$/);
      if (request.method === "GET" && botMcpsMatch) {
        return withDecodedBotId(botMcpsMatch[1], (botId) =>
          handleListBotMcps(store, botId),
        );
      }
      if (request.method === "POST" && botMcpsMatch) {
        return withDecodedBotId(botMcpsMatch[1], (botId) =>
          handleUpsertBotMcp(request, store, botId),
        );
      }

      const botMcpDeleteMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/mcps\/([^/]+)$/);
      if (request.method === "DELETE" && botMcpDeleteMatch) {
        return withDecodedBotId(botMcpDeleteMatch[1], (botId) =>
          handleDeleteBotMcp(store, botId, botMcpDeleteMatch[2]),
        );
      }

      const botCapabilityAuditLogsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/capability-audit-logs$/,
      );
      if (request.method === "GET" && botCapabilityAuditLogsMatch) {
        return withDecodedBotId(botCapabilityAuditLogsMatch[1], (botId) =>
          handleListBotCapabilityAuditLogs(
            store,
            botId,
          ),
        );
      }

      const wecomTestMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/wecom\/test$/,
      );
      if (request.method === "POST" && wecomTestMatch) {
        return handleTestWeComConnection(store, wecomTestMatch[1]);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/conversations/resolve"
      ) {
        return handleResolveConversation(request, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/conversations"
      ) {
        return handleListConversations(url, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/conversations"
      ) {
        return handleCreateConversation(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/conversations/open"
      ) {
        return handleOpenConversation(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/conversations/name"
      ) {
        return handleRenameConversation(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/message-context/resolve"
      ) {
        return handleResolveMessageContext(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/memory-documents"
      ) {
        return handleUpsertMemoryDocument(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/bot-config-documents"
      ) {
        return handleUpsertBotConfigDocument(request, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/memory-documents/current"
      ) {
        return handleListCurrentMemoryDocuments(url, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/global-documents"
      ) {
        return handleListGlobalDocuments(url, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/global-documents"
      ) {
        return handleCreateGlobalDocument(request, store);
      }

      const globalDocumentMatch = url.pathname.match(
        /^\/v1\/global-documents\/([^/]+)$/,
      );
      if (request.method === "PUT" && globalDocumentMatch) {
        return handleUpdateGlobalDocument(
          request,
          store,
          globalDocumentMatch[1],
        );
      }
      if (request.method === "DELETE" && globalDocumentMatch) {
        return handleDeleteGlobalDocument(store, globalDocumentMatch[1]);
      }

      if (request.method === "GET" && url.pathname === "/v1/roles") {
        return handleListRoles(url, store);
      }

      if (request.method === "POST" && url.pathname === "/v1/roles") {
        return handleCreateRole(request, store);
      }

      const roleMatch = url.pathname.match(/^\/v1\/roles\/([^/]+)$/);
      if (request.method === "GET" && roleMatch) {
        return handleGetRole(store, roleMatch[1]);
      }
      if (request.method === "PUT" && roleMatch) {
        return handleUpdateRole(request, store, roleMatch[1]);
      }
      if (request.method === "DELETE" && roleMatch) {
        return handleDeleteRole(store, roleMatch[1]);
      }

      const roleDocumentsMatch = url.pathname.match(
        /^\/v1\/roles\/([^/]+)\/documents$/,
      );
      if (request.method === "GET" && roleDocumentsMatch) {
        return handleListRoleDocuments(url, store, roleDocumentsMatch[1]);
      }
      if (request.method === "POST" && roleDocumentsMatch) {
        return handleCreateRoleDocument(request, store, roleDocumentsMatch[1]);
      }

      const roleDocumentMatch = url.pathname.match(
        /^\/v1\/roles\/([^/]+)\/documents\/([^/]+)$/,
      );
      if (request.method === "PUT" && roleDocumentMatch) {
        return handleUpdateRoleDocument(
          request,
          store,
          roleDocumentMatch[1],
          roleDocumentMatch[2],
        );
      }
      if (request.method === "DELETE" && roleDocumentMatch) {
        return handleDeleteRoleDocument(
          store,
          roleDocumentMatch[1],
          roleDocumentMatch[2],
        );
      }

      const roleQuestionsMatch = url.pathname.match(
        /^\/v1\/roles\/([^/]+)\/questions$/,
      );
      if (request.method === "GET" && roleQuestionsMatch) {
        return handleListRoleQuestions(url, store, roleQuestionsMatch[1]);
      }
      if (request.method === "POST" && roleQuestionsMatch) {
        return handleCreateRoleQuestion(request, store, roleQuestionsMatch[1]);
      }

      const roleQuestionMatch = url.pathname.match(
        /^\/v1\/roles\/([^/]+)\/questions\/([^/]+)$/,
      );
      if (request.method === "PUT" && roleQuestionMatch) {
        return handleUpdateRoleQuestion(
          request,
          store,
          roleQuestionMatch[1],
          roleQuestionMatch[2],
        );
      }
      if (request.method === "DELETE" && roleQuestionMatch) {
        return handleDeleteRoleQuestion(
          store,
          roleQuestionMatch[1],
          roleQuestionMatch[2],
        );
      }

      const memoryDocumentVersionsMatch = url.pathname.match(
        /^\/v1\/memory-documents\/([^/]+)\/versions$/,
      );
      if (request.method === "GET" && memoryDocumentVersionsMatch) {
        return handleListMemoryDocumentVersions(
          store,
          memoryDocumentVersionsMatch[1],
        );
      }

      const adminClaimMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claim$/,
      );
      if (request.method === "POST" && adminClaimMatch) {
        return handleClaimAdmin(request, store, adminClaimMatch[1]);
      }

      const adminClaimsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claims$/,
      );
      if (request.method === "POST" && adminClaimsMatch) {
        return handleCreateAdminClaim(store, adminClaimsMatch[1]);
      }

      const adminResetMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/reset$/,
      );
      if (request.method === "POST" && adminResetMatch) {
        return handleResetAdminClaim(store, adminResetMatch[1]);
      }

      const adminMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/admin$/);
      if (request.method === "GET" && adminMatch) {
        return handleGetAdmin(store, adminMatch[1]);
      }

      const adminTransferMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/transfer$/,
      );
      if (request.method === "POST" && adminTransferMatch) {
        return handleTransferAdmin(request, store, adminTransferMatch[1]);
      }

      const adminClaimVerifyMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claim\/verify$/,
      );
      if (request.method === "POST" && adminClaimVerifyMatch) {
        return handleVerifyAdminClaim(request, store, adminClaimVerifyMatch[1]);
      }

      const readyMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/ready$/);
      if (request.method === "POST" && readyMatch) {
        return handleMarkReady(store, readyMatch[1]);
      }

      const resetMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/reset$/);
      if (request.method === "POST" && resetMatch) {
        return handleResetBot(store, resetMatch[1]);
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

async function handleCreateBot(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createBot(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBot(store: DataStore, botId: string): Response {
  try {
    const bot = store.getBot(botId);
    if (!bot) {
      return jsonResponse({ error: `bot not found: ${botId}` }, 404);
    }
    return jsonResponse(bot);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBots(store: DataStore): Response {
  try {
    return jsonResponse(store.listBots());
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotChannels(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(
      store.listBotChannels(url.searchParams.get("bot_id") ?? undefined),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function parseWeComChannelRoute(pathname: string): { botId: string } | undefined {
  const match = pathname.match(/^\/v1\/bot-channels\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const channelId = decodeURIComponent(match[1]);
  if (!channelId.startsWith("wecom:")) {
    return undefined;
  }
  const botId = channelId.slice("wecom:".length);
  return botId ? { botId } : undefined;
}

function handleGetBotChannelDetail(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.getBotChannelDetail(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotChannel(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.deleteBotChannel(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListWeComRuntimeBots(store: DataStore): Response {
  try {
    return jsonResponse(store.listWeComRuntimeBots());
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateBusinessDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createBusinessDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateBusinessDocument(
  request: Request,
  store: DataStore,
  documentId: string,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<UpdateBusinessDocumentInput>;
    if (typeof body.content !== "string" || body.content.trim() === "") {
      throw new Error("content is required");
    }
    return jsonResponse(store.updateBusinessDocument({
      content: body.content,
      ...(body.change_summary ? { change_summary: body.change_summary } : {}),
      ...(body.chunk_count !== undefined ? { chunk_count: body.chunk_count } : {}),
      document_id: documentId,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBusinessDocument(
  url: URL,
  store: DataStore,
  documentId: string,
): Response {
  try {
    const versionParam = url.searchParams.get("version");
    const version = versionParam === null ? undefined : Number(versionParam);
    if (
      versionParam !== null &&
      (!Number.isInteger(Number(versionParam)) || Number(versionParam) < 1)
    ) {
      throw new Error("version must be a positive integer");
    }
    const document = store.getBusinessDocument(documentId, version);
    if (!document) {
      return jsonResponse({ error: `business document not found: ${documentId}` }, 404);
    }
    return jsonResponse(document);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBusinessDocuments(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(store.listBusinessDocuments({
      scope: optionalMemoryScope(url.searchParams.get("scope")),
      owner_id: optionalSearchParam(url, "owner_id"),
      doc_type: optionalSearchParam(url, "doc_type"),
      status: optionalActiveStatus(url.searchParams.get("status")),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateMemoryRecord(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createMemoryRecord(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListMemories(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(store.listMemories({
      scope: optionalMemoryScope(url.searchParams.get("scope")),
      owner_id: optionalSearchParam(url, "owner_id"),
      tier: optionalTier(url.searchParams.get("tier")),
      status: optionalActiveStatus(url.searchParams.get("status")),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRecordChunks(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.recordChunks(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRecordAsset(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.recordAsset(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertInitializationSession(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertInitializationSession(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetActiveInitializationSession(
  url: URL,
  store: DataStore,
): Response {
  try {
    return jsonResponse(store.getActiveInitializationSession({
      bot_id: url.searchParams.get("bot_id") ?? "",
      wecom_user_id: url.searchParams.get("wecom_user_id") ?? "",
      conversation_id: url.searchParams.get("conversation_id") ?? "",
    }) ?? null);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleClearInitializationSession(
  url: URL,
  store: DataStore,
): Response {
  try {
    store.clearInitializationSession({
      bot_id: url.searchParams.get("bot_id") ?? "",
      wecom_user_id: url.searchParams.get("wecom_user_id") ?? "",
      conversation_id: url.searchParams.get("conversation_id") ?? "",
    });
    return jsonResponse({ cleared: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertRuntimeSession(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertRuntimeSession(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetRuntimeSession(
  store: DataStore,
  encodedRunnerSessionId: string,
): Response {
  try {
    const runnerSessionId = decodeURIComponent(encodedRunnerSessionId);
    const session = store.getRuntimeSession(runnerSessionId);
    return session ? jsonResponse(session) : jsonResponse({ error: "runtime session not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreatePendingGeneratedDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createPendingGeneratedDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListPendingGeneratedDocuments(
  url: URL,
  store: DataStore,
): Response {
  try {
    return jsonResponse(store.listPendingGeneratedDocuments({
      bot_id: url.searchParams.get("bot_id") ?? "",
      wecom_user_id: url.searchParams.get("wecom_user_id") ?? "",
      conversation_id: url.searchParams.get("conversation_id") ?? "",
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleConfirmPendingGeneratedDocuments(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.confirmPendingGeneratedDocuments(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCancelPendingGeneratedDocuments(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.cancelPendingGeneratedDocuments(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleApplyPendingGeneratedDocuments(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.applyPendingGeneratedDocuments(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetMemoryStats(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(store.getMemoryStats({
      scope: optionalMemoryScope(url.searchParams.get("scope")),
      owner_id: optionalSearchParam(url, "owner_id"),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetRuntimeConfig(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.getRuntimeConfig(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function withDecodedBotId<T extends Response | Promise<Response>>(
  pathSegment: string,
  callback: (botId: string) => T,
): T | Response {
  try {
    return callback(decodeURIComponent(pathSegment));
  } catch (error) {
    if (error instanceof URIError) {
      return errorResponse(new Error("bot_id path segment is malformed"));
    }
    throw error;
  }
}

async function handleUpsertRuntimeConfig(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertRuntimeConfig(botId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateBot(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(store.updateBot(botId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBotMcpCapabilityConfig(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.getBotMcpCapabilityConfig(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateBotMcpCapabilityConfig(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(
      store.updateBotMcpCapabilityConfig(botId, await request.json()),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBotRuntimePolicy(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.getOrCreateBotRuntimePolicy(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateBotRuntimePolicy(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(store.updateBotRuntimePolicy(botId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotEnvVars(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse({
      items: store.listBotEnvVars(botId)
        .filter((item) => item.key !== PROJECT_DOTENV_ENV_KEY),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBotProjectEnvMetadata(
  store: DataStore,
  botId: string,
): Response {
  try {
    const record = store.getBotEnvVar(botId, PROJECT_DOTENV_ENV_KEY);
    return jsonResponse({
      configured: Boolean(record),
      ...(record ? { updated_at: record.updated_at } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handlePutBotProjectEnv(
  request: Request,
  store: DataStore,
  config: DataServiceServerConfig,
  botId: string,
): Promise<Response> {
  try {
    if (!config.credentialVault) {
      return jsonResponse({ error: "credential vault is not configured" }, 503);
    }
    const body = await request.json() as {
      content?: unknown;
      updated_by_wecom_user_id?: unknown;
    };
    const content = requireProjectDotenvContent(body.content);
    const record = store.upsertBotEnvVar(botId, {
      key: PROJECT_DOTENV_ENV_KEY,
      value_ciphertext: config.credentialVault.encryptText(content),
      updated_by_wecom_user_id: requireText(
        body.updated_by_wecom_user_id,
        "updated_by_wecom_user_id",
      ),
    });
    return jsonResponse({
      configured: true,
      updated_at: record.updated_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotProjectEnv(
  store: DataStore,
  botId: string,
): Response {
  try {
    store.deleteBotEnvVar(botId, PROJECT_DOTENV_ENV_KEY);
    return jsonResponse({ configured: false });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetInternalBotProjectEnv(
  request: Request,
  store: DataStore,
  config: DataServiceServerConfig,
  botId: string,
): Response {
  const accessError = internalCredentialAccessError(request, config);
  if (accessError) {
    return accessError;
  }
  if (!config.credentialVault) {
    return jsonResponse({ error: "credential vault is not configured" }, 503);
  }
  try {
    const record = store.getBotEnvVar(botId, PROJECT_DOTENV_ENV_KEY);
    return jsonResponse(record
      ? {
          configured: true,
          content: config.credentialVault.decryptText(record.value_ciphertext),
        }
      : { configured: false });
  } catch (error) {
    return errorResponse(error);
  }
}

function requireProjectDotenvContent(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("project .env content is required");
  }
  if (value.includes("\0")) {
    throw new Error("project .env content contains an invalid character");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PROJECT_DOTENV_BYTES) {
    throw new Error("project .env content is too large");
  }
  return value;
}

async function handleUpsertBotEnvVar(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = await request.json() as {
      key?: string;
      value_ciphertext?: string;
      updated_by_wecom_user_id?: string;
    };
    store.upsertBotEnvVar(botId, {
      key: requireText(body.key, "key"),
      value_ciphertext: requireText(body.value_ciphertext, "value_ciphertext"),
      updated_by_wecom_user_id: requireText(
        body.updated_by_wecom_user_id,
        "updated_by_wecom_user_id",
      ),
    });
    const record = store
      .listBotEnvVars(botId)
      .find((item) => item.key === body.key);
    return jsonResponse(record ?? null, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotEnvVar(
  store: DataStore,
  botId: string,
  key: string,
): Response {
  try {
    store.deleteBotEnvVar(botId, decodeURIComponent(key));
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotSkills(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.listBotSkills(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertBotSkill(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const record = store.upsertBotSkill(botId, {
      name: requireText(body.name, "name"),
      source_type: requireText(body.source_type, "source_type") as "builtin" | "github" | "url" | "local",
      source_ref: requireText(body.source_ref, "source_ref"),
      status: requireText(body.status, "status") as "installing" | "installed" | "failed",
      installed_by_wecom_user_id: requireText(body.installed_by_wecom_user_id, "installed_by_wecom_user_id"),
      last_error: typeof body.last_error === "string" ? body.last_error : undefined,
    });
    return jsonResponse(record, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotSkill(
  store: DataStore,
  botId: string,
  name: string,
): Response {
  try {
    store.deleteBotSkill(botId, decodeURIComponent(name));
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotMcps(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.listBotMcps(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertBotMcp(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const record = store.upsertBotMcp(botId, {
      name: requireText(body.name, "name"),
      mode: requireText(body.mode, "mode") as "config" | "package",
      source_ref: requireText(body.source_ref, "source_ref"),
      status: requireText(body.status, "status") as "installing" | "installed" | "failed",
      installed_by_wecom_user_id: requireText(body.installed_by_wecom_user_id, "installed_by_wecom_user_id"),
      last_error: typeof body.last_error === "string" ? body.last_error : undefined,
    });
    return jsonResponse(record, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotMcp(
  store: DataStore,
  botId: string,
  name: string,
): Response {
  try {
    store.deleteBotMcp(botId, decodeURIComponent(name));
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotCapabilityAuditLogs(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.listBotCapabilityAuditLogs(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleTestWeComConnection(
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(await store.testWeComConnection(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleResolveConversation(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.resolveConversation(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleListConversations(
  url: URL,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.listConversations({
      bot_id: requireQueryParam(url, "bot_id"),
      wecom_user_id: requireQueryParam(url, "wecom_user_id"),
      channel: requireConversationChannel(requireQueryParam(url, "channel")),
      purpose: requireConversationPurpose(requireQueryParam(url, "purpose")),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateConversation(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createConversation(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleOpenConversation(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.openConversation(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRenameConversation(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.renameConversation(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

function requireQueryParam(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null || value.trim() === "") {
    throw new Error(`missing query param: ${key}`);
  }
  return value;
}

function requireConversationChannel(value: string) {
  if (value !== "wecom_direct" && value !== "wecom_group") {
    throw new Error(`invalid conversation channel: ${value}`);
  }
  return value;
}

function requireConversationPurpose(value: string) {
  if (value !== "normal_chat" && value !== "init" && value !== "doc_generation") {
    throw new Error(`invalid conversation purpose: ${value}`);
  }
  return value;
}

async function handleResolveMessageContext(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.resolveMessageContext(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleClaimAdmin(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { wecom_user_id?: string };
    return jsonResponse(
      store.claimAdmin({
        bot_id: botId,
        wecom_user_id: body.wecom_user_id ?? "",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertMemoryDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertMemoryDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertBotConfigDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertBotConfigDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateGlobalDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    const body = await request.json() as {
      title?: string;
      slug?: string;
      content?: string;
      enabled?: boolean;
      sort_order?: number;
    };
    const existing = store.listGlobalDocuments({ includeDisabled: true }).find(
      (document) => document.slug === body.slug,
    );
    if (existing) {
      return jsonResponse({ error: `global document slug already exists: ${body.slug}` }, 400);
    }
    return jsonResponse(store.upsertGlobalDocument({
      title: requireText(body.title, "title"),
      slug: requireText(body.slug, "slug"),
      content: requireText(body.content, "content"),
      enabled: body.enabled,
      sort_order: body.sort_order,
    }), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListGlobalDocuments(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(store.listGlobalDocuments({
      includeDisabled: parseIncludeDisabled(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateGlobalDocument(
  request: Request,
  store: DataStore,
  documentId: string,
): Promise<Response> {
  try {
    const existing = store.listGlobalDocuments({ includeDisabled: true }).find(
      (document) => document.document_id === documentId,
    );
    if (!existing) {
      return jsonResponse({ error: `global document not found: ${documentId}` }, 404);
    }
    const body = await request.json() as {
      title?: string;
      slug?: string;
      content?: string;
      enabled?: boolean;
      sort_order?: number;
    };
    return jsonResponse(store.upsertGlobalDocument({
      document_id: documentId,
      title: body.title ?? "",
      slug: body.slug ?? "",
      content: body.content ?? "",
      enabled: body.enabled,
      sort_order: body.sort_order,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteGlobalDocument(
  store: DataStore,
  documentId: string,
): Response {
  try {
    const existing = store.listGlobalDocuments({ includeDisabled: true }).find(
      (document) => document.document_id === documentId,
    );
    if (!existing) {
      return jsonResponse({ error: `global document not found: ${documentId}` }, 404);
    }
    store.deleteGlobalDocument(documentId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateRole(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    const body = await request.json() as {
      name?: string;
      slug?: string;
      description?: string;
      enabled?: boolean;
      sort_order?: number;
    };
    const existing = store.listRoles({ includeDisabled: true }).find(
      (role) => role.slug === body.slug,
    );
    if (existing) {
      return jsonResponse({ error: `role slug already exists: ${body.slug}` }, 400);
    }
    return jsonResponse(store.upsertRole({
      name: requireText(body.name, "name"),
      slug: requireText(body.slug, "slug"),
      description: body.description ?? "",
      enabled: body.enabled,
      sort_order: body.sort_order,
    }), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListRoles(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(store.listRoles({
      includeDisabled: parseIncludeDisabled(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetRole(store: DataStore, roleId: string): Response {
  try {
    const role = store.listRoles({ includeDisabled: true }).find(
      (item) => item.role_id === roleId,
    );
    if (!role) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    return jsonResponse(role);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateRole(
  request: Request,
  store: DataStore,
  roleId: string,
): Promise<Response> {
  try {
    const existing = store.listRoles({ includeDisabled: true }).find(
      (role) => role.role_id === roleId,
    );
    if (!existing) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    const body = await request.json() as {
      name?: string;
      slug?: string;
      description?: string;
      enabled?: boolean;
      sort_order?: number;
    };
    return jsonResponse(store.upsertRole({
      role_id: roleId,
      name: body.name ?? "",
      slug: body.slug ?? "",
      description: body.description ?? "",
      enabled: body.enabled,
      sort_order: body.sort_order,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteRole(store: DataStore, roleId: string): Response {
  try {
    const existing = store.listRoles({ includeDisabled: true }).find(
      (role) => role.role_id === roleId,
    );
    if (!existing) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    store.deleteRole(roleId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateRoleDocument(
  request: Request,
  store: DataStore,
  roleId: string,
): Promise<Response> {
  try {
    const role = store.listRoles({ includeDisabled: true }).find(
      (record) => record.role_id === roleId,
    );
    if (!role) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    const body = await request.json() as {
      title?: string;
      content?: string;
      enabled?: boolean;
    };
    const existing = store
      .listRoleDocuments(roleId, { includeDisabled: true })
      .find((document) => document.title === body.title);
    if (existing) {
      return jsonResponse(
        { error: `role document already exists for role ${roleId} and title ${body.title}` },
        400,
      );
    }
    return jsonResponse(store.upsertRoleDocument({
      role_id: roleId,
      title: body.title ?? "",
      content: body.content ?? "",
      enabled: body.enabled,
    }), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListRoleDocuments(
  url: URL,
  store: DataStore,
  roleId: string,
): Response {
  try {
    const role = store.listRoles({ includeDisabled: true }).find(
      (record) => record.role_id === roleId,
    );
    if (!role) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    return jsonResponse(store.listRoleDocuments(roleId, {
      includeDisabled: parseIncludeDisabled(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateRoleDocument(
  request: Request,
  store: DataStore,
  roleId: string,
  roleDocumentId: string,
): Promise<Response> {
  try {
    const existing = store
      .listRoleDocuments(roleId, { includeDisabled: true })
      .find((document) => document.role_document_id === roleDocumentId);
    if (!existing) {
      return jsonResponse({ error: `role document not found: ${roleDocumentId}` }, 404);
    }
    const body = await request.json() as {
      title?: string;
      content?: string;
      enabled?: boolean;
    };
    return jsonResponse(store.upsertRoleDocument({
      role_document_id: roleDocumentId,
      role_id: roleId,
      title: body.title ?? "",
      content: body.content ?? "",
      enabled: body.enabled,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteRoleDocument(
  store: DataStore,
  roleId: string,
  roleDocumentId: string,
): Response {
  try {
    const existing = store
      .listRoleDocuments(roleId, { includeDisabled: true })
      .find((document) => document.role_document_id === roleDocumentId);
    if (!existing) {
      return jsonResponse({ error: `role document not found: ${roleDocumentId}` }, 404);
    }
    store.deleteRoleDocument(roleDocumentId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateRoleQuestion(
  request: Request,
  store: DataStore,
  roleId: string,
): Promise<Response> {
  try {
    const role = store.listRoles({ includeDisabled: true }).find(
      (record) => record.role_id === roleId,
    );
    if (!role) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    const body = await request.json() as {
      key?: string;
      title?: string;
      description?: string;
      question_type?: string;
      options_json?: Array<{ value?: string; label?: string }>;
      required?: boolean;
      enabled?: boolean;
      sort_order?: number;
      depends_on_json?: Array<{ key?: string; equals?: string }>;
    };
    const existing = store
      .listRoleQuestions(roleId, { includeDisabled: true })
      .find((question) => question.key === body.key);
    if (existing) {
      return jsonResponse(
        { error: `role question already exists for role ${roleId} and key ${body.key}` },
        400,
      );
    }
    return jsonResponse(store.upsertRoleQuestion({
      role_id: roleId,
      key: requireText(body.key, "key"),
      title: requireText(body.title, "title"),
      description: body.description,
      question_type: body.question_type as "single_choice" | "multi_choice" | "free_text",
      options_json: parseRoleQuestionOptions(body.options_json),
      required: body.required,
      enabled: body.enabled,
      sort_order: body.sort_order,
      depends_on_json: parseRoleQuestionDependencies(body.depends_on_json),
    }), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListRoleQuestions(
  url: URL,
  store: DataStore,
  roleId: string,
): Response {
  try {
    const role = store.listRoles({ includeDisabled: true }).find(
      (record) => record.role_id === roleId,
    );
    if (!role) {
      return jsonResponse({ error: `role not found: ${roleId}` }, 404);
    }
    return jsonResponse(store.listRoleQuestions(roleId, {
      includeDisabled: parseIncludeDisabled(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateRoleQuestion(
  request: Request,
  store: DataStore,
  roleId: string,
  questionId: string,
): Promise<Response> {
  try {
    const existing = store
      .listRoleQuestions(roleId, { includeDisabled: true })
      .find((question) => question.question_id === questionId);
    if (!existing) {
      return jsonResponse({ error: `role question not found: ${questionId}` }, 404);
    }
    const body = await request.json() as {
      key?: string;
      title?: string;
      description?: string;
      question_type?: string;
      options_json?: Array<{ value?: string; label?: string }>;
      required?: boolean;
      enabled?: boolean;
      sort_order?: number;
      depends_on_json?: Array<{ key?: string; equals?: string }>;
    };
    return jsonResponse(store.upsertRoleQuestion({
      question_id: questionId,
      role_id: roleId,
      key: requireText(body.key, "key"),
      title: requireText(body.title, "title"),
      description: body.description,
      question_type: body.question_type as "single_choice" | "multi_choice" | "free_text",
      options_json: parseRoleQuestionOptions(body.options_json),
      required: body.required,
      enabled: body.enabled,
      sort_order: body.sort_order,
      depends_on_json: parseRoleQuestionDependencies(body.depends_on_json),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteRoleQuestion(
  store: DataStore,
  roleId: string,
  questionId: string,
): Response {
  try {
    const existing = store
      .listRoleQuestions(roleId, { includeDisabled: true })
      .find((question) => question.question_id === questionId);
    if (!existing) {
      return jsonResponse({ error: `role question not found: ${questionId}` }, 404);
    }
    store.deleteRoleQuestion(questionId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotConfigDocuments(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.listBotConfigDocuments(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListMemoryDocumentVersions(
  store: DataStore,
  memoryDocId: string,
): Response {
  try {
    return jsonResponse(store.listMemoryDocumentVersions(memoryDocId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListCurrentMemoryDocuments(
  url: URL,
  store: DataStore,
): Response {
  try {
    return jsonResponse(
      store.listCurrentMemoryDocuments({
        scope: requireMemoryScope(url.searchParams.get("scope")),
        owner_id: url.searchParams.get("owner_id") ?? "",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function handleMarkReady(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.markBotReady(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleResetBot(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.resetBot(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleCreateAdminClaim(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.createAdminClaim(botId), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleResetAdminClaim(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.resetAdminClaim(botId), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetAdmin(store: DataStore, botId: string): Response {
  try {
    const admin = store.getAdmin(botId);
    if (!admin) {
      return jsonResponse({ error: `admin not found for bot: ${botId}` }, 404);
    }
    return jsonResponse(admin);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleTransferAdmin(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      current_wecom_user_id?: string;
      new_wecom_user_id?: string;
    };
    return jsonResponse(
      store.transferAdmin({
        bot_id: botId,
        current_wecom_user_id: body.current_wecom_user_id ?? "",
        new_wecom_user_id: body.new_wecom_user_id ?? "",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleVerifyAdminClaim(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      wecom_user_id?: string;
      code?: string;
    };
    return jsonResponse(
      store.verifyAdminClaim({
        bot_id: botId,
        wecom_user_id: body.wecom_user_id ?? "",
        code: body.code ?? "",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateUserCredentialBinding(
  request: Request,
  store: DataStore,
  config: DataServiceServerConfig,
): Promise<Response> {
  const accessError = internalCredentialAccessError(request, config);
  if (accessError) {
    return accessError;
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const binding = store.createUserCredentialBinding({
      bot_id: requireText(body.bot_id, "bot_id"),
      wecom_user_id: requireText(body.wecom_user_id, "wecom_user_id"),
      provider: requireCredentialProvider(body.provider),
    });
    return jsonResponse({
      token: binding.token,
      provider: binding.provider,
      expires_at: binding.expires_at,
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetUserCredentialBinding(
  store: DataStore,
  encodedToken: string,
): Response {
  try {
    const binding = store.getUserCredentialBinding(decodeURIComponent(encodedToken));
    if (!binding) {
      return jsonResponse({ error: "credential binding link is invalid or expired" }, 404);
    }
    return jsonResponse({
      provider: binding.provider,
      expires_at: binding.expires_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCompleteUserCredentialBinding(
  request: Request,
  store: DataStore,
  config: DataServiceServerConfig,
  encodedToken: string,
): Promise<Response> {
  if (!config.credentialVault) {
    return jsonResponse({ error: "user credential vault is not configured" }, 503);
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const binding = store.getUserCredentialBinding(decodeURIComponent(encodedToken));
    if (!binding) {
      return jsonResponse({ error: "credential binding link is invalid or expired" }, 404);
    }
    const payload = normalizeCredentialPayload(binding.provider, body);
    const metadata = store.completeUserCredentialBinding({
      token: decodeURIComponent(encodedToken),
      payload_ciphertext: config.credentialVault.encrypt(payload),
    });
    return jsonResponse({
      provider: metadata.provider,
      is_bound: metadata.is_bound,
      updated_at: metadata.updated_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleUserCredential(
  request: Request,
  url: URL,
  store: DataStore,
  config: DataServiceServerConfig,
): Response {
  const accessError = internalCredentialAccessError(request, config);
  if (accessError) {
    return accessError;
  }
  try {
    const scope = credentialScopeFromUrl(url);
    if (request.method === "DELETE") {
      store.deleteUserCredential(scope);
      return jsonResponse({ deleted: true });
    }
    const metadata = store.getUserCredentialMetadata(scope);
    return jsonResponse(metadata ?? {
      ...scope,
      is_bound: false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetUserCredentialRuntimeEnv(
  request: Request,
  url: URL,
  store: DataStore,
  config: DataServiceServerConfig,
): Response {
  const accessError = internalCredentialAccessError(request, config);
  if (accessError) {
    return accessError;
  }
  if (!config.credentialVault) {
    return jsonResponse({ error: "user credential vault is not configured" }, 503);
  }
  try {
    const credential = store.getUserCredential(credentialScopeFromUrl(url));
    if (!credential) {
      return jsonResponse({ env: {} });
    }
    const payload = config.credentialVault.decrypt(credential.payload_ciphertext);
    if (payload.provider === "github_fork") {
      return jsonResponse({ env: {} });
    }
    return jsonResponse({
      env: {
        MY_AGENT_JIRA_CREDENTIAL_VERSION: credential.updated_at,
        EASEMOB_JIRA_USERNAME: payload.username,
        EASEMOB_JIRA_PASSWORD: payload.password,
        ...(payload.redirect_username
          ? { EASEMOB_JIRA_REDIRECT_USERNAME: payload.redirect_username }
          : {}),
        ...(payload.redirect_password
          ? { EASEMOB_JIRA_REDIRECT_PASSWORD: payload.redirect_password }
          : {}),
      },
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "credential lookup failed",
    }, 500);
  }
}

function handleGetUserCredentialProjectGit(
  request: Request,
  url: URL,
  store: DataStore,
  config: DataServiceServerConfig,
): Response {
  const accessError = internalCredentialAccessError(request, config);
  if (accessError) {
    return accessError;
  }
  if (!config.credentialVault) {
    return jsonResponse({ error: "user credential vault is not configured" }, 503);
  }
  try {
    const scope = credentialScopeFromUrl(url);
    if (scope.provider !== "github_fork") {
      return jsonResponse({ error: "github fork credential is required" }, 400);
    }
    const projectKey = requireText(url.searchParams.get("project_key"), "project_key");
    const credential = store.getUserCredential(scope);
    if (!credential) {
      return jsonResponse({ error: "GitHub fork is not bound for the current WeCom user and Bot. Send /github bind first." }, 404);
    }
    const payload = config.credentialVault.decrypt(credential.payload_ciphertext);
    if (payload.provider !== "github_fork") {
      return jsonResponse({ error: "GitHub fork credential is invalid" }, 500);
    }
    return jsonResponse({
      project_key: projectKey,
      repository_url: payload.repository_url,
      branch: payload.branch,
      access_token: payload.access_token,
      credential_version: credential.updated_at,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "GitHub credential lookup failed" }, 500);
  }
}

function credentialScopeFromUrl(url: URL) {
  return {
    bot_id: requireText(url.searchParams.get("bot_id"), "bot_id"),
    wecom_user_id: requireText(
      url.searchParams.get("wecom_user_id"),
      "wecom_user_id",
    ),
    provider: requireCredentialProvider(url.searchParams.get("provider")),
  };
}

function requireCredentialProvider(value: unknown): "easemob_jira" | "github_fork" {
  if (value !== "easemob_jira" && value !== "github_fork") {
    throw new Error("unsupported credential provider");
  }
  return value;
}

function normalizeCredentialPayload(
  provider: "easemob_jira" | "github_fork",
  body: Record<string, unknown>,
): UserCredentialPayload {
  if (provider === "github_fork") {
    return {
      provider,
      access_token: requireSecret(body.access_token, "access_token"),
      repository_url: requireSecret(body.repository_url, "repository_url"),
      branch: requireSecret(body.branch, "branch"),
    };
  }
  const username = requireSecret(body.username, "username");
  const password = requireSecret(body.password, "password");
  const redirectUsername = optionalSecret(body.redirect_username);
  const redirectPassword = optionalSecret(body.redirect_password);
  if (Boolean(redirectUsername) !== Boolean(redirectPassword)) {
    throw new Error("redirect username and password must be provided together");
  }
  return {
    provider,
    username,
    password,
    ...(redirectUsername ? { redirect_username: redirectUsername } : {}),
    ...(redirectPassword ? { redirect_password: redirectPassword } : {}),
  };
}

function internalCredentialAccessError(
  request: Request,
  config: DataServiceServerConfig,
): Response | undefined {
  const expected = config.credentialInternalToken?.trim();
  if (!expected) {
    return jsonResponse({ error: "user credential internal token is not configured" }, 503);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (
    expectedBuffer.length !== actualBuffer.length
    || !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return undefined;
}

function requireSecret(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function optionalSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalSearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function parseIncludeDisabled(url: URL): boolean {
  return url.searchParams.get("include_disabled") === "true";
}

function requireText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function parseRoleQuestionOptions(
  value: Array<{ value?: string; label?: string }> | undefined,
): RoleQuestionOption[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.map((option, index) => ({
    value: requireText(option.value, `options_json[${index}].value`),
    label: requireText(option.label, `options_json[${index}].label`),
  }));
}

function parseRoleQuestionDependencies(
  value: Array<{ key?: string; equals?: string }> | undefined,
): RoleQuestionDependency[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.map((dependency, index) => ({
    key: requireText(dependency.key, `depends_on_json[${index}].key`),
    equals: requireText(dependency.equals, `depends_on_json[${index}].equals`),
  }));
}

function optionalMemoryScope(value: string | null): MemoryScope | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  return requireMemoryScope(value);
}

function optionalTier(value: string | null): "core" | "reference" | "temp" | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (value === "core" || value === "reference" || value === "temp") {
    return value;
  }
  throw new Error("tier must be core, reference, or temp");
}

function optionalActiveStatus(value: string | null): "active" | "archived" | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (value === "active" || value === "archived") {
    return value;
  }
  throw new Error("status must be active or archived");
}

function errorResponse(error: unknown): Response {
  return jsonResponse(
    { error: error instanceof Error ? error.message : "invalid request" },
    400,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
