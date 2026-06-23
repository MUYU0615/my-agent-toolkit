import Database from "better-sqlite3";
import {
  buildDefaultMcpCapabilityConfig,
  parseMcpCapabilityConfig,
  type McpCapabilityConfig,
} from "@my-agent-toolkit/contracts";
import {
  ADMIN_CLAIM_TTL_MS,
  buildWeComConnectionTestResult,
  configDocumentOrder,
  defaultRuntimeConfig,
  hashClaimCode,
  initializationSessionKey,
  isBotConfigDocumentTitle,
  nextIsoTimestamp,
  normalizeAnswerArray,
  normalizeRuntimeConfigOptions,
  normalizeRuntimeConfigStream,
  optionalText,
  requireBotConfigDocumentTitle,
  requireBotStatus,
  requireInitializationGenerationInProgress,
  requireInitializationPhase,
  requireInitializationSessionStatus,
  requireText,
  type AdminClaimRecord,
  type AdminRecord,
  type AssetRecord,
  type BusinessDocumentRecord,
  type BusinessDocumentVersionRecord,
  type BotChannelDetail,
  type BotConfigDocumentRecord,
  type BotChannelRecord,
  type BotRecord,
  type ClaimAdminInput,
  type ChunkRecord,
  type CreateBusinessDocumentInput,
  type ConversationRecord,
  type CreateMemoryRecordInput,
  type DataStore,
  type KnowledgeTier,
  type InitializationSessionRecord,
  type InitializationSessionKeyInput,
  type ListBusinessDocumentsInput,
  type ListCurrentMemoryDocumentsInput,
  type ListMemoriesInput,
  type MemoryRecord,
  type MemoryStats,
  type MemoryStatsInput,
  type MemoryDocumentRecord,
  type ApplyPendingGeneratedDocumentsInput,
  type AppliedPendingGeneratedDocumentResult,
  type CreatePendingGeneratedDocumentInput,
  type PendingGeneratedDocumentQuery,
  type PendingGeneratedDocumentRecord,
  type PendingGeneratedDocumentStatus,
  type RecordAssetInput,
  type RecordChunksInput,
  type ResolveConversationInput,
  type RuntimeConfigRecord,
  type TransferAdminInput,
  type UpdateBusinessDocumentInput,
  type UpsertRuntimeConfigInput,
  type UpsertInitializationSessionInput,
  type UpsertMemoryDocumentInput,
  type UpsertBotConfigDocumentInput,
  type CreateBotInput,
  type DataStoreOptions,
  type UpdateBotInput,
  type WeComRuntimeBotConfig,
} from "./store.js";

