import {
  buildDefaultMcpCapabilityConfig,
  parseMcpCapabilityConfig,
  type McpCapabilityConfig,
} from "@my-agent-toolkit/contracts";
import { createHash, randomBytes } from "node:crypto";

export type BotStatus = "draft" | "initializing" | "ready";
export type ConversationPurpose = "normal_chat" | "init" | "doc_generation";
export type ConversationChannel = "wecom_direct" | "wecom_group";
export type InitializationPhase = "soul" | "role_select" | "agents";
export type InitializationSessionStatus = "active" | "completed" | "cancelled";
export type InitializationGenerationInProgress = "soul" | "agents";
export type PendingGeneratedDocumentStatus = "pending" | "confirmed" | "cancelled";
export type MemoryScope = "system" | "shared" | "bot" | "user" | "session";
export const MEMORY_SCOPES = [
  "system",
  "shared",
  "bot",
  "user",
  "session",
] as const;
export const ADMIN_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export interface BotRecord {
  bot_id: string;
  name: string;
  runtime: string;
  status: BotStatus;
  wecom_bot_id?: string;
  wecom_secret_configured: boolean;
  wecom_connection_status: WeComConnectionStatus;
  last_wecom_check_at?: string;
  last_wecom_error?: string;
  project_key?: string;
  project_repository_url?: string;
  project_default_branch?: string;
  project_directory?: string;
  created_at: string;
  updated_at: string;
}

export type WeComConnectionStatus =
  | "unchecked"
  | "configured"
  | "verified"
  | "failed"
  | "missing_config";

export interface WeComConnectionTestResult {
  bot_id: string;
  status: Exclude<WeComConnectionStatus, "unchecked">;
  wecom_bot_id?: string;
  wecom_secret_configured: boolean;
  missing: Array<"wecom_bot_id" | "wecom_secret">;
  checked_at: string;
  error?: string;
}

export interface WeComRuntimeBotConfig {
  bot_id: string;
  runtime: string;
  wecom_bot_id: string;
  wecom_secret: string;
}

export interface BotChannelRecord {
  channel_id: string;
  bot_id: string;
  channel_type: "wecom";
  display_name: string;
  wecom_bot_id?: string;
  secret_configured: boolean;
  connection_status: WeComConnectionStatus;
  runtime_enabled: boolean;
  runtime_status:
    | "enabled"
    | "missing_bot_id"
    | "missing_secret";
  last_check_at?: string;
  last_error?: string;
}

export interface BotChannelDetail {
  channel: BotChannelRecord;
  bot: BotRecord;
  admin?: AdminRecord;
  pending_admin_claim?: {
    status: "pending" | "claimed" | "expired";
    code?: string;
    expires_at?: string;
  };
  memory_documents: MemoryDocumentRecord[];
  config_documents: BotConfigDocumentRecord[];
}

export interface CreateBotInput {
  bot_id: string;
  name: string;
  runtime: string;
  wecom_bot_id?: string;
  wecom_secret?: string;
  project_key?: string;
  project_repository_url?: string;
  project_default_branch?: string;
  project_directory?: string;
}

export interface UpdateBotInput {
  name?: string;
  runtime?: string;
  status?: BotStatus;
  wecom_bot_id?: string;
  wecom_secret?: string;
  project_key?: string;
  project_repository_url?: string;
  project_default_branch?: string;
  project_directory?: string;
}

export type BotProjectConfig = Pick<
  BotRecord,
  | "project_key"
  | "project_repository_url"
  | "project_default_branch"
  | "project_directory"
>;

export interface ConversationRecord {
  conversation_id: string;
  sequence_no: number;
  bot_id: string;
  wecom_user_id: string;
  channel: ConversationChannel;
  purpose: ConversationPurpose;
  display_name?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InitializationSessionRecord {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: InitializationPhase;
  selected_role_id?: string;
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: InitializationGenerationInProgress;
  status: InitializationSessionStatus;
  created_at: string;
  updated_at: string;
}

export interface UpsertInitializationSessionInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: InitializationPhase;
  selected_role_id?: string;
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: InitializationGenerationInProgress;
  status: InitializationSessionStatus;
}

export interface InitializationSessionKeyInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}

