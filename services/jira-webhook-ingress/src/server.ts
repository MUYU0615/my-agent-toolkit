import { createHash, timingSafeEqual } from "node:crypto";
import type { JiraWebhookEventStore } from "./eventStore.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface JiraWebhookIngressConfig {
  eventStore: JiraWebhookEventStore;
  sharedSecret?: string;
  internalToken?: string;
  now?: () => Date;
}

export interface JiraWebhookIngressServer {
  fetch(request: Request): Promise<Response>;
}

export function createJiraWebhookIngressServer(config: JiraWebhookIngressConfig): JiraWebhookIngressServer {
  const sharedSecret = config.sharedSecret?.trim();
  const now = config.now ?? (() => new Date());
  return {
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ service: "jira-webhook-ingress", status: "ok" });
      }
      if (request.method === "POST" && url.pathname === "/internal/events/lease") {
        if (!hasValidInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await request.json().catch(() => undefined) as { worker_id?: unknown; lease_seconds?: unknown } | undefined;
        const workerId = typeof body?.worker_id === "string" ? body.worker_id.trim() : "";
        const leaseSeconds = typeof body?.lease_seconds === "number" ? body.lease_seconds : 0;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
          return Response.json({ error: "invalid lease request" }, { status: 400 });
        }
        const event = await config.eventStore.lease(workerId, leaseSeconds, now());
        return event ? Response.json({ event }) : new Response(null, { status: 204 });
      }
      const completeMatch = url.pathname.match(/^\/internal\/events\/([^/]+)\/complete$/);
      if (request.method === "POST" && completeMatch) {
        if (!hasValidInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await request.json().catch(() => undefined) as { lease_id?: unknown; status?: unknown; error?: unknown } | undefined;
        const leaseId = typeof body?.lease_id === "string" ? body.lease_id : "";
        const status = body?.status === "succeeded" || body?.status === "failed" ? body.status : undefined;
        if (!leaseId || !status) return Response.json({ error: "invalid completion request" }, { status: 400 });
        const event = await config.eventStore.complete(decodeURIComponent(completeMatch[1]), leaseId, status, now(), typeof body?.error === "string" ? body.error.slice(0, 4000) : undefined);
        return event ? Response.json({ event }) : Response.json({ error: "lease not found" }, { status: 409 });
      }
      if (request.method !== "POST" || url.pathname !== "/webhooks/jira") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (sharedSecret && !hasValidSecret(request, sharedSecret)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: "payload is too large" }, { status: 413 });
      }
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: "payload is too large" }, { status: 413 });
      }
      const payload = parsePayload(rawBody);
      if (!payload) return Response.json({ error: "body must be a JSON object" }, { status: 400 });
      const issueKey = findIssueKey(payload);
      if (!issueKey) {
        return Response.json({ error: "Jira issue key is required" }, { status: 400 });
      }
      const eventType = findText(payload, ["webhookEvent", "event_type", "event", "type"]) ?? "issue_updated";
      const sourceEventId = request.headers.get("x-jira-webhook-id")
        ?? findText(payload, ["webhook_id", "event_id", "id"]);
      const eventId = sourceEventId?.trim() || createEventId(issueKey, eventType, payload, rawBody);
      const recorded = await config.eventStore.record({
        event_id: eventId,
        issue_key: issueKey,
        event_type: eventType,
        received_at: now().toISOString(),
        payload,
      });
      return Response.json({
        accepted: !recorded.duplicate,
        duplicate: recorded.duplicate,
        event_id: recorded.event.event_id,
        issue_key: recorded.event.issue_key,
        status: "pending_route",
      }, { status: recorded.duplicate ? 200 : 202 });
    },
  };
}

function hasValidSecret(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  const provided = request.headers.get("x-agentlattice-webhook-secret")
    ?? request.headers.get("x-jira-webhook-secret")
    ?? (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined);
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function parsePayload(rawBody: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function findIssueKey(payload: Record<string, unknown>): string | undefined {
  const issue = payload.issue;
  if (issue && typeof issue === "object" && !Array.isArray(issue)) {
    const key = (issue as Record<string, unknown>).key;
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  return findText(payload, ["issue_key", "issueKey", "key"]);
}

function findText(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function createEventId(
  issueKey: string,
  eventType: string,
  payload: Record<string, unknown>,
  rawBody: string,
): string {
  const updated = findText(payload, ["timestamp", "updated", "update_time", "time"])
    ?? findNestedText(payload, ["issue", "fields", "updated"])
    ?? createHash("sha256").update(rawBody, "utf8").digest("hex");
  return `jira:${issueKey}:${eventType}:${updated}`;
}

function hasValidInternalToken(request: Request, expected: string | undefined): boolean {
  const token = expected?.trim();
  if (!token) return false;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(provided) && provided === token;
}

function findNestedText(payload: Record<string, unknown>, path: string[]): string | undefined {
  let value: unknown = payload;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
