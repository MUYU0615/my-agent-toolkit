import { describe, expect, it } from "vitest";
import {
  signRunnerToken,
  verifyRunnerToken,
} from "./context.js";

describe("runner token context", () => {
  const secret = "test-runner-secret";
  const context = {
    bot_id: "prd-bot",
    user_id: "user-a",
    conversation_id: "conv-1",
    runtime: "kiro" as const,
  };

  it("signs and verifies a trusted MCP context", () => {
    const token = signRunnerToken(secret, context);

    expect(verifyRunnerToken(secret, token, {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toEqual(context);
  });

  it("rejects tokens that do not match the requested bot or conversation", () => {
    const token = signRunnerToken(secret, context);

    expect(() => verifyRunnerToken(secret, token, {
      bot_id: "other-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token context does not match request path");
    expect(() => verifyRunnerToken(secret, token, {
      bot_id: "prd-bot",
      conversation_id: "other-conv",
    })).toThrow("runner token context does not match request path");
  });

  it("rejects malformed or wrongly signed tokens", () => {
    const token = signRunnerToken(secret, context);

    expect(() => verifyRunnerToken("wrong-secret", token, {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token signature is invalid");
    expect(() => verifyRunnerToken(secret, "not-a-token", {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token is invalid");
  });
});
