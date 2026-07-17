import type { BotHostConfig } from "./server.js";

export interface InitializationSessionDto {
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

export interface PendingGeneratedDocumentDto {
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

export interface BotRuntimePolicyDto {
  bot_id: string;
  skill_install_policy: "open" | "admin_only";
  mcp_manage_policy: "open" | "admin_only";
}

export interface BotEnvVarMetadataDto {
  bot_id: string;
  key: string;
  is_set: boolean;
  updated_at: string;
}

export interface UpsertBotEnvVarInput {
  key: string;
  value_ciphertext: string;
  updated_by_wecom_user_id: string;
}

export interface UserEnvVarMetadataDto {
  bot_id: string;
  wecom_user_id: string;
  key: string;
  is_set: true;
  updated_at: string;
}

export interface UserEnvScopeDto {
  bot_id: string;
  wecom_user_id: string;
}

export interface BotSkillDto {
  bot_id: string;
  name: string;
  source_type: string;
  source_ref: string;
  status: string;
}

export interface BotMcpDto {
  bot_id: string;
  name: string;
  mode: string;
  source_ref: string;
  status: string;
}

export interface BotCapabilityAuditLogDto {
  bot_id: string;
  action_type: string;
  target_name: string;
  result: string;
  created_at: string;
}

export interface UserCredentialScopeDto {
  bot_id: string;
  wecom_user_id: string;
  provider: "easemob_jira" | "github_fork";
}

export interface UserCredentialStatusDto extends UserCredentialScopeDto {
  is_bound: boolean;
  updated_at?: string;
}

export interface UserCredentialBindingDto {
  token: string;
  provider: "easemob_jira" | "github_fork";
  expires_at: string;
}

export async function createUserCredentialBinding(
  config: BotHostConfig,
  input: UserCredentialScopeDto,
): Promise<UserCredentialBindingDto> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-credential-bindings`,
    {
      method: "POST",
      headers: credentialInternalHeaders(config),
      body: JSON.stringify(input),
    },
  ));
  return credentialResponse<UserCredentialBindingDto>(response, "create user credential binding");
}

export async function getUserCredentialStatus(
  config: BotHostConfig,
  input: UserCredentialScopeDto,
): Promise<UserCredentialStatusDto> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-credentials?${credentialScopeQuery(input)}`,
    { headers: credentialInternalHeaders(config, false) },
  ));
  return credentialResponse<UserCredentialStatusDto>(response, "get user credential binding status");
}

export async function deleteUserCredential(
  config: BotHostConfig,
  input: UserCredentialScopeDto,
): Promise<void> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-credentials?${credentialScopeQuery(input)}`,
    { method: "DELETE", headers: credentialInternalHeaders(config, false) },
  ));
  await credentialResponse(response, "delete user credential binding");
}

function credentialScopeQuery(input: UserCredentialScopeDto): string {
  return new URLSearchParams({
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    provider: input.provider,
  }).toString();
}

function userEnvScopeQuery(input: UserEnvScopeDto): string {
  return new URLSearchParams({
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
  }).toString();
}

function credentialInternalHeaders(
  config: BotHostConfig,
  includeContentType = true,
): HeadersInit {
  const token = config.credentialInternalToken?.trim();
  if (!token) {
    throw new Error("Jira credential service is not configured");
  }
  return {
    ...(includeContentType ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${token}`,
  };
}

async function credentialResponse<T = unknown>(
  response: Response,
  action: string,
): Promise<T> {
  const payload = await response.json().catch(() => undefined) as
    | T
    | { error?: string }
    | undefined;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? payload.error
        : `${action} failed`,
    );
  }
  return payload as T;
}

export interface ConversationDto {
  conversation_id: string;
  sequence_no: number;
  bot_id: string;
  wecom_user_id: string;
  channel: "wecom_direct" | "wecom_group";
  purpose: "normal_chat" | "init" | "doc_generation";
  display_name?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function getActiveInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<InitializationSessionDto | undefined> {
  const response = await config.fetch(new Request(activeInitializationSessionUrl(config, input)));
  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildInitializationSessionError("get active initialization session", response, errorPayload(payload)));
  }
  const payload = await response.json() as InitializationSessionDto | null;
  return payload === null ? undefined : payload as InitializationSessionDto;
}