export function createSqliteDataStore(
  dbPath: string,
  options: DataStoreOptions = {},
): DataStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);

  return {
    createBot(input) {
      const now = new Date().toISOString();
      const wecomSecret = optionalText(input.wecom_secret);
      const wecomBotId = optionalText(input.wecom_bot_id);
      assertUniqueWeComBotId(db, wecomBotId);
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
      db.prepare(
        "insert into bots (bot_id, name, runtime, status, wecom_bot_id, wecom_secret, wecom_connection_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        bot.bot_id,
        bot.name,
        bot.runtime,
        bot.status,
        bot.wecom_bot_id ?? null,
        wecomSecret ?? null,
        bot.wecom_connection_status,
        bot.created_at,
        bot.updated_at,
      );
      return bot;
    },

    getBot(botId) {
      return mapBotRecord(
        db.prepare("select * from bots where bot_id = ?").get(botId),
      );
    },

    listBots() {
      return db
        .prepare("select * from bots order by rowid asc")
        .all()
        .map(mapBotRecord)
        .filter((bot): bot is BotRecord => Boolean(bot));
    },

    updateBot(botId, input) {
      return updateBot(db, botId, input);
    },

    getBotMcpCapabilityConfig(botId) {
      return getBotMcpCapabilityConfig(db, botId);
    },

    updateBotMcpCapabilityConfig(botId, input) {
      return updateBotMcpCapabilityConfig(db, botId, input);
    },

    listBotChannels(botId) {
      const rows = botId
        ? [getRequiredBot(db, botId)]
        : db
          .prepare("select * from bots order by rowid asc")
          .all()
          .map(mapBotRecord)
          .filter((bot): bot is BotRecord => Boolean(bot));
      return rows
        .filter(hasWeComChannelConfig)
        .map(botToChannelRecord);
    },

    getBotChannelDetail(botId) {
      return getBotChannelDetail(db, botId);
    },

    resetAdminClaim(botId) {
      const bot = getRequiredBot(db, botId);
      db.prepare("delete from admins where bot_id = ?").run(bot.bot_id);
      db.prepare("delete from admin_claims where bot_id = ?").run(bot.bot_id);
      return this.createAdminClaim(bot.bot_id);
    },

    resetBot(botId) {
      const bot = getRequiredBot(db, botId);
      const admin = db.prepare("select * from admins where bot_id = ?").get(bot.bot_id);
      const status = admin ? "initializing" : "draft";
      const updatedAt = nextIsoTimestamp(bot.updated_at);
      db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
        status,
        updatedAt,
        bot.bot_id,
      );
      return { ...bot, status, updated_at: updatedAt };
    },

    deleteBotChannel(botId) {
      const bot = getRequiredBot(db, botId);
      const updatedAt = nextIsoTimestamp(bot.updated_at);
      db.prepare(
        "update bots set wecom_bot_id = null, wecom_secret = null, wecom_connection_status = ?, last_wecom_check_at = null, last_wecom_error = null, updated_at = ? where bot_id = ?",
      ).run("unchecked", updatedAt, bot.bot_id);
      return botToChannelRecord({
        ...bot,
        wecom_bot_id: undefined,
        wecom_secret_configured: false,
        wecom_connection_status: "unchecked",
        last_wecom_check_at: undefined,
        last_wecom_error: undefined,
        updated_at: updatedAt,
      });
    },

    listWeComRuntimeBots() {
      return db.prepare(
        `
          select bot_id, runtime, wecom_bot_id, wecom_secret
          from bots
          where wecom_bot_id is not null
            and wecom_secret is not null
          order by rowid asc
        `,
      ).all() as WeComRuntimeBotConfig[];
    },

    async testWeComConnection(botId) {
      return testWeComConnection(db, botId, options);
    },

    getRuntimeConfig(botId) {
      return getRuntimeConfig(db, botId);
    },

    upsertRuntimeConfig(botId, input) {
      return upsertRuntimeConfig(db, botId, input);
    },

    getAdmin(botId) {
      return db.prepare("select * from admins where bot_id = ?").get(botId) as
        | AdminRecord
        | undefined;
    },

    createAdminClaim(botId) {
      const bot = getRequiredBot(db, botId);
      const existingAdmin = db
        .prepare("select * from admins where bot_id = ?")
        .get(bot.bot_id);
      if (existingAdmin) {
        throw new Error(`admin already claimed for bot: ${bot.bot_id}`);
      }

      const code = String(
        crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
      ).padStart(6, "0");
      const now = new Date();
      const claim: AdminClaimRecord = {
        bot_id: bot.bot_id,
        code,
        code_hash: hashClaimCode(code),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ADMIN_CLAIM_TTL_MS).toISOString(),
      };

      db.prepare(
        "insert or replace into admin_claims (bot_id, code_hash, created_at, expires_at) values (?, ?, ?, ?)",
      ).run(claim.bot_id, claim.code_hash, claim.created_at, claim.expires_at);
      return claim;
    },

    claimAdmin(input) {
      return claimAdmin(db, input);
    },

    verifyAdminClaim(input) {
      const claim = db
        .prepare("select * from admin_claims where bot_id = ?")
        .get(input.bot_id) as
        | Omit<AdminClaimRecord, "code">
        | undefined;
      if (!claim) {
        throw new Error(
          `admin claim code does not exist for bot: ${input.bot_id}`,
        );
      }
      if (new Date(claim.expires_at).getTime() < Date.now()) {
        throw new Error("admin claim code expired");
      }
      if (claim.code_hash !== hashClaimCode(input.code)) {
        throw new Error("invalid admin claim code");
      }

      const admin = claimAdmin(db, input);
      db.prepare("delete from admin_claims where bot_id = ?").run(input.bot_id);
      return admin;
    },

    transferAdmin(input) {
      return transferAdmin(db, input);
    },

    markBotReady(botId) {
      const bot = getRequiredBot(db, botId);
      const admin = db.prepare("select * from admins where bot_id = ?").get(botId);
      if (!admin) {
        throw new Error(`admin is not claimed for bot: ${botId}`);
      }
      const updatedAt = new Date().toISOString();
      db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
        "ready",
        updatedAt,
        botId,
      );
      return { ...bot, status: "ready", updated_at: updatedAt };
    },

    resolveMessageContext(input) {
      const bot = getRequiredBot(db, input.bot_id);
      const admin = db
        .prepare("select * from admins where bot_id = ?")
        .get(input.bot_id) as AdminRecord | undefined;
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
            conversation: resolveConversation(db, { ...input, purpose: "init" }),
          };
        }

        return {
          bot_id: bot.bot_id,
          wecom_user_id: input.wecom_user_id,
          is_admin: false,
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
        conversation: resolveConversation(db, input),
      };
    },

    resolveConversation(input) {
      return resolveConversation(db, input);
    },

    upsertInitializationSession(input) {
      return upsertInitializationSession(db, input);
    },

    getActiveInitializationSession(input) {
      return getActiveInitializationSession(db, input);
    },

    clearInitializationSession(input) {
      clearInitializationSession(db, input);
    },

    createPendingGeneratedDocument(input) {
      return createPendingGeneratedDocument(db, input);
    },

    listPendingGeneratedDocuments(input) {
      return listPendingGeneratedDocuments(db, input);
    },

    confirmPendingGeneratedDocuments(input) {
      return updatePendingGeneratedDocuments(db, input, "confirmed");
    },

    cancelPendingGeneratedDocuments(input) {
      return updatePendingGeneratedDocuments(db, input, "cancelled");
    },

    applyPendingGeneratedDocuments(input) {
      return applyPendingGeneratedDocuments(db, input);
    },

    upsertBotConfigDocument(input) {
      return upsertBotConfigDocument(db, input);
    },

    listBotConfigDocuments(botId) {
      return listBotConfigDocuments(db, botId);
    },

    upsertMemoryDocument(input) {
      if (input.scope === "bot" && isBotConfigDocumentTitle(input.title)) {
        throw new Error("bot config documents must use /v1/bot-config-documents");
      }
      const memoryDocId = input.memory_doc_id ?? `mem_${crypto.randomUUID()}`;
      const latest = db
        .prepare(
          "select max(version) as version from memory_document_versions where memory_doc_id = ?",
        )
        .get(memoryDocId) as { version: number | null };
      const record: MemoryDocumentRecord = {
        memory_doc_id: memoryDocId,
        scope: input.scope,
        owner_id: requireText(input.owner_id, "owner_id"),
        title: requireText(input.title, "title"),
        version: (latest.version ?? 0) + 1,
        content: input.content,
        status: "active",
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "insert into memory_document_versions (memory_doc_id, version, scope, owner_id, title, content, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.memory_doc_id,
        record.version,
        record.scope,
        record.owner_id,
        record.title,
        record.content,
        record.status,
        record.created_at,
      );
      return record;
    },

    listMemoryDocumentVersions(memoryDocId) {
      return db
        .prepare(
          "select memory_doc_id, scope, owner_id, title, version, content, status, created_at from memory_document_versions where memory_doc_id = ? order by version asc",
        )
        .all(memoryDocId) as MemoryDocumentRecord[];
    },

    listCurrentMemoryDocuments(input) {
      return listCurrentMemoryDocuments(db, input);
    },

    createBusinessDocument(input) {
      return createBusinessDocument(db, input);
    },

    updateBusinessDocument(input) {
      return updateBusinessDocument(db, input);
    },

    getBusinessDocument(documentId, version) {
      return getBusinessDocument(db, documentId, version);
    },

    listBusinessDocuments(input = {}) {
      return listBusinessDocuments(db, input);
    },

    createMemoryRecord(input) {
      return createMemoryRecord(db, input);
    },

    listMemories(input = {}) {
      return listMemories(db, input);
    },

    recordChunks(input) {
      return recordChunks(db, input);
    },

    recordAsset(input) {
      return recordAsset(db, input);
    },

    getMemoryStats(input = {}) {
      return getMemoryStats(db, input);
    },

    close() {
      db.close();
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

function getBotChannelDetail(
  db: Database.Database,
  botId: string,
): BotChannelDetail {
  const bot = getRequiredBot(db, botId);
  const admin = db
    .prepare("select * from admins where bot_id = ?")
    .get(bot.bot_id) as AdminRecord | undefined;
  const memoryDocuments = listCurrentMemoryDocuments(db, {
    scope: "bot",
    owner_id: bot.bot_id,
  });
  return {
    channel: botToChannelRecord(bot),
    bot,
    ...(admin ? { admin } : {}),
    memory_documents: memoryDocuments,
    config_documents: listBotConfigDocuments(db, bot.bot_id),
  };
}

function upsertBotConfigDocument(
  db: Database.Database,
  input: UpsertBotConfigDocumentInput,
): BotConfigDocumentRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const title = requireBotConfigDocumentTitle(input.title);
  const existing = db
    .prepare("select created_at from bot_config_documents where bot_id = ? and title = ?")
    .get(bot.bot_id, title) as { created_at: string } | undefined;
  const now = new Date().toISOString();
  const record: BotConfigDocumentRecord = {
    bot_id: bot.bot_id,
    title,
    content: input.content,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `
      insert into bot_config_documents (bot_id, title, content, created_at, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(bot_id, title) do update set
        content = excluded.content,
        updated_at = excluded.updated_at
    `,
  ).run(record.bot_id, record.title, record.content, record.created_at, record.updated_at);
  return record;
}

