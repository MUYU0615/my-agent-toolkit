import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLlmStreamFetch,
  DEFAULT_LLM_STREAM_BODY_TIMEOUT_MS,
} from "./llmStreamFetch.js";

describe("LLM stream fetch", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it("uses a body timeout longer than the CLI execution limit", () => {
    expect(DEFAULT_LLM_STREAM_BODY_TIMEOUT_MS).toBe(16 * 60_000);
  });

  it("keeps an internal NDJSON response open across an idle interval", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"type":"run"}\n');
      setTimeout(() => response.end('{"type":"done"}\n'), 40);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const fetchStream = createLlmStreamFetch(150);
    const response = await fetchStream(`http://127.0.0.1:${address.port}/v1/chat/stream`);

    expect(await response.text()).toBe('{"type":"run"}\n{"type":"done"}\n');
  });
});
