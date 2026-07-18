import {
  parseDocumentCreateInput,
  parseMcpScope,
  parseMcpTier,
  type DocumentCreateInput,
  type McpCapabilityConfig,
  type McpScope,
  type McpTier,
  type TrustedMcpContext,
} from "@my-agent-toolkit/contracts";
import type { DataServiceClient } from "./dataClient.js";
import type { MemoryBackendClient } from "./memoryBackendClient.js";
import type { ProjectClient } from "./projectClient.js";

export interface McpToolCall {
  tool: string;
  input: unknown;
}

export interface McpToolDependencies {
  dataClient: Pick<DataServiceClient, "createDocument" | "createMemory" | "getMemoryStats">;
  memoryBackend: Pick<MemoryBackendClient, "storeMemory" | "search"> &
    Partial<Pick<MemoryBackendClient, "ingestFile" | "fetchUrl" | "scanDirectory" | "deleteMemory">>;
  allowedDirectoryRefs?: Record<string, string>;
  capabilityConfig?: McpCapabilityConfig;
  projectClient?: ProjectClient;
}

export type McpToolResult =
  | {
    ok: true;
    result: unknown;
  }
  | {
    ok: false;
    error: {
      code: "permission_denied" | "validation_error" | "storage_unavailable";
      message: string;
    };
  };

export interface McpToolManifest {
  version: 1;
  directory_refs: string[];
  tools: McpToolDescriptor[];
}

export interface McpToolDescriptor {
  name: string;
  category: "document" | "memory" | "search" | "project";
  description: string;
  input_schema: {
    type: "object";
    required: string[];
    properties: Record<string, unknown>;
  };
  permissions: {
    reads: McpScope[];
    writes: McpScope[];
  };
}

export function listMcpTools(options: {
  allowedDirectoryRefs?: Record<string, string>;
  enabledTools?: string[];
} = {}): McpToolManifest {
  const directoryRefs = Object.keys(options.allowedDirectoryRefs ?? {}).sort();
  const enabledTools = options.enabledTools
    ? new Set(options.enabledTools)
    : undefined;
  const tools = [
    toolDescriptor(
      "document.create",
      "document",
      "Create a business document in data-service.",
      ["scope", "owner_id", "title", "doc_type", "content"],
      documentProperties(),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "document.ingest_file",
      "document",
      "Create a document record and index file content for retrieval.",
      ["scope", "owner_id", "filename", "title", "doc_type", "content"],
      { ...documentProperties(), filename: stringProperty() },
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "document.ingest_url",
      "document",
      "Create a document record and ask memory backend to fetch and index a URL.",
      ["scope", "owner_id", "url", "title", "doc_type"],
      { ...documentBaseProperties(), url: stringProperty({ format: "uri" }) },
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "document.scan",
      "document",
      "Scan an authorized directory ref as document sources.",
      ["scope", "owner_id", "directory_ref", "doc_type"],
      scanProperties(directoryRefs),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.write",
      "memory",
      "Store a long-term memory record and index it for retrieval.",
      ["scope", "owner_id", "content"],
      memoryWriteProperties(),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.ingest_file",
      "memory",
      "Index file content as memory without creating a business document.",
      ["scope", "owner_id", "filename", "content"],
      ingestFileProperties(),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.ingest_url",
      "memory",
      "Fetch and index a URL as memory without creating a business document.",
      ["scope", "owner_id", "url"],
      fetchUrlProperties(),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.scan",
      "memory",
      "Scan an authorized directory ref as memory.",
      ["scope", "owner_id", "directory_ref"],
      scanProperties(directoryRefs),
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.delete",
      "memory",
      "Delete a backend memory index record by id.",
      ["memory_id"],
      { memory_id: stringProperty() },
      { writes: writableScopes(), reads: [] },
    ),
    toolDescriptor(
      "memory.search",
      "memory",
      "Search scoped memories.",
      ["query", "scopes", "owner_ids"],
      searchProperties(),
      { writes: [], reads: readableScopes() },
    ),
    toolDescriptor(
      "memory.stats",
      "memory",
      "Read memory statistics for an optional scope and owner.",
      [],
      memoryStatsProperties(),
      { writes: [], reads: readableScopes() },
    ),
    toolDescriptor(
      "search.query",
      "search",
      "Search documents and memories through the unified backend index.",
      ["query", "scopes", "owner_ids"],
      searchProperties(),
      { writes: [], reads: readableScopes() },
    ),
    toolDescriptor(
      "project.publish",
      "project",
      "Commit validated changes from the current user's shared project workspace and push a new bot/ branch to that user's bound GitHub fork. Requires explicit user authorization.",
      ["project_key", "branch", "commit_message"],
      {
        project_key: stringProperty(),
        branch: stringProperty(),
        commit_message: stringProperty(),
      },
      { writes: [], reads: [] },
    ),
    toolDescriptor(
      "jira.project.publish",
      "project",
      "Commit the current conversation's validated Jira project directory and push it to the current user's bound GitHub fork. The project is selected by Jira key only; no local path or token is accepted. Requires explicit user authorization.",
      ["jira_key", "branch", "commit_message"],
      {
        jira_key: stringProperty(),
        branch: stringProperty(),
        commit_message: stringProperty(),
      },
      { writes: [], reads: [] },
    ),
  ].filter((tool) => !enabledTools || enabledTools.has(tool.name));
  return {
    version: 1,
    directory_refs: directoryRefs,
    tools,
  };
}

