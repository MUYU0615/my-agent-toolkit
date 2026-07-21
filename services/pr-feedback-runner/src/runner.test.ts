import { createHash, createHmac, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createPrFeedbackRunner } from "./runner.js";
import { createJsonFileProjectSessionStore } from "./store.js";

describe("pr feedback runner", () => {
  it("binds a persistent project session then resumes it from a signed GitHub PR comment", async () => {
    const root = join(tmpdir(), `pr-feedback-${randomUUID()}`);
    const secret = "local-test-secret";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ output: "resumed", provider_session_id: "11111111-1111-4111-8111-111111111111" }));
    const app = createPrFeedbackRunner({
      store: createJsonFileProjectSessionStore(join(root, "state.json")), internalToken: "internal", llmRunnerUrl: "http://runner", workspaceRoot: root,
      webhookSecret: secret, executionTimeoutMs: 1_000, fetch,
    });
    const workspace = join(root, "system-flows", "jira-automation", "projects", "jira-HIM-1");
    const registered = await app.fetch(new Request("http://localhost/internal/project-sessions", {
      method: "POST", headers: { authorization: "Bearer internal", "content-type": "application/json" },
      body: JSON.stringify({ project_id: "jira-HIM-1", jira_key: "HIM-1", flow_id: "jira-automation", workspace_id: "jira-HIM-1", workspace_root: workspace, repository: "https://github.com/example/private", branch: "bot/HIM-1", runtime: "kiro", provider_session_id: "00000000-0000-4000-8000-000000000000", head_sha: "abc" }),
    }));
    expect(registered.status).toBe(201);
    const bound = await app.fetch(new Request("http://localhost/internal/project-sessions/jira-HIM-1/bind-pr", {
      method: "POST", headers: { authorization: "Bearer internal", "content-type": "application/json" }, body: JSON.stringify({ repository_id: "123", pr_number: 42 }),
    }));
    expect(bound.status).toBe(200);
    const body = JSON.stringify({ repository: { id: 123 }, issue: { number: 42, pull_request: { url: "x" } }, comment: { id: 99, body: "修复边界情况" }, sender: { type: "User" } });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = await app.fetch(new Request("http://localhost/webhooks/github", { method: "POST", headers: { "x-github-event": "issue_comment", "x-github-delivery": createHash("sha256").update(body).digest("hex"), "x-hub-signature-256": signature }, body }));
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0][0] as Request;
    expect(await request.json()).toMatchObject({ workspace_id: "jira-HIM-1", provider_session_id: "00000000-0000-4000-8000-000000000000", run_id: "pr-jira-HIM-1-99" });
    await rm(root, { recursive: true, force: true });
  });
});