export interface PendingGeneratedDocumentRecord {
  pending_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  status: PendingGeneratedDocumentStatus;
  created_by_bot_id: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeConfigRecord {
  bot_id: string;
  provider: string;
  stream: boolean;
  options: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UpsertRuntimeConfigInput {
  provider: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface RuntimeSessionRecord {
  runner_session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  runtime: string;
  provider_session_id?: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertRuntimeSessionInput {
  runner_session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  runtime: string;
  provider_session_id?: string;
}

export type BotCapabilityPolicy = "admin_only" | "open";

export interface BotRuntimePolicyRecord {
  bot_id: string;
  skill_install_policy: BotCapabilityPolicy;
  mcp_manage_policy: BotCapabilityPolicy;
  created_at: string;
  updated_at: string;
}

export interface UpdateBotRuntimePolicyInput {
  skill_install_policy?: BotCapabilityPolicy;
  mcp_manage_policy?: BotCapabilityPolicy;
}

export interface BotEnvVarRecord {
  bot_id: string;
  key: string;
  value_ciphertext: string;
  is_set: boolean;
  updated_at: string;
  updated_by_wecom_user_id: string;
}

export interface UpsertBotEnvVarInput {
  key: string;
  value_ciphertext: string;
  updated_by_wecom_user_id: string;
}

export interface BotEnvVarMetadataRecord {
  bot_id: string;
  key: string;
  is_set: boolean;
  updated_at: string;
}

export type UserCredentialProvider = "easemob_jira" | "github_fork";

export interface UserCredentialRecord {
  bot_id: string;
  wecom_user_id: string;
  provider: UserCredentialProvider;
  payload_ciphertext: string;
  created_at: string;
  updated_at: string;
}

export interface UserCredentialMetadataRecord {
  bot_id: string;
  wecom_user_id: string;
  provider: UserCredentialProvider;
  is_bound: true;
  updated_at: string;
}

export interface UserCredentialBindingRecord {
  token: string;
  token_hash: string;
  bot_id: string;
  wecom_user_id: string;
  provider: UserCredentialProvider;
  created_at: string;
  expires_at: string;
  consumed_at?: string;
}

export interface UserCredentialScopeInput {
  bot_id: string;
  wecom_user_id: string;
  provider: UserCredentialProvider;
}

export interface CompleteUserCredentialBindingInput {
  token: string;
  payload_ciphertext: string;
}

export type BotSkillSourceType = "builtin" | "github" | "url" | "local";
export type BotCapabilityInstallStatus = "installing" | "installed" | "failed";

export interface BotSkillRecord {
  skill_id: string;
  bot_id: string;
  name: string;
  source_type: BotSkillSourceType;
  source_ref: string;
  status: BotCapabilityInstallStatus;
  installed_at: string;
  installed_by_wecom_user_id: string;
  last_error?: string;
}

export interface UpsertBotSkillInput {
  name: string;
  source_type: BotSkillSourceType;
  source_ref: string;
  status: BotCapabilityInstallStatus;
  installed_by_wecom_user_id: string;
  last_error?: string;
}

export type BotMcpMode = "config" | "package";

export interface BotMcpRecord {
  mcp_id: string;
  bot_id: string;
  name: string;
  mode: BotMcpMode;
  source_ref: string;
  status: BotCapabilityInstallStatus;
  installed_at: string;
  installed_by_wecom_user_id: string;
  last_error?: string;
}

export interface UpsertBotMcpInput {
  name: string;
  mode: BotMcpMode;
  source_ref: string;
  status: BotCapabilityInstallStatus;
  installed_by_wecom_user_id: string;
  last_error?: string;
}

export type BotCapabilityAuditActionType =
  | "env_set"
  | "env_delete"
  | "skill_install"
  | "skill_delete"
  | "mcp_install"
  | "mcp_delete"
  | "policy_update";
export type BotCapabilityAuditResult = "success" | "failed";

export interface BotCapabilityAuditLogRecord {
  log_id: string;
  bot_id: string;
  wecom_user_id: string;
  display_name?: string;
  action_type: BotCapabilityAuditActionType;
  target_name: string;
  source_ref?: string;
  result: BotCapabilityAuditResult;
  error_message?: string;
  created_at: string;
}

export interface AppendBotCapabilityAuditLogInput {
  bot_id: string;
  wecom_user_id: string;
  display_name?: string;
  action_type: BotCapabilityAuditActionType;
  target_name: string;
  source_ref?: string;
  result: BotCapabilityAuditResult;
  error_message?: string;
}

export type McpToolExecutionStatus = "success" | "failed" | "rejected";

export interface McpToolExecutionRecord {
  execution_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  tool_name: string;
  status: McpToolExecutionStatus;
  duration_ms: number;
  error_code?: string;
  created_at: string;
}

export interface AppendMcpToolExecutionInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  tool_name: string;
  status: McpToolExecutionStatus;
  duration_ms: number;
  error_code?: string;
}

export interface CreatePendingGeneratedDocumentInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  title: string;
  content: string;
  created_by_bot_id: string;
  created_by_user_id: string;
}

export interface PendingGeneratedDocumentQuery {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}

export interface ApplyPendingGeneratedDocumentsInput extends PendingGeneratedDocumentQuery {
  created_by_bot_id: string;
  created_by_user_id: string;
}

export interface AppliedPendingGeneratedDocumentResult {
  pending_id: string;
  title: string;
  version: number;
}

export interface ResolveConversationInput {
  bot_id: string;
  wecom_user_id: string;
  channel: ConversationChannel;
  purpose: ConversationPurpose;
}

export interface ListConversationsInput extends ResolveConversationInput {}

export interface CreateConversationInput extends ResolveConversationInput {
  display_name?: string;
}

export interface OpenConversationInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
}

export interface RenameConversationInput extends OpenConversationInput {
  display_name: string;
}

export interface MemoryDocumentRecord {
  memory_doc_id: string;
  scope: MemoryScope;
  owner_id: string;
  title: string;
  version: number;
  content: string;
  status: "active";
  created_at: string;
}

export type KnowledgeTier = "core" | "reference" | "temp";
export type SourceType = "text" | "file" | "url" | "directory" | "document" | "memory";
export type StoredSourceType = "document" | "memory";

export interface BusinessDocumentRecord {
  document_id: string;
  scope: MemoryScope;
  owner_id: string;
  title: string;
  doc_type: string;
  visibility: string;
  tier: KnowledgeTier;
  source_type?: SourceType;
  source_uri?: string;
  content_hash?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
  version: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_hit_at?: string;
  hit_count: number;
  status: "active" | "archived";
}

export interface BusinessDocumentVersionRecord {
  document_id: string;
  version: number;
  content: string;
  change_summary?: string;
  created_at: string;
  chunk_count: number;
}

export interface MemoryRecord {
  memory_id: string;
  scope: MemoryScope;
  owner_id: string;
  content: string;
  tier: KnowledgeTier;
  source_type: SourceType;
  source_conversation_id?: string;
  source_message_id?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_hit_at?: string;
  hit_count: number;
  status: "active" | "archived";
}

export interface ChunkRecord {
  chunk_id: string;
  source_type: StoredSourceType;
  source_id: string;
  scope: MemoryScope;
  owner_id: string;
  content: string;
  chunk_index: number;
  heading_path?: string;
  location?: string;
  tier: KnowledgeTier;
  created_at: string;
  last_hit_at?: string;
  hit_count: number;
}

export interface AssetRecord {
  asset_id: string;
  source_type: StoredSourceType;
  source_id: string;
  filename: string;
  content_type: string;
  storage_uri: string;
  size_bytes: number;
  content_hash: string;
  created_at: string;
}

export interface MemoryStats {
  total_memories: number;
  total_chunks: number;
  by_tier: Record<KnowledgeTier, number>;
  disk_usage_bytes: number;
}

export interface BotConfigDocumentRecord {
  bot_id: string;
  title: "soul" | "agents.md";
  content: string;
  created_at: string;
  updated_at: string;
}

export interface AdminRecord {
  bot_id: string;
  wecom_user_id: string;
  role: "admin";
  claimed_at: string;
}

export interface AdminClaimRecord {
  bot_id: string;
  code: string;
  code_hash: string;
  created_at: string;
  expires_at: string;
}

export interface ClaimAdminInput {
  bot_id: string;
  wecom_user_id: string;
  code?: string;
}

export interface TransferAdminInput {
  bot_id: string;
  current_wecom_user_id: string;
  new_wecom_user_id: string;
}

export type MessageContextReason =
  | "admin_unclaimed"
  | "initialization_required"
  | "initializing"
  | "ready";

export interface MessageContext {
  bot_id: string;
  wecom_user_id: string;
  is_admin: boolean;
  allowed: boolean;
  reason: MessageContextReason;
  conversation?: ConversationRecord;
  project_key?: string;
}

export interface UpsertMemoryDocumentInput {
  memory_doc_id?: string;
  scope: MemoryScope;
  owner_id: string;
  title: string;
  content: string;
}

export interface UpsertBotConfigDocumentInput {
  bot_id: string;
  title: string;
  content: string;
}

export interface ListCurrentMemoryDocumentsInput {
  scope: MemoryScope;
  owner_id: string;
}

export interface CreateBusinessDocumentInput {
  document_id?: string;
  scope: MemoryScope;
  owner_id: string;
  title: string;
  doc_type: string;
  content: string;
  visibility?: string;
  tier?: KnowledgeTier;
  source_type?: SourceType;
  source_uri?: string;
  content_hash?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
  tags?: string[];
}

export interface UpdateBusinessDocumentInput {
  document_id: string;
  content: string;
  change_summary?: string;
  chunk_count?: number;
}

export interface ListBusinessDocumentsInput {
  scope?: MemoryScope;
  owner_id?: string;
  doc_type?: string;
  status?: "active" | "archived";
}

export interface CreateMemoryRecordInput {
  memory_id?: string;
  scope: MemoryScope;
  owner_id: string;
  content: string;
  tier?: KnowledgeTier;
  source_type?: SourceType;
  source_conversation_id?: string;
  source_message_id?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
  tags?: string[];
}

export interface ListMemoriesInput {
  scope?: MemoryScope;
  owner_id?: string;
  tier?: KnowledgeTier;
  status?: "active" | "archived";
}

export interface RecordChunksInput {
  source_type: StoredSourceType;
  source_id: string;
  scope: MemoryScope;
  owner_id: string;
  chunks: Array<{
    content: string;
    chunk_index: number;
    heading_path?: string;
    location?: string;
    tier?: KnowledgeTier;
  }>;
}

export interface RecordAssetInput {
  source_type: StoredSourceType;
  source_id: string;
  filename: string;
  content_type: string;
  storage_uri: string;
  size_bytes: number;
  content_hash: string;
}

export interface MemoryStatsInput {
  scope?: MemoryScope;
  owner_id?: string;
}

export interface ListEnabledRecordsOptions {
  includeDisabled?: boolean;
}

export interface GlobalDocumentRecord {
  document_id: string;
  title: string;
  slug: string;
  content: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertGlobalDocumentInput {
  document_id?: string;
  title: string;
  slug: string;
  content: string;
  enabled?: boolean;
  sort_order?: number;
}

export interface RoleRecord {
  role_id: string;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertRoleInput {
  role_id?: string;
  name: string;
  slug: string;
  description: string;
  enabled?: boolean;
  sort_order?: number;
}

export interface RoleDocumentRecord {
  role_document_id: string;
  role_id: string;
  title: string;
  content: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertRoleDocumentInput {
  role_document_id?: string;
  role_id: string;
  title: string;
  content: string;
  enabled?: boolean;
}

export type RoleQuestionType = "single_choice" | "multi_choice" | "free_text";

export interface RoleQuestionOption {
  value: string;
  label: string;
}

export interface RoleQuestionDependency {
  key: string;
  equals: string;
}

export interface RoleQuestionRecord {
  question_id: string;
  role_id: string;
  key: string;
  title: string;
  description: string;
  question_type: RoleQuestionType;
  options_json: RoleQuestionOption[];
  required: boolean;
  enabled: boolean;
  sort_order: number;
  depends_on_json: RoleQuestionDependency[];
  created_at: string;
  updated_at: string;
}

export interface UpsertRoleQuestionInput {
  question_id?: string;
  role_id: string;
  key: string;
  title: string;
  description?: string;
  question_type: RoleQuestionType;
  options_json?: RoleQuestionOption[];
  required?: boolean;
  enabled?: boolean;
  sort_order?: number;
  depends_on_json?: RoleQuestionDependency[];
}

export interface DataStore {
  createBot(input: CreateBotInput): BotRecord;
  listBots(): BotRecord[];
  getBot(botId: string): BotRecord | undefined;
  updateBot(botId: string, input: UpdateBotInput): BotRecord;
  resetToStandardRoleConfig(): void;
  getBotMcpCapabilityConfig(botId: string): McpCapabilityConfig;
  updateBotMcpCapabilityConfig(
    botId: string,
    input: unknown,
  ): McpCapabilityConfig;
  listBotChannels(botId?: string): BotChannelRecord[];
  getBotChannelDetail(botId: string): BotChannelDetail;
  resetAdminClaim(botId: string): AdminClaimRecord;
  resetBot(botId: string): BotRecord;
  deleteBotChannel(botId: string): BotChannelRecord;
  listWeComRuntimeBots(): WeComRuntimeBotConfig[];
  testWeComConnection(botId: string): Promise<WeComConnectionTestResult>;
  getRuntimeConfig(botId: string): RuntimeConfigRecord;
  upsertRuntimeConfig(
    botId: string,
    input: UpsertRuntimeConfigInput,
  ): RuntimeConfigRecord;
  getRuntimeSession(runnerSessionId: string): RuntimeSessionRecord | undefined;
  upsertRuntimeSession(input: UpsertRuntimeSessionInput): RuntimeSessionRecord;
  getOrCreateBotRuntimePolicy(botId: string): BotRuntimePolicyRecord;
  updateBotRuntimePolicy(
    botId: string,
    input: UpdateBotRuntimePolicyInput,
  ): BotRuntimePolicyRecord;
  upsertBotEnvVar(botId: string, input: UpsertBotEnvVarInput): BotEnvVarRecord;
  getBotEnvVar(botId: string, key: string): BotEnvVarRecord | undefined;
  listBotEnvVars(botId: string): BotEnvVarMetadataRecord[];
  deleteBotEnvVar(botId: string, key: string): void;
  createUserCredentialBinding(input: UserCredentialScopeInput): UserCredentialBindingRecord;
  getUserCredentialBinding(token: string): UserCredentialBindingRecord | undefined;
  completeUserCredentialBinding(
    input: CompleteUserCredentialBindingInput,
  ): UserCredentialMetadataRecord;
  getUserCredential(input: UserCredentialScopeInput): UserCredentialRecord | undefined;
  getUserCredentialMetadata(
    input: UserCredentialScopeInput,
  ): UserCredentialMetadataRecord | undefined;
  deleteUserCredential(input: UserCredentialScopeInput): void;
  upsertBotSkill(botId: string, input: UpsertBotSkillInput): BotSkillRecord;
  listBotSkills(botId: string): BotSkillRecord[];
  deleteBotSkill(botId: string, name: string): void;
  upsertBotMcp(botId: string, input: UpsertBotMcpInput): BotMcpRecord;
  listBotMcps(botId: string): BotMcpRecord[];
  deleteBotMcp(botId: string, name: string): void;
  appendBotCapabilityAuditLog(input: AppendBotCapabilityAuditLogInput): BotCapabilityAuditLogRecord;
  listBotCapabilityAuditLogs(botId: string): BotCapabilityAuditLogRecord[];
  appendMcpToolExecution(input: AppendMcpToolExecutionInput): McpToolExecutionRecord;
  listMcpToolExecutions(botId: string): McpToolExecutionRecord[];
  getAdmin(botId: string): AdminRecord | undefined;
  createAdminClaim(botId: string): AdminClaimRecord;
  claimAdmin(input: ClaimAdminInput): AdminRecord;
  verifyAdminClaim(input: Required<ClaimAdminInput>): AdminRecord;
  transferAdmin(input: TransferAdminInput): AdminRecord;
  markBotReady(botId: string): BotRecord;
  resolveMessageContext(input: ResolveConversationInput): MessageContext;
  resolveConversation(input: ResolveConversationInput): ConversationRecord;
  listConversations(input: ListConversationsInput): ConversationRecord[];
  createConversation(input: CreateConversationInput): ConversationRecord;
  openConversation(input: OpenConversationInput): ConversationRecord;
  renameConversation(input: RenameConversationInput): ConversationRecord;
  upsertInitializationSession(input: UpsertInitializationSessionInput): InitializationSessionRecord;
  getActiveInitializationSession(
    input: InitializationSessionKeyInput,
  ): InitializationSessionRecord | undefined;
  clearInitializationSession(input: InitializationSessionKeyInput): void;
  createPendingGeneratedDocument(
    input: CreatePendingGeneratedDocumentInput,
  ): PendingGeneratedDocumentRecord;
  listPendingGeneratedDocuments(
    input: PendingGeneratedDocumentQuery,
  ): PendingGeneratedDocumentRecord[];
  confirmPendingGeneratedDocuments(
    input: PendingGeneratedDocumentQuery,
  ): PendingGeneratedDocumentRecord[];
  cancelPendingGeneratedDocuments(
    input: PendingGeneratedDocumentQuery,
  ): PendingGeneratedDocumentRecord[];
  applyPendingGeneratedDocuments(
    input: ApplyPendingGeneratedDocumentsInput,
  ): AppliedPendingGeneratedDocumentResult[];
  upsertGlobalDocument(input: UpsertGlobalDocumentInput): GlobalDocumentRecord;
  listGlobalDocuments(options?: ListEnabledRecordsOptions): GlobalDocumentRecord[];
  deleteGlobalDocument(documentId: string): void;
  upsertRole(input: UpsertRoleInput): RoleRecord;
  listRoles(options?: ListEnabledRecordsOptions): RoleRecord[];
  deleteRole(roleId: string): void;
  upsertRoleDocument(input: UpsertRoleDocumentInput): RoleDocumentRecord;
  listRoleDocuments(roleId: string, options?: ListEnabledRecordsOptions): RoleDocumentRecord[];
  deleteRoleDocument(roleDocumentId: string): void;
  upsertRoleQuestion(input: UpsertRoleQuestionInput): RoleQuestionRecord;
  listRoleQuestions(roleId: string, options?: ListEnabledRecordsOptions): RoleQuestionRecord[];
  deleteRoleQuestion(questionId: string): void;
  upsertBotConfigDocument(input: UpsertBotConfigDocumentInput): BotConfigDocumentRecord;
  listBotConfigDocuments(botId: string): BotConfigDocumentRecord[];
  upsertMemoryDocument(input: UpsertMemoryDocumentInput): MemoryDocumentRecord;
  listMemoryDocumentVersions(memoryDocId: string): MemoryDocumentRecord[];
  listCurrentMemoryDocuments(
    input: ListCurrentMemoryDocumentsInput,
  ): MemoryDocumentRecord[];
  createBusinessDocument(input: CreateBusinessDocumentInput): BusinessDocumentRecord;
  updateBusinessDocument(input: UpdateBusinessDocumentInput): BusinessDocumentVersionRecord;
  getBusinessDocument(
    documentId: string,
    version?: number,
  ): BusinessDocumentVersionRecord | undefined;
  listBusinessDocuments(input?: ListBusinessDocumentsInput): BusinessDocumentRecord[];
  createMemoryRecord(input: CreateMemoryRecordInput): MemoryRecord;
  listMemories(input?: ListMemoriesInput): MemoryRecord[];
  recordChunks(input: RecordChunksInput): ChunkRecord[];
  recordAsset(input: RecordAssetInput): AssetRecord;
  getMemoryStats(input?: MemoryStatsInput): MemoryStats;
  close?(): void;
}

export interface DataStoreOptions {
  wecomVerifier?: {
    verify(input: {
      bot_id: string;
      secret: string;
    }): Promise<{ verified: true } | { verified: false; error: string }>;
  };
}

export function createDataStore(options: DataStoreOptions = {}): DataStore {
  const bots = new Map<string, BotRecord>();
  const admins = new Map<string, AdminRecord>();
  const adminClaims = new Map<string, AdminClaimRecord>();
  const conversationHistory = new Map<string, ConversationRecord>();
  const activeConversationIds = new Map<string, string>();
  const initializationSessions = new Map<string, InitializationSessionRecord>();
  const pendingGeneratedDocuments = new Map<string, PendingGeneratedDocumentRecord>();
  const runtimeConfigs = new Map<string, RuntimeConfigRecord>();
  const runtimeSessions = new Map<string, RuntimeSessionRecord>();
  const botRuntimePolicies = new Map<string, BotRuntimePolicyRecord>();
  const botEnvVars = new Map<string, BotEnvVarRecord>();
  const userCredentials = new Map<string, UserCredentialRecord>();
  const userCredentialBindings = new Map<string, UserCredentialBindingRecord>();
  const botSkills = new Map<string, BotSkillRecord>();
  const botMcps = new Map<string, BotMcpRecord>();
  const botCapabilityAuditLogs = new Map<string, BotCapabilityAuditLogRecord>();
  const mcpToolExecutions = new Map<string, McpToolExecutionRecord>();
  const globalDocuments = new Map<string, GlobalDocumentRecord>();
  const roles = new Map<string, RoleRecord>();
  const roleDocuments = new Map<string, RoleDocumentRecord>();
  const roleQuestions = new Map<string, RoleQuestionRecord>();
  const memoryDocuments = new Map<string, MemoryDocumentRecord[]>();
  const botConfigDocuments = new Map<string, BotConfigDocumentRecord>();
  const businessDocuments = new Map<string, BusinessDocumentRecord>();
  const businessDocumentVersions = new Map<string, BusinessDocumentVersionRecord[]>();
  const memories = new Map<string, MemoryRecord>();
  const chunks = new Map<string, ChunkRecord>();
  const assets = new Map<string, AssetRecord>();
  const wecomSecrets = new Map<string, string>();
  const mcpCapabilityConfigs = new Map<string, McpCapabilityConfig>();

  return {
    createBot(input) {
      const now = new Date().toISOString();
      const wecomSecret = optionalText(input.wecom_secret);
      const wecomBotId = optionalText(input.wecom_bot_id);
      const project = normalizeBotProjectConfig(input);
      assertUniqueWeComBotId(bots, wecomBotId);
      const bot: BotRecord = {
        bot_id: requireText(input.bot_id, "bot_id"),
        name: requireText(input.name, "name"),
        runtime: requireText(input.runtime, "runtime"),
        status: "draft",
        wecom_bot_id: wecomBotId,
        wecom_secret_configured: Boolean(wecomSecret),
        wecom_connection_status: "unchecked",
        ...project,
        created_at: now,
        updated_at: now,
      };
      bots.set(bot.bot_id, bot);
      if (wecomSecret) {
        wecomSecrets.set(bot.bot_id, wecomSecret);
      }
      return bot;
    },

    getBot(botId) {
      return bots.get(botId);
    },

    listBots() {
      return [...bots.values()];
    },

    updateBot(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const wecomSecret = optionalText(input.wecom_secret);
      const wecomBotId = input.wecom_bot_id === undefined
        ? bot.wecom_bot_id
        : optionalText(input.wecom_bot_id);
      assertUniqueWeComBotId(bots, wecomBotId, bot.bot_id);
      const project = normalizeBotProjectConfig(input, bot);
      const updated: BotRecord = {
        ...bot,
        name: input.name === undefined ? bot.name : requireText(input.name, "name"),
        runtime: input.runtime === undefined
          ? bot.runtime
          : requireText(input.runtime, "runtime"),
        status: input.status === undefined
          ? bot.status
          : requireBotStatus(input.status),
        wecom_bot_id: wecomBotId,
        wecom_secret_configured: wecomSecret
          ? true
          : bot.wecom_secret_configured,
        wecom_connection_status: "unchecked",
        last_wecom_check_at: undefined,
        last_wecom_error: undefined,
        ...project,
        updated_at: nextIsoTimestamp(bot.updated_at),
      };
      bots.set(bot.bot_id, updated);
      if (wecomSecret) {
        wecomSecrets.set(bot.bot_id, wecomSecret);
      }
      return updated;
    },

    resetToStandardRoleConfig() {
      const playground = this.listGlobalDocuments({ includeDisabled: true }).find((document) =>
        document.slug === "playground"
      );

      bots.clear();
      wecomSecrets.clear();
      conversationHistory.clear();
      activeConversationIds.clear();
      conversationHistory.clear();
      admins.clear();
      adminClaims.clear();
      initializationSessions.clear();
      pendingGeneratedDocuments.clear();
      runtimeConfigs.clear();
      runtimeSessions.clear();
      businessDocuments.clear();
      businessDocumentVersions.clear();
      memoryDocuments.clear();
      botConfigDocuments.clear();
      roleDocuments.clear();
      roleQuestions.clear();
      roles.clear();
      memories.clear();
      chunks.clear();
      assets.clear();
      mcpCapabilityConfigs.clear();
      botRuntimePolicies.clear();
      botEnvVars.clear();
      userCredentials.clear();
      userCredentialBindings.clear();
      botSkills.clear();
      botMcps.clear();
      botCapabilityAuditLogs.clear();
      mcpToolExecutions.clear();

      if (playground) {
        globalDocuments.clear();
        globalDocuments.set(playground.document_id, {
          ...playground,
        });
      } else {
        globalDocuments.clear();
      }

      seedDefaultRoleConfig(this);
    },

    getBotMcpCapabilityConfig(botId) {
      const bot = getRequiredBot(bots, botId);
      return mcpCapabilityConfigs.get(bot.bot_id) ?? buildDefaultMcpCapabilityConfig();
    },

    updateBotMcpCapabilityConfig(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const config = parseMcpCapabilityConfig(input);
      mcpCapabilityConfigs.set(bot.bot_id, config);
      return config;
    },

    listBotChannels(botId) {
      return [...bots.values()]
        .filter((bot) => !botId || bot.bot_id === botId)
        .filter(hasWeComChannelConfig)
        .map(botToChannelRecord);
    },

    getBotChannelDetail(botId) {
      const bot = getRequiredBot(bots, botId);
      const pendingClaim = adminClaims.get(bot.bot_id);
      const admin = admins.get(bot.bot_id);
      const pendingAdminClaim = admin
        ? { status: "claimed" as const }
        : pendingClaim
          ? new Date(pendingClaim.expires_at).getTime() < Date.now()
            || !pendingClaim.code
            ? { status: "expired" as const, expires_at: pendingClaim.expires_at }
            : {
              status: "pending" as const,
              code: pendingClaim.code,
              expires_at: pendingClaim.expires_at,
            }
          : undefined;
      return {
        channel: botToChannelRecord(bot),
        bot,
        ...(admin ? { admin } : {}),
        ...(pendingAdminClaim ? { pending_admin_claim: pendingAdminClaim } : {}),
        memory_documents: this.listCurrentMemoryDocuments({
          scope: "bot",
          owner_id: bot.bot_id,
        }),
        config_documents: this.listBotConfigDocuments(bot.bot_id),
      };
    },

    resetAdminClaim(botId) {
      const bot = getRequiredBot(bots, botId);
      admins.delete(bot.bot_id);
      adminClaims.delete(bot.bot_id);
      return this.createAdminClaim(bot.bot_id);
    },

    resetBot(botId) {
      const bot = getRequiredBot(bots, botId);
      for (const key of [...botConfigDocuments.keys()]) {
        if (key.startsWith(`${bot.bot_id}:`)) {
          botConfigDocuments.delete(key);
        }
      }
      for (const [key, session] of [...initializationSessions.entries()]) {
        if (session.bot_id === bot.bot_id) {
          initializationSessions.delete(key);
        }
      }
      for (const [pendingId, document] of [...pendingGeneratedDocuments.entries()]) {
        if (document.bot_id === bot.bot_id) {
          pendingGeneratedDocuments.delete(pendingId);
        }
      }
      for (const [scopeKey, conversationId] of [...activeConversationIds.entries()]) {
        const record = conversationHistory.get(conversationId);
        if (!record || record.bot_id === bot.bot_id) {
          activeConversationIds.delete(scopeKey);
        }
      }
      for (const key of [...conversationHistory.keys()]) {
        const record = conversationHistory.get(key);
        if (record?.bot_id === bot.bot_id) {
          conversationHistory.delete(key);
        }
      }
      const updated = {
        ...bot,
        status: admins.has(bot.bot_id) ? "initializing" as const : "draft" as const,
        updated_at: new Date().toISOString(),
      };
      bots.set(bot.bot_id, updated);
      return updated;
    },

    deleteBotChannel(botId) {
      const bot = getRequiredBot(bots, botId);
      wecomSecrets.delete(bot.bot_id);
      const updated: BotRecord = {
        ...bot,
        wecom_bot_id: undefined,
        wecom_secret_configured: false,
        wecom_connection_status: "unchecked",
        last_wecom_check_at: undefined,
        last_wecom_error: undefined,
        updated_at: new Date().toISOString(),
      };
      bots.set(bot.bot_id, updated);
      return botToChannelRecord(updated);
    },

    listWeComRuntimeBots() {
      return [...bots.values()]
        .map((bot) => {
          const secret = wecomSecrets.get(bot.bot_id);
          return bot.wecom_bot_id && secret
            ? {
              bot_id: bot.bot_id,
              runtime: bot.runtime,
              wecom_bot_id: bot.wecom_bot_id,
              wecom_secret: secret,
            }
            : undefined;
        })
        .filter((bot): bot is WeComRuntimeBotConfig => Boolean(bot));
    },

    async testWeComConnection(botId) {
      const bot = getRequiredBot(bots, botId);
      const secret = wecomSecrets.get(bot.bot_id);
      const prelim = buildWeComConnectionTestResult(bot);
      const verification = prelim.status === "configured" && options.wecomVerifier && secret
        ? await options.wecomVerifier.verify({
          bot_id: bot.wecom_bot_id ?? "",
          secret,
        })
        : undefined;
      const result = buildWeComConnectionTestResult(bot, verification);
      const updated: BotRecord = {
        ...bot,
        wecom_connection_status: result.status,
        last_wecom_check_at: result.checked_at,
        last_wecom_error: result.error,
        updated_at: nextIsoTimestamp(bot.updated_at),
      };
      bots.set(bot.bot_id, updated);
      return result;
    },

    getRuntimeConfig(botId) {
      const bot = getRequiredBot(bots, botId);
      const record = runtimeConfigs.get(bot.bot_id) ?? defaultRuntimeConfig(bot);
      return cloneRuntimeConfigRecord(record);
    },

    upsertRuntimeConfig(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const existing = runtimeConfigs.get(bot.bot_id);
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: RuntimeConfigRecord = {
        bot_id: bot.bot_id,
        provider: requireText(input.provider, "provider"),
        stream: normalizeRuntimeConfigStream(input.stream),
        options: normalizeRuntimeConfigOptions(input.options),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      runtimeConfigs.set(record.bot_id, record);
      return cloneRuntimeConfigRecord(record);
    },

    getRuntimeSession(runnerSessionId) {
      const record = runtimeSessions.get(requireText(runnerSessionId, "runner_session_id"));
      return record ? cloneRuntimeSessionRecord(record) : undefined;
    },

    upsertRuntimeSession(input) {
      getRequiredBot(bots, input.bot_id);
      const runnerSessionId = requireText(input.runner_session_id, "runner_session_id");
      const existing = runtimeSessions.get(runnerSessionId);
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: RuntimeSessionRecord = {
        runner_session_id: runnerSessionId,
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        runtime: requireText(input.runtime, "runtime"),
        ...(optionalText(input.provider_session_id) ? { provider_session_id: optionalText(input.provider_session_id) } : {}),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      runtimeSessions.set(record.runner_session_id, record);
      return cloneRuntimeSessionRecord(record);
    },

    getOrCreateBotRuntimePolicy(botId) {
      const bot = getRequiredBot(bots, botId);
      const existing = botRuntimePolicies.get(bot.bot_id);
      if (existing) {
        return cloneBotRuntimePolicyRecord(existing);
      }
      const created = defaultBotRuntimePolicy(bot);
      botRuntimePolicies.set(bot.bot_id, created);
      return cloneBotRuntimePolicyRecord(created);
    },

    updateBotRuntimePolicy(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const existing = botRuntimePolicies.get(bot.bot_id) ?? defaultBotRuntimePolicy(bot);
      const updated: BotRuntimePolicyRecord = {
        ...existing,
        skill_install_policy: input.skill_install_policy === undefined
          ? existing.skill_install_policy
          : requireBotCapabilityPolicy(input.skill_install_policy, "skill_install_policy"),
        mcp_manage_policy: input.mcp_manage_policy === undefined
          ? existing.mcp_manage_policy
          : requireBotCapabilityPolicy(input.mcp_manage_policy, "mcp_manage_policy"),
        updated_at: nextIsoTimestamp(existing.updated_at),
      };
      botRuntimePolicies.set(bot.bot_id, updated);
      return cloneBotRuntimePolicyRecord(updated);
    },

    upsertBotEnvVar(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const key = botCapabilityScopedKey(bot.bot_id, requireText(input.key, "key"));
      const existing = botEnvVars.get(key);
      const updatedAt = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: BotEnvVarRecord = {
        bot_id: bot.bot_id,
        key: requireText(input.key, "key"),
        value_ciphertext: requireText(input.value_ciphertext, "value_ciphertext"),
        is_set: true,
        updated_at: updatedAt,
        updated_by_wecom_user_id: requireText(
          input.updated_by_wecom_user_id,
          "updated_by_wecom_user_id",
        ),
      };
      botEnvVars.set(key, record);
      return cloneBotEnvVarRecord(record);
    },

    getBotEnvVar(botId, envKey) {
      const bot = getRequiredBot(bots, botId);
      const record = botEnvVars.get(botCapabilityScopedKey(
        bot.bot_id,
        requireText(envKey, "key"),
      ));
      return record ? cloneBotEnvVarRecord(record) : undefined;
    },

    listBotEnvVars(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...botEnvVars.values()]
        .filter((record) => record.bot_id === bot.bot_id)
        .sort(compareUpdatedRecordsDesc)
        .map((record) => ({
          bot_id: record.bot_id,
          key: record.key,
          is_set: record.is_set,
          updated_at: record.updated_at,
        }));
    },

    deleteBotEnvVar(botId, key) {
      const bot = getRequiredBot(bots, botId);
      botEnvVars.delete(botCapabilityScopedKey(bot.bot_id, requireText(key, "key")));
    },

    createUserCredentialBinding(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const scope = normalizeUserCredentialScope({ ...input, bot_id: bot.bot_id });
      if (userCredentials.has(userCredentialScopeKey(scope))) {
        throw new Error("user credential is already bound; unbind first");
      }
      const token = randomCredentialBindingToken();
      const now = new Date();
      for (const [tokenHash, existing] of userCredentialBindings.entries()) {
        if (
          existing.bot_id === scope.bot_id
          && existing.wecom_user_id === scope.wecom_user_id
          && existing.provider === scope.provider
          && !existing.consumed_at
        ) {
          userCredentialBindings.set(tokenHash, {
            ...existing,
            consumed_at: now.toISOString(),
          });
        }
      }
      const record: UserCredentialBindingRecord = {
        token,
        token_hash: hashCredentialBindingToken(token),
        ...scope,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      };
      userCredentialBindings.set(record.token_hash, record);
      return cloneUserCredentialBindingRecord(record);
    },

    getUserCredentialBinding(token) {
      const record = userCredentialBindings.get(hashCredentialBindingToken(token));
      return isActiveUserCredentialBinding(record)
        ? cloneUserCredentialBindingRecord(record)
        : undefined;
    },

    completeUserCredentialBinding(input) {
      const tokenHash = hashCredentialBindingToken(input.token);
      const binding = userCredentialBindings.get(tokenHash);
      if (!isActiveUserCredentialBinding(binding)) {
        throw new Error("credential binding link is invalid or expired");
      }
      const scopeKey = userCredentialScopeKey(binding);
      const existing = userCredentials.get(scopeKey);
      const now = new Date().toISOString();
      const credential: UserCredentialRecord = {
        bot_id: binding.bot_id,
        wecom_user_id: binding.wecom_user_id,
        provider: binding.provider,
        payload_ciphertext: requireText(input.payload_ciphertext, "payload_ciphertext"),
        created_at: existing?.created_at ?? now,
        updated_at: existing ? nextIsoTimestamp(existing.updated_at) : now,
      };
      userCredentials.set(scopeKey, credential);
      userCredentialBindings.set(tokenHash, { ...binding, consumed_at: now });
      return userCredentialMetadata(credential);
    },

    getUserCredential(input) {
      getRequiredBot(bots, input.bot_id);
      const record = userCredentials.get(userCredentialScopeKey(normalizeUserCredentialScope(input)));
      return record ? { ...record } : undefined;
    },

    getUserCredentialMetadata(input) {
      const record = this.getUserCredential(input);
      return record ? userCredentialMetadata(record) : undefined;
    },

    deleteUserCredential(input) {
      getRequiredBot(bots, input.bot_id);
      userCredentials.delete(userCredentialScopeKey(normalizeUserCredentialScope(input)));
    },

    upsertBotSkill(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const name = requireText(input.name, "name");
      const mapKey = botCapabilityScopedKey(bot.bot_id, name);
      const existing = botSkills.get(mapKey);
      const installedAt = existing
        ? nextIsoTimestamp(existing.installed_at)
        : nextCollectionIsoTimestamp(botSkills, "installed_at");
      const record: BotSkillRecord = {
        skill_id: existing?.skill_id ?? `skill_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        name,
        source_type: requireBotSkillSourceType(input.source_type),
        source_ref: requireText(input.source_ref, "source_ref"),
        status: requireBotCapabilityInstallStatus(input.status),
        installed_at: installedAt,
        installed_by_wecom_user_id: requireText(
          input.installed_by_wecom_user_id,
          "installed_by_wecom_user_id",
        ),
        last_error: optionalText(input.last_error),
      };
      botSkills.set(mapKey, record);
      return cloneBotSkillRecord(record);
    },

    listBotSkills(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...botSkills.values()]
        .filter((record) => record.bot_id === bot.bot_id)
        .sort(compareInstalledRecordsDesc)
        .map(cloneBotSkillRecord);
    },

    deleteBotSkill(botId, name) {
      const bot = getRequiredBot(bots, botId);
      botSkills.delete(botCapabilityScopedKey(bot.bot_id, requireText(name, "name")));
    },

    upsertBotMcp(botId, input) {
      const bot = getRequiredBot(bots, botId);
      const name = requireText(input.name, "name");
      const mapKey = botCapabilityScopedKey(bot.bot_id, name);
      const existing = botMcps.get(mapKey);
      const installedAt = existing
        ? nextIsoTimestamp(existing.installed_at)
        : nextCollectionIsoTimestamp(botMcps, "installed_at");
      const record: BotMcpRecord = {
        mcp_id: existing?.mcp_id ?? `mcp_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        name,
        mode: requireBotMcpMode(input.mode),
        source_ref: requireText(input.source_ref, "source_ref"),
        status: requireBotCapabilityInstallStatus(input.status),
        installed_at: installedAt,
        installed_by_wecom_user_id: requireText(
          input.installed_by_wecom_user_id,
          "installed_by_wecom_user_id",
        ),
        last_error: optionalText(input.last_error),
      };
      botMcps.set(mapKey, record);
      return cloneBotMcpRecord(record);
    },

    listBotMcps(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...botMcps.values()]
        .filter((record) => record.bot_id === bot.bot_id)
        .sort(compareInstalledRecordsDesc)
        .map(cloneBotMcpRecord);
    },

    deleteBotMcp(botId, name) {
      const bot = getRequiredBot(bots, botId);
      botMcps.delete(botCapabilityScopedKey(bot.bot_id, requireText(name, "name")));
    },

    appendBotCapabilityAuditLog(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const createdAt = nextCollectionIsoTimestamp(botCapabilityAuditLogs, "created_at");
      const record: BotCapabilityAuditLogRecord = {
        log_id: `cap_audit_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        display_name: optionalText(input.display_name),
        action_type: requireBotCapabilityAuditActionType(input.action_type),
        target_name: requireText(input.target_name, "target_name"),
        source_ref: optionalText(input.source_ref),
        result: requireBotCapabilityAuditResult(input.result),
        error_message: optionalText(input.error_message),
        created_at: createdAt,
      };
      botCapabilityAuditLogs.set(record.log_id, record);
      return cloneBotCapabilityAuditLogRecord(record);
    },

    listBotCapabilityAuditLogs(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...botCapabilityAuditLogs.values()]
        .filter((record) => record.bot_id === bot.bot_id)
        .sort(compareCreatedRecordsDesc)
        .map(cloneBotCapabilityAuditLogRecord);
    },

    appendMcpToolExecution(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const record: McpToolExecutionRecord = {
        execution_id: `mcp_exec_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        tool_name: requireText(input.tool_name, "tool_name"),
        status: requireMcpToolExecutionStatus(input.status),
        duration_ms: requireMcpToolExecutionDuration(input.duration_ms),
        error_code: optionalText(input.error_code),
        created_at: nextCollectionIsoTimestamp(mcpToolExecutions, "created_at"),
      };
      mcpToolExecutions.set(record.execution_id, record);
      return cloneMcpToolExecutionRecord(record);
    },

    listMcpToolExecutions(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...mcpToolExecutions.values()]
        .filter((record) => record.bot_id === bot.bot_id)
        .sort(compareCreatedRecordsDesc)
        .map(cloneMcpToolExecutionRecord);
    },

    getAdmin(botId) {
      return admins.get(botId);
    },

    createAdminClaim(botId) {
      const bot = getRequiredBot(bots, botId);
      if (admins.has(botId)) {
        throw new Error(`admin already claimed for bot: ${botId}`);
      }

      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)
        .padStart(6, "0");
      const now = new Date();
      const claim: AdminClaimRecord = {
        bot_id: bot.bot_id,
        code,
        code_hash: hashClaimCode(code),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ADMIN_CLAIM_TTL_MS).toISOString(),
      };
      adminClaims.set(bot.bot_id, claim);
      return claim;
    },

