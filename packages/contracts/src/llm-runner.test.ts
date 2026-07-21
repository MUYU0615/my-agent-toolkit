import { describe, expect, it } from "vitest";
import { parseChatRequest, parseSystemRunRequest } from "./llm-runner.js";

describe("parseChatRequest", () => {
  it("accepts a minimal valid chat request", () => {
    const result = parseChatRequest({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "hello",
    });

    expect(result).toEqual({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "mock",
      prompt: "hello",
    });
  });

  it("accepts the Claude Code runtime", () => {
    expect(parseChatRequest({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-claude",
      runtime: "claude-code",
      prompt: "hello",
    }).runtime).toBe("claude-code");
  });

  it("parses a system Flow run without Bot or user fields", () => {
    expect(parseSystemRunRequest({
      flow_id: "jira-automation",
      run_id: "jira-HIM-22187-abc123",
      runtime: "claude-code",
      prompt: "run the isolated Jira task",
      runtime_env: { EASEMOB_JIRA_USERNAME: "jira-service" },
      auto_execute: true,
    })).toMatchObject({
      flow_id: "jira-automation",
      run_id: "jira-HIM-22187-abc123",
      runtime: "claude-code",
      runtime_env: { EASEMOB_JIRA_USERNAME: "jira-service" },
      auto_execute: true,
    });
  });

  it("rejects missing required fields", () => {
    expect(() => parseChatRequest({ bot_id: "prd-bot" })).toThrow(
      "conversation_id is required",
    );
  });
});
