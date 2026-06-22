import {
  parseMcpCapabilityConfig,
  type DocumentCreateInput,
  type McpCapabilityConfig,
  type McpScope,
  type McpTier,
} from "@my-agent-toolkit/contracts";

export interface DataServiceClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface DataServiceClient {
  createDocument(input: DocumentCreateInput): Promise<Record<string, unknown>>;
  createMemory(input: CreateMemoryInput): Promise<Record<string, unknown>>;
  getMemoryStats(input: MemoryStatsInput): Promise<Record<string, unknown>>;
  getMcpCapabilityConfig(botId: string): Promise<McpCapabilityConfig>;
}

export interface CreateMemoryInput {
  scope: McpScope;
  owner_id: string;
  content: string;
  tier?: McpTier;
  source_type?: string;
  source_conversation_id?: string;
  source_message_id?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
  tags?: string[];
}

export interface MemoryStatsInput {
  scope?: McpScope;
  owner_id?: string;
}

export function createDataServiceClient(
  options: DataServiceClientOptions,
): DataServiceClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async createDocument(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/documents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async createMemory(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async getMemoryStats(input) {
      const url = new URL(`${baseUrl}/internal/memory-stats`);
      appendOptionalSearchParam(url, "scope", input.scope);
      appendOptionalSearchParam(url, "owner_id", input.owner_id);
      return requestJson(fetchImpl, url.toString(), {
        method: "GET",
      });
    },

    async getMcpCapabilityConfig(botId) {
      const body = await requestJson(
        fetchImpl,
        `${baseUrl}/v1/bots/${encodeURIComponent(botId)}/mcp-capabilities/config`,
        {
          method: "GET",
        },
      );
      return parseMcpCapabilityConfig(body);
    },
  };
}

function appendOptionalSearchParam(
  url: URL,
  name: string,
  value: string | undefined,
): void {
  if (value) {
    url.searchParams.set(name, value);
  }
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
      : `data-service request failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}
