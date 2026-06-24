export interface CapabilityRunnerServer {
  fetch(request: Request): Promise<Response>;
}

export type CapabilityAction =
  | "skills/install"
  | "skills/delete"
  | "mcps/install"
  | "mcps/delete";

export interface CapabilityDispatchContext {
  action: CapabilityAction;
  botId: string;
  payload: unknown;
}

export interface CreateCapabilityRunnerServerOptions {
  dispatch?(context: CapabilityDispatchContext): void | Promise<void>;
}

export function createCapabilityRunnerServer(
  options: CreateCapabilityRunnerServerOptions = {},
): CapabilityRunnerServer {
  const dispatch = options.dispatch;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      const skillInstallRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/skills\/install$/,
      );
      if (request.method === "POST" && skillInstallRouteMatch) {
        return dispatchAccepted(
          "skills/install",
          skillInstallRouteMatch[1],
          request,
          dispatch,
        );
      }

      const skillDeleteRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/skills\/delete$/,
      );
      if (request.method === "POST" && skillDeleteRouteMatch) {
        return dispatchAccepted(
          "skills/delete",
          skillDeleteRouteMatch[1],
          request,
          dispatch,
        );
      }

      const mcpInstallRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/mcps\/install$/,
      );
      if (request.method === "POST" && mcpInstallRouteMatch) {
        return dispatchAccepted(
          "mcps/install",
          mcpInstallRouteMatch[1],
          request,
          dispatch,
        );
      }

      const mcpDeleteRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/mcps\/delete$/,
      );
      if (request.method === "POST" && mcpDeleteRouteMatch) {
        return dispatchAccepted(
          "mcps/delete",
          mcpDeleteRouteMatch[1],
          request,
          dispatch,
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

function dispatchAccepted(
  action: CapabilityAction,
  pathSegment: string,
  request: Request,
  dispatch?: (context: CapabilityDispatchContext) => void | Promise<void>,
): Promise<Response> | Response {
  return withDecodedBotId(pathSegment, async (botId) => {
    const payload = await readJsonPayload(request);
    await dispatch?.({ action, botId, payload });
    return jsonResponse({ accepted: true }, 202);
  });
}

async function readJsonPayload(request: Request): Promise<unknown> {
  const bodyText = await request.text();
  if (bodyText.length === 0) {
    return null;
  }
  return JSON.parse(bodyText) as unknown;
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
