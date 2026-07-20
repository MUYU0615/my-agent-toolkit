import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JiraWebhookEvent {
  event_id: string;
  issue_key: string;
  event_type: string;
  received_at: string;
  payload: Record<string, unknown>;
}

export interface JiraWebhookEventStore {
  record(event: JiraWebhookEvent): Promise<{ duplicate: boolean; event: JiraWebhookEvent }>;
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
        events.set(event.event_id, event);
        await persist();
        result = { duplicate: false, event };
      });
      await serial;
      return result;
    },
  };
}
