import {
  buildDefaultMcpCapabilityConfig,
  parseMcpCapabilityConfig,
  type McpCapabilityConfig,
} from "@my-agent-toolkit/contracts";

export type BotStatus = "draft" | "initializing" | "ready";
export type ConversationPurpose = "normal_chat" | "init" | "doc_generation";
export type ConversationChannel = "wecom_direct" | "wecom_group";
export type InitializationPhase = "soul" | "agents";
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
  memory_documents: MemoryDocumentRecord[];
  config_documents: BotConfigDocumentRecord[];
}

export interface CreateBotInput {
  bot_id: string;
  name: string;
  runtime: string;
  wecom_bot_id?: string;
  wecom_secret?: string;
}

export interface UpdateBotInput {
  name?: string;
  runtime?: string;
  status?: BotStatus;
  wecom_bot_id?: string;
  wecom_secret?: string;
}

export interface ConversationRecord {
  conversation_id: string;
  bot_id: string;
  wecom_user_id: string;
  channel: ConversationChannel;
  purpose: ConversationPurpose;
  created_at: string;
  updated_at: string;
}

export interface InitializationSessionRecord {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: InitializationPhase;
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

export interface DataStore {
  createBot(input: CreateBotInput): BotRecord;
  listBots(): BotRecord[];
  getBot(botId: string): BotRecord | undefined;
  updateBot(botId: string, input: UpdateBotInput): BotRecord;
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
  getAdmin(botId: string): AdminRecord | undefined;
  createAdminClaim(botId: string): AdminClaimRecord;
  claimAdmin(input: ClaimAdminInput): AdminRecord;
  verifyAdminClaim(input: Required<ClaimAdminInput>): AdminRecord;
  transferAdmin(input: TransferAdminInput): AdminRecord;
  markBotReady(botId: string): BotRecord;
  resolveMessageContext(input: ResolveConversationInput): MessageContext;
  resolveConversation(input: ResolveConversationInput): ConversationRecord;
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
  const conversations = new Map<string, ConversationRecord>();
  const initializationSessions = new Map<string, InitializationSessionRecord>();
  const pendingGeneratedDocuments = new Map<string, PendingGeneratedDocumentRecord>();
  const runtimeConfigs = new Map<string, RuntimeConfigRecord>();
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
      assertUniqueWeComBotId(bots, wecomBotId);
      const bot: BotRecord = {
        bot_id: requireText(input.bot_id, "bot_id"),
        name: requireText(input.name, "name"),
        runtime: requireText(input.runtime, "runtime"),
        status: "draft",
        wecom_bot_id: wecomBotId,
        wecom_secret_configured: Boolean(wecomSecret),
        wecom_connection_status: "unchecked",
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
        updated_at: nextIsoTimestamp(bot.updated_at),
      };
      bots.set(bot.bot_id, updated);
      if (wecomSecret) {
        wecomSecrets.set(bot.bot_id, wecomSecret);
      }
      return updated;
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
      return {
        channel: botToChannelRecord(bot),
        bot,
        ...(admins.get(bot.bot_id) ? { admin: admins.get(bot.bot_id) } : {}),
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

      if (!admin) {
        return {
          bot_id: bot.bot_id,
          wecom_user_id: input.wecom_user_id,
          is_admin: false,
          allowed: false,
          reason: "admin_unclaimed",
        };
      }

      if (bot.status !== "ready") {
        if (isAdmin) {
          return {
            bot_id: bot.bot_id,
            wecom_user_id: input.wecom_user_id,
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
          bot_id: bot.bot_id,
          wecom_user_id: input.wecom_user_id,
          is_admin: isAdmin,
          allowed: false,
          reason: "initialization_required",
        };
      }

      return {
        bot_id: bot.bot_id,
        wecom_user_id: input.wecom_user_id,
        is_admin: isAdmin,
        allowed: true,
        reason: "ready",
        conversation: this.resolveConversation(input),
      };
    },

    resolveConversation(input) {
      getRequiredBot(bots, input.bot_id);

      const key = [
        input.bot_id,
        input.wecom_user_id,
        input.channel,
        input.purpose,
      ].join(":");
      const existing = conversations.get(key);
      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        conversation_id: `conv_${crypto.randomUUID()}`,
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        channel: input.channel,
        purpose: input.purpose,
        created_at: now,
        updated_at: now,
      };
      conversations.set(key, conversation);
      return conversation;
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
      return record;
    },

    getActiveInitializationSession(input) {
      const record = initializationSessions.get(initializationSessionKey(input));
      return record?.status === "active" ? record : undefined;
    },

    clearInitializationSession(input) {
      const key = initializationSessionKey(input);
      const record = initializationSessions.get(key);
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
  if (value !== "soul" && value !== "agents") {
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

export function cloneRuntimeConfigRecord(
  record: RuntimeConfigRecord,
): RuntimeConfigRecord {
  return {
    ...record,
    options: normalizeRuntimeConfigOptions(record.options),
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

export function nextIsoTimestamp(previous: string): string {
  const now = Date.now();
  const previousTime = new Date(previous).getTime();
  return new Date(Math.max(now, previousTime + 1)).toISOString();
}
