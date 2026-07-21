import { describe, expect, it, vi } from "vitest";
import { createJiraAutomationRunner } from "./runner.js";

const base = {
  ingressUrl: "http://ingress", internalToken: "internal", llmRunnerUrl: "http://runner",
  repositoryBranch: "main", workspaceRoot: "/tmp/workspaces", mirrorRoot: "/tmp/mirrors",
  flowId: "jira-automation", runtime: "mock" as const,
  pollIntervalMs: 1_000, leaseSeconds: 120, executionTimeoutMs: 1_000,
};

describe("jira automation runner", () => {
  it("does not claim Jira events until the flow is explicitly enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runner = createJiraAutomationRunner({ ...base, enabled: false, fetch });
    await runner.poll();
    expect(fetch).not.toHaveBeenCalled();
    expect(runner.status()).toMatchObject({ enabled: false, active: false });
  });

  it("polls the ingress with its internal credential when enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const runner = createJiraAutomationRunner({ ...base, enabled: true, fetch });
    await runner.poll();
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://ingress/internal/events/lease");
    expect(request.headers.get("authorization")).toBe("Bearer internal");
  });
});
