import { createServer } from "node:http";
import { createJsonFileProjectSessionStore } from "./store.js";
import { createPrFeedbackRunner } from "./runner.js";

const port = Number.parseInt(process.env.PORT ?? "8920", 10);
const app = createPrFeedbackRunner({
  store: createJsonFileProjectSessionStore(process.env.PR_FEEDBACK_STORE_FILE ?? "/data/project-sessions.json"),
  internalToken: process.env.JIRA_AUTOMATION_INTERNAL_TOKEN ?? "",
  llmRunnerUrl: process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200",
  workspaceRoot: process.env.JIRA_AUTOMATION_WORKSPACE_ROOT ?? "/kiro-workspaces",
  settingsFile: process.env.PR_FEEDBACK_SETTINGS_FILE,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  executionTimeoutMs: Number.parseInt(process.env.PR_FEEDBACK_EXECUTION_TIMEOUT_MS ?? "910000", 10),
  onError(error) { console.error(error instanceof Error ? error.message : "PR feedback error"); },
});
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method, headers: req.headers as HeadersInit, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
server.listen(port, "0.0.0.0", () => console.log(`pr-feedback-runner listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
