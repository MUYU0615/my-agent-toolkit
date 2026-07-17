import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmRunnerNodeServer, type FetchApplication } from "./nodeServer.js";

describe("llm-runner node server", () => {
  const servers: Array<ReturnType<typeof createLlmRunnerNodeServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it("flushes the first streaming chunk before the response completes", async () => {
    const encoder = new TextEncoder();
    const app: FetchApplication = {
      async fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("first\n"));
            setTimeout(() => {
              controller.enqueue(encoder.encode("second\n"));
              controller.close();
            }, 150);
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      },
    };
    const server = createLlmRunnerNodeServer(0, app, "test-runner");
    servers.push(server);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/stream`, { method: "POST" });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("second\n");
    expect((await reader.read()).done).toBe(true);
  });
});
