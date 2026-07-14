import { describe, expect, it, vi } from "vitest";
import { createProjectClient } from "./projectClient.js";

describe("project client", () => {
  it("forwards trusted context and authenticates to capability-runner", async () => {
    const requests: Request[] = [];
    const client = createProjectClient({
      baseUrl: "http://capability-runner:8700/",
      token: "runner-secret",
      fetch: vi.fn(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return Response.json({ path: "projects/im-test-hub", reused: false });
      }),
    });

    await expect(client.ensure({
      bot_id: "qa-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    }, "im-test-hub")).resolves.toEqual({
      path: "projects/im-test-hub",
      reused: false,
    });

    expect(requests[0].url).toBe(
      "http://capability-runner:8700/internal/bots/qa-bot/projects/ensure",
    );
    expect(requests[0].headers.get("x-project-runner-token")).toBe("runner-secret");
    await expect(requests[0].json()).resolves.toEqual({
      user_id: "user-a",
      conversation_id: "conv-1",
      project_key: "im-test-hub",
    });
  });

  it("sends the current user identity to project endpoints", async () => {
    const requests: Request[] = [];
    const client = createProjectClient({
      baseUrl: "http://capability-runner:8700",
      token: "runner-secret",
      fetch: vi.fn(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return Response.json({ base_commit: "a".repeat(40) });
      }),
    });
    const context = {
      bot_id: "qa-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro" as const,
    };

    await client.inspect(context, "im-test-hub");
    await client.read(context, { projectKey: "im-test-hub", path: "README.md", startLine: 2 });
    await client.search(context, { projectKey: "im-test-hub", query: "SDK", path: "tests" });

    expect(requests.map((request) => request.url)).toEqual([
      "http://capability-runner:8700/internal/bots/qa-bot/projects/inspect",
      "http://capability-runner:8700/internal/bots/qa-bot/projects/read",
      "http://capability-runner:8700/internal/bots/qa-bot/projects/search",
    ]);
    await expect(requests[0].json()).resolves.toEqual({
      user_id: "user-a",
      project_key: "im-test-hub",
    });
    await expect(requests[1].json()).resolves.toEqual({
      user_id: "user-a",
      project_key: "im-test-hub",
      path: "README.md",
      start_line: 2,
    });
    await expect(requests[2].json()).resolves.toEqual({
      user_id: "user-a",
      project_key: "im-test-hub",
      query: "SDK",
      path: "tests",
    });
  });
});