function listBotConfigDocuments(
  db: Database.Database,
  botId: string,
): BotConfigDocumentRecord[] {
  const bot = getRequiredBot(db, botId);
  const rows = db
    .prepare(
      `
        select bot_id, title, content, created_at, updated_at
        from bot_config_documents
        where bot_id = ?
      `,
    )
    .all(bot.bot_id) as BotConfigDocumentRecord[];
  return rows.sort((left, right) => configDocumentOrder(left.title) - configDocumentOrder(right.title));
}

function getBotMcpCapabilityConfig(
  db: Database.Database,
  botId: string,
): McpCapabilityConfig {
  const bot = getRequiredBot(db, botId);
  const row = db
    .prepare("select config_json from bot_mcp_capability_configs where bot_id = ?")
    .get(bot.bot_id) as { config_json: string } | undefined;
  if (!row) {
    return buildDefaultMcpCapabilityConfig();
  }
  return parseMcpCapabilityConfig(JSON.parse(row.config_json) as unknown);
}

function updateBotMcpCapabilityConfig(
  db: Database.Database,
  botId: string,
  input: unknown,
): McpCapabilityConfig {
  const bot = getRequiredBot(db, botId);
  const config = parseMcpCapabilityConfig(input);
  db.prepare(`
    insert into bot_mcp_capability_configs (bot_id, config_json, updated_at)
    values (?, ?, ?)
    on conflict(bot_id) do update set
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(bot.bot_id, JSON.stringify(config), new Date().toISOString());
  return config;
}

function getRuntimeConfig(
  db: Database.Database,
  botId: string,
): RuntimeConfigRecord {
  const bot = getRequiredBot(db, botId);
  const record = mapRuntimeConfigRecord(
    db.prepare("select * from runtime_configs where bot_id = ?").get(bot.bot_id),
  );
  return record ?? defaultRuntimeConfig(bot);
}

function upsertRuntimeConfig(
  db: Database.Database,
  botId: string,
  input: UpsertRuntimeConfigInput,
): RuntimeConfigRecord {
  const bot = getRequiredBot(db, botId);
  const existing = mapRuntimeConfigRecord(
    db.prepare("select * from runtime_configs where bot_id = ?").get(bot.bot_id),
  );
  const now = existing ? nextIsoTimestamp(existing.updated_at) : new Date().toISOString();
  const record: RuntimeConfigRecord = {
    bot_id: bot.bot_id,
    provider: requireText(input.provider, "provider"),
    stream: normalizeRuntimeConfigStream(input.stream),
    options: normalizeRuntimeConfigOptions(input.options),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `
      insert into runtime_configs (bot_id, provider, stream, options_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(bot_id) do update set
        provider = excluded.provider,
        stream = excluded.stream,
        options_json = excluded.options_json,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.bot_id,
    record.provider,
    record.stream ? 1 : 0,
    JSON.stringify(record.options),
    record.created_at,
    record.updated_at,
  );
  return record;
}

function updateBot(
  db: Database.Database,
  botId: string,
  input: UpdateBotInput,
): BotRecord {
  const bot = getRequiredBot(db, botId);
  const wecomSecret = optionalText(input.wecom_secret);
  const wecomBotId = input.wecom_bot_id === undefined
    ? bot.wecom_bot_id
    : optionalText(input.wecom_bot_id);
  assertUniqueWeComBotId(db, wecomBotId, bot.bot_id);
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
  const currentSecret = db
    .prepare("select wecom_secret from bots where bot_id = ?")
    .get(botId) as { wecom_secret?: string | null };
  db.prepare(
    "update bots set name = ?, runtime = ?, status = ?, wecom_bot_id = ?, wecom_secret = ?, wecom_connection_status = ?, last_wecom_check_at = ?, last_wecom_error = ?, updated_at = ? where bot_id = ?",
  ).run(
    updated.name,
    updated.runtime,
    updated.status,
    updated.wecom_bot_id ?? null,
    wecomSecret ?? currentSecret.wecom_secret ?? null,
    updated.wecom_connection_status,
    null,
    null,
    updated.updated_at,
    updated.bot_id,
  );
  return updated;
}

async function testWeComConnection(
  db: Database.Database,
  botId: string,
  options: DataStoreOptions,
): Promise<ReturnType<typeof buildWeComConnectionTestResult>> {
  const bot = getRequiredBot(db, botId);
  const secretRecord = db
    .prepare("select wecom_secret from bots where bot_id = ?")
    .get(botId) as { wecom_secret?: string | null };
  const prelim = buildWeComConnectionTestResult(bot);
  const secret = typeof secretRecord.wecom_secret === "string"
    ? secretRecord.wecom_secret
    : undefined;
  const verification = prelim.status === "configured" && options.wecomVerifier && secret
    ? await options.wecomVerifier.verify({
      bot_id: bot.wecom_bot_id ?? "",
      secret,
    })
    : undefined;
  const result = buildWeComConnectionTestResult(bot, verification);
  const updatedAt = nextIsoTimestamp(bot.updated_at);
  db.prepare(
    "update bots set wecom_connection_status = ?, last_wecom_check_at = ?, last_wecom_error = ?, updated_at = ? where bot_id = ?",
  ).run(
    result.status,
    result.checked_at,
    result.error ?? null,
    updatedAt,
    bot.bot_id,
  );
  return result;
}

function transferAdmin(
  db: Database.Database,
  input: TransferAdminInput,
): AdminRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const existing = db
    .prepare("select * from admins where bot_id = ?")
    .get(bot.bot_id);
  if (!existing) {
    throw new Error(`admin is not claimed for bot: ${bot.bot_id}`);
  }
  const existingAdmin = existing as AdminRecord;
  if (
    existingAdmin.wecom_user_id !==
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
  db.prepare(
    "update admins set wecom_user_id = ?, role = ?, claimed_at = ? where bot_id = ?",
  ).run(admin.wecom_user_id, admin.role, admin.claimed_at, admin.bot_id);
  return admin;
}

function listCurrentMemoryDocuments(
  db: Database.Database,
  input: ListCurrentMemoryDocumentsInput,
): MemoryDocumentRecord[] {
  return db
    .prepare(
      `
        select
          memory_doc_id,
          scope,
          owner_id,
          title,
          version,
          content,
          status,
          created_at
        from memory_document_versions
        where scope = ?
          and owner_id = ?
          and not (scope = 'bot' and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md'))
          and version = (
            select max(latest.version)
            from memory_document_versions latest
            where latest.memory_doc_id = memory_document_versions.memory_doc_id
          )
        order by (
          select min(first_version.rowid)
          from memory_document_versions first_version
          where first_version.memory_doc_id = memory_document_versions.memory_doc_id
        ) asc
      `,
    )
    .all(input.scope, requireText(input.owner_id, "owner_id")) as MemoryDocumentRecord[];
}

function createBusinessDocument(
  db: Database.Database,
  input: CreateBusinessDocumentInput,
): BusinessDocumentRecord {
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
  const insertDocument = db.prepare(
    `
      insert into business_documents (
        document_id, scope, owner_id, title, doc_type, visibility, tier,
        source_type, source_uri, content_hash, created_by_bot_id, created_by_user_id,
        version, created_at, updated_at, last_hit_at, hit_count, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertVersion = db.prepare(
    `
      insert into business_document_versions (
        document_id, version, content, change_summary, created_at, chunk_count
      ) values (?, ?, ?, ?, ?, ?)
    `,
  );
  const insertTag = db.prepare(
    "insert or ignore into business_document_tags (document_id, tag) values (?, ?)",
  );
  db.transaction(() => {
    insertDocument.run(
      document.document_id,
      document.scope,
      document.owner_id,
      document.title,
      document.doc_type,
      document.visibility,
      document.tier,
      document.source_type ?? null,
      document.source_uri ?? null,
      document.content_hash ?? null,
      document.created_by_bot_id ?? null,
      document.created_by_user_id ?? null,
      document.version,
      document.created_at,
      document.updated_at,
      document.last_hit_at ?? null,
      document.hit_count,
      document.status,
    );
    insertVersion.run(document.document_id, 1, input.content, null, now, 0);
    for (const tag of document.tags) {
      insertTag.run(document.document_id, tag);
    }
  })();
  return document;
}

function updateBusinessDocument(
  db: Database.Database,
  input: UpdateBusinessDocumentInput,
): BusinessDocumentVersionRecord {
  const document = mapBusinessDocumentRecord(
    db.prepare("select * from business_documents where document_id = ?")
      .get(input.document_id),
    db,
  );
  if (!document) {
    throw new Error(`business document not found: ${input.document_id}`);
  }
  const nextVersion = document.version + 1;
  const now = nextIsoTimestamp(document.updated_at);
  const version: BusinessDocumentVersionRecord = {
    document_id: document.document_id,
    version: nextVersion,
    content: input.content,
    ...(input.change_summary ? { change_summary: input.change_summary } : {}),
    created_at: now,
    chunk_count: input.chunk_count ?? 0,
  };
  db.transaction(() => {
    db.prepare(
      `
        insert into business_document_versions (
          document_id, version, content, change_summary, created_at, chunk_count
        ) values (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      version.document_id,
      version.version,
      version.content,
      version.change_summary ?? null,
      version.created_at,
      version.chunk_count,
    );
    db.prepare(
      "update business_documents set version = ?, updated_at = ? where document_id = ?",
    ).run(version.version, version.created_at, version.document_id);
  })();
  return version;
}

