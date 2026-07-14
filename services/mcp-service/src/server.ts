import { verifyRunnerToken } from "./context.js";
import { createDataServiceClient, type DataServiceClient } from "./dataClient.js";
import {
  createMemoryBackendClient,
  type MemoryBackendClient,
} from "./memoryBackendClient.js";
import { callMcpTool, listMcpTools, type McpToolResult } from "./tools.js";
import { createProjectClient, type ProjectClient } from "./projectClient.js";

export type McpMemoryBackendDependency = Pick<
  MemoryBackendClient,
  "storeMemory" | "search" | "ingestFile" | "fetchUrl" | "scanDirectory" | "deleteMemory"
>;

export interface McpServiceConfig {
  runnerSecret: string;
  dataServiceUrl?: string;
  dataClient?: Pick<DataServiceClient, "createDocument" | "createMemory" | "getMemoryStats" | "getMcpCapabilityConfig">;
  memoryBackendUrl?: string;
  memoryBackend?: McpMemoryBackendDependency;
  allowedDirectoryRefs?: Record<string, string>;
  capabilityRunnerUrl?: string;
  projectClient?: ProjectClient;
}

export interface McpServiceServer {
  fetch(request: Request): Promise<Response>;
}

export function createMcpServiceServer(
  config: McpServiceConfig,
): McpServiceServer {
  const dataClient = config.dataClient ?? createDataServiceClient({
    baseUrl: config.dataServiceUrl ?? "http://data-service:8300",
  });
  const memoryBackend = config.memoryBackend ?? createMemoryBackendClient({
    baseUrl: config.memoryBackendUrl ?? "http://memory-service:8100",
  });
  const projectClient = config.projectClient ?? (config.capabilityRunnerUrl
    ? createProjectClient({
      baseUrl: config.capabilityRunnerUrl,
      token: config.runnerSecret,
    })
    : undefined);
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "mcp-service",
          status: "ok",
        });
      }

      const contextRoute = url.pathname.match(
        /^\/mcp\/bots\/([^/]+)\/sessions\/([^/]+)\/context$/,
      );
      if (request.method === "GET" && contextRoute) {
        return handleGetContext(
          request,
          config,
          decodeURIComponent(contextRoute[1]),
          decodeURIComponent(contextRoute[2]),
        );
      }

      const toolsListRoute = url.pathname.match(
        /^\/mcp\/bots\/([^/]+)\/sessions\/([^/]+)\/tools$/,
      );
      if (request.method === "GET" && toolsListRoute) {
        return handleListTools(
          request,
          config,
          dataClient,
          decodeURIComponent(toolsListRoute[1]),
          decodeURIComponent(toolsListRoute[2]),
        );
      }

      const toolRoute = url.pathname.match(
        /^\/mcp\/bots\/([^/]+)\/sessions\/([^/]+)\/tools\/call$/,
      );
      if (request.method === "POST" && toolRoute) {
        return handleToolCall(
          request,
          config,
          dataClient,
          memoryBackend,
          projectClient,
          decodeURIComponent(toolRoute[1]),
          decodeURIComponent(toolRoute[2]),
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleListTools(
  request: Request,
  config: McpServiceConfig,
  dataClient: Pick<DataServiceClient, "getMcpCapabilityConfig">,
  botId: string,
  conversationId: string,
): Promise<Response> {
  const context = authenticateRequest(request, config, botId, conversationId);
  if (context instanceof Response) {
    return context;
  }
  const capabilityConfig = await dataClient.getMcpCapabilityConfig(context.bot_id);
  return jsonResponse(listMcpTools({
    allowedDirectoryRefs: filterAllowedDirectoryRefs(
      config.allowedDirectoryRefs ?? {},
      capabilityConfig.directory_refs,
    ),
    enabledTools: capabilityConfig.tools.enabled,
  }));
}

function handleGetContext(
  request: Request,
  config: McpServiceConfig,
  botId: string,
  conversationId: string,
): Response {
  const token = request.headers.get("x-runner-token");
  if (!token) {
    return mcpErrorResponse("permission_denied", "x-runner-token is required", 401);
  }
  try {
    return jsonResponse(verifyRunnerToken(config.runnerSecret, token, {
      bot_id: botId,
      conversation_id: conversationId,
    }));
  } catch (error) {
    return mcpErrorResponse(
      "permission_denied",
      error instanceof Error ? error.message : "runner token is invalid",
      403,
    );
  }
}

async function handleToolCall(
  request: Request,
  config: McpServiceConfig,
  dataClient: Pick<DataServiceClient, "createDocument" | "createMemory" | "getMemoryStats" | "getMcpCapabilityConfig">,
  memoryBackend: McpMemoryBackendDependency,
  projectClient: ProjectClient | undefined,
  botId: string,
  conversationId: string,
): Promise<Response> {
  const context = authenticateRequest(request, config, botId, conversationId);
  if (context instanceof Response) {
    return context;
  }
  try {
    const toolCall = await request.json() as { tool: string; input: unknown };
    const capabilityConfig = await dataClient.getMcpCapabilityConfig(context.bot_id);
    if (!capabilityConfig.tools.enabled.includes(toolCall.tool)) {
      return jsonResponse(disabledToolResult(toolCall.tool));
    }
    return jsonResponse(await callMcpTool(context, {
      dataClient,
      memoryBackend,
      allowedDirectoryRefs: filterAllowedDirectoryRefs(
        config.allowedDirectoryRefs ?? {},
        capabilityConfig.directory_refs,
      ),
      capabilityConfig,
      projectClient,
    }, toolCall));
  } catch (error) {
    return mcpErrorResponse(
      "validation_error",
      error instanceof Error ? error.message : "invalid MCP tool request",
      400,
    );
  }
}

function disabledToolResult(toolName: string): McpToolResult {
  return {
    ok: false,
    error: {
      code: "permission_denied",
      message: `MCP tool is disabled by bot capability config: ${toolName}`,
    },
  };
}

function filterAllowedDirectoryRefs(
  configuredRefs: Record<string, string>,
  enabledRefs: string[],
): Record<string, string> {
  const enabled = new Set(enabledRefs);
  return Object.fromEntries(
    Object.entries(configuredRefs).filter(([ref]) => enabled.has(ref)),
  );
}

function authenticateRequest(
  request: Request,
  config: McpServiceConfig,
  botId: string,
  conversationId: string,
): ReturnType<typeof verifyRunnerToken> | Response {
  const token = request.headers.get("x-runner-token");
  if (!token) {
    return mcpErrorResponse("permission_denied", "x-runner-token is required", 401);
  }
  try {
    return verifyRunnerToken(config.runnerSecret, token, {
      bot_id: botId,
      conversation_id: conversationId,
    });
  } catch (error) {
    return mcpErrorResponse(
      "permission_denied",
      error instanceof Error ? error.message : "runner token is invalid",
      403,
    );
  }
}

export function parseAllowedDirectoryRefs(value: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const path = trimmed.slice(separatorIndex + 1).trim();
    if (key && path) {
      refs[key] = path;
    }
  }
  return refs;
}

function mcpErrorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return jsonResponse({
    error: {
      code,
      message,
    },
  }, status);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
