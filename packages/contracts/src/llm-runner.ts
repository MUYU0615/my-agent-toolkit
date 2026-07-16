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

function readRequiredString(
  record: Record<string, unknown>,
  field: keyof ChatRequest,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}
