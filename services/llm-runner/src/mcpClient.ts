import {
  signRunnerToken,
  type TrustedMcpContext,
} from "@my-agent-toolkit/contracts";
import type { McpRunnerConfig } from "./config.js";

export interface McpToolManifest {
  version: 1;
  directory_refs: string[];
  tools: McpToolDescriptor[];
}

export interface McpToolDescriptor {
  name: string;
  category: string;
  description: string;
  input_schema: {
    type: string;
    required: string[];
    properties: Record<string, unknown>;
  };
  permissions: {
    reads: string[];
    writes: string[];
  };
}

export interface McpClientConfig extends McpRunnerConfig {
  fetch?: typeof fetch;
}

export interface McpToolCall {
  tool: string;
  input: unknown;
}

export interface McpToolResult {
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

export type McpToolCallRequest =
  | {
    status: "none";
  }
  | {
    status: "call";
    call: McpToolCall;
  }
  | {
    status: "error";
    result: McpToolResult;
  };

export async function fetchMcpToolManifest(
  config: McpClientConfig,
  context: TrustedMcpContext,
): Promise<McpToolManifest> {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = config.service_url.replace(/\/+$/, "");
  const url = `${baseUrl}/mcp/bots/${encodeURIComponent(context.bot_id)}/sessions/${
    encodeURIComponent(context.conversation_id)
  }/tools`;
  const response = await fetchImpl(new Request(url, {
    method: "GET",
    headers: {
      "x-runner-token": signRunnerToken(config.runner_secret, context),
    },
  }));
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(`mcp-service tools request failed: ${response.status}`);
  }
  return parseMcpToolManifest(body);
}

export async function callMcpTool(
  config: McpClientConfig,
  context: TrustedMcpContext,
  toolCall: McpToolCall,
): Promise<McpToolResult> {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = config.service_url.replace(/\/+$/, "");
  const url = `${baseUrl}/mcp/bots/${encodeURIComponent(context.bot_id)}/sessions/${
    encodeURIComponent(context.conversation_id)
  }/tools/call`;
  const response = await fetchImpl(new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-runner-token": signRunnerToken(config.runner_secret, context),
    },
    body: JSON.stringify(toolCall),
  }));
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    return {
      ok: false,
      error: body,
    };
  }
  return parseMcpToolResult(body);
}

export function parseMcpToolCall(output: string): McpToolCall | undefined {
  const request = parseMcpToolCallRequest(output);
  if (request.status !== "call") {
    return undefined;
  }
  return request.call;
}

