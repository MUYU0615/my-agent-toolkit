import { createServer } from "node:http";
import { createControlApiServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "8600", 10);
const app = createControlApiServer({
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  logServiceUrl: process.env.LOG_SERVICE_URL ?? "http://log-service:8500",
  botHostUrl: process.env.BOT_HOST_URL ?? "http://bot-api:8400",
  fetch,
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
  console.log(`control-api listening on ${port}`);
});
