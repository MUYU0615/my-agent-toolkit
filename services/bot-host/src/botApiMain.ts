import { createNodeServer } from "./nodeServer.js";
import type { RestartInitializationResult } from "./server.js";
import { createBotHostServer } from "./server.js";

export function startBotApiMain(): void {
  const port = Number.parseInt(process.env.PORT ?? "8400", 10);
  const wecomWorkerUrl = process.env.WECOM_WORKER_URL ?? "http://wecom-worker:8401";
  const app = createBotHostServer({
    dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
    llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
    capabilityRunnerUrl: process.env.CAPABILITY_RUNNER_URL,
    logServiceUrl: process.env.LOG_SERVICE_URL,
    credentialBindPublicUrl: process.env.CREDENTIAL_BIND_PUBLIC_URL,
    credentialInternalToken: process.env.USER_CREDENTIALS_INTERNAL_TOKEN,
    fetch,
    initializationController: {
      async restartInitialization(input): Promise<RestartInitializationResult> {
        const response = await fetch(
          `${wecomWorkerUrl}/internal/bots/${encodeURIComponent(input.botId)}/initialization/restart`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              admin_wecom_user_id: input.adminWeComUserId,
            }),
          },
        );
        const payload = await response.json() as
          | RestartInitializationResult
          | { error?: string };
        if (!response.ok) {
          throw new Error(
            "error" in payload && typeof payload.error === "string"
              ? payload.error
              : "failed to restart initialization",
          );
        }
        if (
          !("bot_id" in payload)
          || !("admin_wecom_user_id" in payload)
          || !("output" in payload)
        ) {
          throw new Error("failed to restart initialization");
        }
        return payload;
      },
    },
  });

  createNodeServer(port, app, "bot-host api");
}

startBotApiMain();
