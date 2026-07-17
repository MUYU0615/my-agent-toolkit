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

    await client.publish({
      bot_id: "qa-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    }, {
      projectKey: "im-test-hub",
      branch: "bot/add-case",
      commitMessage: "test: add case",
    });
    expect(requests[0].url).toBe(
      "http://capability-runner:8700/internal/bots/qa-bot/projects/publish",
    );
    expect(requests[0].headers.get("x-project-runner-token")).toBe("runner-secret");
    await expect(requests[0].json()).resolves.toEqual({
      user_id: "user-a",
      conversation_id: "conv-1",
      project_key: "im-test-hub",
      branch: "bot/add-case",
      commit_message: "test: add case",
    });
  });

});
