import { createNodeServer } from "./nodeServer.js";
import { createBotHostSupervisor } from "./server.js";
import { WeComLongConnectionClient } from "./wecomClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function createWeComWorkerApp() {
  const hostConfig = {
    dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
    llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
    capabilityRunnerUrl: process.env.CAPABILITY_RUNNER_URL,
    logServiceUrl: process.env.LOG_SERVICE_URL,
    fetch,
  };

  const supervisor = createBotHostSupervisor({
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
  });

  return {
    supervisor,
    app: {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/health") {
          return jsonResponse({
            service: "wecom-worker",
            status: "ok",
          });
        }

        if (request.method === "POST" && url.pathname === "/internal/wecom-runtime/sync") {
          try {
            await supervisor.sync?.();
            return jsonResponse({ synced: true });
          } catch (error) {
            return jsonResponse({
              error: error instanceof Error ? error.message : "failed to sync runtime",
            }, 500);
          }
        }

        return jsonResponse({ error: "not found" }, 404);
      },
    },
  };
}

export function startWeComWorkerMain(): void {
  const port = Number.parseInt(process.env.PORT ?? "8401", 10);
  const { app, supervisor } = createWeComWorkerApp();

  createNodeServer(port, app, "bot-host worker");

  supervisor.start().catch((error) => {
    console.error("failed to start WeCom worker", error);
    process.exitCode = 1;
  });
}

startWeComWorkerMain();
