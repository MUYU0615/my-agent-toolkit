import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { MemoryClient } from "./memoryClient.js";

function createRuntime(memoryEnabled: boolean, env: Record<string, string> = {}): BotRuntime {
  const rootDir = path.join(os.tmpdir(), "memory-client-test");
  const workspaceDir = path.join(rootDir, "workspace");
  return {
    botName: "test-bot",
    rootDir,
    workspaceDir,
    privateDir: path.join(workspaceDir, "private"),
    filesDir: path.join(workspaceDir, "files"),
    instructionsDir: path.join(workspaceDir, "instructions"),
    config: {
      bot: {
        name: "test-bot",
        session_idle_ttl_seconds: 3600,
        stop_keyword: "/stop",
        thinking_message: "thinking",
        busy_message: "busy"
      },
      wecom: {
        bot_id_env: "WECOM_BOT_ID",
        secret_env: "WECOM_SECRET"
      },
      cli: {
        provider: "test",
        command: "test-cli",
        args: [],
        input_mode: "stdin",
        stream_output: "stdout",
        stop_signal: "SIGTERM",
        kill_after_ms: 100,
        timeout_seconds: 10
      },
      memory: {
        enabled: memoryEnabled,
        api_url_env: "MEMORY_API_URL",
        namespace_env: "MEMORY_NAMESPACE",
        auto_retrieve: true,
        auto_store: true,
        retrieve_limit: 5
      }
    },
    env,
    secrets: []
  };
}

test("MemoryClient.enabled is false when config disables memory even if runtime env url exists", () => {
  const client = new MemoryClient(createRuntime(false, {
    MEMORY_API_URL: "http://localhost:8100",
    MEMORY_NAMESPACE: "shared"
  }));

  assert.equal(client.enabled, false);
});

test("MemoryClient.enabled is true when config enables memory and runtime env url exists", () => {
  const client = new MemoryClient(createRuntime(true, {
    MEMORY_API_URL: "http://localhost:8100",
    MEMORY_NAMESPACE: "shared"
  }));

  assert.equal(client.enabled, true);
});
