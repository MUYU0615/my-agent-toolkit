import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const providerSessionId = "f2946a26-3735-4b08-8d05-c928010302d5";
let relay;
let relayUrl;

before(async () => {
  const port = await reservePort();
  relayUrl = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, ["services/llm-runner/scripts/kiro-host-relay.mjs"], {
    env: {
      ...process.env,
      KIRO_COMMAND: process.execPath,
      KIRO_HOST_RELAY_HOST: "127.0.0.1",
      KIRO_HOST_RELAY_PORT: String(port),
      KIRO_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) {
      throw new Error(`relay exited early with code ${relay.exitCode}`);
    }
    try {
      const response = await fetch(`${relayUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("relay did not become healthy");
});

after(async () => {
  if (relay && relay.exitCode === null) {
    relay.kill("SIGTERM");
    await once(relay, "close");
  }
});

test("host relay returns the Kiro session id from the process exit hint", async () => {
  const script = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('answer');",
    `  process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
    "});",
  ].join(" ");
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", args: ["-e", script] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    output: "answer",
    provider_session_id: providerSessionId,
  });
});

test("host relay emits a session event for streaming calls", async () => {
  const script = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('answer');",
    `  process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
    "});",
  ].join(" ");
  const response = await fetch(`${relayUrl}/v1/kiro/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", args: ["-e", script] }),
  });

  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { type: "chunk", content: "answer" },
    { type: "session", provider_session_id: providerSessionId },
    { type: "done" },
  ]);
});

test("host relay rejects bare resume", async () => {
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", args: ["chat", "--resume"] }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "bare --resume is not allowed; use --resume-id",
  });
});

test("host relay fails closed when a new Kiro session id is unavailable", async () => {
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "hello",
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('answer'))"],
    }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "kiro runtime did not report a session id",
  });
});

test("host relay discovers a new non-interactive session from the session list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kiro-relay-session-list-"));
  const commandPath = join(directory, "fake-kiro.mjs");
  const statePath = join(directory, "sessions.json");
  const fakeKiro = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const sessionId = ${JSON.stringify(providerSessionId)};
if (process.argv.includes("--list-sessions")) {
  const ids = existsSync(process.env.KIRO_FAKE_STATE)
    ? JSON.parse(readFileSync(process.env.KIRO_FAKE_STATE, "utf8"))
    : [];
  process.stdout.write(JSON.stringify([{
    cwd: process.cwd(),
    sessions: ids.map((id) => ({ sessionId: id, updatedAt: new Date().toISOString() })),
  }]));
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    writeFileSync(process.env.KIRO_FAKE_STATE, JSON.stringify([sessionId]));
    process.stdout.write("answer-without-resume-hint");
  });
}
`;
  await writeFile(commandPath, fakeKiro, "utf8");
  await chmod(commandPath, 0o755);
  const port = await reservePort();
  const isolatedRelay = spawn(process.execPath, ["services/llm-runner/scripts/kiro-host-relay.mjs"], {
    env: {
      ...process.env,
      KIRO_COMMAND: commandPath,
      KIRO_FAKE_STATE: statePath,
      KIRO_HOST_RELAY_HOST: "127.0.0.1",
      KIRO_HOST_RELAY_PORT: String(port),
      KIRO_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const isolatedRelayUrl = `http://127.0.0.1:${port}`;
    await waitForRelay(isolatedRelayUrl, isolatedRelay);
    const response = await fetch(`${isolatedRelayUrl}/v1/kiro/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hello",
        args: ["chat", "--no-interactive"],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      output: "answer-without-resume-hint",
      provider_session_id: providerSessionId,
    });
  } finally {
    if (isolatedRelay.exitCode === null) {
      isolatedRelay.kill("SIGTERM");
      await once(isolatedRelay, "close");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForRelay(url, process) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`relay exited early with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("relay did not become healthy");
}