export async function upsertInitializationSession(
  config: BotHostConfig,
  input: Omit<InitializationSessionDto, "session_id">,
): Promise<InitializationSessionDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/initialization-sessions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildInitializationSessionError("upsert initialization session", response, errorPayload(payload)));
  }
  const payload = await response.json() as InitializationSessionDto;
  return payload as InitializationSessionDto;
}

export async function clearInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<void> {
  const response = await config.fetch(
    new Request(activeInitializationSessionUrl(config, input), { method: "DELETE" }),
  );
  if (response.ok || response.status === 404) {
    return;
  }
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  throw new Error(buildInitializationSessionError("clear initialization session", response, payload));
}

export async function createPendingGeneratedDocument(
  config: BotHostConfig,
  input: Omit<PendingGeneratedDocumentDto, "pending_id" | "status">,
): Promise<PendingGeneratedDocumentDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/pending-generated-documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildPendingGeneratedDocumentError("create pending generated document", response, errorPayload(payload)));
  }
  return await response.json() as PendingGeneratedDocumentDto;
}

export async function listPendingGeneratedDocuments(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<PendingGeneratedDocumentDto[]> {
  const query = [
    `bot_id=${encodeURIComponent(input.bot_id)}`,
    `wecom_user_id=${encodeURIComponent(input.wecom_user_id)}`,
    `conversation_id=${encodeURIComponent(input.conversation_id)}`,
  ].join("&");
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/pending-generated-documents?${query}`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildPendingGeneratedDocumentError("list pending generated documents", response, errorPayload(payload)));
  }
  return await response.json() as PendingGeneratedDocumentDto[];
}

export async function confirmPendingGeneratedDocuments(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<PendingGeneratedDocumentDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/pending-generated-documents/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildPendingGeneratedDocumentError("confirm pending generated documents", response, errorPayload(payload)));
  }
  return await response.json() as PendingGeneratedDocumentDto[];
}

export async function cancelPendingGeneratedDocuments(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<PendingGeneratedDocumentDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/pending-generated-documents/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildPendingGeneratedDocumentError("cancel pending generated documents", response, errorPayload(payload)));
  }
  return await response.json() as PendingGeneratedDocumentDto[];
}

export async function applyAndConfirmPendingGeneratedDocuments(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
    created_by_bot_id: string;
    created_by_user_id: string;
  },
): Promise<Array<{ pending_id: string; title: string; version: number }>> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/pending-generated-documents/apply-and-confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildPendingGeneratedDocumentError("apply pending generated documents", response, errorPayload(payload)));
  }
  return await response.json() as Array<{ pending_id: string; title: string; version: number }>;
}

export async function listBotEnvVars(
  config: BotHostConfig,
  botId: string,
): Promise<BotEnvVarMetadataDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/env`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("list bot env vars", response, errorPayload(payload)));
  }
  const payload = await response.json() as { items?: BotEnvVarMetadataDto[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function listUserEnvVars(
  config: BotHostConfig,
  input: UserEnvScopeDto,
): Promise<UserEnvVarMetadataDto[]> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-env?${userEnvScopeQuery(input)}`,
    { headers: credentialInternalHeaders(config, false) },
  ));
  const payload = await credentialResponse<{ items?: UserEnvVarMetadataDto[] }>(
    response,
    "list user environment variables",
  );
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function upsertUserEnvVar(
  config: BotHostConfig,
  input: UserEnvScopeDto & { key: string; value: string },
): Promise<UserEnvVarMetadataDto> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-env?${userEnvScopeQuery(input)}`,
    {
      method: "POST",
      headers: credentialInternalHeaders(config),
      body: JSON.stringify({ key: input.key, value: input.value }),
    },
  ));
  return credentialResponse<UserEnvVarMetadataDto>(response, "set user environment variable");
}