function getBusinessDocument(
  db: Database.Database,
  documentId: string,
  version?: number,
): BusinessDocumentVersionRecord | undefined {
  const row = version === undefined
    ? db.prepare(
      `
        select *
        from business_document_versions
        where document_id = ?
        order by version desc
        limit 1
      `,
    ).get(documentId)
    : db.prepare(
      "select * from business_document_versions where document_id = ? and version = ?",
    ).get(documentId, version);
  return mapBusinessDocumentVersionRecord(row);
}

function listBusinessDocuments(
  db: Database.Database,
  input: ListBusinessDocumentsInput,
): BusinessDocumentRecord[] {
  const rows = db.prepare(
    `
      select *
      from business_documents
      where (? is null or scope = ?)
        and (? is null or owner_id = ?)
        and (? is null or doc_type = ?)
        and (? is null or status = ?)
        and lower(title) not in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md')
      order by created_at asc
    `,
  ).all(
    input.scope ?? null,
    input.scope ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
    input.doc_type ?? null,
    input.doc_type ?? null,
    input.status ?? null,
    input.status ?? null,
  );
  return rows
    .map((row) => mapBusinessDocumentRecord(row, db))
    .filter((document): document is BusinessDocumentRecord => Boolean(document));
}

function createMemoryRecord(
  db: Database.Database,
  input: CreateMemoryRecordInput,
): MemoryRecord {
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
  const insertMemory = db.prepare(
    `
      insert into memories (
        memory_id, scope, owner_id, content, tier, source_type,
        source_conversation_id, source_message_id, created_by_bot_id, created_by_user_id,
        created_at, updated_at, last_hit_at, hit_count, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertTag = db.prepare(
    "insert or ignore into memory_tags (memory_id, tag) values (?, ?)",
  );
  db.transaction(() => {
    insertMemory.run(
      memory.memory_id,
      memory.scope,
      memory.owner_id,
      memory.content,
      memory.tier,
      memory.source_type,
      memory.source_conversation_id ?? null,
      memory.source_message_id ?? null,
      memory.created_by_bot_id ?? null,
      memory.created_by_user_id ?? null,
      memory.created_at,
      memory.updated_at,
      memory.last_hit_at ?? null,
      memory.hit_count,
      memory.status,
    );
    for (const tag of memory.tags) {
      insertTag.run(memory.memory_id, tag);
    }
  })();
  return memory;
}

function listMemories(db: Database.Database, input: ListMemoriesInput): MemoryRecord[] {
  const rows = db.prepare(
    `
      select *
      from memories
      where (? is null or scope = ?)
        and (? is null or owner_id = ?)
        and (? is null or tier = ?)
        and (? is null or status = ?)
      order by created_at asc
    `,
  ).all(
    input.scope ?? null,
    input.scope ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
    input.tier ?? null,
    input.tier ?? null,
    input.status ?? null,
    input.status ?? null,
  );
  return rows
    .map((row) => mapMemoryRecord(row, db))
    .filter((memory): memory is MemoryRecord => Boolean(memory));
}

function recordChunks(db: Database.Database, input: RecordChunksInput): ChunkRecord[] {
  const createdAt = new Date().toISOString();
  const insertChunk = db.prepare(
    `
      insert into chunks (
        chunk_id, source_type, source_id, scope, owner_id, content, chunk_index,
        heading_path, location, tier, created_at, last_hit_at, hit_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const records = input.chunks.map((chunk) => ({
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
  }) satisfies ChunkRecord);
  db.transaction(() => {
    for (const chunk of records) {
      insertChunk.run(
        chunk.chunk_id,
        chunk.source_type,
        chunk.source_id,
        chunk.scope,
        chunk.owner_id,
        chunk.content,
        chunk.chunk_index,
        chunk.heading_path ?? null,
        chunk.location ?? null,
        chunk.tier,
        chunk.created_at,
        null,
        chunk.hit_count,
      );
    }
  })();
  return records;
}

function recordAsset(db: Database.Database, input: RecordAssetInput): AssetRecord {
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
  db.prepare(
    `
      insert into assets (
        asset_id, source_type, source_id, filename, content_type,
        storage_uri, size_bytes, content_hash, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    asset.asset_id,
    asset.source_type,
    asset.source_id,
    asset.filename,
    asset.content_type,
    asset.storage_uri,
    asset.size_bytes,
    asset.content_hash,
    asset.created_at,
  );
  return asset;
}

function getMemoryStats(db: Database.Database, input: MemoryStatsInput): MemoryStats {
  const memories = listMemories(db, {
    scope: input.scope,
    owner_id: input.owner_id,
  });
  const chunkRow = db.prepare(
    `
      select count(*) as count
      from chunks
      where (? is null or scope = ?)
        and (? is null or owner_id = ?)
    `,
  ).get(
    input.scope ?? null,
    input.scope ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
  ) as { count: number };
  const assetRow = db.prepare(
    `
      select coalesce(sum(assets.size_bytes), 0) as bytes
      from assets
      left join memories on assets.source_type = 'memory' and assets.source_id = memories.memory_id
      left join business_documents on assets.source_type = 'document' and assets.source_id = business_documents.document_id
      where (
          assets.source_type = 'memory'
          and (? is null or memories.scope = ?)
          and (? is null or memories.owner_id = ?)
        )
        or (
          assets.source_type = 'document'
          and (? is null or business_documents.scope = ?)
          and (? is null or business_documents.owner_id = ?)
        )
    `,
  ).get(
    input.scope ?? null,
    input.scope ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
    input.scope ?? null,
    input.scope ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
  ) as { bytes: number };
  return {
    total_memories: memories.length,
    total_chunks: chunkRow.count,
    by_tier: countMemoriesByTier(memories),
    disk_usage_bytes: assetRow.bytes,
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists bots (
      bot_id text primary key,
      name text not null,
      runtime text not null,
      status text not null,
      wecom_bot_id text,
      wecom_secret text,
      wecom_connection_status text not null default 'unchecked',
      last_wecom_check_at text,
      last_wecom_error text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists admins (
      bot_id text primary key,
      wecom_user_id text not null,
      role text not null,
      claimed_at text not null
    );

    create table if not exists admin_claims (
      bot_id text primary key,
      code_hash text not null,
      created_at text not null,
      expires_at text not null
    );

    create table if not exists conversations (
      conversation_key text primary key,
      conversation_id text not null,
      bot_id text not null,
      wecom_user_id text not null,
      channel text not null,
      purpose text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists initialization_sessions (
      session_key text primary key,
      session_id text not null,
      bot_id text not null,
      wecom_user_id text not null,
      conversation_id text not null,
      phase text not null,
      soul_answers_json text not null,
      agents_answers_json text not null,
      generation_in_progress text,
      status text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists pending_generated_documents (
      pending_id text primary key,
      bot_id text not null,
      wecom_user_id text not null,
      conversation_id text not null,
      title text not null,
      content text not null,
      status text not null,
      created_by_bot_id text not null,
      created_by_user_id text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists runtime_configs (
      bot_id text primary key,
      provider text not null,
      stream integer not null,
      options_json text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists memory_document_versions (
      memory_doc_id text not null,
      version integer not null,
      scope text not null,
      owner_id text not null,
      title text not null,
      content text not null,
      status text not null,
      created_at text not null,
      primary key (memory_doc_id, version)
    );

    create table if not exists bot_config_documents (
      bot_id text not null,
      title text not null,
      content text not null,
      created_at text not null,
      updated_at text not null,
      primary key (bot_id, title)
    );

    create table if not exists bot_config_document_versions (
      bot_id text not null,
      title text not null,
      version integer not null,
      content text not null,
      created_at text not null,
      primary key (bot_id, title, version)
    );

    create table if not exists bot_mcp_capability_configs (
      bot_id text primary key,
      config_json text not null,
      updated_at text not null
    );

    create table if not exists business_documents (
      document_id text primary key,
      scope text not null,
      owner_id text not null,
      title text not null,
      doc_type text not null,
      visibility text not null,
      tier text not null,
      source_type text,
      source_uri text,
      content_hash text,
      created_by_bot_id text,
      created_by_user_id text,
      version integer not null,
      created_at text not null,
      updated_at text not null,
      last_hit_at text,
      hit_count integer not null,
      status text not null
    );

    create table if not exists business_document_versions (
      document_id text not null,
      version integer not null,
      content text not null,
      change_summary text,
      created_at text not null,
      chunk_count integer not null,
      primary key (document_id, version)
    );

    create table if not exists business_document_tags (
      document_id text not null,
      tag text not null,
      primary key (document_id, tag)
    );

    create table if not exists memories (
      memory_id text primary key,
      scope text not null,
      owner_id text not null,
      content text not null,
      tier text not null,
      source_type text not null,
      source_conversation_id text,
      source_message_id text,
      created_by_bot_id text,
      created_by_user_id text,
      created_at text not null,
      updated_at text not null,
      last_hit_at text,
      hit_count integer not null,
      status text not null
    );

    create table if not exists memory_tags (
      memory_id text not null,
      tag text not null,
      primary key (memory_id, tag)
    );

    create table if not exists chunks (
      chunk_id text primary key,
      source_type text not null,
      source_id text not null,
      scope text not null,
      owner_id text not null,
      content text not null,
      chunk_index integer not null,
      heading_path text,
      location text,
      tier text not null,
      created_at text not null,
      last_hit_at text,
      hit_count integer not null
    );

    create table if not exists assets (
      asset_id text primary key,
      source_type text not null,
      source_id text not null,
      filename text not null,
      content_type text not null,
      storage_uri text not null,
      size_bytes integer not null,
      content_hash text not null,
      created_at text not null
    );
  `);
  addColumnIfMissing(db, "bots", "wecom_bot_id", "text");
  addColumnIfMissing(db, "bots", "wecom_secret", "text");
  addColumnIfMissing(
    db,
    "bots",
    "wecom_connection_status",
    "text not null default 'unchecked'",
  );
  addColumnIfMissing(db, "bots", "last_wecom_check_at", "text");
  addColumnIfMissing(db, "bots", "last_wecom_error", "text");
  db.prepare(
    "create unique index if not exists idx_bots_wecom_bot_id_unique on bots (wecom_bot_id) where wecom_bot_id is not null",
  ).run();
  migrateBotConfigDocuments(db);
}

function migrateBotConfigDocuments(db: Database.Database): void {
  db.prepare(
    `
      insert or ignore into bot_config_document_versions (bot_id, title, version, content, created_at)
      select
        owner_id as bot_id,
        case
          when lower(title) in ('soul', 'soul.md', 'private/soul.md') then 'soul'
          else 'agents.md'
        end as title,
        version,
        content,
        created_at
      from memory_document_versions
      where scope = 'bot'
        and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md')
    `,
  ).run();
  db.prepare(
    `
      insert into bot_config_documents (bot_id, title, content, created_at, updated_at)
      select source.bot_id, source.title, source.content, source.created_at, source.created_at
      from bot_config_document_versions source
      where source.version = (
        select max(latest.version)
        from bot_config_document_versions latest
        where latest.bot_id = source.bot_id
          and latest.title = source.title
      )
      on conflict(bot_id, title) do nothing
    `,
  ).run();
  db.prepare(
    `
      delete from memory_document_versions
      where scope = 'bot'
        and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md')
    `,
  ).run();
}

function assertUniqueWeComBotId(
  db: Database.Database,
  wecomBotId: string | undefined,
  currentBotId?: string,
): void {
  if (!wecomBotId) {
    return;
  }

  const existing = db
    .prepare("select bot_id from bots where wecom_bot_id = ? and bot_id != ?")
    .get(wecomBotId, currentBotId ?? "") as { bot_id: string } | undefined;
  if (existing) {
    throw new Error(`wecom bot id already bound to bot: ${existing.bot_id}`);
  }
}

function claimAdmin(db: Database.Database, input: ClaimAdminInput): AdminRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const existing = db
    .prepare("select * from admins where bot_id = ?")
    .get(input.bot_id);
  if (existing) {
    throw new Error(`admin already claimed for bot: ${input.bot_id}`);
  }

  const now = new Date().toISOString();
  const admin: AdminRecord = {
    bot_id: bot.bot_id,
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    role: "admin",
    claimed_at: now,
  };
  db.prepare(
    "insert into admins (bot_id, wecom_user_id, role, claimed_at) values (?, ?, ?, ?)",
  ).run(admin.bot_id, admin.wecom_user_id, admin.role, admin.claimed_at);
  db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
    "initializing",
    now,
    bot.bot_id,
  );
  return admin;
}

