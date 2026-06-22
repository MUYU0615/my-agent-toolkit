import { createServer } from "node:http";
import { createBotHostServer, createBotHostSupervisor } from "./server.js";
import { WeComLongConnectionClient } from "./wecomClient.js";

const port = Number.parseInt(process.env.PORT ?? "8400", 10);
const hostConfig = {
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
  logServiceUrl: process.env.LOG_SERVICE_URL,
  fetch,
};

const worker = process.env.WECOM_ENABLED === "true"
  ? createBotHostSupervisor({
    ...hostConfig,
    pollIntervalMs: Number.parseInt(
      process.env.WECOM_RUNTIME_SYNC_INTERVAL_MS ?? "5000",
      10,
    ),
    createWeComClient(input) {
      return new WeComLongConnectionClient({
        botId: input.botId,
        secret: input.secret,
      });
    },
  })
  : undefined;
const app = createBotHostServer({
  ...hostConfig,
  initializationController: worker?.restartInitialization
    ? {
      restartInitialization(input) {
        return worker.restartInitialization!(input);
      },
    }
    : undefined,
  runtimeController: worker?.sync
    ? {
      sync() {
        return worker.sync!();
      },
    }
    : undefined,
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
  console.log(`bot-host listening on ${port}`);
});

worker?.start().catch((error) => {
  console.error("failed to start WeCom worker", error);
  process.exitCode = 1;
});