export async function deleteUserEnvVar(
  config: BotHostConfig,
  input: UserEnvScopeDto & { key: string },
): Promise<void> {
  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/user-env/${encodeURIComponent(input.key)}?${userEnvScopeQuery(input)}`,
    { method: "DELETE", headers: credentialInternalHeaders(config, false) },
  ));
  await credentialResponse(response, "delete user environment variable");
}

export async function getBotRuntimePolicy(
  config: BotHostConfig,
  botId: string,
): Promise<BotRuntimePolicyDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/runtime-policy`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("get bot runtime policy", response, errorPayload(payload)));
  }
  return await response.json() as BotRuntimePolicyDto;
}

export async function updateBotRuntimePolicy(
  config: BotHostConfig,
  botId: string,
  input: Partial<Pick<BotRuntimePolicyDto, "skill_install_policy" | "mcp_manage_policy">>,
): Promise<BotRuntimePolicyDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/runtime-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("update bot runtime policy", response, errorPayload(payload)));
  }
  return await response.json() as BotRuntimePolicyDto;
}

export async function listBotSkills(
  config: BotHostConfig,
  botId: string,
): Promise<BotSkillDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/skills`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("list bot skills", response, errorPayload(payload)));
  }
  return await response.json() as BotSkillDto[];
}

export async function listBotMcps(
  config: BotHostConfig,
  botId: string,
): Promise<BotMcpDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/mcps`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("list bot mcps", response, errorPayload(payload)));
  }
  return await response.json() as BotMcpDto[];
}

