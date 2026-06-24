import { createNodeServer } from "./nodeServer.js";
import { type RestartInitializationResult } from "./server.js";
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

function healthResponse(service: string): {
  service: string;
  status: "ok";
  git_sha: string;
  build_time: string;
} {
  return {
    service,
    status: "ok",
    git_sha: process.env.APP_BUILD_SHA ?? "unknown",
    build_time: process.env.APP_BUILD_TIME ?? "unknown",
  };
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
          return jsonResponse(healthResponse("wecom-worker"));
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

        const restartInitializationMatch = url.pathname.match(
          /^\/internal\/bots\/([^/]+)\/initialization\/restart$/,
        );
        if (request.method === "POST" && restartInitializationMatch) {
          try {
            const body = await request.json() as { admin_wecom_user_id?: unknown };
            if (typeof body.admin_wecom_user_id !== "string" || body.admin_wecom_user_id.trim() === "") {
              return jsonResponse({ error: "admin_wecom_user_id is required" }, 400);
            }
            const result = await supervisor.restartInitialization?.({
              botId: restartInitializationMatch[1],
              adminWeComUserId: body.admin_wecom_user_id,
            });
            if (!result) {
              return jsonResponse({ error: "initialization controller is not configured" }, 503);
            }
            return jsonResponse(result satisfies RestartInitializationResult);
          } catch (error) {
            return jsonResponse({
              error: error instanceof Error ? error.message : "failed to restart initialization",
            }, 400);
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
