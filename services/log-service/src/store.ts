export interface MemoryRef {
  scope: string;
  owner_id: string;
  memory_doc_id: string;
  title: string;
  version: number;
}

export interface RecordChatEventInput {
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  runtime: string;
  prompt: string;
  output: string;
  run_id: string;
  trace_id?: string;
  memory_refs: MemoryRef[];
}

export interface ChatEventRecord extends RecordChatEventInput {
  event_id: string;
  created_at: string;
}

export type LogEventOrder = "asc" | "desc";

export interface ListChatEventsQuery {
  bot_id: string;
  wecom_user_id?: string;
  conversation_id?: string;
  run_id?: string;
  trace_id?: string;
  created_from?: string;
  created_to?: string;
  limit?: number;
  offset?: number;
  order?: LogEventOrder;
}

export interface NormalizedListChatEventsQuery {
  bot_id: string;
  wecom_user_id: string | undefined;
  conversation_id: string | undefined;
  run_id: string | undefined;
  trace_id: string | undefined;
  created_from: string | undefined;
  created_to: string | undefined;
  limit: number;
  offset: number;
  order: LogEventOrder;
}

export interface RecordAuditEventInput {
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
}

export interface AuditEventRecord extends RecordAuditEventInput {
  event_id: string;
  created_at: string;
}

export interface ListAuditEventsQuery {
  target_type: string;
  target_id: string;
  action?: string;
  limit?: number;
  offset?: number;
  order?: LogEventOrder;
}

export interface NormalizedListAuditEventsQuery {
  target_type: string;
  target_id: string;
  action: string | undefined;
  limit: number;
  offset: number;
  order: LogEventOrder;
}

export type ToolEventStatus = "ok" | "error";
export type ToolEventSummary = Record<string, unknown>;

export interface RecordToolEventInput {
  bot_id: string;
  user_id: string;
  conversation_id: string;
  tool_name: string;
  input_summary: ToolEventSummary;
  output_summary: ToolEventSummary;
  target_type: string;
  target_id: string;
  status: ToolEventStatus;
  error_code?: string;
  duration_ms: number;
  trace_id?: string;
}

export interface ToolEventRecord extends RecordToolEventInput {
  event_id: string;
  created_at: string;
}

export interface ListToolEventsQuery {
  bot_id: string;
  user_id?: string;
  conversation_id?: string;
  tool_name?: string;
  status?: ToolEventStatus;
  limit?: number;
  offset?: number;
  order?: LogEventOrder;
}

export interface NormalizedListToolEventsQuery {
  bot_id: string;
  user_id: string | undefined;
  conversation_id: string | undefined;
  tool_name: string | undefined;
  status: ToolEventStatus | undefined;
  limit: number;
  offset: number;
  order: LogEventOrder;
}

export type TraceStatus = "running" | "ok" | "error" | "cancelled";

export interface RecordMessageTraceInput {
  trace_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  runtime: string;
  status?: TraceStatus;
}

export interface MessageTraceRecord extends RecordMessageTraceInput {
  status: TraceStatus;
  started_at: string;
  ended_at?: string;
}

export interface ListMessageTracesQuery {
  bot_id: string;
  wecom_user_id?: string;
  conversation_id?: string;
  limit?: number;
}

export interface RecordTraceSpanInput {
  trace_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  stage: string;
  status: TraceStatus;
  summary?: ToolEventSummary;
  run_id?: string;
  duration_ms?: number;
  error_code?: string;
}

export interface TraceSpanRecord extends RecordTraceSpanInput {
  span_id: string;
  summary: ToolEventSummary;
  created_at: string;
}

export interface ListTraceSpansQuery {
  trace_id: string;
  bot_id: string;
}

export interface LogStore {
  recordChatEvent(input: RecordChatEventInput): ChatEventRecord;
  listChatEvents(query: string | ListChatEventsQuery): ChatEventRecord[];
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord;
  listAuditEvents(query: ListAuditEventsQuery): AuditEventRecord[];
  recordToolEvent(input: RecordToolEventInput): ToolEventRecord;
  listToolEvents(query: ListToolEventsQuery): ToolEventRecord[];
  recordMessageTrace(input: RecordMessageTraceInput): MessageTraceRecord;
  listMessageTraces(query: ListMessageTracesQuery): MessageTraceRecord[];
  finishMessageTrace(traceId: string, status: Exclude<TraceStatus, "running">): MessageTraceRecord | undefined;
  recordTraceSpan(input: RecordTraceSpanInput): TraceSpanRecord;
  listTraceSpans(query: ListTraceSpansQuery): TraceSpanRecord[];
  close?(): void;
}