export async function listBotCapabilityAuditLogs(
  config: BotHostConfig,
  botId: string,
): Promise<BotCapabilityAuditLogDto[]> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/capability-audit-logs`),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("list bot capability audit logs", response, errorPayload(payload)));
  }
  return await response.json() as BotCapabilityAuditLogDto[];
}

export async function listConversations(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    channel: "wecom_direct" | "wecom_group";
    purpose: "normal_chat" | "init" | "doc_generation";
  },
): Promise<ConversationDto[]> {
  const query = [
    `bot_id=${encodeURIComponent(input.bot_id)}`,
    `wecom_user_id=${encodeURIComponent(input.wecom_user_id)}`,
    `channel=${encodeURIComponent(input.channel)}`,
    `purpose=${encodeURIComponent(input.purpose)}`,
  ].join("&");
  const response = await config.fetch(new Request(`${config.dataServiceUrl}/v1/conversations?${query}`));
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("list conversations", response, errorPayload(payload)));
  }
  const payload = await response.json() as { items?: ConversationDto[] } | ConversationDto[];
  return Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : []);
}

export async function createConversation(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    channel: "wecom_direct" | "wecom_group";
    purpose: "normal_chat" | "init" | "doc_generation";
    display_name?: string;
  },
): Promise<ConversationDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("create conversation", response, errorPayload(payload)));
  }
  return await response.json() as ConversationDto;
}

export async function openConversation(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
  },
): Promise<ConversationDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/conversations/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("open conversation", response, errorPayload(payload)));
  }
  return await response.json() as ConversationDto;
}

export async function renameConversation(
  config: BotHostConfig,
  input: {
    bot_id: string;
    wecom_user_id: string;
    conversation_id: string;
    display_name: string;
  },
): Promise<ConversationDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/conversations/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("rename conversation", response, errorPayload(payload)));
  }
  return await response.json() as ConversationDto;
}

export async function requestInstallBotSkill(
  config: BotHostConfig,
  botId: string,
  input: { name: string; source_ref?: string; source_type?: string },
): Promise<{ accepted: boolean }> {
  if (!config.capabilityRunnerUrl) {
    throw new Error("capability runner is not configured");
  }
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("request skill install", response, errorPayload(payload)));
  }
  return await response.json() as { accepted: boolean };
}

export async function requestDeleteBotSkill(
  config: BotHostConfig,
  botId: string,
  input: { name: string },
): Promise<{ accepted: boolean }> {
  if (!config.capabilityRunnerUrl) {
    throw new Error("capability runner is not configured");
  }
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/skills/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("request skill delete", response, errorPayload(payload)));
  }
  return await response.json() as { accepted: boolean };
}

export async function requestInstallBotMcp(
  config: BotHostConfig,
  botId: string,
  input: { name: string; source_ref?: string; mode?: string },
): Promise<{ accepted: boolean }> {
  if (!config.capabilityRunnerUrl) {
    throw new Error("capability runner is not configured");
  }
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/mcps/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("request mcp install", response, errorPayload(payload)));
  }
  return await response.json() as { accepted: boolean };
}

export async function requestDeleteBotMcp(
  config: BotHostConfig,
  botId: string,
  input: { name: string },
): Promise<{ accepted: boolean }> {
  if (!config.capabilityRunnerUrl) {
    throw new Error("capability runner is not configured");
  }
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/mcps/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("request mcp delete", response, errorPayload(payload)));
  }
  return await response.json() as { accepted: boolean };
}

export async function upsertBotEnvVar(
  config: BotHostConfig,
  botId: string,
  input: UpsertBotEnvVarInput,
): Promise<BotEnvVarMetadataDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(buildCapabilityError("upsert bot env var", response, errorPayload(payload)));
  }
  return await response.json() as BotEnvVarMetadataDto;
}

export async function deleteBotEnvVar(
  config: BotHostConfig,
  botId: string,
  key: string,
): Promise<void> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/env/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  );
  if (response.ok || response.status === 204 || response.status === 404) {
    return;
  }
  const payload = await response.json().catch(() => undefined);
  throw new Error(buildCapabilityError("delete bot env var", response, errorPayload(payload)));
}

function activeInitializationSessionUrl(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): string {
  const query = [
    `bot_id=${encodeURIComponent(input.bot_id)}`,
    `wecom_user_id=${encodeURIComponent(input.wecom_user_id)}`,
    `conversation_id=${encodeURIComponent(input.conversation_id)}`,
  ].join("&");
  return `${config.dataServiceUrl}/internal/initialization-sessions/active?${query}`;
}

function buildInitializationSessionError(
  action: string,
  response: Response,
  payload: { error?: string } | undefined,
): string {
  const detail = payload?.error ? `: ${payload.error}` : "";
  return `failed to ${action}: ${response.status} ${response.statusText}${detail}`;
}

function buildPendingGeneratedDocumentError(
  action: string,
  response: Response,
  payload: { error?: string } | undefined,
): string {
  const detail = payload?.error ? `: ${payload.error}` : "";
  return `failed to ${action}: ${response.status} ${response.statusText}${detail}`;
}

function buildCapabilityError(
  action: string,
  response: Response,
  payload: { error?: string } | undefined,
): string {
  const detail = payload?.error ? `: ${payload.error}` : "";
  return `failed to ${action}: ${response.status} ${response.statusText}${detail}`;
}

function errorPayload(payload: unknown): { error?: string } | undefined {
  return payload && typeof payload === "object" && "error" in payload
    ? payload as { error?: string }
    : undefined;
}

export interface EnsureProjectResult {
  project_key: string;
  path: string;
  branch: string;
  base_commit: string;
  reused: boolean;
}

export async function syncBotProject(
  config: BotHostConfig,
  botId: string,
  userId: string,
  conversationId: string,
): Promise<EnsureProjectResult | { error: string } | undefined> {
  if (!config.capabilityRunnerUrl) {
    return undefined;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.projectRunnerToken) {
    headers["x-project-runner-token"] = config.projectRunnerToken;
  }
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/projects/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: userId,
        conversation_id: conversationId,
      }),
    }),
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.error === "string" && (
      body.error.includes("credential") || body.error.includes("token") || body.error.includes("auth")
    )) {
      return { error: body.error };
    }
    return undefined;
  }
  return await response.json() as EnsureProjectResult;
}
