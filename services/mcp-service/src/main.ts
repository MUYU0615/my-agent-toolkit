import { createServer } from "node:http";
import {
  createMcpServiceServer,
  parseAllowedDirectoryRefs,
} from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "8700", 10);
const runnerSecret = process.env.MCP_RUNNER_SECRET ?? "";
const app = createMcpServiceServer({
  runnerSecret,
  dataServiceUrl: process.env.DATA_SERVICE_URL,
  memoryBackendUrl: process.env.MEMORY_BACKEND_URL,
  capabilityRunnerUrl: process.env.CAPABILITY_RUNNER_URL,
  allowedDirectoryRefs: parseAllowedDirectoryRefs(process.env.MCP_ALLOWED_DIRECTORY_REFS ?? ""),
});

const server = createServer(async (req, res) => {
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

  const response = await app.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mcp-service listening on ${port}`);
});