export async function callMcpTool(
  context: TrustedMcpContext,
  deps: McpToolDependencies,
  call: McpToolCall,
): Promise<McpToolResult> {
  try {
    if (call.tool === "document.create") {
      const input = parseDocumentCreateInput(call.input);
      assertDocumentWritePermission(context, input);
      assertDocumentCapabilityWritePermission(deps, input.scope);
      return {
        ok: true,
        result: await deps.dataClient.createDocument(input),
      };
    }

    if (call.tool === "document.ingest_file") {
      const input = parseDocumentIngestFileInput(call.input);
      assertDocumentWritePermission(context, input);
      assertDocumentCapabilityWritePermission(deps, input.scope);
      const ingestFile = requireBackendMethod(deps.memoryBackend.ingestFile, "ingestFile");
      const document = await deps.dataClient.createDocument({
        scope: input.scope,
        owner_id: input.owner_id,
        title: input.title,
        doc_type: input.doc_type,
        content: input.content,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_type: "file",
        source_uri: input.filename,
        created_by_bot_id: context.bot_id,
        created_by_user_id: context.user_id,
      });
      const backend = await ingestFile({
        scope: input.scope,
        owner_id: input.owner_id,
        filename: input.filename,
        content: input.content,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_kind: "document",
        source_id: readDocumentId(document),
      });
      return {
        ok: true,
        result: {
          document,
          backend,
        },
      };
    }

    if (call.tool === "document.ingest_url") {
      const input = parseDocumentIngestUrlInput(call.input);
      assertScopedWritePermission(context, input);
      assertDocumentCapabilityWritePermission(deps, input.scope);
      const fetchUrl = requireBackendMethod(deps.memoryBackend.fetchUrl, "fetchUrl");
      const document = await deps.dataClient.createDocument({
        scope: input.scope,
        owner_id: input.owner_id,
        title: input.title,
        doc_type: input.doc_type,
        content: `Imported from URL: ${input.url}`,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_type: "url",
        source_uri: input.url,
        created_by_bot_id: context.bot_id,
        created_by_user_id: context.user_id,
      });
      const backend = await fetchUrl({
        scope: input.scope,
        owner_id: input.owner_id,
        url: input.url,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_kind: "document",
        source_id: readDocumentId(document),
      });
      return {
        ok: true,
        result: {
          document,
          backend,
        },
      };
    }

    if (call.tool === "document.scan") {
      const input = parseDocumentScanInput(call.input);
      assertScopedWritePermission(context, input);
      assertDocumentCapabilityWritePermission(deps, input.scope);
      const directory = deps.allowedDirectoryRefs?.[input.directory_ref];
      if (!directory) {
        throw new PermissionError("directory_ref is not authorized");
      }
      const scanDirectory = requireBackendMethod(deps.memoryBackend.scanDirectory, "scanDirectory");
      const backend = await scanDirectory({
        scope: input.scope,
        owner_id: input.owner_id,
        directory_ref: input.directory_ref,
        directory,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_kind: "document",
      });
      const documents = [];
      for (const file of readScannedFiles(backend)) {
        documents.push(await deps.dataClient.createDocument({
          scope: input.scope,
          owner_id: input.owner_id,
          title: file.filename,
          doc_type: input.doc_type,
          content: `Imported from directory ${input.directory_ref}: ${file.filename}`,
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.tier ? { tier: input.tier } : {}),
          source_type: "file",
          source_uri: `${input.directory_ref}/${file.filename}`,
          created_by_bot_id: context.bot_id,
          created_by_user_id: context.user_id,
        }));
      }
      return {
        ok: true,
        result: {
          scanned: documents.length,
          documents,
          backend,
        },
      };
    }

    if (call.tool === "memory.write") {
      const input = parseMemoryWriteInput(call.input);
      assertScopedWritePermission(context, input);
      assertMemoryCapabilityWritePermission(deps, input.scope);
      const memory = await deps.dataClient.createMemory({
        ...input,
        source_type: input.source_type ?? "text",
        source_conversation_id: context.conversation_id,
        created_by_bot_id: context.bot_id,
        created_by_user_id: context.user_id,
      });
      const backend = await deps.memoryBackend.storeMemory({
        scope: input.scope,
        owner_id: input.owner_id,
        content: input.content,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        source_type: input.source_type ?? "text",
      });
      return {
        ok: true,
        result: {
          memory,
          backend,
        },
      };
    }

    if (call.tool === "memory.search") {
      const input = parseSearchInput(call.input);
      assertScopedReadPermission(context, input);
      assertMemoryCapabilityReadPermission(deps, input.scopes);
      return {
        ok: true,
        result: await deps.memoryBackend.search(input),
      };
    }

    if (call.tool === "memory.stats") {
      const input = parseMemoryStatsInput(call.input);
      assertStatsPermission(context, input);
      if (input.scope) {
        assertMemoryCapabilityReadPermission(deps, [input.scope]);
      }
      return {
        ok: true,
        result: await deps.dataClient.getMemoryStats(input),
      };
    }

    if (call.tool === "memory.ingest_file") {
      const input = parseIngestFileInput(call.input);
      assertScopedWritePermission(context, input);
      assertMemoryCapabilityWritePermission(deps, input.scope);
      const ingestFile = requireBackendMethod(deps.memoryBackend.ingestFile, "ingestFile");
      return {
        ok: true,
        result: await ingestFile({
          ...input,
          source_kind: "memory",
        }),
      };
    }

    if (call.tool === "memory.ingest_url") {
      const input = parseFetchUrlInput(call.input);
      assertScopedWritePermission(context, input);
      assertMemoryCapabilityWritePermission(deps, input.scope);
      const fetchUrl = requireBackendMethod(deps.memoryBackend.fetchUrl, "fetchUrl");
      return {
        ok: true,
        result: await fetchUrl({
          ...input,
          source_kind: "memory",
        }),
      };
    }

    if (call.tool === "memory.scan") {
      const input = parseScanInput(call.input);
      assertScopedWritePermission(context, input);
      assertMemoryCapabilityWritePermission(deps, input.scope);
      const directory = deps.allowedDirectoryRefs?.[input.directory_ref];
      if (!directory) {
        throw new PermissionError("directory_ref is not authorized");
      }
      const scanDirectory = requireBackendMethod(deps.memoryBackend.scanDirectory, "scanDirectory");
      return {
        ok: true,
        result: await scanDirectory({
          ...input,
          directory,
          source_kind: "memory",
        }),
      };
    }

    if (call.tool === "memory.delete") {
      const input = parseDeleteInput(call.input);
      const deleteMemory = requireBackendMethod(deps.memoryBackend.deleteMemory, "deleteMemory");
      return {
        ok: true,
        result: await deleteMemory(input.memory_id),
      };
    }

    if (call.tool === "search.query") {
      const input = parseSearchInput(call.input);
      assertScopedReadPermission(context, input);
      assertMemoryCapabilityReadPermission(deps, input.scopes);
      return {
        ok: true,
        result: await deps.memoryBackend.search(input),
      };
    }

    if (call.tool === "project.publish") {
      const input = parseProjectPublishInput(call.input);
      if (!deps.projectClient) {
        throw new StorageUnavailableError("project manager is unavailable");
      }
      return {
        ok: true,
        result: await deps.projectClient.publish(context, input),
      };
    }

    if (call.tool === "jira.project.publish") {
      const input = parseJiraProjectPublishInput(call.input);
      if (!deps.projectClient) {
        throw new StorageUnavailableError("project manager is unavailable");
      }
      return {
        ok: true,
        result: await deps.projectClient.publishJira(context, input),
      };
    }

    return toolError("validation_error", `unsupported MCP tool: ${call.tool}`);
  } catch (error) {
    return toolError(errorCodeFor(error), errorMessageFor(error));
  }
}

