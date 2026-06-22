import type { McpScope, McpTier } from "@my-agent-toolkit/contracts";

export interface MemoryBackendClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface StoreMemoryBackendInput {
  scope: McpScope;
  owner_id: string;
  content: string;
  tags?: string[];
  tier?: McpTier;
  source_type?: string;
}

export interface IngestFileInput {
  scope: McpScope;
  owner_id: string;
  filename: string;
  content: string | Blob;
  tags?: string[];
  tier?: McpTier;
  source_kind?: "document" | "memory";
  source_id?: string;
}

export interface FetchUrlInput {
  scope: McpScope;
  owner_id: string;
  url: string;
  tags?: string[];
  tier?: McpTier;
  source_kind?: "document" | "memory";
  source_id?: string;
}

export interface ScanDirectoryInput {
  scope: McpScope;
  owner_id: string;
  directory_ref: string;
  directory: string;
  tags?: string[];
  tier?: McpTier;
  source_kind?: "document" | "memory";
}

export interface SearchBackendInput {
  query: string;
  scopes: McpScope[];
  owner_ids: string[];
  sources?: Array<"documents" | "memories">;
  tags?: string[];
  limit?: number;
}

export interface MemoryBackendClient {
  storeMemory(input: StoreMemoryBackendInput): Promise<Record<string, unknown>>;
  search(input: SearchBackendInput): Promise<Record<string, unknown>>;
  ingestFile(input: IngestFileInput): Promise<Record<string, unknown>>;
  fetchUrl(input: FetchUrlInput): Promise<Record<string, unknown>>;
  scanDirectory(input: ScanDirectoryInput): Promise<Record<string, unknown>>;
  deleteMemory(memoryId: string): Promise<Record<string, unknown>>;
}

export function createMemoryBackendClient(
  options: MemoryBackendClientOptions,
): MemoryBackendClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async storeMemory(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async search(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async ingestFile(input) {
      const form = new FormData();
      form.set("scope", input.scope);
      form.set("owner_id", input.owner_id);
      form.set("tags", (input.tags ?? []).join(","));
      form.set("tier", input.tier ?? "core");
      form.set("source_kind", input.source_kind ?? "memory");
      form.set("source_id", input.source_id ?? "");
      const blob = input.content instanceof Blob
        ? input.content
        : new Blob([input.content], { type: "text/plain" });
      form.set("file", blob, input.filename);
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories/ingest-file`, {
        method: "POST",
        body: form,
      });
    },

    async fetchUrl(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories/fetch-url`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async scanDirectory(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: input.scope,
          owner_id: input.owner_id,
          directory: input.directory,
          tags: input.tags ?? [],
          tier: input.tier ?? "core",
          incremental: true,
          source_kind: input.source_kind ?? "memory",
        }),
      });
    },

    async deleteMemory(memoryId) {
      return requestJson(
        fetchImpl,
        `${baseUrl}/internal/v1/memories/${encodeURIComponent(memoryId)}`,
        { method: "DELETE" },
      );
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : `memory backend request failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}
