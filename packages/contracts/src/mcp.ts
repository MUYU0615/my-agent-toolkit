import { createHmac, timingSafeEqual } from "node:crypto";

export type McpScope = "system" | "shared" | "bot" | "user" | "session";
export type McpTier = "core" | "reference" | "temp";
export type McpRuntime = "mock" | "kiro" | "claude-code";

export interface TrustedMcpContext {
  bot_id: string;
  user_id: string;
  conversation_id: string;
  runtime: McpRuntime;
}

export interface ExpectedMcpPathContext {
  bot_id: string;
  conversation_id: string;
}

export interface DocumentCreateInput {
  scope: McpScope;
  owner_id: string;
  title: string;
  doc_type: string;
  content: string;
  tags?: string[];
  visibility?: "private" | "bot" | "shared";
  tier?: McpTier;
  source_type?: string;
  source_uri?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
}

export interface McpCapabilityConfig {
  version: 1;
  memory: {
    enabled: boolean;
    readable_scopes: McpScope[];
    writable_scopes: McpScope[];
  };
  documents: {
    enabled: boolean;
    writable_scopes: McpScope[];
  };
  tools: {
    enabled: string[];
  };
  directory_refs: string[];
}

const MCP_SCOPES = ["system", "shared", "bot", "user", "session"] as const;
const MCP_TIERS = ["core", "reference", "temp"] as const;
const MCP_RUNTIMES = ["mock", "kiro", "claude-code"] as const;
const DEFAULT_MCP_TOOLS = [
  "document.create",
  "document.ingest_file",
  "document.ingest_url",
  "document.scan",
  "memory.write",
  "memory.ingest_file",
  "memory.ingest_url",
  "memory.scan",
  "memory.delete",
  "memory.search",
  "memory.stats",
  "search.query",
  "project.publish",
  "jira.project.publish",
  "handoff.draft.create",
  "handoff.draft.select_bot",
  "handoff.draft.confirm_send",
] as const;
const RESERVED_CONFIG_DOCUMENT_TITLES = new Set([
  "soul",
  "soul.md",
  "agents",
  "agents.md",
]);

export function parseTrustedMcpContext(value: unknown): TrustedMcpContext {
  const record = requireRecord(value, "trusted MCP context");
  return {
    bot_id: readRequiredString(record, "bot_id").trim(),
    user_id: readRequiredString(record, "user_id").trim(),
    conversation_id: readRequiredString(record, "conversation_id").trim(),
    runtime: parseMcpRuntime(record.runtime),
  };
}

export function signRunnerToken(
  secret: string,
  context: TrustedMcpContext,
): string {
  const payload = base64UrlEncode(JSON.stringify({
    ...parseTrustedMcpContext(context),
    iat: Math.floor(Date.now() / 1000),
  }));
  const signature = signPayload(secret, payload);
  return `${payload}.${signature}`;
}

export function verifyRunnerToken(
  secret: string,
  token: string,
  expected: ExpectedMcpPathContext,
): TrustedMcpContext {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new Error("runner token is invalid");
  }
  const expectedSignature = signPayload(secret, payload);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new Error("runner token signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw new Error("runner token is invalid");
  }
  const context = parseTrustedMcpContext(decoded);
  if (
    context.bot_id !== expected.bot_id ||
    context.conversation_id !== expected.conversation_id
  ) {
    throw new Error("runner token context does not match request path");
  }
  return context;
}

export function buildDefaultMcpCapabilityConfig(): McpCapabilityConfig {
  return {
    version: 1,
    memory: {
      enabled: true,
      readable_scopes: ["system", "shared", "bot", "user", "session"],
      writable_scopes: ["bot", "user", "session"],
    },
    documents: {
      enabled: true,
      writable_scopes: ["bot", "user", "session"],
    },
    tools: {
      enabled: [...DEFAULT_MCP_TOOLS],
    },
    directory_refs: [],
  };
}

export function parseMcpCapabilityConfig(value: unknown): McpCapabilityConfig {
  const record = requireRecord(value, "MCP capability config");
  if (record.version !== 1) {
    throw new Error("MCP capability config version must be 1");
  }
  const memory = requireRecord(record.memory, "MCP memory capability");
  const documents = requireRecord(record.documents, "MCP document capability");
  const tools = requireRecord(record.tools, "MCP tool capability");
  return {
    version: 1,
    memory: {
      enabled: readRequiredBoolean(memory, "enabled"),
      readable_scopes: parseScopeArray(memory.readable_scopes, "readable_scopes"),
      writable_scopes: parseScopeArray(memory.writable_scopes, "writable_scopes"),
    },
    documents: {
      enabled: readRequiredBoolean(documents, "enabled"),
      writable_scopes: parseScopeArray(documents.writable_scopes, "writable_scopes"),
    },
    tools: {
      enabled: parseStringArray(tools.enabled, "enabled")
        .filter((tool) => tool !== "project.ensure"),
    },
    directory_refs: parseStringArray(record.directory_refs, "directory_refs"),
  };
}

export function parseDocumentCreateInput(value: unknown): DocumentCreateInput {
  const record = requireRecord(value, "document create input");
  const title = readRequiredString(record, "title").trim();
  if (isReservedConfigDocumentTitle(title)) {
    throw new Error("document title is reserved for bot configuration");
  }

  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id").trim(),
    title,
    doc_type: readRequiredString(record, "doc_type").trim(),
    content: readRequiredString(record, "content"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.visibility !== undefined
      ? { visibility: parseDocumentVisibility(record.visibility) }
      : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
    ...(record.source_type !== undefined
      ? { source_type: readRequiredString(record, "source_type").trim() }
      : {}),
    ...(record.source_uri !== undefined
      ? { source_uri: readRequiredString(record, "source_uri").trim() }
      : {}),
    ...(record.created_by_bot_id !== undefined
      ? { created_by_bot_id: readRequiredString(record, "created_by_bot_id").trim() }
      : {}),
    ...(record.created_by_user_id !== undefined
      ? { created_by_user_id: readRequiredString(record, "created_by_user_id").trim() }
      : {}),
  };
}

export function parseMcpScope(value: unknown): McpScope {
  if (isOneOf(value, MCP_SCOPES)) {
    return value;
  }
  throw new Error("scope must be system, shared, bot, user, or session");
}

export function parseMcpTier(value: unknown): McpTier {
  if (isOneOf(value, MCP_TIERS)) {
    return value;
  }
  throw new Error("tier must be core, reference, or temp");
}

export function isReservedConfigDocumentTitle(value: string): boolean {
  return RESERVED_CONFIG_DOCUMENT_TITLES.has(value.trim().toLowerCase());
}

function parseMcpRuntime(value: unknown): McpRuntime {
  if (isOneOf(value, MCP_RUNTIMES)) {
    return value;
  }
  throw new Error("runtime must be mock, kiro, or claude-code");
}

function parseDocumentVisibility(value: unknown): "private" | "bot" | "shared" {
  if (value === "private" || value === "bot" || value === "shared") {
    return value;
  }
  throw new Error("visibility must be private, bot, or shared");
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
  return value;
}

function readRequiredBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function parseScopeArray(value: unknown, field: string): McpScope[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of scopes`);
  }
  return value.map(parseMcpScope);
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  options: T,
): value is T[number] {
  return typeof value === "string" && options.includes(value);
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", requireSecret(secret))
    .update(payload)
    .digest("base64url");
}

function requireSecret(secret: string): string {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error("runner secret is required");
  }
  return secret;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
