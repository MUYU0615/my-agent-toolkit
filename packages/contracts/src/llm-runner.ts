export type RuntimeName = "mock" | "kiro" | "claude-code";

export interface ChatRequest {
  bot_id: string;
  user_id: string;
  conversation_id: string;
  /** Correlates one inbound WeCom message across host, runner and MCP spans. */
  trace_id?: string;
  runtime: RuntimeName;
  prompt: string;
}

export interface ChatResponse {
  run_id: string;
  runner_session_id: string;
  output: string;
}

/** A non-conversational, system-owned Flow execution. It is intentionally separate from ChatRequest. */
export interface SystemRunRequest {
  flow_id: string;
  run_id: string;
  runtime: RuntimeName;
  prompt: string;
  trace_id?: string;
  /** Runtime-only Flow environment. Never part of a Bot or chat request. */
  runtime_env?: Record<string, string>;
  /** Explicit administrator authorization for a non-conversational Flow. */
  auto_execute?: boolean;
}

const requiredFields: Array<keyof ChatRequest> = [
  "conversation_id",
  "bot_id",
  "user_id",
  "runtime",
  "prompt",
];

export function parseChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object") {
    throw new Error("chat request must be an object");
  }

  const record = value as Record<string, unknown>;
  for (const field of requiredFields) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      throw new Error(`${field} is required`);
    }
  }

  if (record.runtime !== "mock" && record.runtime !== "kiro" && record.runtime !== "claude-code") {
    throw new Error("runtime must be mock, kiro, or claude-code");
  }

  return {
    bot_id: readRequiredString(record, "bot_id").trim(),
    user_id: readRequiredString(record, "user_id").trim(),
    conversation_id: readRequiredString(record, "conversation_id").trim(),
    ...(typeof record.trace_id === "string" && record.trace_id.trim()
      ? { trace_id: record.trace_id.trim() }
      : {}),
    runtime: record.runtime,
    prompt: readRequiredString(record, "prompt"),
  };
}

export function parseSystemRunRequest(value: unknown): SystemRunRequest {
  if (!value || typeof value !== "object") throw new Error("system run request must be an object");
  const record = value as Record<string, unknown>;
  const flowId = readRequiredString(record, "flow_id").trim();
  const runId = readRequiredString(record, "run_id").trim();
  const prompt = readRequiredString(record, "prompt");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flowId)) throw new Error("flow_id is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("run_id is invalid");
  if (record.runtime !== "mock" && record.runtime !== "kiro" && record.runtime !== "claude-code") {
    throw new Error("runtime must be mock, kiro, or claude-code");
  }
  return {
    flow_id: flowId,
    run_id: runId,
    runtime: record.runtime,
    prompt,
    ...(record.runtime_env === undefined ? {} : { runtime_env: parseSystemRuntimeEnv(record.runtime_env) }),
    ...(record.auto_execute === true ? { auto_execute: true } : {}),
    ...(typeof record.trace_id === "string" && record.trace_id.trim() ? { trace_id: record.trace_id.trim() } : {}),
  };
}

function parseSystemRuntimeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime_env must be an object");
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error("runtime_env has too many entries");
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, item] of entries) {
    if (!isAllowedSystemRuntimeEnvKey(key) || typeof item !== "string" || item.length > 8192) {
      throw new Error("runtime_env contains an unsupported value");
    }
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(item, "utf8");
    if (totalBytes > 64 * 1024) throw new Error("runtime_env is too large");
    result[key] = item;
  }
  return result;
}

function isAllowedSystemRuntimeEnvKey(key: string): boolean {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) return false;
  if (["PATH", "HOME", "SHELL", "NODE_OPTIONS", "KIRO_HOME", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"].includes(key)) return false;
  return !key.startsWith("KIRO_RELAY_") && !key.startsWith("MY_AGENT_") && !key.startsWith("SYSTEM_") && !key.startsWith("LD_") && !key.startsWith("DYLD_");
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