export function parseMcpToolCallRequest(output: string): McpToolCallRequest {
  const matches = [...output.matchAll(/<mcp_tool_call>\s*([\s\S]*?)\s*<\/mcp_tool_call>/g)];
  if (matches.length === 0) {
    return { status: "none" };
  }
  if (matches.length > 1) {
    return protocolError(
      "multiple_tool_calls",
      "Only one MCP tool call is allowed per runtime turn",
    );
  }
  const match = matches[0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return protocolError(
      "invalid_tool_call_json",
      "MCP tool call JSON is invalid",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return protocolError(
      "invalid_tool_call",
      "MCP tool call must be a JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.tool !== "string" || record.tool.trim() === "") {
    return protocolError(
      "invalid_tool_call",
      "MCP tool call requires a non-empty tool name",
    );
  }
  return {
    status: "call",
    call: {
      tool: record.tool.trim(),
      input: record.input ?? {},
    },
  };
}

function protocolError(code: string, message: string): McpToolCallRequest {
  return {
    status: "error",
    result: {
      ok: false,
      error: {
        code,
        message,
      },
    },
  };
}

export function formatMcpToolResult(result: McpToolResult): string {
  return [
    "<mcp_tool_result>",
    JSON.stringify(result),
    "</mcp_tool_result>",
  ].join("\n");
}

export function buildMcpPromptSection(manifest: McpToolManifest): string {
  const toolLines = manifest.tools.map((tool) => [
    `- ${tool.name} [${tool.category}]: ${tool.description}`,
    `  required: ${tool.input_schema.required.length > 0 ? tool.input_schema.required.join(", ") : "none"}`,
    `  input fields: ${Object.keys(tool.input_schema.properties).length > 0 ? Object.keys(tool.input_schema.properties).join(", ") : "none"}`,
    `  reads: ${tool.permissions.reads.length > 0 ? tool.permissions.reads.join(", ") : "none"}`,
    `  writes: ${tool.permissions.writes.length > 0 ? tool.permissions.writes.join(", ") : "none"}`,
  ].join("\n"));

  return [
    "<mcp_tools>",
    "Use these MCP tools only through the runner-provided MCP channel. Do not invent tool names or directory refs.",
    "When a tool is needed, reply with exactly one MCP call block and no prose.",
    "Its literal form is &lt;mcp_tool_call&gt;{\"tool\":\"tool.name\",\"input\":{}}&lt;/mcp_tool_call&gt;; output real angle brackets, not the escaped entities.",
    "Never write an mcp_tool_call result attribute and never invent a tool result, branch, commit, or URL. Only the runner may return MCP results after a real tool execution.",
    "Wait for the runner's MCP tool result block before deciding whether another tool is needed or writing the user-facing answer.",
    "Do not invoke native Kiro CLI tools (including dummy, Read, shell, or web tools) to replace an MCP tool.",
    "A shared repository is prepared with /sync. A Test-Jira project is the current conversation's <JIRA-KEY>/ directory. Never clone or locate a repository yourself.",
    "Native Git commit and push are disabled in the CLI runtime. Do not use native CLI or shell commands for Git commit, Git push, token setup, or other remote project writes. When the user explicitly asks to submit or Push a shared repository, use project.publish. When they explicitly ask to submit or Push the current Jira project, use jira.project.publish. Supply a valid concise bot/<task-name> branch hint; the trusted service selects a stable branch for the current conversation and returns its actual name.",
    `Allowed directory refs: ${manifest.directory_refs.length > 0 ? manifest.directory_refs.join(", ") : "none"}`,
    ...toolLines,
    "</mcp_tools>",
  ].join("\n");
}

export function injectMcpPromptSection(
  prompt: string,
  manifest: McpToolManifest | undefined,
): string {
  if (!manifest) {
    return prompt;
  }
  return `${buildMcpPromptSection(manifest)}\n\n<message>\n${prompt}\n</message>`;
}

export { signRunnerToken };

function parseMcpToolManifest(value: unknown): McpToolManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mcp tool manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("mcp tool manifest version must be 1");
  }
  if (!Array.isArray(record.directory_refs)) {
    throw new Error("mcp tool manifest directory_refs must be an array");
  }
  if (!Array.isArray(record.tools)) {
    throw new Error("mcp tool manifest tools must be an array");
  }
  return {
    version: 1,
    directory_refs: record.directory_refs.filter((item): item is string => typeof item === "string"),
    tools: record.tools.map(parseMcpToolDescriptor),
  };
}

function parseMcpToolResult(value: unknown): McpToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "mcp tool result must be an object",
    };
  }
  const record = value as Record<string, unknown>;
  return {
    ok: record.ok === true,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

function parseMcpToolDescriptor(value: unknown): McpToolDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mcp tool descriptor must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    name: readRequiredString(record, "name"),
    category: readRequiredString(record, "category"),
    description: readRequiredString(record, "description"),
    input_schema: parseInputSchema(record.input_schema),
    permissions: parsePermissions(record.permissions),
  };
}

function parseInputSchema(value: unknown): McpToolDescriptor["input_schema"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mcp tool input_schema must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    type: readRequiredString(record, "type"),
    required: Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === "string")
      : [],
    properties: (!record.properties || typeof record.properties !== "object" || Array.isArray(record.properties))
      ? {}
      : record.properties as Record<string, unknown>,
  };
}

function parsePermissions(value: unknown): McpToolDescriptor["permissions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      reads: [],
      writes: [],
    };
  }
  const record = value as Record<string, unknown>;
  return {
    reads: Array.isArray(record.reads)
      ? record.reads.filter((item): item is string => typeof item === "string")
      : [],
    writes: Array.isArray(record.writes)
      ? record.writes.filter((item): item is string => typeof item === "string")
      : [],
  };
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
