import {
  parseDocumentCreateInput,
  parseMcpScope,
  parseMcpTier,
  type DocumentCreateInput,
  type McpScope,
  type McpTier,
  type TrustedMcpContext,
} from "@my-agent-toolkit/contracts";
import type { DataServiceClient } from "./dataClient.js";
import type { MemoryBackendClient } from "./memoryBackendClient.js";

export interface McpToolCall {
  tool: string;
  input: unknown;
}

export interface McpToolDependencies {
  dataClient: Pick<DataServiceClient, "createDocument" | "createMemory" | "getMemoryStats">;
  memoryBackend: Pick<MemoryBackendClient, "storeMemory" | "search"> &
    Partial<Pick<MemoryBackendClient, "ingestFile" | "fetchUrl" | "scanDirectory" | "deleteMemory">>;
  allowedDirectoryRefs?: Record<string, string>;
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

export async function callMcpTool(
  context: TrustedMcpContext,
  deps: McpToolDependencies,
  call: McpToolCall,
): Promise<McpToolResult> {
  try {
    if (call.tool === "document.create") {
      const input = parseDocumentCreateInput(call.input);
      assertDocumentWritePermission(context, input);
      return {
        ok: true,
        result: await deps.dataClient.createDocument(input),
      };
    }

    if (call.tool === "memory.write") {
      const input = parseMemoryWriteInput(call.input);
      assertScopedWritePermission(context, input);
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
      return {
        ok: true,
        result: await deps.memoryBackend.search(input),
      };
    }

    if (call.tool === "memory.stats") {
      const input = parseMemoryStatsInput(call.input);
      assertStatsPermission(context, input);
      return {
        ok: true,
        result: await deps.dataClient.getMemoryStats(input),
      };
    }

    if (call.tool === "memory.ingest_file") {
      const input = parseIngestFileInput(call.input);
      assertScopedWritePermission(context, input);
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
      return {
        ok: true,
        result: await deps.memoryBackend.search(input),
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

function assertDocumentWritePermission(
  context: TrustedMcpContext,
  input: DocumentCreateInput,
): void {
  assertScopedWritePermission(context, input);
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
