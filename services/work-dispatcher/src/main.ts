import { createServer } from "node:http";
import { createWorkDispatcher } from "./dispatcher.js";
import { createWorkDispatcherServer } from "./server.js";

const port = positiveInteger(process.env.PORT, 8900);
const dispatcher = createWorkDispatcher({
  dataServiceUrl: (process.env.DATA_SERVICE_URL ?? "http://data-service:8300").replace(/\/+$/, ""),
  llmRunnerUrl: (process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200").replace(/\/+$/, ""),
  wecomWorkerUrl: process.env.WECOM_WORKER_URL?.replace(/\/+$/, ""),
  internalToken: process.env.DATA_SERVICE_INTERNAL_TOKEN ?? "",
  workerId: process.env.WORK_DISPATCHER_ID?.trim() || "work-dispatcher-1",
  pollIntervalMs: positiveInteger(process.env.WORK_DISPATCHER_POLL_MS, 1_000),
  maxConcurrency: positiveInteger(process.env.WORK_DISPATCHER_MAX_CONCURRENCY, 4),
  leaseSeconds: positiveInteger(process.env.WORK_DISPATCHER_LEASE_SECONDS, 1_200),
  executionTimeoutMs: positiveInteger(process.env.WORK_DISPATCHER_EXECUTION_TIMEOUT_MS, 910_000),
  fetch,
  onError(error) {
    console.error(error instanceof Error ? error.message : "work dispatcher error");
  },
});
const app = createWorkDispatcherServer(dispatcher);

const server = createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
  const response = await app.fetch(new Request(url, { method: req.method }));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "0.0.0.0", () => {
  dispatcher.start();
  console.log(`work-dispatcher listening on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    dispatcher.stop();
    server.close(() => process.exit(0));
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer: ${value}`);
  return parsed;
}