function requireBackendMethod<T>(
  method: T | undefined,
  name: string,
): T {
  if (!method) {
    throw new StorageUnavailableError(`memory backend method is unavailable: ${name}`);
  }
  return method;
}

function toolDescriptor(
  name: string,
  category: McpToolDescriptor["category"],
  description: string,
  required: string[],
  properties: Record<string, unknown>,
  permissions: McpToolDescriptor["permissions"],
): McpToolDescriptor {
  return {
    name,
    category,
    description,
    input_schema: {
      type: "object",
      required,
      properties,
    },
    permissions,
  };
}

function documentProperties(): Record<string, unknown> {
  return {
    ...documentBaseProperties(),
    content: stringProperty(),
  };
}

function documentBaseProperties(): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
    title: stringProperty(),
    doc_type: stringProperty(),
    tags: stringArrayProperty(),
    tier: tierProperty(),
  };
}

function memoryWriteProperties(): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
    content: stringProperty(),
    tags: stringArrayProperty(),
    tier: tierProperty(),
    source_type: stringProperty(),
  };
}

function ingestFileProperties(): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
    filename: stringProperty(),
    content: stringProperty(),
    tags: stringArrayProperty(),
    tier: tierProperty(),
  };
}

function fetchUrlProperties(): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
    url: stringProperty({ format: "uri" }),
    tags: stringArrayProperty(),
    tier: tierProperty(),
  };
}