    claimAdmin(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const existing = admins.get(input.bot_id);
      if (existing) {
        throw new Error(`admin already claimed for bot: ${input.bot_id}`);
      }

      const admin: AdminRecord = {
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        role: "admin",
        claimed_at: new Date().toISOString(),
      };
      admins.set(bot.bot_id, admin);
      bot.status = "initializing";
      bot.updated_at = new Date().toISOString();
      return admin;
    },

    verifyAdminClaim(input) {
      const claim = adminClaims.get(input.bot_id);
      if (!claim) {
        throw new Error(`admin claim code does not exist for bot: ${input.bot_id}`);
      }
      if (new Date(claim.expires_at).getTime() < Date.now()) {
        throw new Error("admin claim code expired");
      }
      if (claim.code_hash !== hashClaimCode(input.code)) {
        throw new Error("invalid admin claim code");
      }

      const admin = this.claimAdmin({
        bot_id: input.bot_id,
        wecom_user_id: input.wecom_user_id,
      });
      adminClaims.delete(input.bot_id);
      return admin;
    },

    transferAdmin(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const existing = admins.get(bot.bot_id);
      if (!existing) {
        throw new Error(`admin is not claimed for bot: ${bot.bot_id}`);
      }
      if (
        existing.wecom_user_id !==
        requireText(input.current_wecom_user_id, "current_wecom_user_id")
      ) {
        throw new Error("current admin does not match");
      }

      const admin: AdminRecord = {
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.new_wecom_user_id, "new_wecom_user_id"),
        role: "admin",
        claimed_at: new Date().toISOString(),
      };
      admins.set(bot.bot_id, admin);
      return admin;
    },

