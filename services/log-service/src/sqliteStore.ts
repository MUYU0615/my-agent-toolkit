import Database from "better-sqlite3";
import {
  normalizeListChatEventsQuery,
  normalizeListAuditEventsQuery,
  normalizeListToolEventsQuery,
  redactSummary,
  requireText,
  type AuditEventRecord,
  type ChatEventRecord,
  type LogStore,
  type MessageTraceRecord,
  type RecordChatEventInput,
  type TraceSpanRecord,
  type ToolEventRecord,
} from "./store.js";

export function createSqliteLogStore(dbPath: string): LogStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);

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
      db.prepare(
        `
          insert into chat_events (
            event_id,
            bot_id,
            wecom_user_id,
            conversation_id,
            runtime,
            prompt,
            output,
            run_id,
            trace_id,
            memory_refs_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        event.event_id,
        event.bot_id,
        event.wecom_user_id,
        event.conversation_id,
        event.runtime,
        event.prompt,
        event.output,
        event.run_id,
        event.trace_id,
        JSON.stringify(event.memory_refs),
        event.created_at,
      );
      return event;
    },

    listChatEvents(query) {
      const normalized = normalizeListChatEventsQuery(query);
      const conditions = ["bot_id = ?"];
      const params: Array<string | number> = [normalized.bot_id];
      if (normalized.conversation_id) {
        conditions.push("conversation_id = ?");
        params.push(normalized.conversation_id);
      }
      if (normalized.wecom_user_id) {
        conditions.push("wecom_user_id = ?");
        params.push(normalized.wecom_user_id);
      }
      if (normalized.run_id) {
        conditions.push("run_id = ?");
        params.push(normalized.run_id);
      }
      if (normalized.trace_id) {
        conditions.push("trace_id = ?");
        params.push(normalized.trace_id);
      }
      if (normalized.created_from) {
        conditions.push("created_at >= ?");
        params.push(normalized.created_from);
      }
      if (normalized.created_to) {
        conditions.push("created_at <= ?");
        params.push(normalized.created_to);
      }
      params.push(normalized.limit, normalized.offset);

      return db
        .prepare(
          `
            select
              event_id,
              bot_id,
              wecom_user_id,
              conversation_id,
              runtime,
              prompt,
              output,
              run_id,
              trace_id,
              memory_refs_json,
              created_at
            from chat_events
            where ${conditions.join(" and ")}
            order by created_at ${normalized.order}, rowid ${normalized.order}
            limit ?
            offset ?
          `,
        )
        .all(...params)
        .map(rowToChatEvent);
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
      db.prepare(
        `
          insert into audit_events (
            event_id,
            actor_id,
            action,
            target_type,
            target_id,
            metadata_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        event.event_id,
        event.actor_id,
        event.action,
        event.target_type,
        event.target_id,
        JSON.stringify(event.metadata),
        event.created_at,
      );
      return event;
    },

    listAuditEvents(query) {
      const normalized = normalizeListAuditEventsQuery(query);
      const conditions = ["target_type = ?", "target_id = ?"];
      const params: Array<string | number> = [
        normalized.target_type,
        normalized.target_id,
      ];
      if (normalized.action) {
        conditions.push("action = ?");
        params.push(normalized.action);
      }
      params.push(normalized.limit, normalized.offset);

      return db
        .prepare(
          `
            select
              event_id,
              actor_id,
              action,
              target_type,
              target_id,
              metadata_json,
              created_at
            from audit_events
            where ${conditions.join(" and ")}
            order by created_at ${normalized.order}, rowid ${normalized.order}
            limit ?
            offset ?
          `,
        )
        .all(...params)
        .map(rowToAuditEvent);
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
        status: input.status,
        ...(input.error_code ? { error_code: input.error_code } : {}),
        duration_ms: input.duration_ms,
        created_at: new Date().toISOString(),
      };
      db.prepare(
        `
          insert into tool_events (
            event_id,
            bot_id,
            user_id,
            conversation_id,
            tool_name,
            input_summary_json,
            output_summary_json,
            target_type,
            target_id,
            status,
            error_code,
            duration_ms,
            trace_id,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        event.event_id,
        event.bot_id,
        event.user_id,
        event.conversation_id,
        event.tool_name,
        JSON.stringify(event.input_summary),
        JSON.stringify(event.output_summary),
        event.target_type,
        event.target_id,
        event.status,
        event.error_code ?? null,
        event.duration_ms,
        event.trace_id,
        event.created_at,
      );
      return event;
    },

    listToolEvents(query) {
      const normalized = normalizeListToolEventsQuery(query);
      const conditions = ["bot_id = ?"];
      const params: Array<string | number> = [normalized.bot_id];
      if (normalized.conversation_id) {
        conditions.push("conversation_id = ?");
        params.push(normalized.conversation_id);
      }
      if (normalized.user_id) {
        conditions.push("user_id = ?");
        params.push(normalized.user_id);
      }
      if (normalized.tool_name) {
        conditions.push("tool_name = ?");
        params.push(normalized.tool_name);
      }
      if (normalized.status) {
        conditions.push("status = ?");
        params.push(normalized.status);
      }
      params.push(normalized.limit, normalized.offset);

      return db.prepare(
        `
          select
            event_id,
            bot_id,
            user_id,
            conversation_id,
            tool_name,
            input_summary_json,
            output_summary_json,
            target_type,
            target_id,
            status,
            error_code,
            duration_ms,
            trace_id,
            created_at
          from tool_events
          where ${conditions.join(" and ")}
          order by created_at ${normalized.order}, rowid ${normalized.order}
          limit ?
          offset ?
        `,
      ).all(...params).map(rowToToolEvent);
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
      db.prepare(`
        insert into message_traces (trace_id, bot_id, wecom_user_id, conversation_id, runtime, status, started_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(trace_id) do nothing
      `).run(event.trace_id, event.bot_id, event.wecom_user_id, event.conversation_id, event.runtime, event.status, event.started_at);
      return event;
    },

    listMessageTraces(query) {
      const conditions = ["bot_id = ?"];
      const params: Array<string | number> = [requireText(query.bot_id, "bot_id")];
      if (query.wecom_user_id) {
        conditions.push("wecom_user_id = ?");
        params.push(query.wecom_user_id);
      }
      if (query.conversation_id) {
        conditions.push("conversation_id = ?");
        params.push(query.conversation_id);
      }
      params.push(query.limit ?? 50);
      return db.prepare(`
        select trace_id, bot_id, wecom_user_id, conversation_id, runtime, status, started_at, ended_at
        from message_traces where ${conditions.join(" and ")}
        order by started_at desc, rowid desc limit ?
      `).all(...params).map(rowToMessageTrace);
    },

    finishMessageTrace(traceId, status) {
      const endedAt = new Date().toISOString();
      db.prepare("update message_traces set status = ?, ended_at = ? where trace_id = ?")
        .run(status, endedAt, requireText(traceId, "trace_id"));
      const row = db.prepare("select * from message_traces where trace_id = ?").get(traceId);
      return row ? rowToMessageTrace(row) : undefined;
    },

    recordTraceSpan(input) {
      const event: TraceSpanRecord = {
        span_id: `span_${crypto.randomUUID()}`,
        trace_id: requireText(input.trace_id, "trace_id"),
        bot_id: requireText(input.bot_id, "bot_id"),
        wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
        conversation_id: requireText(input.conversation_id, "conversation_id"),
        stage: requireText(input.stage, "stage"),
        status: input.status,
        summary: redactSummary(input.summary ?? {}),
        ...(input.run_id ? { run_id: input.run_id } : {}),
        ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
        ...(input.error_code ? { error_code: input.error_code } : {}),
        created_at: new Date().toISOString(),
      };
      db.prepare(`
        insert into trace_spans (
          span_id, trace_id, bot_id, wecom_user_id, conversation_id, stage, status,
          summary_json, run_id, duration_ms, error_code, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.span_id, event.trace_id, event.bot_id, event.wecom_user_id, event.conversation_id,
        event.stage, event.status, JSON.stringify(event.summary), event.run_id ?? null,
        event.duration_ms ?? null, event.error_code ?? null, event.created_at,
      );
      return event;
    },

    listTraceSpans(query) {
      return db.prepare(`
        select span_id, trace_id, bot_id, wecom_user_id, conversation_id, stage, status,
          summary_json, run_id, duration_ms, error_code, created_at
        from trace_spans where trace_id = ? and bot_id = ? order by created_at asc, rowid asc
      `).all(requireText(query.trace_id, "trace_id"), requireText(query.bot_id, "bot_id"))
        .map(rowToTraceSpan);
    },

    close() {
      db.close();
    },
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists chat_events (
      event_id text primary key,
      bot_id text not null,
      wecom_user_id text not null,
      conversation_id text not null,
      runtime text not null,
      prompt text not null,
      output text not null,
      run_id text not null,
      trace_id text,
      memory_refs_json text not null,
      created_at text not null
    );

    create index if not exists idx_chat_events_bot_id
      on chat_events (bot_id);

    create index if not exists idx_chat_events_conversation_id
      on chat_events (conversation_id);

    create index if not exists idx_chat_events_run_id
      on chat_events (run_id);

    create index if not exists idx_chat_events_created_at
      on chat_events (created_at);

    create index if not exists idx_chat_events_scope
      on chat_events (bot_id, wecom_user_id, conversation_id, created_at desc);


    create table if not exists audit_events (
      event_id text primary key,
      actor_id text not null,
      action text not null,
      target_type text not null,
      target_id text not null,
      metadata_json text not null,
      created_at text not null
    );

    create index if not exists idx_audit_events_target
      on audit_events (target_type, target_id);

    create index if not exists idx_audit_events_action
      on audit_events (action);

    create table if not exists tool_events (
      event_id text primary key,
      bot_id text not null,
      user_id text not null,
      conversation_id text not null,
      tool_name text not null,
      input_summary_json text not null,
      output_summary_json text not null,
      target_type text not null,
      target_id text not null,
      status text not null,
      error_code text,
      duration_ms integer not null,
      trace_id text,
      created_at text not null
    );

    create index if not exists idx_tool_events_bot_id
      on tool_events (bot_id);

    create index if not exists idx_tool_events_conversation_id
      on tool_events (conversation_id);

    create index if not exists idx_tool_events_tool_name
      on tool_events (tool_name);

    create index if not exists idx_tool_events_scope
      on tool_events (bot_id, user_id, conversation_id, created_at desc);


    create table if not exists message_traces (
      trace_id text primary key,
      bot_id text not null,
      wecom_user_id text not null,
      conversation_id text not null,
      runtime text not null,
      status text not null,
      started_at text not null,
      ended_at text
    );

    create index if not exists idx_message_traces_scope
      on message_traces (bot_id, wecom_user_id, conversation_id, started_at desc);

    create table if not exists trace_spans (
      span_id text primary key,
      trace_id text not null,
      bot_id text not null,
      wecom_user_id text not null,
      conversation_id text not null,
      stage text not null,
      status text not null,
      summary_json text not null,
      run_id text,
      duration_ms integer,
      error_code text,
      created_at text not null
    );

    create index if not exists idx_trace_spans_trace
      on trace_spans (trace_id, created_at asc);
  `);

  addColumnIfMissing(db, "chat_events", "trace_id", "text");
  addColumnIfMissing(db, "tool_events", "trace_id", "text");
  db.exec(`
    create index if not exists idx_chat_events_trace_id on chat_events (trace_id);
    create index if not exists idx_tool_events_trace_id on tool_events (trace_id);
  `);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function rowToChatEvent(row: unknown): ChatEventRecord {
  const record = row as Record<string, unknown>;
  return {
    event_id: record.event_id as string,
    bot_id: record.bot_id as string,
    wecom_user_id: record.wecom_user_id as string,
    conversation_id: record.conversation_id as string,
    runtime: record.runtime as string,
    prompt: record.prompt as string,
    output: record.output as string,
    run_id: record.run_id as string,
    ...(typeof record.trace_id === "string" ? { trace_id: record.trace_id } : {}),
    memory_refs: JSON.parse(record.memory_refs_json as string),
    created_at: record.created_at as string,
  };
}

function rowToAuditEvent(row: unknown): AuditEventRecord {
  const record = row as Record<string, unknown>;
  return {
    event_id: record.event_id as string,
    actor_id: record.actor_id as string,
    action: record.action as string,
    target_type: record.target_type as string,
    target_id: record.target_id as string,
    metadata: JSON.parse(record.metadata_json as string),
    created_at: record.created_at as string,
  };
}

function rowToToolEvent(row: unknown): ToolEventRecord {
  const record = row as Record<string, unknown>;
  return {
    event_id: record.event_id as string,
    bot_id: record.bot_id as string,
    user_id: record.user_id as string,
    conversation_id: record.conversation_id as string,
    tool_name: record.tool_name as string,
    input_summary: JSON.parse(record.input_summary_json as string),
    output_summary: JSON.parse(record.output_summary_json as string),
    target_type: record.target_type as string,
    target_id: record.target_id as string,
    status: record.status as ToolEventRecord["status"],
    ...(typeof record.error_code === "string" ? { error_code: record.error_code } : {}),
    duration_ms: record.duration_ms as number,
    ...(typeof record.trace_id === "string" ? { trace_id: record.trace_id } : {}),
    created_at: record.created_at as string,
  };
}

function rowToMessageTrace(row: unknown): MessageTraceRecord {
  const record = row as Record<string, unknown>;
  return {
    trace_id: record.trace_id as string,
    bot_id: record.bot_id as string,
    wecom_user_id: record.wecom_user_id as string,
    conversation_id: record.conversation_id as string,
    runtime: record.runtime as string,
    status: record.status as MessageTraceRecord["status"],
    started_at: record.started_at as string,
    ...(typeof record.ended_at === "string" ? { ended_at: record.ended_at } : {}),
  };
}

function rowToTraceSpan(row: unknown): TraceSpanRecord {
  const record = row as Record<string, unknown>;
  return {
    span_id: record.span_id as string,
    trace_id: record.trace_id as string,
    bot_id: record.bot_id as string,
    wecom_user_id: record.wecom_user_id as string,
    conversation_id: record.conversation_id as string,
    stage: record.stage as string,
    status: record.status as TraceSpanRecord["status"],
    summary: JSON.parse(record.summary_json as string),
    ...(typeof record.run_id === "string" ? { run_id: record.run_id } : {}),
    ...(typeof record.duration_ms === "number" ? { duration_ms: record.duration_ms } : {}),
    ...(typeof record.error_code === "string" ? { error_code: record.error_code } : {}),
    created_at: record.created_at as string,
  };
}
