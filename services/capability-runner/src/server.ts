export interface CapabilityRunnerServer {
  fetch(request: Request): Promise<Response>;
}

export function createCapabilityRunnerServer(): CapabilityRunnerServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      const installRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/skills\/install$/,
      );
      if (request.method === "POST" && installRouteMatch) {
        return withDecodedBotId(installRouteMatch[1], () =>
          jsonResponse({ accepted: true }, 202),
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

function withDecodedBotId<T extends Response | Promise<Response>>(
  pathSegment: string,
  callback: (botId: string) => T,
): T | Response {
  try {
    return callback(decodeURIComponent(pathSegment));
  } catch (error) {
    if (error instanceof URIError) {
      return jsonResponse({ error: "bot_id path segment is malformed" }, 400);
    }
    throw error;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