export function createLogStore(): LogStore {
  const events: ChatEventRecord[] = [];
  const auditEvents: AuditEventRecord[] = [];
  const toolEvents: ToolEventRecord[] = [];
  const messageTraces: MessageTraceRecord[] = [];
  const traceSpans: TraceSpanRecord[] = [];

  return {
    recordChatEvent(input) {
      const event: ChatEventRecord = {
        event_id: `evt_${crypto.randomUUID()}`,
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        runtime: requireText(input.runtime, "runtime"),
        prompt: requireText(input.prompt, "prompt"),
        output: input.output,
        run_id: requireText(input.run_id, "run_id"),
        trace_id: input.trace_id?.trim() || `trace_${crypto.randomUUID()}`,
        memory_refs: input.memory_refs,
        created_at: new Date().toISOString(),
      };
      events.push(event);
      return event;
    },

    listChatEvents(query) {
      const normalized = normalizeListChatEventsQuery(query);
      return orderLogEvents(
        events.filter((event) => matchesChatEventQuery(event, normalized)),
        normalized.order,
      )
        .slice(
          normalized.offset,
          normalized.offset + normalized.limit,
        );
    },

    recordAuditEvent(input) {
      const event: AuditEventRecord = {
        event_id: `audit_${crypto.randomUUID()}`,
        actor_id: requireText(input.actor_id, "actor_id"),
        action: requireText(input.action, "action"),
        target_type: requireText(input.target_type, "target_type"),
        target_id: requireText(input.target_id, "target_id"),
        metadata: input.metadata,
        created_at: new Date().toISOString(),
      };
      auditEvents.push(event);
      return event;
    },

    listAuditEvents(query) {
      const normalized = normalizeListAuditEventsQuery(query);
      return orderLogEvents(
        auditEvents.filter((event) => matchesAuditEventQuery(event, normalized)),
        normalized.order,
      )
        .slice(
          normalized.offset,
          normalized.offset + normalized.limit,
        );
    },

    recordToolEvent(input) {
      const event: ToolEventRecord = {
        event_id: `tool_${crypto.randomUUID()}`,
        bot_id: requireText(input.bot_id, "bot_id"),
        user_id: requireText(input.user_id, "user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        tool_name: requireText(input.tool_name, "tool_name"),
        input_summary: redactSummary(input.input_summary),
        output_summary: redactSummary(input.output_summary),
        target_type: requireText(input.target_type, "target_type"),
        target_id: requireText(input.target_id, "target_id"),
        status: requireToolEventStatus(input.status),
        ...(input.error_code ? { error_code: input.error_code } : {}),
        trace_id: input.trace_id?.trim() || `trace_${crypto.randomUUID()}`,
        duration_ms: normalizeNonNegativeInteger(input.duration_ms, 0, "duration_ms"),
        created_at: new Date().toISOString(),
      };
      toolEvents.push(event);
      return event;
    },

    listToolEvents(query) {
      const normalized = normalizeListToolEventsQuery(query);
      return orderLogEvents(
        toolEvents.filter((event) => matchesToolEventQuery(event, normalized)),
        normalized.order,
      )
        .slice(normalized.offset, normalized.offset + normalized.limit);
    },

    recordMessageTrace(input) {
      const event: MessageTraceRecord = {
        trace_id: requireText(input.trace_id, "trace_id"),
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        runtime: requireText(input.runtime, "runtime"),
        status: input.status ?? "running",
        started_at: new Date().toISOString(),
      };
      messageTraces.push(event);
      return event;
    },

    listMessageTraces(query) {
      const botId = requireText(query.bot_id, "bot_id");
      const limit = normalizeNonNegativeInteger(query.limit, 50, "limit");
      return [...messageTraces]
        .filter((item) => item.bot_id === botId
          && (!query.wecom_user_id || item.wecom_user_id === query.wecom_user_id)
          && (!query.conversation_id || item.conversation_id === query.conversation_id))
        .sort((left, right) => right.started_at.localeCompare(left.started_at))
        .slice(0, limit);
    },

    finishMessageTrace(traceId, status) {
      const event = messageTraces.find((item) => item.trace_id === traceId);
      if (!event) return undefined;
      event.status = status;
      event.ended_at = new Date().toISOString();
      return event;
    },

    recordTraceSpan(input) {
      const event: TraceSpanRecord = {
        span_id: `span_${crypto.randomUUID()}`,
        trace_id: requireText(input.trace_id, "trace_id"),
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        stage: requireText(input.stage, "stage"),
        status: requireTraceStatus(input.status),
        summary: redactSummary(input.summary ?? {}),
        ...(input.run_id ? { run_id: input.run_id } : {}),
        ...(input.duration_ms === undefined ? {} : { duration_ms: normalizeNonNegativeInteger(input.duration_ms, 0, "duration_ms") }),
        ...(input.error_code ? { error_code: input.error_code } : {}),
        created_at: new Date().toISOString(),
      };
      traceSpans.push(event);
      return event;
    },

    listTraceSpans(query) {
      const traceId = requireText(query.trace_id, "trace_id");
      const botId = requireText(query.bot_id, "bot_id");
      return orderLogEvents(traceSpans.filter((event) => event.trace_id === traceId && event.bot_id === botId), "asc");
    },
  };
}

export function normalizeListChatEventsQuery(
  query: string | ListChatEventsQuery,
): NormalizedListChatEventsQuery {
  if (typeof query === "string") {
    return {
      bot_id: requireText(query, "bot_id"),
      wecom_user_id: undefined,
      conversation_id: undefined,
      run_id: undefined,
      trace_id: undefined,
      created_from: undefined,
      created_to: undefined,
      limit: 100,
      offset: 0,
      order: "desc",
    };
  }

  return {
    bot_id: requireText(query.bot_id, "bot_id"),
    wecom_user_id: query.wecom_user_id,
    conversation_id: query.conversation_id,
    run_id: query.run_id,
    trace_id: query.trace_id,
    created_from: query.created_from,
    created_to: query.created_to,
    limit: normalizeNonNegativeInteger(query.limit, 100, "limit"),
    offset: normalizeNonNegativeInteger(query.offset, 0, "offset"),
    order: normalizeLogEventOrder(query.order),
  };
}

function matchesChatEventQuery(
  event: ChatEventRecord,
  query: NormalizedListChatEventsQuery,
): boolean {
  return event.bot_id === query.bot_id &&
    (!query.wecom_user_id || event.wecom_user_id === query.wecom_user_id) &&
    (!query.conversation_id || event.conversation_id === query.conversation_id) &&
    (!query.run_id || event.run_id === query.run_id) &&
    (!query.trace_id || event.trace_id === query.trace_id) &&
    (!query.created_from || event.created_at >= query.created_from) &&
    (!query.created_to || event.created_at <= query.created_to);
}

export function normalizeListAuditEventsQuery(
  query: ListAuditEventsQuery,
): NormalizedListAuditEventsQuery {
  return {
    target_type: requireText(query.target_type, "target_type"),
    target_id: requireText(query.target_id, "target_id"),
    action: query.action,
    limit: normalizeNonNegativeInteger(query.limit, 100, "limit"),
    offset: normalizeNonNegativeInteger(query.offset, 0, "offset"),
    order: normalizeLogEventOrder(query.order),
  };
}

function matchesAuditEventQuery(
  event: AuditEventRecord,
  query: NormalizedListAuditEventsQuery,
): boolean {
  return event.target_type === query.target_type &&
    event.target_id === query.target_id &&
    (!query.action || event.action === query.action);
}

export function normalizeListToolEventsQuery(
  query: ListToolEventsQuery,
): NormalizedListToolEventsQuery {
  return {
    bot_id: requireText(query.bot_id, "bot_id"),
    user_id: query.user_id,
    conversation_id: query.conversation_id,
    tool_name: query.tool_name,
    status: query.status === undefined ? undefined : requireToolEventStatus(query.status),
    limit: normalizeNonNegativeInteger(query.limit, 100, "limit"),
    offset: normalizeNonNegativeInteger(query.offset, 0, "offset"),
    order: normalizeLogEventOrder(query.order),
  };
}

function matchesToolEventQuery(
  event: ToolEventRecord,
  query: NormalizedListToolEventsQuery,
): boolean {
  return event.bot_id === query.bot_id &&
    (!query.user_id || event.user_id === query.user_id) &&
    (!query.conversation_id || event.conversation_id === query.conversation_id) &&
    (!query.tool_name || event.tool_name === query.tool_name) &&
    (!query.status || event.status === query.status);
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  defaultValue: number,
  field: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeLogEventOrder(value: LogEventOrder | undefined): LogEventOrder {
  if (value === undefined) {
    return "desc";
  }
  if (value === "asc" || value === "desc") {
    return value;
  }
  throw new Error("order must be asc or desc");
}

function orderLogEvents<T extends { created_at: string }>(
  records: T[],
  order: LogEventOrder,
): T[] {
  const ordered = [...records].sort((left, right) => left.created_at.localeCompare(right.created_at));
  return order === "desc" ? ordered.reverse() : ordered;
}

function requireToolEventStatus(value: unknown): ToolEventStatus {
  if (value === "ok" || value === "error") {
    return value;
  }
  throw new Error("status must be ok or error");
}

function requireTraceStatus(value: unknown): TraceStatus {
  if (value === "running" || value === "ok" || value === "error" || value === "cancelled") return value;
  throw new Error("status must be running, ok, error, or cancelled");
}

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

const SENSITIVE_SUMMARY_KEYS = new Set([
  "secret",
  "api_key",
  "apikey",
  "claim_code",
  "code",
  "token",
]);

export function redactSummary(value: ToolEventSummary): ToolEventSummary {
  return redactTraceText(redactValue(value)) as ToolEventSummary;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_SUMMARY_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

/**
 * Trace artifacts may contain rendered prompts or CLI text. Redact common
 * credential representations even when they are embedded in a free-form string.
 */
function redactTraceText(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
      .replace(/\b((?:api[_-]?key|token|secret|password|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactTraceText);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactTraceText(item)]));
  }
  return value;
}
