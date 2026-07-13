import { spawn } from "node:child_process";
import type { ChatRequest, RuntimeName } from "@my-agent-toolkit/contracts";
import { redactText } from "./redact.js";

export interface RuntimeResult {
  runner_session_id: string;
  provider_session_id?: string;
  output: string;
}

export interface RuntimeStreamResult {
  runner_session_id: string;
  provider_session_id: Promise<string | undefined>;
  stream: ReadableStream<string>;
}

export interface CliRuntimeConfig {
  command: string;
  args: string[];
  timeout_ms: number;
  env?: Record<string, string>;
  provider_session_id?: string;
}

const runtimeMetadataPrefix = "__MY_AGENT_TOOLKIT_RUNTIME_META__";
const kiroSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RuntimeExecutionError extends Error {
  constructor(
    public readonly code:
      | "runtime_exit"
      | "runtime_timeout"
      | "runtime_spawn_error"
      | "runtime_session_error",
    public readonly status: number,
    message: string,
    public readonly details?: string,
  ) {
    super(message);
  }
}

export async function runMockRuntime(
  request: ChatRequest,
): Promise<RuntimeResult> {
  return {
    runner_session_id: buildRunnerSessionId("mock", request),
    output: `mock: ${request.prompt}`,
  };
}

export async function runCliRuntime(
  config: CliRuntimeConfig,
  request: ChatRequest,
): Promise<RuntimeResult> {
  const runnerSessionId = buildRunnerSessionId(request.runtime, request);
  const result = await runProcess(config, request.prompt);
  return {
    runner_session_id: runnerSessionId,
    ...result,
  };
}

export function runMockRuntimeStream(
  request: ChatRequest,
): RuntimeStreamResult {
  return {
    runner_session_id: buildRunnerSessionId("mock", request),
    provider_session_id: Promise.resolve(undefined),
    stream: new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`mock: ${request.prompt}`);
        controller.close();
      },
    }),
  };
}

export function runCliRuntimeStream(
  config: CliRuntimeConfig,
  request: ChatRequest,
): RuntimeStreamResult {
  const runnerSessionId = buildRunnerSessionId(request.runtime, request);
  return {
    runner_session_id: runnerSessionId,
    ...streamProcess(config, request.prompt),
  };
}

export function buildRunnerSessionId(
  runtime: RuntimeName,
  request: Pick<ChatRequest, "bot_id" | "user_id" | "conversation_id">,
): string {
  return [runtime, request.bot_id, request.user_id, request.conversation_id].join(
    ":",
  );
}

function runProcess(
  config: CliRuntimeConfig,
  input: string,
): Promise<{ output: string; provider_session_id?: string }> {
  return new Promise((resolve, reject) => {
    const args = argsForRunnerSession(config.args, config.provider_session_id);
    const child = spawn(config.command, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(
        new RuntimeExecutionError(
          "runtime_timeout",
          504,
          "runtime timed out",
        ),
      );
    }, config.timeout_ms);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(
        new RuntimeExecutionError(
          "runtime_spawn_error",
          502,
          "runtime failed to start",
          redactText(error.message),
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      const runtimeStderr = parseRuntimeStderr(Buffer.concat(stderr).toString());
      if (code !== 0) {
        reject(
          new RuntimeExecutionError(
            "runtime_exit",
            502,
            `runtime exited with code ${code ?? "unknown"}`,
            runtimeStderr.diagnostics
              ? redactText(runtimeStderr.diagnostics)
              : undefined,
          ),
        );
        return;
      }

      resolve({
        output: Buffer.concat(stdout).toString(),
        ...(runtimeStderr.provider_session_id ?? config.provider_session_id
          ? { provider_session_id: runtimeStderr.provider_session_id ?? config.provider_session_id }
          : {}),
      });
    });

    child.stdin.end(input);
  });
}

function streamProcess(
  config: CliRuntimeConfig,
  input: string,
): Pick<RuntimeStreamResult, "provider_session_id" | "stream"> {
  let resolveProviderSessionId!: (value: string | undefined) => void;
  const providerSessionId = new Promise<string | undefined>((resolve) => {
    resolveProviderSessionId = resolve;
  });
  const stream = new ReadableStream<string>({
    start(controller) {
      const args = argsForRunnerSession(config.args, config.provider_session_id);
      const child = spawn(config.command, args, {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stderr: Buffer[] = [];
      let settled = false;
      const fail = (error: RuntimeExecutionError) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveProviderSessionId(undefined);
        controller.error(error);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new RuntimeExecutionError("runtime_timeout", 504, "runtime timed out"));
      }, config.timeout_ms);

      child.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        fail(
          new RuntimeExecutionError(
            "runtime_spawn_error",
            502,
            "runtime failed to start",
            redactText(error.message),
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const runtimeStderr = parseRuntimeStderr(Buffer.concat(stderr).toString());
        if (code !== 0) {
          resolveProviderSessionId(undefined);
          controller.error(
            new RuntimeExecutionError(
              "runtime_exit",
              502,
              `runtime exited with code ${code ?? "unknown"}`,
              runtimeStderr.diagnostics
                ? redactText(runtimeStderr.diagnostics)
                : undefined,
            ),
          );
          return;
        }
        resolveProviderSessionId(
          runtimeStderr.provider_session_id ?? config.provider_session_id,
        );
        controller.close();
      });

      child.stdin.end(input);
    },
  });
  return {
    provider_session_id: providerSessionId,
    stream,
  };
}

function argsForRunnerSession(args: string[], providerSessionId?: string): string[] {
  if (args.includes("--resume")) {
    throw new RuntimeExecutionError(
      "runtime_session_error",
      500,
      "bare --resume is not allowed",
    );
  }
  if (args.includes("--resume-id") || args.some((arg) => arg.startsWith("--resume-id="))) {
    throw new RuntimeExecutionError(
      "runtime_session_error",
      500,
      "runtime args must not contain a fixed --resume-id",
    );
  }
  if (!providerSessionId) {
    return [...args];
  }
  if (!isKiroSessionId(providerSessionId)) {
    throw new RuntimeExecutionError(
      "runtime_session_error",
      500,
      "invalid provider session id",
    );
  }

  const chatIndex = args.indexOf("chat");
  if (chatIndex < 0) {
    throw new RuntimeExecutionError(
      "runtime_session_error",
      500,
      "kiro chat command is required to resume a session",
    );
  }

  const nextArgs = [...args];
  nextArgs.splice(chatIndex + 1, 0, "--resume-id", providerSessionId);
  return nextArgs;
}

function parseRuntimeStderr(stderr: string): {
  provider_session_id?: string;
  diagnostics: string;
} {
  let providerSessionId: string | undefined;
  const diagnostics: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith(runtimeMetadataPrefix)) {
      if (line) {
        diagnostics.push(line);
      }
      continue;
    }

    try {
      const metadata = JSON.parse(line.slice(runtimeMetadataPrefix.length)) as {
        provider_session_id?: unknown;
      };
      if (isKiroSessionId(metadata.provider_session_id)) {
        providerSessionId = metadata.provider_session_id;
      }
    } catch {
      diagnostics.push("invalid runtime metadata");
    }
  }
  return {
    ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
    diagnostics: diagnostics.join("\n"),
  };
}

function isKiroSessionId(value: unknown): value is string {
  return typeof value === "string" && kiroSessionIdPattern.test(value);
}
