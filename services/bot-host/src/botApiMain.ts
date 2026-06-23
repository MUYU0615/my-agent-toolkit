import { createNodeServer } from "./nodeServer.js";
import { createBotHostServer } from "./server.js";

export function startBotApiMain(): void {
  const port = Number.parseInt(process.env.PORT ?? "8400", 10);
  const app = createBotHostServer({
    dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
    llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
    logServiceUrl: process.env.LOG_SERVICE_URL,
    fetch,
  });

  createNodeServer(port, app, "bot-host api");
}

startBotApiMain();