    markBotReady(botId) {
      const bot = getRequiredBot(bots, botId);
      if (!admins.has(botId)) {
        throw new Error(`admin is not claimed for bot: ${botId}`);
      }
      bot.status = "ready";
      bot.updated_at = new Date().toISOString();
      return bot;
    },

    resolveMessageContext(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const admin = admins.get(input.bot_id);
      const isAdmin = admin?.wecom_user_id === input.wecom_user_id;

      const projectKey = bot.project_key;
      const contextBase = {
        bot_id: bot.bot_id,
        wecom_user_id: input.wecom_user_id,
        ...(projectKey ? { project_key: projectKey } : {}),
      };
      if (!admin) {
        return {
          ...contextBase,
          is_admin: false,
          allowed: false,
          reason: "admin_unclaimed",
        };
      }

      if (bot.status !== "ready") {
        if (isAdmin) {
          return {
            ...contextBase,
            is_admin: true,
            allowed: true,
            reason: "initializing",
            conversation: this.resolveConversation({
              ...input,
              purpose: "init",
            }),
          };
        }

        return {
          ...contextBase,
          is_admin: isAdmin,
          allowed: false,
          reason: "initialization_required",
        };
      }

      return {
        ...contextBase,
        is_admin: isAdmin,
        allowed: true,
        reason: "ready",
        conversation: this.resolveConversation(input),
      };
    },

    resolveConversation(input) {
      const key = conversationScopeKey(
        input.bot_id,
        input.wecom_user_id,
        input.channel,
        input.purpose,
      );
      const activeConversationId = activeConversationIds.get(key);
      const active = activeConversationId ? conversationHistory.get(activeConversationId) : undefined;
      return active ? cloneConversationRecord(active) : createConversationForScope(conversationHistory, activeConversationIds, input);
    },

    listConversations(input) {
      getRequiredBot(bots, input.bot_id);
      return [...conversationHistory.values()]
        .filter((conversation) =>
          conversation.bot_id === input.bot_id
          && conversation.wecom_user_id === input.wecom_user_id
          && conversation.channel === input.channel
          && conversation.purpose === input.purpose
        )
        .sort((left, right) => right.sequence_no - left.sequence_no)
        .map((conversation) => cloneConversationRecord(conversation));
    },

    createConversation(input) {
      return createConversationForScope(conversationHistory, activeConversationIds, input);
    },

    openConversation(input) {
      getRequiredBot(bots, input.bot_id);
      const conversation = conversationHistory.get(input.conversation_id);
      if (!conversation || conversation.bot_id !== input.bot_id || conversation.wecom_user_id !== input.wecom_user_id) {
        throw new Error(`conversation not found: ${input.conversation_id}`);
      }
      const key = conversationScopeKey(conversation.bot_id, conversation.wecom_user_id, conversation.channel, conversation.purpose);
      const previousConversationId = activeConversationIds.get(key);
      if (previousConversationId && previousConversationId !== conversation.conversation_id) {
        const previous = conversationHistory.get(previousConversationId);
        if (previous) {
          conversationHistory.set(previous.conversation_id, {
            ...previous,
            is_active: false,
          });
        }
      }
      const activated = {
        ...conversation,
        is_active: true,
        updated_at: nextIsoTimestamp(conversation.updated_at),
      };
      activeConversationIds.set(key, activated.conversation_id);
      conversationHistory.set(activated.conversation_id, activated);
      return cloneConversationRecord(activated);
    },

    renameConversation(input) {
      getRequiredBot(bots, input.bot_id);
      const conversation = conversationHistory.get(input.conversation_id);
      if (!conversation || conversation.bot_id !== input.bot_id || conversation.wecom_user_id !== input.wecom_user_id) {
        throw new Error(`conversation not found: ${input.conversation_id}`);
      }
      const updated = {
        ...conversation,
        display_name: requireText(input.display_name, "display_name"),
        updated_at: nextIsoTimestamp(conversation.updated_at),
      };
      conversationHistory.set(updated.conversation_id, updated);
      const key = conversationScopeKey(updated.bot_id, updated.wecom_user_id, updated.channel, updated.purpose);
      const activeConversationId = activeConversationIds.get(key);
      if (activeConversationId === updated.conversation_id) {
        conversationHistory.set(updated.conversation_id, {
          ...updated,
          is_active: true,
        });
      }
      return cloneConversationRecord(updated);
    },

