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

      if (request.method === "POST" && url.pathname === "/internal/message-traces") {
        return handleRecordMessageTrace(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/message-traces") {
        return handleListMessageTraces(url, store);
      }

      if (request.method === "POST" && url.pathname === "/internal/message-traces/finish") {
        return handleFinishMessageTrace(request, store);
      }

      if (request.method === "POST" && url.pathname === "/internal/trace-spans") {
        return handleRecordTraceSpan(request, store);
      }

      if (request.method === "GET" && url.pathname === "/internal/trace-spans") {
        return handleListTraceSpans(url, store);
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
      wecom_user_id: optionalParam(url, "wecom_user_id"),
      conversation_id: optionalParam(url, "conversation_id"),
      run_id: optionalParam(url, "run_id"),
      trace_id: optionalParam(url, "trace_id"),
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

async function handleRecordMessageTrace(request: Request, store: LogStore): Promise<Response> {
  try {
    return jsonResponse(store.recordMessageTrace(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListMessageTraces(url: URL, store: LogStore): Response {
  try {
    return jsonResponse(store.listMessageTraces({
      bot_id: url.searchParams.get("bot_id") ?? "",
      wecom_user_id: optionalParam(url, "wecom_user_id"),
      conversation_id: optionalParam(url, "conversation_id"),
      limit: optionalNumberParam(url, "limit"),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleFinishMessageTrace(request: Request, store: LogStore): Promise<Response> {
  try {
    const body = await request.json() as { trace_id?: string; status?: "ok" | "error" | "cancelled" };
    if (body.status !== "ok" && body.status !== "error" && body.status !== "cancelled") {
      throw new Error("status must be ok, error, or cancelled");
    }
    const record = store.finishMessageTrace(body.trace_id ?? "", body.status);
    return record ? jsonResponse(record) : jsonResponse({ error: "trace not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRecordTraceSpan(request: Request, store: LogStore): Promise<Response> {
  try {
    return jsonResponse(store.recordTraceSpan(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListTraceSpans(url: URL, store: LogStore): Response {
  try {
    return jsonResponse(store.listTraceSpans({
      trace_id: url.searchParams.get("trace_id") ?? "",
      bot_id: url.searchParams.get("bot_id") ?? "",
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
      user_id: optionalParam(url, "user_id"),
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
