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
});