function resolveConversation(
  db: Database.Database,
  input: ResolveConversationInput,
): ConversationRecord {
  getRequiredBot(db, input.bot_id);
  const key = [
    input.bot_id,
    input.wecom_user_id,
    input.channel,
    input.purpose,
  ].join(":");
  const existing = db
    .prepare(
      "select conversation_id, bot_id, wecom_user_id, channel, purpose, created_at, updated_at from conversations where conversation_key = ?",
    )
    .get(key) as ConversationRecord | undefined;
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    conversation_id: `conv_${crypto.randomUUID()}`,
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    channel: input.channel,
    purpose: input.purpose,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    "insert into conversations (conversation_key, conversation_id, bot_id, wecom_user_id, channel, purpose, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    key,
    conversation.conversation_id,
    conversation.bot_id,
    conversation.wecom_user_id,
    conversation.channel,
    conversation.purpose,
    conversation.created_at,
    conversation.updated_at,
  );
  return conversation;
}

function upsertInitializationSession(
  db: Database.Database,
  input: UpsertInitializationSessionInput,
): InitializationSessionRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const key = initializationSessionKey({
    bot_id: bot.bot_id,
    wecom_user_id: input.wecom_user_id,
    conversation_id: input.conversation_id,
  });
  const existing = mapInitializationSessionRecord(
    db.prepare("select * from initialization_sessions where session_key = ?").get(key),
  );
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
  db.prepare(
    `
      insert into initialization_sessions (
        session_key, session_id, bot_id, wecom_user_id, conversation_id, phase,
        soul_answers_json, agents_answers_json, generation_in_progress,
        status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(session_key) do update set
        phase = excluded.phase,
        soul_answers_json = excluded.soul_answers_json,
        agents_answers_json = excluded.agents_answers_json,
        generation_in_progress = excluded.generation_in_progress,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
  ).run(
    key,
    record.session_id,
    record.bot_id,
    record.wecom_user_id,
    record.conversation_id,
    record.phase,
    JSON.stringify(record.soul_answers),
    JSON.stringify(record.agents_answers),
    record.generation_in_progress ?? null,
    record.status,
    record.created_at,
    record.updated_at,
  );
  const persisted = mapInitializationSessionRecord(
    db.prepare("select * from initialization_sessions where session_key = ?").get(key),
  );
  if (!persisted) {
    throw new Error("initialization session was not persisted");
  }
  return persisted;
}

function getActiveInitializationSession(
  db: Database.Database,
  input: InitializationSessionKeyInput,
): InitializationSessionRecord | undefined {
  return mapInitializationSessionRecord(
    db.prepare(
      "select * from initialization_sessions where session_key = ? and status = 'active'",
    ).get(initializationSessionKey(input)),
  );
}

function clearInitializationSession(
  db: Database.Database,
  input: InitializationSessionKeyInput,
): void {
  db.prepare(
    "delete from initialization_sessions where session_key = ? and status = 'active'",
  ).run(initializationSessionKey(input));
}

function createPendingGeneratedDocument(
  db: Database.Database,
  input: CreatePendingGeneratedDocumentInput,
): PendingGeneratedDocumentRecord {
  const bot = getRequiredBot(db, input.bot_id);
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
  db.prepare(
    `
      insert into pending_generated_documents (
        pending_id, bot_id, wecom_user_id, conversation_id, title, content,
        status, created_by_bot_id, created_by_user_id, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.pending_id,
    record.bot_id,
    record.wecom_user_id,
    record.conversation_id,
    record.title,
    record.content,
    record.status,
    record.created_by_bot_id,
    record.created_by_user_id,
    record.created_at,
    record.updated_at,
  );
  return record;
}

