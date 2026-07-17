import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "./config.js";

describe("loadRunnerConfig", () => {
  it("enables mock runtime by default", () => {
    const config = loadRunnerConfig({});

    expect(config.enabled_runtimes).toEqual(["mock"]);
    expect(config.kiro).toBeUndefined();
  });

  it("requires KIRO_COMMAND when kiro runtime is enabled", () => {
    expect(() =>
      loadRunnerConfig({
        LLM_RUNNER_ENABLED_RUNTIMES: "mock,kiro",
      }),
    ).toThrow("KIRO_COMMAND is required when kiro runtime is enabled");
  });

  it("loads kiro CLI runtime config from env", () => {
    const config = loadRunnerConfig({
      LLM_RUNNER_ENABLED_RUNTIMES: "mock,kiro",
      KIRO_COMMAND: "/usr/local/bin/kiro-cli",
      KIRO_ARGS: "chat --no-interactive --trust-all-tools",
      KIRO_TIMEOUT_MS: "1234",
    });

    expect(config).toEqual({
      enabled_runtimes: ["mock", "kiro"],
      kiro: {
        provider: "kiro",
        command: "/usr/local/bin/kiro-cli",
        args: ["chat", "--no-interactive", "--trust-all-tools"],
        timeout_ms: 1234,
      },
    });
  });

  it("loads Claude Code through the existing host relay", () => {
    const config = loadRunnerConfig({
      LLM_RUNNER_ENABLED_RUNTIMES: "claude-code",
      CLAUDE_CODE_TIMEOUT_MS: "4321",
      KIRO_RELAY_URL: "http://host.docker.internal:8210/v1/kiro/chat",
    });

    expect(config.claude_code).toEqual({
      provider: "claude-code",
      command: "node",
      args: [
        "services/llm-runner/scripts/kiro-relay-cli.mjs",
        "-p",
        "--output-format",
        "text",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "project,local",
      ],
      timeout_ms: 4321,
    });
    expect(config.kiro_relay_cancel_url).toBe(
      "http://host.docker.internal:8210/v1/kiro/cancel",
    );
  });

  it("uses a fifteen-minute Kiro timeout by default", () => {
    const config = loadRunnerConfig({
      LLM_RUNNER_ENABLED_RUNTIMES: "kiro",
      KIRO_COMMAND: "/usr/local/bin/kiro-cli",
    });

    expect(config.kiro?.timeout_ms).toBe(900_000);
  });

  it("loads optional MCP service config from env", () => {
    const config = loadRunnerConfig({
      LLM_RUNNER_ENABLED_RUNTIMES: "mock",
      MCP_SERVICE_URL: "http://mcp-service:8700/",
      MCP_RUNNER_SECRET: "runner-secret",
    });

    expect(config.mcp).toEqual({
      service_url: "http://mcp-service:8700",
      runner_secret: "runner-secret",
      max_tool_rounds: 4,
    });
  });
});
