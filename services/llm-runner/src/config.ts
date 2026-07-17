import type { RuntimeName } from "@my-agent-toolkit/contracts";
import type { CliRuntimeConfig } from "./runtimes.js";

export interface RunnerConfig {
  enabled_runtimes: RuntimeName[];
  data_service_url?: string;
  log_service_url?: string;
  kiro?: CliRuntimeConfig;
  claude_code?: CliRuntimeConfig;
  mcp?: McpRunnerConfig;
  fetch?: typeof fetch;
  resolveBotEnvVars?: BotEnvResolver;
  resolveUserEnvVars?: UserEnvResolver;
  credential_internal_token?: string;
  kiro_relay_cancel_url?: string;
  kiro_relay_auth_token?: string;
}

export type BotEnvResolver = (botId: string) => Promise<Record<string, string>>;
export type UserEnvResolver = (
  botId: string,
  userId: string,
) => Promise<Record<string, string>>;

export interface McpRunnerConfig {
  service_url: string;
  runner_secret: string;
  /** Maximum MCP calls the runner may execute for one user message. */
  max_tool_rounds?: number;
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

  const dataServiceUrl = env.DATA_SERVICE_URL?.trim();
  if (dataServiceUrl) {
    config.data_service_url = dataServiceUrl.replace(/\/+$/, "");
  }

  const logServiceUrl = env.LOG_SERVICE_URL?.trim();
  if (logServiceUrl) {
    config.log_service_url = logServiceUrl.replace(/\/+$/, "");
  }

  const credentialInternalToken = env.USER_CREDENTIALS_INTERNAL_TOKEN?.trim();
  if (credentialInternalToken) {
    config.credential_internal_token = credentialInternalToken;
  }

  if (enabledRuntimes.includes("kiro")) {
    const command = env.KIRO_COMMAND?.trim();
    if (!command) {
      throw new Error("KIRO_COMMAND is required when kiro runtime is enabled");
    }

    config.kiro = {
      provider: "kiro",
      command,
      args: parseArgs(env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools"),
      timeout_ms: parsePositiveInteger(env.KIRO_TIMEOUT_MS, 900_000),
    };
    const relayUrl = env.KIRO_RELAY_URL?.trim();
    if (relayUrl) {
      config.kiro_relay_cancel_url = (env.KIRO_RELAY_CANCEL_URL?.trim()
        ?? relayUrl.replace(/\/v1\/kiro\/chat$/, "/v1/kiro/cancel"))
        .replace(/\/+$/, "");
    }
    const relayAuthToken = env.KIRO_RELAY_AUTH_TOKEN?.trim();
    if (relayAuthToken) {
      config.kiro_relay_auth_token = relayAuthToken;
    }
  }

  if (enabledRuntimes.includes("claude-code")) {
    config.claude_code = {
      provider: "claude-code",
      command: env.CLAUDE_CODE_COMMAND?.trim() || "node",
      args: parseArgs(env.CLAUDE_CODE_ARGS
        ?? "services/llm-runner/scripts/kiro-relay-cli.mjs -p --output-format text --permission-mode bypassPermissions --setting-sources project,local,user"),
      timeout_ms: parsePositiveInteger(env.CLAUDE_CODE_TIMEOUT_MS, 900_000),
    };
    const relayUrl = env.KIRO_RELAY_URL?.trim();
    if (relayUrl && !config.kiro_relay_cancel_url) {
      config.kiro_relay_cancel_url = (env.KIRO_RELAY_CANCEL_URL?.trim()
        ?? relayUrl.replace(/\/v1\/kiro\/chat$/, "/v1/kiro/cancel"))
        .replace(/\/+$/, "");
    }
    const relayAuthToken = env.KIRO_RELAY_AUTH_TOKEN?.trim();
    if (relayAuthToken && !config.kiro_relay_auth_token) {
      config.kiro_relay_auth_token = relayAuthToken;
    }
  }

  const mcpServiceUrl = env.MCP_SERVICE_URL?.trim();
  const mcpRunnerSecret = env.MCP_RUNNER_SECRET?.trim();
  if (mcpServiceUrl && mcpRunnerSecret) {
    config.mcp = {
      service_url: mcpServiceUrl.replace(/\/+$/, ""),
      runner_secret: mcpRunnerSecret,
      max_tool_rounds: parsePositiveInteger(env.MCP_MAX_TOOL_ROUNDS, 4),
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
    if (runtime !== "mock" && runtime !== "kiro" && runtime !== "claude-code") {
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
