import type { DocumentCreateInput } from "@my-agent-toolkit/contracts";

export interface DataServiceClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface DataServiceClient {
  createDocument(input: DocumentCreateInput): Promise<Record<string, unknown>>;
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
      : `data-service request failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}
