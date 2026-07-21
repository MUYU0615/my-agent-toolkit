import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface JiraWebhookEvent {
  event_id: string;
  issue_key: string;
  event_type: string;
  received_at: string;
  payload: Record<string, unknown>;
  status?: "pending" | "running" | "succeeded" | "failed";
  attempt_count?: number;
  lease_id?: string;
  lease_expires_at?: string;
  completed_at?: string;
  error?: string;
}

export interface JiraWebhookEventStore {
  record(event: JiraWebhookEvent): Promise<{ duplicate: boolean; event: JiraWebhookEvent }>;
  lease(workerId: string, leaseSeconds: number, now: Date): Promise<JiraWebhookEvent | undefined>;
  complete(eventId: string, leaseId: string, status: "succeeded" | "failed", now: Date, error?: string): Promise<JiraWebhookEvent | undefined>;
}

export function createJsonFileJiraWebhookEventStore(filePath: string): JiraWebhookEventStore {
  let loaded = false;
  let events = new Map<string, JiraWebhookEvent>();
  let serial = Promise.resolve();

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as { events?: JiraWebhookEvent[] };
      events = new Map((parsed.events ?? []).map((event) => [event.event_id, event]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const persist = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    const tempFile = `${filePath}.tmp`;
    await writeFile(tempFile, JSON.stringify({ events: [...events.values()] }), { mode: 0o600 });
    await rename(tempFile, filePath);
  };

  return {
    async record(event) {
      let result!: { duplicate: boolean; event: JiraWebhookEvent };
      serial = serial.then(async () => {
        await load();
        const existing = events.get(event.event_id);
        if (existing) {
          result = { duplicate: true, event: existing };
          return;
        }
        events.set(event.event_id, { ...event, status: "pending", attempt_count: 0 });
        await persist();
        result = { duplicate: false, event: events.get(event.event_id)! };
      });
      await serial;
      return result;
    },
    async lease(workerId, leaseSeconds, now) {
      let result: JiraWebhookEvent | undefined;
      serial = serial.then(async () => {
        await load();
        const current = [...events.values()].find((event) => event.status === "pending"
          || (event.status === "running" && Date.parse(event.lease_expires_at ?? "") <= now.getTime()));
        if (!current) return;
        const leased: JiraWebhookEvent = {
          ...current,
          status: "running",
          attempt_count: (current.attempt_count ?? 0) + 1,
          lease_id: `${workerId}:${randomUUID()}`,
          lease_expires_at: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
          error: undefined,
        };
        events.set(leased.event_id, leased);
        await persist();
        result = leased;
      });
      await serial;
      return result;
    },
    async complete(eventId, leaseId, status, now, error) {
      let result: JiraWebhookEvent | undefined;
      serial = serial.then(async () => {
        await load();
        const current = events.get(eventId);
        if (!current || current.status !== "running" || current.lease_id !== leaseId) return;
        const completed: JiraWebhookEvent = {
          ...current,
          status,
          completed_at: now.toISOString(),
          lease_id: undefined,
          lease_expires_at: undefined,
          ...(error ? { error } : { error: undefined }),
        };
        events.set(eventId, completed);
        await persist();
        result = completed;
      });
      await serial;
      return result;
    },
  };
}
