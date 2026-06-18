import type { BotRuntime } from "../types.js";

export type MemorySearchResult = {
  chunk_id: string;
  content: string;
  score: number;
  tags: string[];
  tier: string;
  title: string;
  filename: string;
  created_at: string;
};

export class MemoryClient {
  private baseUrl: string;
  private namespace: string;
  private configEnabled: boolean;

  constructor(runtime: BotRuntime) {
    const mem = runtime.config.memory;
    const url = runtime.env[mem?.api_url_env ?? "MEMORY_API_URL"] ?? "";
    const ns = runtime.env[mem?.namespace_env ?? "MEMORY_NAMESPACE"] ?? "default";
    this.baseUrl = url.replace(/\/$/, "");
    this.namespace = ns;
    this.configEnabled = mem?.enabled === true;
  }

  get enabled(): boolean {
    return this.configEnabled && !!this.baseUrl;
  }

  async store(content: string, tags: string[] = [], tier: string = "core"): Promise<string | null> {
    const res = await this.post("/api/v1/memories", {
      namespace: this.namespace, content, tags, tier, source: "text",
    });
    return res?.id ?? null;
  }

  async storeShared(content: string, tags: string[] = []): Promise<string | null> {
    const res = await this.post("/api/v1/memories", {
      namespace: "shared", content, tags, tier: "core", source: "text",
    });
    return res?.id ?? null;
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    const res = await this.post("/api/v1/memories/search", {
      namespace: this.namespace, query, limit: limit ?? 5, include_shared: true,
    });
    return res?.results ?? [];
  }

  async fetchUrl(url: string, tags: string[] = []): Promise<string | null> {
    const res = await this.post("/api/v1/memories/fetch", {
      namespace: this.namespace, url, tags, tier: "core",
    });
    return res?.id ?? null;
  }

  async scan(directory: string, tags: string[] = []): Promise<number> {
    const res = await this.post("/api/v1/memories/scan", {
      namespace: this.namespace, directory, tags, tier: "core", incremental: true,
    });
    return res?.scanned ?? 0;
  }

  async forget(tags: string[]): Promise<number> {
    const res = await this.post("/api/v1/memories/delete", {
      namespace: this.namespace, tags,
    });
    return res?.deleted_count ?? 0;
  }

  async stats(): Promise<{ total_memories: number; total_chunks: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/memories/stats?namespace=${this.namespace}`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  private async post(path: string, body: unknown): Promise<any> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
}
