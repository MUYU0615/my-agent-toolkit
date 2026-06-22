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
        command: "/usr/local/bin/kiro-cli",
        args: ["chat", "--no-interactive", "--trust-all-tools"],
        timeout_ms: 1234,
      },
    });
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
    });
  });
});
