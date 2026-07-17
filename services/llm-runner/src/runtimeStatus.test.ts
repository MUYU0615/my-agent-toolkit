import { describe, expect, it } from "vitest";
import { getRuntimeStatuses } from "./runtimeStatus.js";

describe("getRuntimeStatuses", () => {
  it("reports enabled mock runtime as available", async () => {
    const statuses = await getRuntimeStatuses({
      enabled_runtimes: ["mock"],
    });

    expect(statuses).toEqual([
      {
        runtime: "mock",
        enabled: true,
        configured: true,
        available: true,
      },
    ]);
  });

  it("reports configured kiro runtime as unavailable when command is missing", async () => {
    const statuses = await getRuntimeStatuses({
      enabled_runtimes: ["mock", "kiro"],
      kiro: {
        command: "/path/to/missing/kiro-cli",
        args: ["chat"],
        timeout_ms: 1000,
      },
    });

    expect(statuses).toEqual([
      {
        runtime: "mock",
        enabled: true,
        configured: true,
        available: true,
      },
      {
        runtime: "kiro",
        enabled: true,
        configured: true,
        available: false,
        error: "command not found: /path/to/missing/kiro-cli",
      },
    ]);
  });

  it("reports configured Claude Code runtime independently", async () => {
    const statuses = await getRuntimeStatuses({
      enabled_runtimes: ["claude-code"],
      claude_code: {
        provider: "claude-code",
        command: process.execPath,
        args: ["relay.mjs"],
        timeout_ms: 1000,
      },
    });

    expect(statuses).toEqual([{
      runtime: "claude-code",
      enabled: true,
      configured: true,
      available: true,
    }]);
  });
});
