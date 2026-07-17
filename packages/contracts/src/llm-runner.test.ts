import { describe, expect, it } from "vitest";
import { parseChatRequest } from "./llm-runner.js";

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

  it("rejects missing required fields", () => {
    expect(() => parseChatRequest({ bot_id: "prd-bot" })).toThrow(
      "conversation_id is required",
    );
  });
});
