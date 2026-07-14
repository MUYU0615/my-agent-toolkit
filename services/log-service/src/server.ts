import { createLogStore, type LogStore } from "./store.js";

export interface LogServiceServer {
  fetch(request: Request): Promise<Response>;
}

export function createLogServiceServer(
  store: LogStore = createLogStore(),
): LogServiceServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "log-service",
          status: "ok",
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/chat-events") {
        return handleRecordChatEvent(request, store);
      }

      if (request.method === "GET" && url.pathname === "/v1/chat-events") {
        return handleListChatEvents(url, store);
      }

      if (request.method === "POST" && url.pathname === "/v1/audit-events") {
        return handleRecordAuditEvent(request, store);
      }

      if (request.method === "GET" && url.pathname === "/v1/audit-events") {
        return handleListAuditEvents(url, store);
      }

      if (request.method === "POST" && url.pathname === "/internal/tool-events") {
        return handleRecordToolEvent(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/tool-events") {
        return handleListToolEvents(url, store);
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleRecordChatEvent(
  request: Request,
  store: LogStore,
): Promise<Response> {
  try {
    return jsonResponse(store.recordChatEvent(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListChatEvents(url: URL, store: LogStore): Response {
  try {
    return jsonResponse(store.listChatEvents({
      bot_id: url.searchParams.get("bot_id") ?? "",
      conversation_id: optionalParam(url, "conversation_id"),
      run_id: optionalParam(url, "run_id"),
      created_from: optionalParam(url, "created_from"),
      created_to: optionalParam(url, "created_to"),
      limit: optionalNumberParam(url, "limit"),
      offset: optionalNumberParam(url, "offset"),
      order: optionalLogEventOrder(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRecordAuditEvent(
  request: Request,
  store: LogStore,
): Promise<Response> {
  try {
    return jsonResponse(store.recordAuditEvent(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListAuditEvents(url: URL, store: LogStore): Response {
  try {
    return jsonResponse(store.listAuditEvents({
      target_type: url.searchParams.get("target_type") ?? "",
      target_id: url.searchParams.get("target_id") ?? "",
      action: optionalParam(url, "action"),
      limit: optionalNumberParam(url, "limit"),
      offset: optionalNumberParam(url, "offset"),
      order: optionalLogEventOrder(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRecordToolEvent(
  request: Request,
  store: LogStore,
): Promise<Response> {
  try {
    return jsonResponse(store.recordToolEvent(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListToolEvents(url: URL, store: LogStore): Response {
  try {
    return jsonResponse(store.listToolEvents({
      bot_id: url.searchParams.get("bot_id") ?? "",
      conversation_id: optionalParam(url, "conversation_id"),
      tool_name: optionalParam(url, "tool_name"),
      status: optionalToolEventStatus(url, "status"),
      limit: optionalNumberParam(url, "limit"),
      offset: optionalNumberParam(url, "offset"),
      order: optionalLogEventOrder(url),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function optionalParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

function optionalToolEventStatus(
  url: URL,
  name: string,
): "ok" | "error" | undefined {
  const value = url.searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  if (value === "ok" || value === "error") {
    return value;
  }
  throw new Error("status must be ok or error");
}

function optionalLogEventOrder(url: URL): "asc" | "desc" | undefined {
  const value = url.searchParams.get("order");
  if (value === null || value === "asc" || value === "desc") {
    return value ?? undefined;
  }
  throw new Error("order must be asc or desc");
}

function optionalNumberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function errorResponse(error: unknown): Response {
  return jsonResponse(
    { error: error instanceof Error ? error.message : "invalid request" },
    400,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
