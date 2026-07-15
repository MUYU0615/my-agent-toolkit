import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const providerSessionId = "f2946a26-3735-4b08-8d05-c928010302d5";
const compactedSessionId = "5cf91421-e688-4741-a2d5-717f87d09ce8";
const userId = "user-a";
const conversationId = "conv-a";
let relay;
let relayUrl;
let workspaceRoot;

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "kiro-relay-workspaces-"));
  const port = await reservePort();
  relayUrl = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, ["services/llm-runner/scripts/kiro-host-relay.mjs"], {
    env: {
      ...process.env,
      KIRO_COMMAND: process.execPath,
      KIRO_HOST_RELAY_HOST: "127.0.0.1",
      KIRO_HOST_RELAY_PORT: String(port),
      KIRO_TIMEOUT_MS: "2000",
      KIRO_WORKSPACE_ROOT: workspaceRoot,
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
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
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
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: conversationId,
      prompt: "hello",
      args: ["-e", script],
    }),
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
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: conversationId,
      prompt: "hello",
      args: ["-e", script],
    }),
  });

  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { type: "chunk", content: "answer" },
    { type: "session", provider_session_id: providerSessionId },
    { type: "done" },
  ]);
});

test("host relay immediately cancels only the matching active Kiro run", async () => {
  const projectRoot = join(
    workspaceRoot,
    "bot-a",
    "users",
    createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32),
    "projects",
    "cancel-rollback",
  );
  await initializeGitProject(projectRoot);
  await writeFile(join(projectRoot, "tracked.txt"), "preexisting change", "utf8");
  await writeFile(join(projectRoot, "before.txt"), "keep me", "utf8");
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  writeFileSync('../../projects/cancel-rollback/tracked.txt', 'changed');",
    "  writeFileSync('../../projects/cancel-rollback/created.txt', 'remove me');",
    "  process.stdout.write('started');",
    "  setInterval(() => {}, 1000);",
    "});",
  ].join(" ");
  const streamResponse = await fetch(`${relayUrl}/v1/kiro/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: "conv-stop",
      prompt: "long task",
      args: ["-e", script],
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const cancelResponse = await fetch(`${relayUrl}/v1/kiro/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: "conv-stop",
    }),
  });

  assert.equal(cancelResponse.status, 200);
  assert.deepEqual(await cancelResponse.json(), { cancelled: true });
  const events = (await streamResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [{ type: "chunk", content: "started" }, {
    type: "error",
    error: "kiro runtime cancelled",
    code: "runtime_cancelled",
  }]);
  assert.equal(await readFile(join(projectRoot, "tracked.txt"), "utf8"), "preexisting change");
  assert.equal(await readFile(join(projectRoot, "before.txt"), "utf8"), "keep me");
  await assert.rejects(access(join(projectRoot, "created.txt")));
});