    upsertInitializationSession(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const key = initializationSessionKey({
        bot_id: bot.bot_id,
        wecom_user_id: input.wecom_user_id,
        conversation_id: input.conversation_id,
      });
      const existing = initializationSessions.get(key);
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: InitializationSessionRecord = {
        session_id: existing?.session_id ?? `init_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        phase: requireInitializationPhase(input.phase),
        ...(optionalText(input.selected_role_id)
          ? { selected_role_id: optionalText(input.selected_role_id) }
          : {}),
        soul_answers: normalizeAnswerArray(input.soul_answers, "soul_answers"),
        agents_answers: normalizeAnswerArray(input.agents_answers, "agents_answers"),
        ...(input.generation_in_progress !== undefined
          ? { generation_in_progress: requireInitializationGenerationInProgress(input.generation_in_progress) }
          : {}),
        status: requireInitializationSessionStatus(input.status),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      initializationSessions.set(key, record);
      return cloneInitializationSessionRecord(record);
    },

    getActiveInitializationSession(input) {
      const record = initializationSessions.get(initializationSessionKey(input));
      return record?.status === "active" ? cloneInitializationSessionRecord(record) : undefined;
    },

    clearInitializationSession(input) {
      const key = initializationSessionKey(input);
      const record = initializationSessions.get(key);
      // Only remove an in-progress session; completed/cancelled history stays in the store.
      if (record?.status === "active") {
        initializationSessions.delete(key);
      }
    },

    createPendingGeneratedDocument(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const now = new Date().toISOString();
      const record: PendingGeneratedDocumentRecord = {
        pending_id: `pending_${crypto.randomUUID()}`,
        bot_id: bot.bot_id,
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        title: requireText(input.title, "title"),
        content: requireText(input.content, "content"),
        status: "pending",
        created_by_bot_id: requireText(input.created_by_bot_id, "created_by_bot_id"),
        created_by_user_id: requireText(input.created_by_user_id, "created_by_user_id"),
        created_at: now,
        updated_at: now,
      };
      pendingGeneratedDocuments.set(record.pending_id, record);
      return record;
    },

    listPendingGeneratedDocuments(input) {
      const query = normalizePendingGeneratedDocumentQuery(input, bots);
      return [...pendingGeneratedDocuments.values()]
        .filter((document) => matchesPendingGeneratedDocumentQuery(document, query));
    },

    confirmPendingGeneratedDocuments(input) {
      const query = normalizePendingGeneratedDocumentQuery(input, bots);
      return updateMatchingPendingGeneratedDocuments(
        pendingGeneratedDocuments,
        query,
        "confirmed",
      );
    },

    cancelPendingGeneratedDocuments(input) {
      const query = normalizePendingGeneratedDocumentQuery(input, bots);
      return updateMatchingPendingGeneratedDocuments(
        pendingGeneratedDocuments,
        query,
        "cancelled",
      );
    },

    applyPendingGeneratedDocuments(input) {
      const query = normalizePendingGeneratedDocumentQuery(input, bots);
      requireText(input.created_by_bot_id, "created_by_bot_id");
      requireText(input.created_by_user_id, "created_by_user_id");
      const pending = [...pendingGeneratedDocuments.values()]
        .filter((document) => matchesPendingGeneratedDocumentQuery(document, query));
      const saved: AppliedPendingGeneratedDocumentResult[] = [];

      for (const pendingDocument of pending) {
        const existing = [...businessDocuments.values()]
          .filter((document) =>
            document.scope === "bot" &&
            document.owner_id === query.bot_id &&
            document.title === pendingDocument.title &&
            !isBotConfigDocumentTitle(document.title)
          )
          .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];

        if (!existing) {
          const now = new Date().toISOString();
          const created: BusinessDocumentRecord = {
            document_id: `doc_${crypto.randomUUID()}`,
            scope: "bot",
            owner_id: query.bot_id,
            title: pendingDocument.title,
            doc_type: "markdown",
            visibility: "bot",
            tier: "core",
            source_type: "document",
            created_by_bot_id: input.created_by_bot_id,
            created_by_user_id: input.created_by_user_id,
            version: 1,
            tags: ["generated", "pending-confirmed"],
            created_at: now,
            updated_at: now,
            hit_count: 0,
            status: "active",
          };
          const version: BusinessDocumentVersionRecord = {
            document_id: created.document_id,
            version: 1,
            content: pendingDocument.content,
            created_at: now,
            chunk_count: 0,
          };
          businessDocuments.set(created.document_id, created);
          businessDocumentVersions.set(created.document_id, [version]);
          saved.push({
            pending_id: pendingDocument.pending_id,
            title: pendingDocument.title,
            version: created.version,
          });
          continue;
        }

        const latestVersion = (businessDocumentVersions.get(existing.document_id) ?? []).at(-1);
        if (latestVersion?.content === pendingDocument.content) {
          saved.push({
            pending_id: pendingDocument.pending_id,
            title: pendingDocument.title,
            version: existing.version,
          });
          continue;
        }

        const versions = businessDocumentVersions.get(existing.document_id) ?? [];
        const now = nextIsoTimestamp(existing.updated_at);
        const updated: BusinessDocumentVersionRecord = {
          document_id: existing.document_id,
          version: versions.length + 1,
          content: pendingDocument.content,
          change_summary: "用户确认后更新文档",
          created_at: now,
          chunk_count: 0,
        };
        businessDocumentVersions.set(existing.document_id, [...versions, updated]);
        businessDocuments.set(existing.document_id, {
          ...existing,
          version: updated.version,
          updated_at: now,
        });
        saved.push({
          pending_id: pendingDocument.pending_id,
          title: pendingDocument.title,
          version: updated.version,
        });
      }

      for (const pendingDocument of pending) {
        pendingGeneratedDocuments.set(pendingDocument.pending_id, {
          ...pendingDocument,
          status: "confirmed",
          updated_at: nextIsoTimestamp(pendingDocument.updated_at),
        });
      }

      return saved;
    },

    upsertGlobalDocument(input) {
      const title = requireText(input.title, "title");
      const slug = requireText(input.slug, "slug");
      const content = requireText(input.content, "content");
      const existing = input.document_id
        ? getRequiredRecordById(
          globalDocuments,
          input.document_id,
          "document_id",
          "global document",
        )
        : findGlobalDocumentBySlug(globalDocuments, slug);
      const duplicate = findGlobalDocumentBySlug(
        globalDocuments,
        slug,
        existing?.document_id,
      );
      if (duplicate) {
        throw new Error(`global document slug already exists: ${slug}`);
      }
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: GlobalDocumentRecord = {
        document_id: existing?.document_id ?? `global_doc_${crypto.randomUUID()}`,
        title,
        slug,
        content,
        enabled: normalizeEnabled(input.enabled),
        sort_order: normalizeSortOrder(input.sort_order),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      globalDocuments.set(record.document_id, record);
      return record;
    },

    listGlobalDocuments(options = {}) {
      return [...globalDocuments.values()]
        .filter((document) => includeEnabledRecord(document, options))
        .sort(compareSortedRecords);
    },

    deleteGlobalDocument(documentId) {
      globalDocuments.delete(documentId);
    },

    upsertRole(input) {
      const name = requireText(input.name, "name");
      const slug = requireText(input.slug, "slug");
      const description = typeof input.description === "string" ? input.description.trim() : "";
      const existing = input.role_id
        ? getRequiredRecordById(roles, input.role_id, "role_id", "role")
        : findRoleBySlug(roles, slug);
      const duplicate = findRoleBySlug(roles, slug, existing?.role_id);
      if (duplicate) {
        throw new Error(`role slug already exists: ${slug}`);
      }
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: RoleRecord = {
        role_id: existing?.role_id ?? `role_${crypto.randomUUID()}`,
        name,
        slug,
        description,
        enabled: normalizeEnabled(input.enabled),
        sort_order: normalizeSortOrder(input.sort_order),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      roles.set(record.role_id, record);
      return record;
    },

    listRoles(options = {}) {
      return [...roles.values()]
        .filter((role) => includeEnabledRecord(role, options))
        .sort(compareSortedRecords);
    },

    deleteRole(roleId) {
      roles.delete(roleId);
      deleteRecordsByRoleId(roleDocuments, roleId);
      deleteRecordsByRoleId(roleQuestions, roleId);
    },

    upsertRoleDocument(input) {
      const role = getRequiredRole(roles, input.role_id);
      const title = requireText(input.title, "title");
      const content = requireText(input.content, "content");
      const existing = input.role_document_id
        ? getRequiredRecordById(
          roleDocuments,
          input.role_document_id,
          "role_document_id",
          "role document",
        )
        : findRoleDocumentByRoleAndTitle(roleDocuments, role.role_id, title);
      const duplicate = findRoleDocumentByRoleAndTitle(
        roleDocuments,
        role.role_id,
        title,
        existing?.role_document_id,
      );
      if (duplicate) {
        throw new Error(
          `role document already exists for role ${role.role_id} and title ${title}`,
        );
      }
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: RoleDocumentRecord = {
        role_document_id: existing?.role_document_id ?? `role_doc_${crypto.randomUUID()}`,
        role_id: role.role_id,
        title,
        content,
        enabled: normalizeEnabled(input.enabled),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      roleDocuments.set(record.role_document_id, record);
      return record;
    },

    listRoleDocuments(roleId, options = {}) {
      return [...roleDocuments.values()]
        .filter((document) => document.role_id === requireText(roleId, "role_id"))
        .filter((document) => includeEnabledRecord(document, options))
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    },

    deleteRoleDocument(roleDocumentId) {
      roleDocuments.delete(roleDocumentId);
    },

    upsertRoleQuestion(input) {
      const role = getRequiredRole(roles, input.role_id);
      const key = requireText(input.key, "key");
      const title = requireText(input.title, "title");
      const existing = input.question_id
        ? getRequiredRecordById(
          roleQuestions,
          input.question_id,
          "question_id",
          "role question",
        )
        : findRoleQuestionByRoleAndKey(roleQuestions, role.role_id, key);
      const duplicate = findRoleQuestionByRoleAndKey(
        roleQuestions,
        role.role_id,
        key,
        existing?.question_id,
      );
      if (duplicate) {
        throw new Error(`role question already exists for role ${role.role_id} and key ${key}`);
      }
      const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
      const record: RoleQuestionRecord = {
        question_id: existing?.question_id ?? `question_${crypto.randomUUID()}`,
        role_id: role.role_id,
        key,
        title,
        description: normalizeOptionalText(input.description),
        question_type: requireRoleQuestionType(input.question_type),
        options_json: normalizeRoleQuestionOptions(input.options_json),
        required: normalizeRequired(input.required),
        enabled: normalizeEnabled(input.enabled),
        sort_order: normalizeSortOrder(input.sort_order),
        depends_on_json: normalizeRoleQuestionDependencies(input.depends_on_json),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      roleQuestions.set(record.question_id, record);
      return cloneRoleQuestionRecord(record);
    },

    listRoleQuestions(roleId, options = {}) {
      return [...roleQuestions.values()]
        .filter((question) => question.role_id === requireText(roleId, "role_id"))
        .filter((question) => includeEnabledRecord(question, options))
        .sort(compareSortedRecords)
        .map(cloneRoleQuestionRecord);
    },

    deleteRoleQuestion(questionId) {
      roleQuestions.delete(questionId);
    },

    upsertBotConfigDocument(input) {
      const bot = getRequiredBot(bots, input.bot_id);
      const title = requireBotConfigDocumentTitle(input.title);
      const key = `${bot.bot_id}:${title}`;
      const existing = botConfigDocuments.get(key);
      const now = new Date().toISOString();
      const record: BotConfigDocumentRecord = {
        bot_id: bot.bot_id,
        title,
        content: input.content,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      botConfigDocuments.set(key, record);
      return record;
    },

    listBotConfigDocuments(botId) {
      const bot = getRequiredBot(bots, botId);
      return [...botConfigDocuments.values()]
        .filter((document) => document.bot_id === bot.bot_id)
        .sort((left, right) => configDocumentOrder(left.title) - configDocumentOrder(right.title));
    },

    upsertMemoryDocument(input) {
      if (input.scope === "bot" && isBotConfigDocumentTitle(input.title)) {
        throw new Error("bot config documents must use /v1/bot-config-documents");
      }
      const memoryDocId = input.memory_doc_id ?? `mem_${crypto.randomUUID()}`;
      const versions = memoryDocuments.get(memoryDocId) ?? [];
      const record: MemoryDocumentRecord = {
        memory_doc_id: memoryDocId,
        scope: input.scope,
        owner_id: requireText(input.owner_id, "owner_id"),
        title: requireText(input.title, "title"),
        version: versions.length + 1,
        content: input.content,
        status: "active",
        created_at: new Date().toISOString(),
      };
      memoryDocuments.set(memoryDocId, [...versions, record]);
      return record;
    },

    listMemoryDocumentVersions(memoryDocId) {
      return memoryDocuments.get(memoryDocId) ?? [];
    },

    listCurrentMemoryDocuments(input) {
      const current: MemoryDocumentRecord[] = [];
      for (const versions of memoryDocuments.values()) {
        const latest = versions.at(-1);
        if (
          latest &&
          latest.scope === input.scope &&
          latest.owner_id === requireText(input.owner_id, "owner_id") &&
          !(latest.scope === "bot" && isBotConfigDocumentTitle(latest.title))
        ) {
          current.push(latest);
        }
      }
      return current;
    },

    createBusinessDocument(input) {
      if (isBotConfigDocumentTitle(input.title)) {
        throw new Error("bot config documents must use /v1/bot-config-documents");
      }
      const now = new Date().toISOString();
      const document: BusinessDocumentRecord = {
        document_id: input.document_id ?? `doc_${crypto.randomUUID()}`,
        scope: input.scope,
        owner_id: requireText(input.owner_id, "owner_id"),
        title: requireText(input.title, "title"),
        doc_type: requireText(input.doc_type, "doc_type"),
        visibility: input.visibility ?? input.scope,
        tier: input.tier ?? "core",
        ...(input.source_type ? { source_type: input.source_type } : {}),
        ...(input.source_uri ? { source_uri: input.source_uri } : {}),
        ...(input.content_hash ? { content_hash: input.content_hash } : {}),
        ...(input.created_by_bot_id ? { created_by_bot_id: input.created_by_bot_id } : {}),
        ...(input.created_by_user_id ? { created_by_user_id: input.created_by_user_id } : {}),
        version: 1,
        tags: normalizeTags(input.tags),
        created_at: now,
        updated_at: now,
        hit_count: 0,
        status: "active",
      };
      const version: BusinessDocumentVersionRecord = {
        document_id: document.document_id,
        version: 1,
        content: input.content,
        created_at: now,
        chunk_count: 0,
      };
      businessDocuments.set(document.document_id, document);
      businessDocumentVersions.set(document.document_id, [version]);
      return document;
    },

    updateBusinessDocument(input) {
      const document = businessDocuments.get(input.document_id);
      if (!document) {
        throw new Error(`business document not found: ${input.document_id}`);
      }
      const versions = businessDocumentVersions.get(document.document_id) ?? [];
      const now = nextIsoTimestamp(document.updated_at);
      const version: BusinessDocumentVersionRecord = {
        document_id: document.document_id,
        version: versions.length + 1,
        content: input.content,
        ...(input.change_summary ? { change_summary: input.change_summary } : {}),
        created_at: now,
        chunk_count: input.chunk_count ?? 0,
      };
      businessDocumentVersions.set(document.document_id, [...versions, version]);
      businessDocuments.set(document.document_id, {
        ...document,
        version: version.version,
        updated_at: now,
      });
      return version;
    },

    getBusinessDocument(documentId, version) {
      const versions = businessDocumentVersions.get(documentId) ?? [];
      if (version !== undefined) {
        return versions.find((item) => item.version === version);
      }
      return versions.at(-1);
    },

    listBusinessDocuments(input = {}) {
      return [...businessDocuments.values()]
        .filter((document) => matchesBusinessDocumentQuery(document, input))
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    },

    createMemoryRecord(input) {
      const now = new Date().toISOString();
      const memory: MemoryRecord = {
        memory_id: input.memory_id ?? `mem_${crypto.randomUUID()}`,
        scope: input.scope,
        owner_id: requireText(input.owner_id, "owner_id"),
        content: requireText(input.content, "content"),
        tier: input.tier ?? "core",
        source_type: input.source_type ?? "text",
        ...(input.source_conversation_id
          ? { source_conversation_id: input.source_conversation_id }
          : {}),
        ...(input.source_message_id ? { source_message_id: input.source_message_id } : {}),
        ...(input.created_by_bot_id ? { created_by_bot_id: input.created_by_bot_id } : {}),
        ...(input.created_by_user_id ? { created_by_user_id: input.created_by_user_id } : {}),
        tags: normalizeTags(input.tags),
        created_at: now,
        updated_at: now,
        hit_count: 0,
        status: "active",
      };
      memories.set(memory.memory_id, memory);
      return memory;
    },

    listMemories(input = {}) {
      return [...memories.values()]
        .filter((memory) => matchesMemoryQuery(memory, input))
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    },

    recordChunks(input) {
      const createdAt = new Date().toISOString();
      const records = input.chunks.map((chunk) => {
        const record: ChunkRecord = {
          chunk_id: `chunk_${crypto.randomUUID()}`,
          source_type: input.source_type,
          source_id: requireText(input.source_id, "source_id"),
          scope: input.scope,
          owner_id: requireText(input.owner_id, "owner_id"),
          content: requireText(chunk.content, "content"),
          chunk_index: chunk.chunk_index,
          ...(chunk.heading_path ? { heading_path: chunk.heading_path } : {}),
          ...(chunk.location ? { location: chunk.location } : {}),
          tier: chunk.tier ?? "core",
          created_at: createdAt,
          hit_count: 0,
        };
        chunks.set(record.chunk_id, record);
        return record;
      });
      return records;
    },

    recordAsset(input) {
      const asset: AssetRecord = {
        asset_id: `asset_${crypto.randomUUID()}`,
        source_type: input.source_type,
        source_id: requireText(input.source_id, "source_id"),
        filename: requireText(input.filename, "filename"),
        content_type: requireText(input.content_type, "content_type"),
        storage_uri: requireText(input.storage_uri, "storage_uri"),
        size_bytes: input.size_bytes,
        content_hash: requireText(input.content_hash, "content_hash"),
        created_at: new Date().toISOString(),
      };
      assets.set(asset.asset_id, asset);
      return asset;
    },

    getMemoryStats(input = {}) {
      const filteredMemories = [...memories.values()].filter((memory) =>
        matchesMemoryStatsQuery(memory, input)
      );
      const filteredChunks = [...chunks.values()].filter((chunk) =>
        matchesMemoryStatsQuery(chunk, input)
      );
      const filteredAssets = [...assets.values()].filter((asset) => {
        const source = asset.source_type === "memory"
          ? memories.get(asset.source_id)
          : businessDocuments.get(asset.source_id);
        return source ? matchesMemoryStatsQuery(source, input) : false;
      });
      return {
        total_memories: filteredMemories.length,
        total_chunks: filteredChunks.length,
        by_tier: countMemoriesByTier(filteredMemories),
        disk_usage_bytes: filteredAssets.reduce((total, asset) => total + asset.size_bytes, 0),
      };
    },
  };
}

export function seedDefaultRoleConfig(store: Pick<
  DataStore,
  | "upsertGlobalDocument"
  | "listGlobalDocuments"
  | "upsertRole"
  | "listRoles"
  | "upsertRoleDocument"
  | "listRoleDocuments"
  | "upsertRoleQuestion"
  | "listRoleQuestions"
>): void {
  const buildSingleChoiceQuestion = (
    key: string,
    title: string,
    sortOrder: number,
    optionLabels: string[],
  ) => ({
    key,
    title,
    description: "",
    question_type: "single_choice" as const,
    options_json: optionLabels.map((label, index) => ({
      value: `option_${index + 1}`,
      label,
    })),
    required: true,
    enabled: true,
    sort_order: sortOrder,
    depends_on_json: [],
  });
  const defaultPlayground = {
    title: "playground.md",
    slug: "playground",
    content: [
      "# Playground",
      "",
      "- 所有回复使用中文，文档使用 Markdown 格式。",
      "- 一次只问一个关键问题。",
      "- 如果采用逐句引导，则每次都要给出候选项，并允许用户直接自由回答。",
      "- 如果能够判断，应先给出推荐项，再让用户确认或修正。",
      "- 候选项必须逐项独立成行，使用 `1. 内容`、`2. 内容` 格式；推荐说明必须单独成句，不得写在候选项行尾。",
      "- 输出应结构化、可执行，避免空泛表述。",
    ].join("\n"),
    enabled: true,
    sort_order: 10,
  } satisfies UpsertGlobalDocumentInput;
  const standardRoles = [
    {
      name: "产品经理",
      slug: "product-manager",
      description: "产品经理角色",
      sort_order: 10,
      document: [
        "# Role: Product Manager",
        "",
        "## 角色定位",
        "你是产品经理，负责把模糊需求澄清为可评审、可落地、可协作的结构化输出。",
        "",
        "## 默认工作规则",
        "- 默认先补齐背景、目标用户、核心问题和业务价值。",
        "- 默认补齐范围、非范围、限制条件、依赖条件和风险点。",
        "- 涉及环信需求时默认检查 Console、IMM、计量计费、集群、开关灰度兼容性。",
        "- 输出偏评审与落地，不写空泛 PRD。",
        "- 生成 PRD 时，功能点清单必须使用 Markdown 表格展示，至少包含编号、功能、说明、优先级列。",
        "- PRD 功能点清单必须按优先级排布，优先级使用 P0/P1/P2；P0 表示首期必须完成，P1 表示首期重要增强，P2 表示后续规划。",
      ].join("\n"),
      questions: [
        buildSingleChoiceQuestion("interaction_mode", "你希望它用什么方式和你交互？", 10, [
          "逐句引导",
          "批量确认",
          "先给推荐方案，再确认",
        ]),
        buildSingleChoiceQuestion("memory_storage", "是否需要长期沉淀规则和文档？", 20, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("output_shape", "默认输出更偏向哪类内容？", 30, [
          "PRD",
          "需求评审",
          "用户故事",
          "拆解清单",
        ]),
        buildSingleChoiceQuestion("recommendation_first", "是否需要优先给推荐方案？", 50, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("work_rules", "是否有额外工作规则？", 60, [
          "没有",
          "直接补充",
        ]),
      ],
    },
    {
      name: "测试工程师",
      slug: "qa-engineer",
      description: "测试工程师角色",
      sort_order: 20,
      document: [
        "# Role: QA Engineer",
        "",
        "## 角色定位",
        "你是测试工程师，负责从范围、异常流、兼容性、回归风险等角度构建可靠测试输出。",
        "",
        "## 默认工作规则",
        "- 默认补齐测试范围、非测试范围、前置条件和风险说明。",
        "- 优先从边界、异常流、兼容性、回归风险切入。",
        "- 输出测试用例时强调步骤、预期结果、边界覆盖和回归覆盖。",
      ].join("\n"),
      questions: [
        buildSingleChoiceQuestion("interaction_mode", "你希望它用什么方式和你交互？", 10, [
          "逐句引导",
          "批量确认",
          "先给结论再展开",
        ]),
        buildSingleChoiceQuestion("memory_storage", "是否需要长期沉淀规则和测试资产？", 20, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("output_shape", "默认输出更偏向哪类内容？", 30, [
          "测试方案",
          "测试用例",
          "回归清单",
          "缺陷分析",
        ]),
        buildSingleChoiceQuestion("exception_priority", "是否优先关注异常场景？", 40, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("compatibility_priority", "是否强调兼容性与回归？", 50, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("work_rules", "是否有额外工作规则？", 60, [
          "没有",
          "直接补充",
        ]),
      ],
    },
    {
      name: "研发工程师",
      slug: "engineer",
      description: "研发工程师角色",
      sort_order: 30,
      document: [
        "# Role: Engineer",
        "",
        "## 角色定位",
        "你是研发工程师，负责把需求转成可实现方案、接口设计、任务拆解和排障思路。",
        "",
        "## 默认工作规则",
        "- 默认先澄清目标、输入输出、约束和依赖。",
        "- 优先给可实现方案，关注兼容性、回滚、灰度与边界。",
        "- 输出方案时强调模块边界、接口、数据流和异常处理。",
      ].join("\n"),
      questions: [
        buildSingleChoiceQuestion("interaction_mode", "你希望它用什么方式和你交互？", 10, [
          "逐句引导",
          "批量确认",
          "先给方案，再补细节",
        ]),
        buildSingleChoiceQuestion("memory_storage", "是否需要长期沉淀规则和技术文档？", 20, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("output_shape", "默认输出更偏向哪类内容？", 30, [
          "技术方案",
          "接口设计",
          "任务拆解",
          "排障分析",
        ]),
        buildSingleChoiceQuestion("compatibility_priority", "是否强调兼容性与回滚？", 40, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("implementation_steps", "是否默认给实现步骤？", 50, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("work_rules", "是否有额外工作规则？", 60, [
          "没有",
          "直接补充",
        ]),
      ],
    },
    {
      name: "市场人员",
      slug: "marketing",
      description: "市场人员角色",
      sort_order: 40,
      document: [
        "# Role: Marketing",
        "",
        "## 角色定位",
        "你是市场人员，负责围绕用户价值、竞品差异、卖点表达和传播角度组织内容。",
        "",
        "## 默认工作规则",
        "- 强调结论清晰、信息可传播，避免技术表达过重。",
        "- 输出分析时突出结论、支撑信息与建议动作。",
        "- 默认围绕用户价值、卖点和外部表达口径展开。",
      ].join("\n"),
      questions: [
        buildSingleChoiceQuestion("interaction_mode", "你希望它用什么方式和你交互？", 10, [
          "逐句引导",
          "批量确认",
          "先给结论再展开",
        ]),
        buildSingleChoiceQuestion("memory_storage", "是否需要长期沉淀规则和市场文档？", 20, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("output_shape", "默认输出更偏向哪类内容？", 30, [
          "竞品分析",
          "卖点整理",
          "活动文案",
          "市场调研摘要",
        ]),
        buildSingleChoiceQuestion("conclusion_first", "是否强调结论先行？", 40, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("external_tone", "是否偏外部表达口径？", 50, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("work_rules", "是否有额外工作规则？", 60, [
          "没有",
          "直接补充",
        ]),
      ],
    },
    {
      name: "运营人员",
      slug: "operations",
      description: "运营人员角色",
      sort_order: 50,
      document: [
        "# Role: Operations",
        "",
        "## 角色定位",
        "你是运营人员，负责围绕执行流程、资源协调、状态跟踪、异常处理与复盘组织输出。",
        "",
        "## 默认工作规则",
        "- 强调明确动作、责任、时间点和风险项。",
        "- 输出内容服务于日常推进与跨团队协作。",
        "- 默认关注执行流程、异常处理和复盘。",
      ].join("\n"),
      questions: [
        buildSingleChoiceQuestion("interaction_mode", "你希望它用什么方式和你交互？", 10, [
          "逐句引导",
          "批量确认",
          "先给执行框架再展开",
        ]),
        buildSingleChoiceQuestion("memory_storage", "是否需要长期沉淀规则和运营文档？", 20, [
          "需要",
          "不需要",
        ]),
        buildSingleChoiceQuestion("output_shape", "默认输出更偏向哪类内容？", 30, [
          "执行方案",
          "SOP",
          "活动排期",
          "复盘纪要",
        ]),
        buildSingleChoiceQuestion("followup_priority", "是否强调任务跟进与风险提醒？", 40, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("list_style", "是否偏列表化和行动项？", 50, [
          "是",
          "否",
        ]),
        buildSingleChoiceQuestion("work_rules", "是否有额外工作规则？", 60, [
          "没有",
          "直接补充",
        ]),
      ],
    },
  ] satisfies Array<{
    name: string;
    slug: string;
    description: string;
    enabled?: boolean;
    sort_order: number;
    document: string;
    questions: Array<Omit<UpsertRoleQuestionInput, "role_id">>;
  }>;

  const existingGlobalDocuments = store.listGlobalDocuments({ includeDisabled: true });
  if (!existingGlobalDocuments.some((document) => document.slug === defaultPlayground.slug)) {
    store.upsertGlobalDocument(defaultPlayground);
  }

  const existingRoles = store.listRoles({ includeDisabled: true });
  for (const standardRole of standardRoles) {
    let role = existingRoles.find((existing) => existing.slug === standardRole.slug);
    if (!role) {
      role = store.upsertRole({
        name: standardRole.name,
        slug: standardRole.slug,
        description: standardRole.description,
        enabled: true,
        sort_order: standardRole.sort_order,
      });
    }

    const existingRoleDocuments = store.listRoleDocuments(role.role_id, { includeDisabled: true });
    if (!existingRoleDocuments.some((document) => document.title === "role.md")) {
      store.upsertRoleDocument({
        role_id: role.role_id,
        title: "role.md",
        content: standardRole.document,
        enabled: true,
      });
    }

    const existingRoleQuestions = store.listRoleQuestions(role.role_id, { includeDisabled: true });
    const existingQuestionKeys = new Set(existingRoleQuestions.map((question) => question.key));
    for (const question of standardRole.questions) {
      if (existingQuestionKeys.has(question.key)) {
        continue;
      }
      store.upsertRoleQuestion({
        role_id: role.role_id,
        ...question,
      });
    }
  }
}

function botToChannelRecord(bot: BotRecord): BotChannelRecord {
  const secretConfigured = bot.wecom_secret_configured;
  const hasWeComBotId = Boolean(bot.wecom_bot_id);
  const runtimeEnabled = hasWeComBotId && secretConfigured;
  const runtimeStatus = !hasWeComBotId
    ? "missing_bot_id"
    : !secretConfigured
      ? "missing_secret"
      : "enabled";
  return {
    channel_id: `wecom:${bot.bot_id}`,
    bot_id: bot.bot_id,
    channel_type: "wecom",
    display_name: "企业微信",
    ...(bot.wecom_bot_id ? { wecom_bot_id: bot.wecom_bot_id } : {}),
    secret_configured: secretConfigured,
    connection_status: bot.wecom_connection_status,
    runtime_enabled: runtimeEnabled,
    runtime_status: runtimeStatus,
    ...(bot.last_wecom_check_at ? { last_check_at: bot.last_wecom_check_at } : {}),
    ...(bot.last_wecom_error ? { last_error: bot.last_wecom_error } : {}),
  };
}

function hasWeComChannelConfig(bot: BotRecord): boolean {
  return Boolean(bot.wecom_bot_id || bot.wecom_secret_configured);
}

export function getRequiredBot(
  bots: Map<string, BotRecord>,
  botId: string,
): BotRecord {
  const bot = bots.get(botId);
  if (!bot) {
    throw new Error(`bot not found: ${botId}`);
  }
  return bot;
}

function getRequiredRole(
  roles: Map<string, RoleRecord>,
  roleId: string,
): RoleRecord {
  const role = roles.get(requireText(roleId, "role_id"));
  if (!role) {
    throw new Error(`role not found: ${roleId}`);
  }
  return role;
}

function assertUniqueWeComBotId(
  bots: Map<string, BotRecord>,
  wecomBotId: string | undefined,
  currentBotId?: string,
): void {
  if (!wecomBotId) {
    return;
  }

  for (const bot of bots.values()) {
    if (bot.wecom_bot_id === wecomBotId && bot.bot_id !== currentBotId) {
      throw new Error(`wecom bot id already bound to bot: ${bot.bot_id}`);
    }
  }
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => requireText(tag, "tag")))];
}

function normalizeEnabled(value: boolean | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  return value;
}

function normalizeRequired(value: boolean | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("required must be a boolean");
  }
  return value;
}

function normalizeOptionalText(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("description must be a string");
  }
  return value.trim();
}

function normalizeSortOrder(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value)) {
    throw new Error("sort_order must be an integer");
  }
  return value;
}

function compareSortedRecords<
  T extends {
    sort_order: number;
    created_at: string;
  },
>(left: T, right: T): number {
  return left.sort_order - right.sort_order ||
    left.created_at.localeCompare(right.created_at);
}

function compareUpdatedRecordsDesc<
  T extends {
    updated_at: string;
  },
>(left: T, right: T): number {
  return right.updated_at.localeCompare(left.updated_at);
}

function compareInstalledRecordsDesc<
  T extends {
    installed_at: string;
  },
>(left: T, right: T): number {
  return right.installed_at.localeCompare(left.installed_at);
}

function compareCreatedRecordsDesc<
  T extends {
    created_at: string;
  },
>(left: T, right: T): number {
  return right.created_at.localeCompare(left.created_at);
}

function nextCollectionIsoTimestamp<
  T extends Record<K, string>,
  K extends string,
>(records: Map<string, T>, field: K): string {
  let latest: string | undefined;
  for (const record of records.values()) {
    const value = record[field];
    if (!latest || value > latest) {
      latest = value;
    }
  }
  return latest ? nextIsoTimestamp(latest) : new Date().toISOString();
}

function includeEnabledRecord<
  T extends {
    enabled: boolean;
  },
>(record: T, options: ListEnabledRecordsOptions): boolean {
  return options.includeDisabled ? true : record.enabled;
}

function getRequiredRecordById<T>(
  records: Map<string, T>,
  recordId: string,
  fieldName: string,
  entityName: string,
): T {
  const normalizedRecordId = requireText(recordId, fieldName);
  const record = records.get(normalizedRecordId);
  if (!record) {
    throw new Error(`${entityName} not found: ${normalizedRecordId}`);
  }
  return record;
}

function findGlobalDocumentBySlug(
  documents: Map<string, GlobalDocumentRecord>,
  slug: string,
  excludedDocumentId?: string,
): GlobalDocumentRecord | undefined {
  return [...documents.values()].find((document) =>
    document.slug === slug && document.document_id !== excludedDocumentId
  );
}

function findRoleBySlug(
  roles: Map<string, RoleRecord>,
  slug: string,
  excludedRoleId?: string,
): RoleRecord | undefined {
  return [...roles.values()].find((role) =>
    role.slug === slug && role.role_id !== excludedRoleId
  );
}

function findRoleDocumentByRoleAndTitle(
  documents: Map<string, RoleDocumentRecord>,
  roleId: string,
  title: string,
  excludedRoleDocumentId?: string,
): RoleDocumentRecord | undefined {
  return [...documents.values()].find((document) =>
    document.role_id === roleId &&
    document.title === title &&
    document.role_document_id !== excludedRoleDocumentId
  );
}

function findRoleQuestionByRoleAndKey(
  questions: Map<string, RoleQuestionRecord>,
  roleId: string,
  key: string,
  excludedQuestionId?: string,
): RoleQuestionRecord | undefined {
  return [...questions.values()].find((question) =>
    question.role_id === roleId &&
    question.key === key &&
    question.question_id !== excludedQuestionId
  );
}

function deleteRecordsByRoleId<
  T extends {
    role_id: string;
  },
>(records: Map<string, T>, roleId: string): void {
  for (const [recordId, record] of records.entries()) {
    if (record.role_id === roleId) {
      records.delete(recordId);
    }
  }
}

function requireRoleQuestionType(value: string): RoleQuestionType {
  if (value !== "single_choice" && value !== "multi_choice" && value !== "free_text") {
    throw new Error("question_type is invalid");
  }
  return value;
}

function normalizeRoleQuestionOptions(value: RoleQuestionOption[] | undefined): RoleQuestionOption[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("options_json must be an array");
  }
  return value.map((option) => ({
    value: requireText(option?.value, "options_json.value"),
    label: requireText(option?.label, "options_json.label"),
  }));
}

function normalizeRoleQuestionDependencies(
  value: RoleQuestionDependency[] | undefined,
): RoleQuestionDependency[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("depends_on_json must be an array");
  }
  return value.map((dependency) => ({
    key: requireText(dependency?.key, "depends_on_json.key"),
    equals: requireText(dependency?.equals, "depends_on_json.equals"),
  }));
}

function cloneRoleQuestionRecord(
  record: RoleQuestionRecord,
): RoleQuestionRecord {
  return {
    ...record,
    options_json: normalizeRoleQuestionOptions(record.options_json),
    depends_on_json: normalizeRoleQuestionDependencies(record.depends_on_json),
  };
}

function botCapabilityScopedKey(botId: string, key: string): string {
  return JSON.stringify([botId, key]);
}

function requireBotCapabilityPolicy(value: string, field: string): BotCapabilityPolicy {
  if (value !== "admin_only" && value !== "open") {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireBotSkillSourceType(value: string): BotSkillSourceType {
  if (value !== "builtin" && value !== "github" && value !== "url" && value !== "local") {
    throw new Error("source_type is invalid");
  }
  return value;
}

function requireBotCapabilityInstallStatus(value: string): BotCapabilityInstallStatus {
  if (value !== "installing" && value !== "installed" && value !== "failed") {
    throw new Error("status is invalid");
  }
  return value;
}

function requireBotMcpMode(value: string): BotMcpMode {
  if (value !== "config" && value !== "package") {
    throw new Error("mode is invalid");
  }
  return value;
}

function requireBotCapabilityAuditActionType(value: string): BotCapabilityAuditActionType {
  if (
    value !== "env_set" &&
    value !== "env_delete" &&
    value !== "skill_install" &&
    value !== "skill_delete" &&
    value !== "mcp_install" &&
    value !== "mcp_delete" &&
    value !== "policy_update"
  ) {
    throw new Error("action_type is invalid");
  }
  return value;
}

function requireBotCapabilityAuditResult(value: string): BotCapabilityAuditResult {
  if (value !== "success" && value !== "failed") {
    throw new Error("result is invalid");
  }
  return value;
}

function requireMcpToolExecutionStatus(value: string): McpToolExecutionStatus {
  if (value !== "success" && value !== "failed" && value !== "rejected") {
    throw new Error("status is invalid");
  }
  return value;
}

function requireMcpToolExecutionDuration(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new Error("duration_ms is invalid");
  }
  return value;
}

export function defaultBotRuntimePolicy(
  bot: Pick<BotRecord, "bot_id" | "created_at" | "updated_at">,
): BotRuntimePolicyRecord {
  return {
    bot_id: bot.bot_id,
    skill_install_policy: "admin_only",
    mcp_manage_policy: "admin_only",
    created_at: bot.created_at,
    updated_at: bot.updated_at,
  };
}

export function cloneBotRuntimePolicyRecord(
  record: BotRuntimePolicyRecord,
): BotRuntimePolicyRecord {
  return { ...record };
}

export function cloneBotEnvVarRecord(
  record: BotEnvVarRecord,
): BotEnvVarRecord {
  return { ...record };
}

export function cloneBotSkillRecord(
  record: BotSkillRecord,
): BotSkillRecord {
  return { ...record };
}

export function cloneBotMcpRecord(
  record: BotMcpRecord,
): BotMcpRecord {
  return { ...record };
}

export function cloneBotCapabilityAuditLogRecord(
  record: BotCapabilityAuditLogRecord,
): BotCapabilityAuditLogRecord {
  return { ...record };
}

export function cloneMcpToolExecutionRecord(record: McpToolExecutionRecord): McpToolExecutionRecord {
  return { ...record };
}

function matchesBusinessDocumentQuery(
  document: BusinessDocumentRecord,
  input: ListBusinessDocumentsInput,
): boolean {
  return (!input.scope || document.scope === input.scope) &&
    (!input.owner_id || document.owner_id === input.owner_id) &&
    (!input.doc_type || document.doc_type === input.doc_type) &&
    (!input.status || document.status === input.status) &&
    !isBotConfigDocumentTitle(document.title);
}

function normalizePendingGeneratedDocumentQuery(
  input: PendingGeneratedDocumentQuery,
  bots: Map<string, BotRecord>,
): PendingGeneratedDocumentQuery {
  const bot = getRequiredBot(bots, input.bot_id);
  return {
    bot_id: bot.bot_id,
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    conversation_id: requireText(input.conversation_id, "conversation_id"),
  };
}

function matchesPendingGeneratedDocumentQuery(
  document: PendingGeneratedDocumentRecord,
  input: PendingGeneratedDocumentQuery,
): boolean {
  return document.bot_id === input.bot_id &&
    document.wecom_user_id === input.wecom_user_id &&
    document.conversation_id === input.conversation_id &&
    document.status === "pending";
}

function updateMatchingPendingGeneratedDocuments(
  documents: Map<string, PendingGeneratedDocumentRecord>,
  input: PendingGeneratedDocumentQuery,
  status: Exclude<PendingGeneratedDocumentStatus, "pending">,
): PendingGeneratedDocumentRecord[] {
  const updated: PendingGeneratedDocumentRecord[] = [];
  const matches = [...documents.values()]
    .filter((document) => matchesPendingGeneratedDocumentQuery(document, input));
  for (const document of matches) {
    const next: PendingGeneratedDocumentRecord = {
      ...document,
      status,
      updated_at: nextIsoTimestamp(document.updated_at),
    };
    documents.set(next.pending_id, next);
    updated.push(next);
  }
  return updated;
}

function matchesMemoryQuery(memory: MemoryRecord, input: ListMemoriesInput): boolean {
  return matchesMemoryStatsQuery(memory, input) &&
    (!input.tier || memory.tier === input.tier) &&
    (!input.status || memory.status === input.status);
}

function matchesMemoryStatsQuery(
  record: Pick<MemoryRecord | ChunkRecord | BusinessDocumentRecord, "scope" | "owner_id">,
  input: MemoryStatsInput,
): boolean {
  return (!input.scope || record.scope === input.scope) &&
    (!input.owner_id || record.owner_id === input.owner_id);
}

function countMemoriesByTier(memories: MemoryRecord[]): Record<KnowledgeTier, number> {
  return memories.reduce<Record<KnowledgeTier, number>>(
    (counts, memory) => {
      counts[memory.tier] += 1;
      return counts;
    },
    { core: 0, reference: 0, temp: 0 },
  );
}

export function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

export function optionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function normalizeBotProjectConfig(
  input: Partial<BotProjectConfig>,
  existing: Partial<BotProjectConfig> = {},
): BotProjectConfig {
  const repositoryUrl = input.project_repository_url === undefined
    ? existing.project_repository_url
    : optionalText(input.project_repository_url);
  if (!repositoryUrl) {
    return {
      project_key: undefined,
      project_repository_url: undefined,
      project_default_branch: undefined,
      project_directory: undefined,
    };
  }

  validateProjectRepositoryUrl(repositoryUrl);
  const projectKey = requireSafeProjectSegment(
    input.project_key === undefined
      ? existing.project_key ?? projectKeyFromRepositoryUrl(repositoryUrl)
      : optionalText(input.project_key) ?? projectKeyFromRepositoryUrl(repositoryUrl),
    "project_key",
  );
  const projectDirectory = requireSafeProjectSegment(
    input.project_directory === undefined
      ? existing.project_directory ?? projectKey
      : optionalText(input.project_directory) ?? projectKey,
    "project_directory",
  );
  const defaultBranch = requireText(
    input.project_default_branch === undefined
      ? existing.project_default_branch ?? "main"
      : optionalText(input.project_default_branch) ?? "main",
    "project_default_branch",
  );
  if (defaultBranch.startsWith("-") || defaultBranch.length > 255) {
    throw new Error("project_default_branch is invalid");
  }
  return {
    project_key: projectKey,
    project_repository_url: repositoryUrl,
    project_default_branch: defaultBranch,
    project_directory: projectDirectory,
  };
}

function projectKeyFromRepositoryUrl(repositoryUrl: string): string {
  const path = /^https:\/\//i.test(repositoryUrl)
    ? new URL(repositoryUrl).pathname
    : repositoryUrl.replace(/^ssh:\/\//, "").replace(/^[^:]+:/, "");
  return path.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/i, "") ?? "";
}

function requireSafeProjectSegment(value: string | undefined, field: string): string {
  const segment = requireText(value ?? "", field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) {
    throw new Error(`${field} must be a safe path segment`);
  }
  return segment;
}

function validateProjectRepositoryUrl(value: string): void {
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new Error("project_repository_url must not contain credentials");
    }
    return;
  }
  if (/^(?:ssh:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/.test(value)) {
    return;
  }
  throw new Error("project_repository_url must be an HTTPS or SSH Git URL");
}

export function buildWeComConnectionTestResult(
  bot: Pick<BotRecord, "bot_id" | "wecom_bot_id" | "wecom_secret_configured">,
  verification?: { verified: true } | { verified: false; error: string },
): WeComConnectionTestResult {
  const missing: WeComConnectionTestResult["missing"] = [];
  if (!optionalText(bot.wecom_bot_id)) {
    missing.push("wecom_bot_id");
  }
  if (!bot.wecom_secret_configured) {
    missing.push("wecom_secret");
  }
  const checkedAt = new Date().toISOString();
  if (missing.length > 0) {
    return {
      bot_id: bot.bot_id,
      status: "missing_config",
      ...(bot.wecom_bot_id ? { wecom_bot_id: bot.wecom_bot_id } : {}),
      wecom_secret_configured: bot.wecom_secret_configured,
      missing,
      checked_at: checkedAt,
      error: `missing ${missing.join(", ")}`,
    };
  }
  if (verification?.verified) {
    return {
      bot_id: bot.bot_id,
      status: "verified",
      wecom_bot_id: bot.wecom_bot_id,
      wecom_secret_configured: true,
      missing: [],
      checked_at: checkedAt,
    };
  }
  if (verification && !verification.verified) {
    return {
      bot_id: bot.bot_id,
      status: "failed",
      wecom_bot_id: bot.wecom_bot_id,
      wecom_secret_configured: true,
      missing: [],
      checked_at: checkedAt,
      error: verification.error,
    };
  }
  return {
    bot_id: bot.bot_id,
    status: "configured",
    wecom_bot_id: bot.wecom_bot_id,
    wecom_secret_configured: true,
    missing: [],
    checked_at: checkedAt,
  };
}

export function requireMemoryScope(value: string | null): MemoryScope {
  if (!MEMORY_SCOPES.includes(value as MemoryScope)) {
    throw new Error("scope is required");
  }
  return value as MemoryScope;
}

export function requireBotConfigDocumentTitle(value: string): BotConfigDocumentRecord["title"] {
  const title = normalizeBotConfigDocumentTitle(value);
  if (!title) {
    throw new Error("bot config document title is invalid");
  }
  return title;
}

export function isBotConfigDocumentTitle(value: string): boolean {
  return Boolean(normalizeBotConfigDocumentTitle(value));
}

function normalizeBotConfigDocumentTitle(value: string): BotConfigDocumentRecord["title"] | undefined {
  const title = String(value).trim().toLowerCase();
  if (title === "soul" || title === "soul.md" || title === "private/soul.md") {
    return "soul";
  }
  if (
    title === "agents" ||
    title === "agents.md" ||
    title === "instructions/agents.md"
  ) {
    return "agents.md";
  }
  return undefined;
}

export function configDocumentOrder(title: BotConfigDocumentRecord["title"]): number {
  return title === "soul" ? 0 : 1;
}

export function requireBotStatus(value: string): BotStatus {
  if (!["draft", "initializing", "ready"].includes(value)) {
    throw new Error("status is invalid");
  }
  return value as BotStatus;
}

export function requireInitializationPhase(value: string): InitializationPhase {
  if (value !== "soul" && value !== "role_select" && value !== "agents") {
    throw new Error("phase is invalid");
  }
  return value;
}

export function requireInitializationSessionStatus(
  value: string,
): InitializationSessionStatus {
  if (value !== "active" && value !== "completed" && value !== "cancelled") {
    throw new Error("status is invalid");
  }
  return value;
}

export function requireInitializationGenerationInProgress(
  value: string,
): InitializationGenerationInProgress {
  if (value !== "soul" && value !== "agents") {
    throw new Error("generation_in_progress is invalid");
  }
  return value;
}

export function normalizeAnswerArray(value: string[], field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} is required`);
  }
  return value.map((answer) => requireText(answer, field));
}

export function normalizeRuntimeConfigOptions(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("options must be an object");
  }
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function normalizeRuntimeConfigStream(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error("stream must be a boolean");
  }
  return value;
}

