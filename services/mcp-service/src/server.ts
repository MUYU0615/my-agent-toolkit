import { verifyRunnerToken } from "./context.js";

export interface McpServiceConfig {
  runnerSecret: string;
}

export interface McpServiceServer {
  fetch(request: Request): Promise<Response>;
}

export function createMcpServiceServer(
  config: McpServiceConfig,
): McpServiceServer {
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