test("host relay stops timed-out work and restores the project checkpoint", async () => {
  const projectRoot = join(
    workspaceRoot,
    "bot-a",
    "users",
    createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32),
    "projects",
    "timeout-rollback",
  );
  await initializeGitProject(projectRoot);
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  writeFileSync('../../projects/timeout-rollback/tracked.txt', 'changed');",
    "  writeFileSync('../../projects/timeout-rollback/created.txt', 'remove me');",
    "  setInterval(() => {}, 1000);",
    "});",
  ].join(" ");
  const response = await fetch(`${relayUrl}/v1/kiro/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: "conv-timeout",
      prompt: "long task",
      args: ["-e", script],
    }),
  });

  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [{
    type: "error",
    error: "任务执行超过时间限制，已自动停止并丢弃本次更改",
    code: "runtime_timeout",
  }]);
  assert.equal(await readFile(join(projectRoot, "tracked.txt"), "utf8"), "baseline");
  await assert.rejects(access(join(projectRoot, "created.txt")));
});

test("host relay persists the session id reported after a resumed session compacts", async () => {
  const script = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('compacted answer');",
    `  process.stderr.write('Resume with: kiro-cli chat --resume-id ${compactedSessionId}\\n');`,
    "});",
  ].join(" ");
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: conversationId,
      prompt: "hello",
      args: ["-e", script, "--", "--resume-id", providerSessionId],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    output: "compacted answer",
    provider_session_id: compactedSessionId,
  });
});

test("host relay rejects bare resume", async () => {
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: conversationId,
      prompt: "hello",
      args: ["chat", "--resume"],
    }),
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
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: conversationId,
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
      KIRO_WORKSPACE_ROOT: join(directory, "workspaces"),
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
        bot_id: "bot-session-list",
        user_id: userId,
        conversation_id: conversationId,
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

test("host relay retries a blank resumed session with its compacted successor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kiro-relay-session-recovery-"));
  const commandPath = join(directory, "fake-kiro.mjs");
  const statePath = join(directory, "sessions.json");
  const fakeKiro = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const oldSessionId = ${JSON.stringify(providerSessionId)};
const successorSessionId = ${JSON.stringify(compactedSessionId)};
const readSessions = () => existsSync(process.env.KIRO_FAKE_STATE)
  ? JSON.parse(readFileSync(process.env.KIRO_FAKE_STATE, "utf8"))
  : [{ sessionId: oldSessionId, updatedAt: "2026-07-14T10:00:00.000Z" }];
if (process.argv.includes("--list-sessions")) {
  process.stdout.write(JSON.stringify([{ cwd: process.cwd(), sessions: readSessions() }]));
} else {
  const resumeIndex = process.argv.indexOf("--resume-id");
  const resumeId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (resumeId === oldSessionId) {
      writeFileSync(process.env.KIRO_FAKE_STATE, JSON.stringify([
        { sessionId: oldSessionId, updatedAt: "2026-07-14T10:00:00.000Z" },
        { sessionId: successorSessionId, updatedAt: "2026-07-14T10:01:00.000Z" },
      ]));
      return;
    }
    process.stdout.write("recovered answer");
    process.stderr.write("Resume with: kiro-cli chat --resume-id " + successorSessionId + "\\n");
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
      KIRO_WORKSPACE_ROOT: join(directory, "workspaces"),
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
        bot_id: "bot-session-recovery",
        user_id: userId,
        conversation_id: conversationId,
        prompt: "hello",
        args: ["chat", "--resume-id", providerSessionId, "--no-interactive"],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      output: "recovered answer",
      provider_session_id: compactedSessionId,
    });
  } finally {
    if (isolatedRelay.exitCode === null) {
      isolatedRelay.kill("SIGTERM");
      await once(isolatedRelay, "close");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("host relay uses bot KIRO_HOME and a user-conversation working directory", async () => {
  const script = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ cwd: process.cwd(), kiroHome: process.env.KIRO_HOME }));",
    `  process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
    "});",
  ].join(" ");
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-workspace",
      user_id: userId,
      conversation_id: conversationId,
      prompt: "hello",
      args: ["-e", script],
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  const root = await realpath(workspaceRoot);
  const botRoot = join(root, "bot-workspace");
  const userHash = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  const conversationRoot = join(
    botRoot,
    "users",
    userHash,
    "conversations",
    conversationId,
  );
  assert.deepEqual(JSON.parse(payload.output), {
    cwd: conversationRoot,
    kiroHome: join(botRoot, ".kiro"),
  });
  await access(join(botRoot, ".kiro", "agents"));
  await access(join(botRoot, ".kiro", "skills"));
  await access(join(botRoot, "users", userHash, "projects"));
  await access(join(conversationRoot, "artifacts"));
  await assert.rejects(access(join(conversationRoot, ".kiro", "skills")));
});

test("host relay isolates working directories by user and conversation", async () => {
  const script = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(process.cwd());",
    `  process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
    "});",
  ].join(" ");
  const invoke = async (nextUserId, nextConversationId) => {
    const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bot_id: "bot-isolation",
        user_id: nextUserId,
        conversation_id: nextConversationId,
        prompt: "hello",
        args: ["-e", script],
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).output;
  };

  const first = await invoke("user-a", "conv-1");
  const second = await invoke("user-b", "conv-1");
  const third = await invoke("user-a", "conv-2");
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.notEqual(second, third);
});

test("host relay rejects bot ids that can escape the configured workspace root", async () => {
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bot_id: "../outside", prompt: "hello", args: ["chat"] }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "bot_id must be a safe path segment",
  });
});

test("host relay rejects conversation ids that can escape the user workspace", async () => {
  const response = await fetch(`${relayUrl}/v1/kiro/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: "bot-a",
      user_id: userId,
      conversation_id: "../outside",
      prompt: "hello",
      args: ["chat"],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "conversation_id must be a safe path segment",
  });
});

