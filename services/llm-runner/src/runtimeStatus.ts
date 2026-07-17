import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { RuntimeName } from "@my-agent-toolkit/contracts";
import type { RunnerConfig } from "./config.js";

export interface RuntimeStatus {
  runtime: RuntimeName;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  error?: string;
}

export async function getRuntimeStatuses(
  config: RunnerConfig,
): Promise<RuntimeStatus[]> {
  const statuses: RuntimeStatus[] = [];

  if (config.enabled_runtimes.includes("mock")) {
    statuses.push({
      runtime: "mock",
      enabled: true,
      configured: true,
      available: true,
    });
  }

  if (config.enabled_runtimes.includes("kiro")) {
    statuses.push(await getCliStatus("kiro", config.kiro));
  }
  if (config.enabled_runtimes.includes("claude-code")) {
    statuses.push(await getCliStatus("claude-code", config.claude_code));
  }

  return statuses;
}

async function getCliStatus(
  runtime: "kiro" | "claude-code",
  cliConfig: RunnerConfig["kiro"],
): Promise<RuntimeStatus> {
  if (!cliConfig) {
    return {
      runtime,
      enabled: true,
      configured: false,
      available: false,
      error: `${runtime} runtime is missing configuration`,
    };
  }

  if (cliConfig.command.includes("/")) {
    try {
      await access(cliConfig.command, constants.X_OK);
    } catch {
      return {
        runtime,
        enabled: true,
        configured: true,
        available: false,
        error: `command not found: ${cliConfig.command}`,
      };
    }
  }

  return {
    runtime,
    enabled: true,
    configured: true,
    available: true,
  };
}
