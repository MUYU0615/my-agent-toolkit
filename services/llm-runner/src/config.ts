import type { RuntimeName } from "@my-agent-toolkit/contracts";
import type { CliRuntimeConfig } from "./runtimes.js";

export interface RunnerConfig {
  enabled_runtimes: RuntimeName[];
  kiro?: CliRuntimeConfig;
  mcp?: McpRunnerConfig;
  fetch?: typeof fetch;
  resolveBotEnvVars?: BotEnvResolver;
}

export type BotEnvResolver = (botId: string) => Promise<Record<string, string>>;

export interface McpRunnerConfig {
  service_url: string;
  runner_secret: string;
}

export function loadRunnerConfig(
  env: Record<string, string | undefined> = process.env,
): RunnerConfig {
  const enabledRuntimes = parseEnabledRuntimes(
    env.LLM_RUNNER_ENABLED_RUNTIMES ?? "mock",
  );

  const config: RunnerConfig = {
    enabled_runtimes: enabledRuntimes,
  };

  if (enabledRuntimes.includes("kiro")) {
    const command = env.KIRO_COMMAND?.trim();
    if (!command) {
      throw new Error("KIRO_COMMAND is required when kiro runtime is enabled");
    }

    config.kiro = {
      command,
      args: parseArgs(env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools"),
      timeout_ms: parsePositiveInteger(env.KIRO_TIMEOUT_MS, 120_000),
    };
  }

  const mcpServiceUrl = env.MCP_SERVICE_URL?.trim();
  const mcpRunnerSecret = env.MCP_RUNNER_SECRET?.trim();
  if (mcpServiceUrl && mcpRunnerSecret) {
    config.mcp = {
      service_url: mcpServiceUrl.replace(/\/+$/, ""),
      runner_secret: mcpRunnerSecret,
    };
  }

  return config;
}

function parseEnabledRuntimes(value: string): RuntimeName[] {
  const runtimes = value
    .split(",")
    .map((runtime) => runtime.trim())
    .filter(Boolean);

  if (runtimes.length === 0) {
    throw new Error("at least one runtime must be enabled");
  }

  return runtimes.map((runtime) => {
    if (runtime !== "mock" && runtime !== "kiro") {
      throw new Error(`unsupported runtime: ${runtime}`);
    }
    return runtime;
  });
}

function parseArgs(value: string): string[] {
  return value
    .split(" ")
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected positive integer, got: ${value}`);
  }

  return parsed;
}
