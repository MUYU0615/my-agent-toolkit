import { timingSafeEqual } from "node:crypto";

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
  listSkills?(): unknown | Promise<unknown>;
  syncProject?(context: {
    botId: string;
    userId: string;
    conversationId: string;
    projectKey?: string;
  }): unknown | Promise<unknown>;
  publishProject?(context: {
    botId: string;
    userId: string;
    conversationId: string;
    projectKey: string;
    branch: string;
    commitMessage: string;
  }): unknown | Promise<unknown>;
  projectRunnerToken?: string;
}

export function createCapabilityRunnerServer(
  options: CreateCapabilityRunnerServerOptions = {},
): CapabilityRunnerServer {
  const dispatch = options.dispatch;
  const listSkills = options.listSkills;
  const syncProject = options.syncProject;
  const publishProject = options.publishProject;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/internal/skills/catalog") {
        return jsonResponse({ items: await listSkills?.() ?? [] });
      }

      const projectSyncRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/projects\/sync$/,
      );
      if (request.method === "POST" && projectSyncRouteMatch) {
        if (!matchesToken(
          request.headers.get("x-project-runner-token"),
          options.projectRunnerToken,
        )) {
          return jsonResponse({ error: "project runner token is invalid" }, 401);
        }
        return withDecodedBotId(projectSyncRouteMatch[1], async (botId) => {
          try {
            const payload = requireRecord(await readJsonPayload(request));
            const result = await syncProject?.({
              botId,
              userId: requireString(payload.user_id, "user_id"),
              conversationId: requireString(payload.conversation_id, "conversation_id"),
              projectKey: optionalString(payload.project_key, "project_key"),
            });
            return jsonResponse(result ?? { error: "project manager is not configured" }, result ? 200 : 503);
          } catch (error) {
            return jsonResponse({
              error: error instanceof Error ? error.message : "project sync failed",
            }, 400);
          }
        });
      }

      const projectPublishRouteMatch = url.pathname.match(
        /^\/internal\/bots\/([^/]+)\/projects\/publish$/,
      );
      if (request.method === "POST" && projectPublishRouteMatch) {
        if (!matchesToken(
          request.headers.get("x-project-runner-token"),
          options.projectRunnerToken,
        )) {
          return jsonResponse({ error: "project runner token is invalid" }, 401);
        }
        return withDecodedBotId(projectPublishRouteMatch[1], async (botId) => {
          try {
            const payload = requireRecord(await readJsonPayload(request));
            const result = await publishProject?.({
              botId,
              userId: requireString(payload.user_id, "user_id"),
              conversationId: requireString(payload.conversation_id, "conversation_id"),
              projectKey: requireString(payload.project_key, "project_key"),
              branch: requireString(payload.branch, "branch"),
              commitMessage: requireString(payload.commit_message, "commit_message"),
            });
            return jsonResponse(result ?? { error: "project manager is not configured" }, result ? 200 : 503);
          } catch (error) {
            return jsonResponse({
              error: error instanceof Error ? error.message : "project publish failed",
            }, 400);
          }
        });
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function matchesToken(actual: string | null, expected: string | undefined): boolean {
  if (!expected || !actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}