test("host relay injects Jira credentials and computes a user-private cookie path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kiro-relay-credentials-"));
  const port = await reservePort();
  const authToken = "relay-test-token";
  const isolatedRelay = spawn(process.execPath, ["services/llm-runner/scripts/kiro-host-relay.mjs"], {
    env: {
      ...process.env,
      KIRO_COMMAND: process.execPath,
      KIRO_HOST_RELAY_HOST: "127.0.0.1",
      KIRO_HOST_RELAY_PORT: String(port),
      KIRO_RELAY_AUTH_TOKEN: authToken,
      KIRO_TIMEOUT_MS: "2000",
      KIRO_WORKSPACE_ROOT: join(directory, "workspaces"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const isolatedRelayUrl = `http://127.0.0.1:${port}`;
    await waitForRelay(isolatedRelayUrl, isolatedRelay);
    const script = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "process.stdout.write(JSON.stringify({",
      "username: process.env.EASEMOB_JIRA_USERNAME,",
      "password: process.env.EASEMOB_JIRA_PASSWORD,",
      "cookie: process.env.EASEMOB_JIRA_COOKIE_FILE,",
      "runtime: process.env.MY_AGENT_RUNTIME,",
      "noColor: process.env.NO_COLOR,",
      "kiroLogNoColor: process.env.KIRO_LOG_NO_COLOR,",
      "relayToken: process.env.KIRO_RELAY_AUTH_TOKEN",
      "}));",
      `process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
      "});",
    ].join(" ");
    const response = await fetch(`${isolatedRelayUrl}/v1/kiro/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        bot_id: "jira-bot",
        user_id: "user-a",
        conversation_id: "conv-jira",
        prompt: "hello",
        args: ["-e", script],
        runtime_env: {
          EASEMOB_JIRA_USERNAME: "jira-user-a",
          EASEMOB_JIRA_PASSWORD: "jira-password-a",
          MY_AGENT_JIRA_CREDENTIAL_VERSION: "2026-07-13T18:00:00.000Z",
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    const output = JSON.parse(payload.output);
    assert.equal(output.username, "jira-user-a");
    assert.equal(output.password, "jira-password-a");
    assert.equal(output.runtime, "wecom");
    assert.equal(output.noColor, "1");
    assert.equal(output.kiroLogNoColor, "1");
    assert.equal(output.relayToken, undefined);
    assert.match(output.cookie, /jira-bot\/\.runtime\/users\/[0-9a-f]{32}\/jira\/[0-9a-f]{16}\/cookies\.json$/);
  } finally {
    if (isolatedRelay.exitCode === null) {
      isolatedRelay.kill("SIGTERM");
      await once(isolatedRelay, "close");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("host relay materializes the managed project .env and forwards project variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kiro-relay-project-env-"));
  const port = await reservePort();
  const authToken = "relay-project-env-token";
  const workspacesRoot = join(directory, "workspaces");
  const botId = "project-bot";
  const testUserId = "user-project";
  const testConversationId = "conv-project";
  const projectName = "im-test-hub";
  const userHash = createHash("sha256").update(testUserId, "utf8").digest("hex").slice(0, 32);
  const workspaceDir = join(
    workspacesRoot,
    botId,
    "users",
    userHash,
    "conversations",
    testConversationId,
  );
  const userRoot = join(workspacesRoot, botId, "users", userHash);
  const projectRoot = join(userRoot, "projects", projectName);
  await mkdir(projectRoot, { recursive: true });
  const projectDotenv = [
    `IM_TEST_HUB_PYTHON=${process.execPath}`,
    "IM_TEST_HUB_API_SECRET=relay-project-secret",
    "",
  ].join("\n");
  const isolatedRelay = spawn(process.execPath, ["services/llm-runner/scripts/kiro-host-relay.mjs"], {
    env: {
      ...process.env,
      KIRO_COMMAND: process.execPath,
      KIRO_HOST_RELAY_HOST: "127.0.0.1",
      KIRO_HOST_RELAY_PORT: String(port),
      KIRO_RELAY_AUTH_TOKEN: authToken,
      KIRO_TIMEOUT_MS: "2000",
      KIRO_WORKSPACE_ROOT: workspacesRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const isolatedRelayUrl = `http://127.0.0.1:${port}`;
    await waitForRelay(isolatedRelayUrl, isolatedRelay);
    const script = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({",
      "python: process.env.IM_TEST_HUB_PYTHON,",
      "secret: process.env.IM_TEST_HUB_API_SECRET,",
      "payload: process.env.MY_AGENT_PROJECT_DOTENV_B64",
      "}));",
      `process.stderr.write('Resume with: kiro-cli chat --resume-id ${providerSessionId}\\n');`,
      "});",
    ].join(" ");
    const response = await fetch(`${isolatedRelayUrl}/v1/kiro/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: testUserId,
        conversation_id: testConversationId,
        prompt: "run tests",
        args: ["-e", script],
        runtime_env: {
          MY_AGENT_PROJECT_DOTENV_B64: Buffer.from(projectDotenv, "utf8").toString("base64"),
        },
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    const runtimeOutput = JSON.parse(payload.output);
    const botRoot = await realpath(join(workspacesRoot, botId));
    assert.equal(runtimeOutput.secret, "relay-project-secret");
    assert.match(runtimeOutput.python, new RegExp(`^${escapeRegExp(join(botRoot, ".runtime", "python-launchers"))}`));
    assert.doesNotMatch(runtimeOutput.python, new RegExp(escapeRegExp(process.execPath)));
    const materializedDotenv = await readFile(join(projectRoot, ".env"), "utf8");
    assert.match(materializedDotenv, /^IM_TEST_HUB_PYTHON=.*\.runtime\/python-launchers\//m);
    assert.doesNotMatch(materializedDotenv, new RegExp(escapeRegExp(process.execPath)));
    assert.match(materializedDotenv, /IM_TEST_HUB_API_SECRET=relay-project-secret/);
    assert.equal((await stat(runtimeOutput.python)).mode & 0o777, 0o700);
    assert.equal((await stat(join(projectRoot, ".env"))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(userRoot, ".runtime", `${projectName}.dotenv-managed`), "utf8"),
      "managed\n",
    );
  } finally {
    if (isolatedRelay.exitCode === null) {
      isolatedRelay.kill("SIGTERM");
      await once(isolatedRelay, "close");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function initializeGitProject(projectRoot) {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "tracked.txt"), "baseline", "utf8");
  execFileSync("git", ["-C", projectRoot, "init", "--quiet"]);
  execFileSync("git", ["-C", projectRoot, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=Kiro Relay Test",
    "-c",
    "user.email=kiro-relay@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
}

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