function listPendingGeneratedDocuments(
  db: Database.Database,
  input: PendingGeneratedDocumentQuery,
): PendingGeneratedDocumentRecord[] {
  const query = normalizePendingGeneratedDocumentQuery(db, input);
  return db.prepare(
    `
      select *
      from pending_generated_documents
      where bot_id = ?
        and wecom_user_id = ?
        and conversation_id = ?
        and status = 'pending'
      order by rowid asc
    `,
  ).all(
    query.bot_id,
    query.wecom_user_id,
    query.conversation_id,
  ).map(mapPendingGeneratedDocumentRecord);
}

function updatePendingGeneratedDocuments(
  db: Database.Database,
  input: PendingGeneratedDocumentQuery,
  status: Exclude<PendingGeneratedDocumentStatus, "pending">,
): PendingGeneratedDocumentRecord[] {
  const pending = listPendingGeneratedDocuments(db, input);
  const update = db.prepare(
    "update pending_generated_documents set status = ?, updated_at = ? where pending_id = ? and status = 'pending'",
  );
  const updated = pending.map((document) => ({
    ...document,
    status,
    updated_at: nextIsoTimestamp(document.updated_at),
  }) satisfies PendingGeneratedDocumentRecord);
  db.transaction(() => {
    for (const document of updated) {
      update.run(document.status, document.updated_at, document.pending_id);
    }
  })();
  return updated;
}