export function defaultRuntimeConfig(bot: BotRecord): RuntimeConfigRecord {
  return {
    bot_id: bot.bot_id,
    provider: bot.runtime,
    stream: true,
    options: {},
    created_at: bot.created_at,
    updated_at: bot.updated_at,
  };
}

export function cloneInitializationSessionRecord(
  record: InitializationSessionRecord,
): InitializationSessionRecord {
  return {
    ...record,
    soul_answers: [...record.soul_answers],
    agents_answers: [...record.agents_answers],
  };
}

export function cloneConversationRecord(
  record: ConversationRecord,
): ConversationRecord {
  return {
    ...record,
  };
}

export function cloneRuntimeConfigRecord(
  record: RuntimeConfigRecord,
): RuntimeConfigRecord {
  return {
    ...record,
    options: normalizeRuntimeConfigOptions(record.options),
  };
}

export function cloneRuntimeSessionRecord(
  record: RuntimeSessionRecord,
): RuntimeSessionRecord {
  return {
    ...record,
  };
}

function assertJsonValue(value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("options must be JSON-serializable");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item);
    }
    return;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      assertJsonValue(nested);
    }
    return;
  }
  throw new Error("options must be JSON-serializable");
}

export function initializationSessionKey(
  input: InitializationSessionKeyInput,
): string {
  return JSON.stringify([
    requireText(input.bot_id, "bot_id"),
    requireText(input.wecom_user_id, "wecom_user_id"),
    requireText(input.conversation_id, "conversation_id"),
  ]);
}