function scanProperties(directoryRefs: string[]): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
    directory_ref: stringProperty(directoryRefs.length > 0 ? { enum: directoryRefs } : {}),
    doc_type: stringProperty(),
    tags: stringArrayProperty(),
    tier: tierProperty(),
  };
}

function searchProperties(): Record<string, unknown> {
  return {
    query: stringProperty(),
    scopes: {
      type: "array",
      items: scopeProperty(),
    },
    owner_ids: stringArrayProperty(),
    sources: {
      type: "array",
      items: {
        type: "string",
        enum: ["documents", "memories"],
      },
    },
    tags: stringArrayProperty(),
    limit: {
      type: "integer",
      minimum: 1,
    },
  };
}

function memoryStatsProperties(): Record<string, unknown> {
  return {
    scope: scopeProperty(),
    owner_id: stringProperty(),
  };
}

function writableScopes(): McpScope[] {
  return ["bot", "user", "session"];
}

function readableScopes(): McpScope[] {
  return ["system", "shared", "bot", "user", "session"];
}

function scopeProperty(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["system", "shared", "bot", "user", "session"],
  };
}

function tierProperty(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["core", "reference", "temp"],
  };
}

function stringArrayProperty(): Record<string, unknown> {
  return {
    type: "array",
    items: stringProperty(),
  };
}

function stringProperty(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "string",
    ...extra,
  };
}

function integerProperty(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "integer",
    ...extra,
  };
}

function assertDocumentWritePermission(
  context: TrustedMcpContext,
  input: DocumentCreateInput,
): void {
  assertScopedWritePermission(context, input);
}

function assertDocumentCapabilityWritePermission(
  deps: McpToolDependencies,
  scope: McpScope,
): void {
  const allowed = deps.capabilityConfig?.documents.writable_scopes;
  if (allowed && !allowed.includes(scope)) {
    throw new PermissionError(
      `document writes to scope are disabled by bot capability config: ${scope}`,
    );
  }
}

function assertMemoryCapabilityWritePermission(
  deps: McpToolDependencies,
  scope: McpScope,
): void {
  const allowed = deps.capabilityConfig?.memory.writable_scopes;
  if (allowed && !allowed.includes(scope)) {
    throw new PermissionError(
      `memory writes to scope are disabled by bot capability config: ${scope}`,
    );
  }
}