function applyPendingGeneratedDocuments(
  db: Database.Database,
  input: ApplyPendingGeneratedDocumentsInput,
): AppliedPendingGeneratedDocumentResult[] {
  const query = normalizePendingGeneratedDocumentQuery(db, input);
  const createdByBotId = requireText(input.created_by_bot_id, "created_by_bot_id");
  const createdByUserId = requireText(input.created_by_user_id, "created_by_user_id");
  const selectPending = db.prepare(
    `
      select *
      from pending_generated_documents
      where bot_id = ?
        and wecom_user_id = ?
        and conversation_id = ?
        and status = 'pending'
      order by rowid asc
    `,
  );
  const selectExistingDocument = db.prepare(
    `
      select document_id, title, version, updated_at
      from business_documents
      where scope = 'bot'
        and owner_id = ?
        and title = ?
      order by created_at asc, document_id asc
      limit 1
    `,
  );
  const selectLatestVersion = db.prepare(
    `
      select content
      from business_document_versions
      where document_id = ?
      order by version desc
      limit 1
    `,
  );
  const insertDocument = db.prepare(
    `
      insert into business_documents (
        document_id, scope, owner_id, title, doc_type, visibility, tier,
        source_type, source_uri, content_hash, created_by_bot_id, created_by_user_id,
        version, created_at, updated_at, last_hit_at, hit_count, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertVersion = db.prepare(
    `
      insert into business_document_versions (
        document_id, version, content, change_summary, created_at, chunk_count
      ) values (?, ?, ?, ?, ?, ?)
    `,
  );
  const insertTag = db.prepare(
    "insert or ignore into business_document_tags (document_id, tag) values (?, ?)",
  );
  const updateDocument = db.prepare(
    "update business_documents set version = ?, updated_at = ? where document_id = ?",
  );
  const confirmPending = db.prepare(
    "update pending_generated_documents set status = 'confirmed', updated_at = ? where pending_id = ? and status = 'pending'",
  );

  return db.transaction(() => {
    const pending = selectPending
      .all(query.bot_id, query.wecom_user_id, query.conversation_id)
      .map(mapPendingGeneratedDocumentRecord);
    const saved: AppliedPendingGeneratedDocumentResult[] = [];

    for (const pendingDocument of pending) {
      const existing = selectExistingDocument.get(query.bot_id, pendingDocument.title) as
        | { document_id: string; version: number; updated_at: string }
        | undefined;

      if (!existing) {
        const now = new Date().toISOString();
        const documentId = `doc_${crypto.randomUUID()}`;
        insertDocument.run(
          documentId,
          "bot",
          query.bot_id,
          pendingDocument.title,
          "markdown",
          "bot",
          "core",
          "document",
          null,
          null,
          createdByBotId,
          createdByUserId,
          1,
          now,
          now,
          null,
          0,
          "active",
        );
        insertVersion.run(documentId, 1, pendingDocument.content, null, now, 0);
        insertTag.run(documentId, "generated");
        insertTag.run(documentId, "pending-confirmed");
        saved.push({
          pending_id: pendingDocument.pending_id,
          title: pendingDocument.title,
          version: 1,
        });
        continue;
      }

      const latest = selectLatestVersion.get(existing.document_id) as { content: string } | undefined;
      if (latest?.content === pendingDocument.content) {
        saved.push({
          pending_id: pendingDocument.pending_id,
          title: pendingDocument.title,
          version: existing.version,
        });
        continue;
      }

      const now = nextIsoTimestamp(existing.updated_at);
      const nextVersion = existing.version + 1;
      insertVersion.run(
        existing.document_id,
        nextVersion,
        pendingDocument.content,
        "用户确认后更新文档",
        now,
        0,
      );
      updateDocument.run(nextVersion, now, existing.document_id);
      saved.push({
        pending_id: pendingDocument.pending_id,
        title: pendingDocument.title,
        version: nextVersion,
      });
    }

    for (const pendingDocument of pending) {
      confirmPending.run(nextIsoTimestamp(pendingDocument.updated_at), pendingDocument.pending_id);
    }

    return saved;
  })();
}

function normalizePendingGeneratedDocumentQuery(
  db: Database.Database,
  input: PendingGeneratedDocumentQuery,
): PendingGeneratedDocumentQuery {
  const bot = getRequiredBot(db, input.bot_id);
  return {
    bot_id: bot.bot_id,
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    conversation_id: requireText(input.conversation_id, "conversation_id"),
  };
}

function getRequiredBot(db: Database.Database, botId: string): BotRecord {
  const bot = mapBotRecord(db.prepare("select * from bots where bot_id = ?").get(botId));
  if (!bot) {
    throw new Error(`bot not found: ${botId}`);
  }
  return bot;
}

function mapBotRecord(row: unknown): BotRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const wecomBotId = typeof record.wecom_bot_id === "string"
    ? record.wecom_bot_id
    : undefined;
  const wecomSecret = typeof record.wecom_secret === "string"
    ? record.wecom_secret
    : undefined;
  return {
    bot_id: record.bot_id as string,
    name: record.name as string,
    runtime: record.runtime as string,
    status: record.status as BotRecord["status"],
    ...(wecomBotId ? { wecom_bot_id: wecomBotId } : {}),
    wecom_secret_configured: Boolean(wecomSecret),
    wecom_connection_status: typeof record.wecom_connection_status === "string"
      ? record.wecom_connection_status as BotRecord["wecom_connection_status"]
      : "unchecked",
    ...(typeof record.last_wecom_check_at === "string"
      ? { last_wecom_check_at: record.last_wecom_check_at }
      : {}),
    ...(typeof record.last_wecom_error === "string"
      ? { last_wecom_error: record.last_wecom_error }
      : {}),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

function mapInitializationSessionRecord(
  row: unknown,
): InitializationSessionRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  return {
    session_id: record.session_id as string,
    bot_id: record.bot_id as string,
    wecom_user_id: record.wecom_user_id as string,
    conversation_id: record.conversation_id as string,
    phase: requireInitializationPhase(record.phase as string),
    soul_answers: normalizeAnswerArray(
      JSON.parse(record.soul_answers_json as string) as string[],
      "soul_answers",
    ),
    agents_answers: normalizeAnswerArray(
      JSON.parse(record.agents_answers_json as string) as string[],
      "agents_answers",
    ),
    ...(typeof record.generation_in_progress === "string"
      ? {
        generation_in_progress: requireInitializationGenerationInProgress(
          record.generation_in_progress,
        ),
      }
      : {}),
    status: requireInitializationSessionStatus(record.status as string),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

function mapRuntimeConfigRecord(row: unknown): RuntimeConfigRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  return {
    bot_id: record.bot_id as string,
    provider: requireText(record.provider as string, "provider"),
    stream: record.stream === 1,
    options: normalizeRuntimeConfigOptions(
      JSON.parse(record.options_json as string) as Record<string, unknown>,
    ),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

function mapPendingGeneratedDocumentRecord(row: unknown): PendingGeneratedDocumentRecord {
  const record = row as Record<string, unknown>;
  return {
    pending_id: record.pending_id as string,
    bot_id: record.bot_id as string,
    wecom_user_id: record.wecom_user_id as string,
    conversation_id: record.conversation_id as string,
    title: record.title as string,
    content: record.content as string,
    status: record.status as PendingGeneratedDocumentStatus,
    created_by_bot_id: record.created_by_bot_id as string,
    created_by_user_id: record.created_by_user_id as string,
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

function mapBusinessDocumentRecord(
  row: unknown,
  db: Database.Database,
): BusinessDocumentRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const documentId = record.document_id as string;
  return {
    document_id: documentId,
    scope: record.scope as BusinessDocumentRecord["scope"],
    owner_id: record.owner_id as string,
    title: record.title as string,
    doc_type: record.doc_type as string,
    visibility: record.visibility as string,
    tier: record.tier as KnowledgeTier,
    ...(typeof record.source_type === "string" ? { source_type: record.source_type as BusinessDocumentRecord["source_type"] } : {}),
    ...(typeof record.source_uri === "string" ? { source_uri: record.source_uri } : {}),
    ...(typeof record.content_hash === "string" ? { content_hash: record.content_hash } : {}),
    ...(typeof record.created_by_bot_id === "string" ? { created_by_bot_id: record.created_by_bot_id } : {}),
    ...(typeof record.created_by_user_id === "string" ? { created_by_user_id: record.created_by_user_id } : {}),
    version: record.version as number,
    tags: listTags(db, "business_document_tags", "document_id", documentId),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
    ...(typeof record.last_hit_at === "string" ? { last_hit_at: record.last_hit_at } : {}),
    hit_count: record.hit_count as number,
    status: record.status as BusinessDocumentRecord["status"],
  };
}

function mapBusinessDocumentVersionRecord(
  row: unknown,
): BusinessDocumentVersionRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  return {
    document_id: record.document_id as string,
    version: record.version as number,
    content: record.content as string,
    ...(typeof record.change_summary === "string"
      ? { change_summary: record.change_summary }
      : {}),
    created_at: record.created_at as string,
    chunk_count: record.chunk_count as number,
  };
}

function mapMemoryRecord(
  row: unknown,
  db: Database.Database,
): MemoryRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const memoryId = record.memory_id as string;
  return {
    memory_id: memoryId,
    scope: record.scope as MemoryRecord["scope"],
    owner_id: record.owner_id as string,
    content: record.content as string,
    tier: record.tier as KnowledgeTier,
    source_type: record.source_type as MemoryRecord["source_type"],
    ...(typeof record.source_conversation_id === "string"
      ? { source_conversation_id: record.source_conversation_id }
      : {}),
    ...(typeof record.source_message_id === "string"
      ? { source_message_id: record.source_message_id }
      : {}),
    ...(typeof record.created_by_bot_id === "string" ? { created_by_bot_id: record.created_by_bot_id } : {}),
    ...(typeof record.created_by_user_id === "string" ? { created_by_user_id: record.created_by_user_id } : {}),
    tags: listTags(db, "memory_tags", "memory_id", memoryId),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
    ...(typeof record.last_hit_at === "string" ? { last_hit_at: record.last_hit_at } : {}),
    hit_count: record.hit_count as number,
    status: record.status as MemoryRecord["status"],
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => requireText(tag, "tag")))];
}

function listTags(
  db: Database.Database,
  table: "business_document_tags" | "memory_tags",
  idColumn: "document_id" | "memory_id",
  id: string,
): string[] {
  return db.prepare(
    `select tag from ${table} where ${idColumn} = ? order by rowid asc`,
  ).all(id).map((row) => (row as { tag: string }).tag);
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

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.prepare(`alter table ${table} add column ${column} ${type}`).run();
  }
}