export function hashClaimCode(code: string): string {
  let hash = 2166136261;
  for (const char of code) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

export function hashCredentialBindingToken(token: string): string {
  return createHash("sha256")
    .update(requireText(token, "token"), "utf8")
    .digest("hex");
}

export function requireUserCredentialProvider(value: string): UserCredentialProvider {
  if (value !== "easemob_jira" && value !== "github_fork") {
    throw new Error("unsupported credential provider");
  }
  return value;
}

function randomCredentialBindingToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeUserCredentialScope(
  input: UserCredentialScopeInput,
): UserCredentialScopeInput {
  return {
    bot_id: requireText(input.bot_id, "bot_id"),
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    provider: requireUserCredentialProvider(input.provider),
  };
}

function userCredentialScopeKey(input: UserCredentialScopeInput): string {
  const scope = normalizeUserCredentialScope(input);
  return [scope.bot_id, scope.wecom_user_id, scope.provider].join(":");
}

function isActiveUserCredentialBinding(
  record: UserCredentialBindingRecord | undefined,
): record is UserCredentialBindingRecord {
  return Boolean(
    record
    && !record.consumed_at
    && new Date(record.expires_at).getTime() >= Date.now(),
  );
}

function cloneUserCredentialBindingRecord(
  record: UserCredentialBindingRecord,
): UserCredentialBindingRecord {
  return { ...record };
}

function userCredentialMetadata(
  record: UserCredentialRecord,
): UserCredentialMetadataRecord {
  return {
    bot_id: record.bot_id,
    wecom_user_id: record.wecom_user_id,
    provider: record.provider,
    is_bound: true,
    updated_at: record.updated_at,
  };
}

export function nextIsoTimestamp(previous: string): string {
  const now = Date.now();
  const previousTime = new Date(previous).getTime();
  return new Date(Math.max(now, previousTime + 1)).toISOString();
}

function conversationScopeKey(
  botId: string,
  wecomUserId: string,
  channel: ConversationChannel,
  purpose: ConversationPurpose,
): string {
  return [botId, wecomUserId, channel, purpose].join(":");
}

function createConversationRecord(
  input: CreateConversationInput,
  sequenceNo: number,
): ConversationRecord {
  const now = new Date().toISOString();
  return {
    conversation_id: `conv_${crypto.randomUUID()}`,
    sequence_no: sequenceNo,
    bot_id: requireText(input.bot_id, "bot_id"),
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    channel: input.channel,
    purpose: input.purpose,
    ...(optionalText(input.display_name) ? { display_name: optionalText(input.display_name) } : {}),
    is_active: true,
    created_at: now,
    updated_at: now,
  };
}

function getActiveConversationForScope(
  conversationHistory: Map<string, ConversationRecord>,
  activeConversationIds: Map<string, string>,
  input: ResolveConversationInput,
): ConversationRecord | undefined {
  const key = conversationScopeKey(
    input.bot_id,
    input.wecom_user_id,
    input.channel,
    input.purpose,
  );
  const conversationId = activeConversationIds.get(key);
  if (!conversationId) {
    return undefined;
  }
  const conversation = conversationHistory.get(conversationId);
  if (!conversation) {
    activeConversationIds.delete(key);
    return undefined;
  }
  return conversation;
}

function createConversationForScope(
  conversationHistory: Map<string, ConversationRecord>,
  activeConversationIds: Map<string, string>,
  input: CreateConversationInput,
): ConversationRecord {
  const sequenceNo = [...conversationHistory.values()]
    .filter((conversation) =>
      conversation.bot_id === input.bot_id
      && conversation.wecom_user_id === input.wecom_user_id
      && conversation.channel === input.channel
      && conversation.purpose === input.purpose
    )
    .reduce((maximum, conversation) => Math.max(maximum, conversation.sequence_no), 0) + 1;
  const conversation = createConversationRecord(input, sequenceNo);
  conversationHistory.set(conversation.conversation_id, conversation);
  activeConversationIds.set(
    conversationScopeKey(
      conversation.bot_id,
      conversation.wecom_user_id,
      conversation.channel,
      conversation.purpose,
    ),
    conversation.conversation_id,
  );
  for (const [id, record] of conversationHistory.entries()) {
    if (
      id !== conversation.conversation_id
      && record.bot_id === conversation.bot_id
      && record.wecom_user_id === conversation.wecom_user_id
      && record.channel === conversation.channel
      && record.purpose === conversation.purpose
      && record.is_active
    ) {
      conversationHistory.set(id, {
        ...record,
        is_active: false,
      });
    }
  }
  return cloneConversationRecord(conversation);
}
