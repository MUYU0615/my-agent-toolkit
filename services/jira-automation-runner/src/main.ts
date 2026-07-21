import { createServer } from "node:http";
import { createJiraAutomationRunner } from "./runner.js";

const port = positiveInteger(process.env.PORT, 8910);
const runner = createJiraAutomationRunner({
  ingressUrl: (process.env.JIRA_WEBHOOK_INGRESS_URL ?? "http://jira-webhook-ingress:9000").replace(/\/+$/, ""),
  internalToken: process.env.JIRA_AUTOMATION_INTERNAL_TOKEN ?? "",
  llmRunnerUrl: (process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200").replace(/\/+$/, ""),
  enabled: process.env.JIRA_AUTOMATION_ENABLED === "true",
  repositoryUrl: process.env.JIRA_AUTOMATION_REPOSITORY_URL?.trim(), repositoryBranch: process.env.JIRA_AUTOMATION_REPOSITORY_BRANCH?.trim() || "main", githubToken: process.env.GITHUB_TOKEN?.trim(),
  workspaceRoot: process.env.JIRA_AUTOMATION_WORKSPACE_ROOT ?? "/kiro-workspaces", mirrorRoot: process.env.JIRA_AUTOMATION_MIRROR_ROOT ?? "/data/repositories",
  flowId: "jira-automation", runtime: (process.env.JIRA_AUTOMATION_RUNTIME === "kiro" || process.env.JIRA_AUTOMATION_RUNTIME === "mock") ? process.env.JIRA_AUTOMATION_RUNTIME : "claude-code",
  pollIntervalMs: positiveInteger(process.env.JIRA_AUTOMATION_POLL_MS, 1000), leaseSeconds: positiveInteger(process.env.JIRA_AUTOMATION_LEASE_SECONDS, 1200), executionTimeoutMs: positiveInteger(process.env.JIRA_AUTOMATION_EXECUTION_TIMEOUT_MS, 910000),
  settingsFile: process.env.JIRA_AUTOMATION_SETTINGS_FILE,
  skillsRoot: process.env.JIRA_AUTOMATION_SKILLS_ROOT ?? "/automation-config/skills",
  runtimeEnv: process.env.JIRA_AUTOMATION_RUNTIME_ENV,
  onError(error) { console.error(error instanceof Error ? error.message : "jira automation error"); },
});
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ service: "jira-automation-runner", status: "ok", ...runner.status() }));
});
server.listen(port, "0.0.0.0", () => { runner.start(); console.log(`jira-automation-runner listening on ${port}`); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { runner.stop(); server.close(() => process.exit(0)); });
function positiveInteger(value: string | undefined, fallback: number): number { if (!value) return fallback; const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer: ${value}`); return parsed; }
