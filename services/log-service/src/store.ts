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
  memory_refs: MemoryRef[];
}

export interface ChatEventRecord extends RecordChatEventInput {
  event_id: string;
  created_at: string;
}

export type LogEventOrder = "asc" | "desc";

export interface ListChatEventsQuery {
  bot_id: string;
  conversation_id?: string;
  run_id?: string;
  created_from?: string;
  created_to?: string;
  limit?: number;
  offset?: number;
  order?: LogEventOrder;
}

export interface NormalizedListChatEventsQuery {
  bot_id: string;
  conversation_id: string | undefined;
  run_id: string | undefined;
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
}

export interface ToolEventRecord extends RecordToolEventInput {
  event_id: string;
  created_at: string;
}

export interface ListToolEventsQuery {
  bot_id: string;
  conversation_id?: string;
  tool_name?: string;
  status?: ToolEventStatus;
  limit?: number;
  offset?: number;
  order?: LogEventOrder;
}

export interface NormalizedListToolEventsQuery {
  bot_id: string;
  conversation_id: string | undefined;
  tool_name: string | undefined;
  status: ToolEventStatus | undefined;
  limit: number;
  offset: number;
  order: LogEventOrder;
}

export interface LogStore {
  recordChatEvent(input: RecordChatEventInput): ChatEventRecord;
  listChatEvents(query: string | ListChatEventsQuery): ChatEventRecord[];
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord;
  listAuditEvents(query: ListAuditEventsQuery): AuditEventRecord[];
  recordToolEvent(input: RecordToolEventInput): ToolEventRecord;
  listToolEvents(query: ListToolEventsQuery): ToolEventRecord[];
  close?(): void;
}

export function createLogStore(): LogStore {
  const events: ChatEventRecord[] = [];
  const auditEvents: AuditEventRecord[] = [];
  const toolEvents: ToolEventRecord[] = [];

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
  };
}

export function normalizeListChatEventsQuery(
  query: string | ListChatEventsQuery,
): NormalizedListChatEventsQuery {
  if (typeof query === "string") {
    return {
      bot_id: requireText(query, "bot_id"),
      conversation_id: undefined,
      run_id: undefined,
      created_from: undefined,
      created_to: undefined,
      limit: 100,
      offset: 0,
      order: "desc",
    };
  }

  return {
    bot_id: requireText(query.bot_id, "bot_id"),
    conversation_id: query.conversation_id,
    run_id: query.run_id,
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
    (!query.conversation_id || event.conversation_id === query.conversation_id) &&
    (!query.run_id || event.run_id === query.run_id) &&
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
  return redactValue(value) as ToolEventSummary;
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