function assertMemoryCapabilityReadPermission(
  deps: McpToolDependencies,
  scopes: McpScope[],
): void {
  const allowed = deps.capabilityConfig?.memory.readable_scopes;
  if (!allowed) {
    return;
  }
  for (const scope of scopes) {
    if (!allowed.includes(scope)) {
      throw new PermissionError(
        `memory reads from scope are disabled by bot capability config: ${scope}`,
      );
    }
  }
}

function assertScopedWritePermission(
  context: TrustedMcpContext,
  input: { scope: McpScope; owner_id: string },
): void {
  if (input.scope === "system") {
    throw new PermissionError("system scope is read only");
  }
  if (input.scope === "shared") {
    throw new PermissionError("shared scope writes require explicit authorization");
  }
  if (input.scope === "bot" && input.owner_id !== context.bot_id) {
    throw new PermissionError("bot scope owner must match trusted bot_id");
  }
  if (input.scope === "user" && input.owner_id !== context.user_id) {
    throw new PermissionError("user scope owner must match trusted user_id");
  }
  if (input.scope === "session" && input.owner_id !== context.conversation_id) {
    throw new PermissionError("session scope owner must match trusted conversation_id");
  }
}

function assertScopedReadPermission(
  context: TrustedMcpContext,
  input: { scopes: McpScope[]; owner_ids: string[] },
): void {
  for (const [index, scope] of input.scopes.entries()) {
    const ownerId = input.owner_ids[index];
    if (!ownerId) {
      throw new PermissionError("each search scope must have a matching owner_id");
    }
    if (scope === "bot" && ownerId !== context.bot_id) {
      throw new PermissionError("bot scope owner must match trusted bot_id");
    }
    if (scope === "user" && ownerId !== context.user_id) {
      throw new PermissionError("user scope owner must match trusted user_id");
    }
    if (scope === "session" && ownerId !== context.conversation_id) {
      throw new PermissionError("session scope owner must match trusted conversation_id");
    }
  }
}

function assertStatsPermission(
  context: TrustedMcpContext,
  input: { scope?: McpScope; owner_id?: string },
): void {
  if (!input.scope || !input.owner_id) {
    return;
  }
  assertScopedReadPermission(context, {
    scopes: [input.scope],
    owner_ids: [input.owner_id],
  });
}

interface MemoryWriteInput {
  scope: McpScope;
  owner_id: string;
  content: string;
  tier?: McpTier;
  source_type?: string;
  tags?: string[];
}

interface SearchInput {
  query: string;
  scopes: McpScope[];
  owner_ids: string[];
  sources?: Array<"documents" | "memories">;
  tags?: string[];
  limit?: number;
}

interface MemoryStatsInput {
  scope?: McpScope;
  owner_id?: string;
}

interface IngestFileInput {
  scope: McpScope;
  owner_id: string;
  filename: string;
  content: string;
  tags?: string[];
  tier?: McpTier;
}

interface FetchUrlInput {
  scope: McpScope;
  owner_id: string;
  url: string;
  tags?: string[];
  tier?: McpTier;
}

interface ScanInput {
  scope: McpScope;
  owner_id: string;
  directory_ref: string;
  tags?: string[];
  tier?: McpTier;
}

interface DeleteInput {
  memory_id: string;
}

interface DocumentIngestFileInput extends DocumentCreateInput {
  filename: string;
}

interface DocumentIngestUrlInput {
  scope: McpScope;
  owner_id: string;
  url: string;
  title: string;
  doc_type: string;
  tags?: string[];
  tier?: McpTier;
}

interface DocumentScanInput {
  scope: McpScope;
  owner_id: string;
  directory_ref: string;
  doc_type: string;
  tags?: string[];
  tier?: McpTier;
}

function parseMemoryWriteInput(value: unknown): MemoryWriteInput {
  const record = requireRecord(value, "memory write input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    content: readRequiredString(record, "content"),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
    ...(record.source_type !== undefined
      ? { source_type: readRequiredString(record, "source_type") }
      : {}),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
  };
}

function parseSearchInput(value: unknown): SearchInput {
  const record = requireRecord(value, "search input");
  return {
    query: readRequiredString(record, "query"),
    scopes: parseScopeArray(record.scopes),
    owner_ids: parseStringArray(record.owner_ids, "owner_ids"),
    ...(record.sources !== undefined ? { sources: parseSources(record.sources) } : {}),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.limit !== undefined ? { limit: parsePositiveInteger(record.limit, "limit") } : {}),
  };
}

