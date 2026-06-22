import { verifyRunnerToken } from "./context.js";
import { createDataServiceClient, type DataServiceClient } from "./dataClient.js";
import { callMcpTool } from "./tools.js";

export interface McpServiceConfig {
  runnerSecret: string;
  dataServiceUrl?: string;
  dataClient?: Pick<DataServiceClient, "createDocument">;
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

      const toolRoute = url.pathname.match(
        /^\/mcp\/bots\/([^/]+)\/sessions\/([^/]+)\/tools\/call$/,
      );
      if (request.method === "POST" && toolRoute) {
        return handleToolCall(
          request,
          config,
          dataClient,
          decodeURIComponent(toolRoute[1]),
          decodeURIComponent(toolRoute[2]),
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
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
  dataClient: Pick<DataServiceClient, "createDocument">,
  botId: string,
  conversationId: string,
): Promise<Response> {
  const context = authenticateRequest(request, config, botId, conversationId);
  if (context instanceof Response) {
    return context;
  }
  try {
    return jsonResponse(await callMcpTool(context, {
      dataClient,
    }, await request.json() as { tool: string; input: unknown }));
  } catch (error) {
    return mcpErrorResponse(
      "validation_error",
      error instanceof Error ? error.message : "invalid MCP tool request",
      400,
    );
  }
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
