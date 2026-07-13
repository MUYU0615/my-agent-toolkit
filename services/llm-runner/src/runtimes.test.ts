import { describe, expect, it } from "vitest";
import {
  RuntimeExecutionError,
  runCliRuntime,
  runMockRuntime,
} from "./runtimes.js";

const request = {
  bot_id: "prd-bot",
  user_id: "user-a",
  conversation_id: "conv-1",
  runtime: "mock" as const,
  prompt: "hello",
};

describe("runtime adapters", () => {
  const providerSessionId = "f2946a26-3735-4b08-8d05-c928010302d5";

  it("runs mock runtime with deterministic session identity", async () => {
    const result = await runMockRuntime(request);

    expect(result).toEqual({
      runner_session_id: "mock:prd-bot:user-a:conv-1",
      output: "mock: hello",
    });
  });

  it("runs CLI runtime by writing prompt to stdin", async () => {
    const result = await runCliRuntime(
      {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        timeout_ms: 1000,
      },
      { ...request, runtime: "kiro" },
    );

    expect(result).toEqual({
      runner_session_id: "kiro:prd-bot:user-a:conv-1",
      output: "hello",
    });
  });

  it("adds an exact resume id when a provider session is known", async () => {
    const command = [
      "const fs = require('node:fs');",
      "const log = process.env.ARGS_LOG;",
      "fs.appendFileSync(log, JSON.stringify(process.argv.slice(1)) + '\\n');",
      "process.stdin.pipe(process.stdout);",
    ].join(" ");
    const logPath = `/tmp/kiro-runner-session-${crypto.randomUUID()}.log`;
    const config = {
      command: process.execPath,
      args: ["-e", command, "chat", "--no-interactive"],
      timeout_ms: 1000,
      env: { ARGS_LOG: logPath },
    };

    const isolatedRequest = {
      ...request,
      conversation_id: `conv-${crypto.randomUUID()}`,
      runtime: "kiro" as const,
    };
    await runCliRuntime(config, { ...isolatedRequest, prompt: "first" });
    await runCliRuntime(
      { ...config, provider_session_id: providerSessionId },
      { ...isolatedRequest, prompt: "second" },
    );

    const lines = (await import("node:fs")).readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      ["chat", "--no-interactive"],
      ["chat", "--resume-id", providerSessionId, "--no-interactive"],
    ]);
  });

  it("reads provider session metadata without including it in output", async () => {
    const command = [
      "process.stdout.write('hello');",
      `process.stderr.write('__MY_AGENT_TOOLKIT_RUNTIME_META__${JSON.stringify({ provider_session_id: providerSessionId })}\\n');`,
    ].join(" ");

    await expect(runCliRuntime(
      {
        command: process.execPath,
        args: ["-e", command],
        timeout_ms: 1000,
      },
      { ...request, runtime: "kiro" },
    )).resolves.toMatchObject({
      output: "hello",
      provider_session_id: providerSessionId,
    });
  });

  it("rejects bare resume and invalid provider session ids", async () => {
    await expect(runCliRuntime(
      {
        command: process.execPath,
        args: ["chat", "--resume"],
        timeout_ms: 1000,
      },
      { ...request, runtime: "kiro" },
    )).rejects.toMatchObject({
      code: "runtime_session_error",
      message: "bare --resume is not allowed",
    });

    await expect(runCliRuntime(
      {
        command: process.execPath,
        args: ["chat"],
        provider_session_id: "not-a-uuid",
        timeout_ms: 1000,
      },
      { ...request, runtime: "kiro" },
    )).rejects.toMatchObject({
      code: "runtime_session_error",
      message: "invalid provider session id",
    });
  });

  it("redacts stderr when CLI runtime exits non-zero", async () => {
    await expect(
      runCliRuntime(
        {
          command: process.execPath,
          args: [
            "-e",
            "console.error('failed token=abc123 secret=my-secret /tmp/auth.db'); process.exit(2)",
          ],
          timeout_ms: 1000,
        },
        { ...request, runtime: "kiro" },
      ),
    ).rejects.toMatchObject({
      code: "runtime_exit",
      status: 502,
      message: "runtime exited with code 2",
      details: "failed token=[REDACTED] secret=[REDACTED] [PATH]",
    } satisfies Partial<RuntimeExecutionError>);
  });

  it("returns a stable timeout error when CLI runtime exceeds timeout", async () => {
    await expect(
      runCliRuntime(
        {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 1000)"],
          timeout_ms: 10,
        },
        { ...request, runtime: "kiro" },
      ),
    ).rejects.toMatchObject({
      code: "runtime_timeout",
      status: 504,
      message: "runtime timed out",
    } satisfies Partial<RuntimeExecutionError>);
  });
});