function parseMemoryStatsInput(value: unknown): MemoryStatsInput {
  const record = requireRecord(value, "memory stats input");
  return {
    ...(record.scope !== undefined ? { scope: parseMcpScope(record.scope) } : {}),
    ...(record.owner_id !== undefined ? { owner_id: readRequiredString(record, "owner_id") } : {}),
  };
}

function parseDocumentIngestFileInput(value: unknown): DocumentIngestFileInput {
  const record = requireRecord(value, "document ingest file input");
  return {
    ...parseDocumentCreateInput(value),
    filename: readRequiredString(record, "filename"),
  };
}

function parseDocumentIngestUrlInput(value: unknown): DocumentIngestUrlInput {
  const record = requireRecord(value, "document ingest url input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    url: readRequiredString(record, "url"),
    title: readRequiredString(record, "title"),
    doc_type: readRequiredString(record, "doc_type"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
  };
}

function parseDocumentScanInput(value: unknown): DocumentScanInput {
  const record = requireRecord(value, "document scan input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    directory_ref: readRequiredString(record, "directory_ref"),
    doc_type: readRequiredString(record, "doc_type"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
  };
}

function parseIngestFileInput(value: unknown): IngestFileInput {
  const record = requireRecord(value, "ingest file input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    filename: readRequiredString(record, "filename"),
    content: readRequiredString(record, "content"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
  };
}

function parseFetchUrlInput(value: unknown): FetchUrlInput {
  const record = requireRecord(value, "fetch url input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    url: readRequiredString(record, "url"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
  };
}

function parseScanInput(value: unknown): ScanInput {
  const record = requireRecord(value, "scan input");
  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id"),
    directory_ref: readRequiredString(record, "directory_ref"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
  };
}

function parseDeleteInput(value: unknown): DeleteInput {
  const record = requireRecord(value, "delete input");
  return {
    memory_id: readRequiredString(record, "memory_id"),
  };
}

function parseProjectPublishInput(value: unknown): {
  projectKey: string;
  branch: string;
  commitMessage: string;
} {
  const record = requireRecord(value, "project publish input");
  return {
    projectKey: readRequiredString(record, "project_key"),
    branch: readRequiredString(record, "branch"),
    commitMessage: readRequiredString(record, "commit_message"),
  };
}

function parseJiraProjectPublishInput(value: unknown): {
  jiraKey: string;
  branch: string;
  commitMessage: string;
} {
  const record = requireRecord(value, "Jira project publish input");
  return {
    jiraKey: readRequiredString(record, "jira_key"),
    branch: readRequiredString(record, "branch"),
    commitMessage: readRequiredString(record, "commit_message"),
  };
}

function parseScopeArray(value: unknown): McpScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }
  return value.map(parseMcpScope);
}

function parseSources(value: unknown): Array<"documents" | "memories"> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("sources must be a non-empty array");
  }
  return value.map((source) => {
    if (source === "documents" || source === "memories") {
      return source;
    }
    throw new Error("sources must contain documents or memories");
  });
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${field} must be an array of strings`);
    }
    return item.trim();
  });
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function readDocumentId(document: Record<string, unknown>): string {
  const value = document.document_id;
  if (typeof value !== "string" || value.trim() === "") {
    throw new StorageUnavailableError("data-service document response missing document_id");
  }
  return value;
}

function readScannedFiles(scanResult: Record<string, unknown>): Array<{ filename: string }> {
  const files = scanResult.files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return [];
    }
    const filename = (file as Record<string, unknown>).filename;
    if (typeof filename !== "string" || filename.trim() === "") {
      return [];
    }
    return [{ filename: filename.trim() }];
  });
}

function toolError(
  code: "permission_denied" | "validation_error" | "storage_unavailable",
  message: string,
): McpToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function errorCodeFor(
  error: unknown,
): "permission_denied" | "validation_error" | "storage_unavailable" {
  if (error instanceof PermissionError) {
    return "permission_denied";
  }
  if (error instanceof StorageUnavailableError) {
    return "storage_unavailable";
  }
  return "validation_error";
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : "invalid MCP tool request";
}

class PermissionError extends Error {}
class StorageUnavailableError extends Error {}
