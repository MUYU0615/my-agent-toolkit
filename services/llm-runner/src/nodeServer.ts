import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

export interface FetchApplication {
  fetch(request: Request): Promise<Response>;
}

/** Bridges Fetch responses to Node without buffering response bodies. */
export function createLlmRunnerNodeServer(
  port: number,
  app: FetchApplication,
  serviceName = "llm-runner",
): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      });
      await writeFetchResponse(res, await app.fetch(request));
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "internal server error");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`${serviceName} listening on ${port}`);
  });
  return server;
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.write(Buffer.from(value))) await once(res, "drain");
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}
