import { describe, expect, it } from "vitest";
import type { JiraWebhookEvent, JiraWebhookEventStore } from "./eventStore.js";
import { createJiraWebhookIngressServer } from "./server.js";

function createMemoryStore(): JiraWebhookEventStore {
  const events = new Map<string, JiraWebhookEvent>();
  return {
    async record(event) {
      const existing = events.get(event.event_id);
      if (existing) return { duplicate: true, event: existing };
      events.set(event.event_id, event);
      return { duplicate: false, event };
    },
    async lease() { return undefined; },
    async complete() { return undefined; },
  };
}

describe("jira webhook ingress", () => {
  it("accepts a Jira event once and returns a duplicate acknowledgement thereafter", async () => {
    const app = createJiraWebhookIngressServer({ eventStore: createMemoryStore() });
    const request = () => new Request("http://localhost/webhooks/jira", {
      method: "POST",
      body: JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: "1720000000000", issue: { key: "HIM-22187" } }),
    });
    const first = await app.fetch(request());
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ accepted: true, duplicate: false, issue_key: "HIM-22187" });
    const duplicate = await app.fetch(request());
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ accepted: false, duplicate: true, issue_key: "HIM-22187" });
  });

  it("requires the configured forwarding secret", async () => {
    const app = createJiraWebhookIngressServer({ eventStore: createMemoryStore(), sharedSecret: "secret" });
    const response = await app.fetch(new Request("http://localhost/webhooks/jira", {
      method: "POST",
      body: JSON.stringify({ issue: { key: "HIM-22187" } }),
    }));
    expect(response.status).toBe(401);
  });

  it("leases and completes an accepted event through the internal runner API", async () => {
    const events = new Map<string, JiraWebhookEvent>();
    const store: JiraWebhookEventStore = {
      async record(event) { events.set(event.event_id, event); return { duplicate: false, event }; },
      async lease(workerId) {
        const event = [...events.values()][0];
        if (!event) return undefined;
        const leased = { ...event, status: "running" as const, lease_id: `${workerId}:lease` };
        events.set(event.event_id, leased);
        return leased;
      },
      async complete(eventId, leaseId, status) {
        const event = events.get(eventId);
        if (!event || event.lease_id !== leaseId) return undefined;
        const completed = { ...event, status, lease_id: undefined };
        events.set(eventId, completed);
        return completed;
      },
    };
    const app = createJiraWebhookIngressServer({ eventStore: store, internalToken: "internal" });
    await app.fetch(new Request("http://localhost/webhooks/jira", { method: "POST", body: JSON.stringify({ issue_key: "HIM-22187", time: "2026-07-21T00:00:00Z" }) }));
    const leased = await app.fetch(new Request("http://localhost/internal/events/lease", {
      method: "POST", headers: { authorization: "Bearer internal" }, body: JSON.stringify({ worker_id: "automation-1", lease_seconds: 120 }),
    }));
    const payload = await leased.json() as { event: JiraWebhookEvent };
    expect(payload.event.issue_key).toBe("HIM-22187");
    const completed = await app.fetch(new Request(`http://localhost/internal/events/${encodeURIComponent(payload.event.event_id)}/complete`, {
      method: "POST", headers: { authorization: "Bearer internal" }, body: JSON.stringify({ lease_id: payload.event.lease_id, status: "succeeded" }),
    }));
    expect(completed.status).toBe(200);
  });
});
