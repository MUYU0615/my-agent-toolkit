import { createHmac } from "node:crypto";
import type { TrustedMcpContext } from "@my-agent-toolkit/contracts";
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

export function buildMcpPromptSection(manifest: McpToolManifest): string {
  const toolLines = manifest.tools.map((tool) => [
    `- ${tool.name} [${tool.category}]: ${tool.description}`,
    `  required: ${tool.input_schema.required.length > 0 ? tool.input_schema.required.join(", ") : "none"}`,
    `  reads: ${tool.permissions.reads.length > 0 ? tool.permissions.reads.join(", ") : "none"}`,
    `  writes: ${tool.permissions.writes.length > 0 ? tool.permissions.writes.join(", ") : "none"}`,
  ].join("\n"));

  return [
    "<mcp_tools>",
    "Use these MCP tools only through the runner-provided MCP channel. Do not invent tool names or directory refs.",
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

export function signRunnerToken(
  secret: string,
  context: TrustedMcpContext,
): string {
  const payload = Buffer.from(JSON.stringify({
    bot_id: context.bot_id,
    user_id: context.user_id,
    conversation_id: context.conversation_id,
    runtime: context.runtime,
    iat: Math.floor(Date.now() / 1000),
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", requireSecret(secret))
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

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

function requireSecret(secret: string): string {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error("runner secret is required");
  }
  return secret;
}
