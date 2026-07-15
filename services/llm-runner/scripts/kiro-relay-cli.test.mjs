import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

const providerSessionId = "f2946a26-3735-4b08-8d05-c928010302d5";
const metadataLine = `__MY_AGENT_TOOLKIT_RUNTIME_META__${JSON.stringify({
  provider_session_id: providerSessionId,
})}\n`;

test("kiro relay cli posts stdin to host relay and writes output", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/kiro/chat");

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      prompt: "hello",
      args: ["chat", "--no-interactive"],
      runtime_env: {},
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output: "world",
      provider_session_id: providerSessionId,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const child = spawn(process.execPath, ["services/llm-runner/scripts/kiro-relay-cli.mjs", "chat", "--no-interactive"], {
    env: {
      ...process.env,
      KIRO_RELAY_BOT_ID: "prd-bot",
      KIRO_RELAY_USER_ID: "user-a",
      KIRO_RELAY_CONVERSATION_ID: "conv-1",
      KIRO_RELAY_URL: `http://127.0.0.1:${address.port}/v1/kiro/chat`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end("hello");
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  server.close();

  assert.equal(code, 0, Buffer.concat(stderr).toString());
  assert.equal(Buffer.concat(stdout).toString(), "world");
  assert.equal(Buffer.concat(stderr).toString(), metadataLine);
});

test("kiro relay cli forwards streamed chunks to stdout", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/kiro/chat/stream");

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      prompt: "hello",
      args: ["chat", "--resume-id", providerSessionId, "--no-interactive"],
      runtime_env: {},
    });

    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ type: "chunk", content: "he" })}\n`);
    setTimeout(() => {
      response.write(`${JSON.stringify({ type: "chunk", content: "llo" })}\n`);
      response.write(`${JSON.stringify({ type: "session", provider_session_id: providerSessionId })}\n`);
      response.end(`${JSON.stringify({ type: "done" })}\n`);
    }, 10);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const child = spawn(process.execPath, ["services/llm-runner/scripts/kiro-relay-cli.mjs", "chat", "--resume-id", providerSessionId, "--no-interactive"], {
    env: {
      ...process.env,
      KIRO_RELAY_BOT_ID: "prd-bot",
      KIRO_RELAY_USER_ID: "user-a",
      KIRO_RELAY_CONVERSATION_ID: "conv-1",
      KIRO_RELAY_URL: `http://127.0.0.1:${address.port}/v1/kiro/chat`,
      KIRO_RELAY_STREAM_URL: `http://127.0.0.1:${address.port}/v1/kiro/chat/stream`,
      KIRO_RELAY_STREAM: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end("hello");
  const chunks = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  server.close();

  assert.equal(code, 0, Buffer.concat(stderr).toString());
  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(Buffer.concat(stderr).toString(), metadataLine);
});

test("kiro relay cli forwards only allowlisted user credentials with relay auth", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer relay-token");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(payload.runtime_env, {
      EASEMOB_JIRA_USERNAME: "jira-user-a",
      EASEMOB_JIRA_PASSWORD: "jira-password-a",
      MY_AGENT_PROJECT_DOTENV_B64: "cHJvamVjdC1lbnY=",
    });
    assert.equal(payload.user_id, "user-a");
    assert.equal(payload.conversation_id, "conv-1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "ok", provider_session_id: providerSessionId }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const child = spawn(process.execPath, ["services/llm-runner/scripts/kiro-relay-cli.mjs", "chat"], {
    env: {
      ...process.env,
      KIRO_RELAY_BOT_ID: "prd-bot",
      KIRO_RELAY_USER_ID: "user-a",
      KIRO_RELAY_CONVERSATION_ID: "conv-1",
      KIRO_RELAY_AUTH_TOKEN: "relay-token",
      KIRO_RELAY_URL: `http://127.0.0.1:${address.port}/v1/kiro/chat`,
      EASEMOB_JIRA_USERNAME: "jira-user-a",
      EASEMOB_JIRA_PASSWORD: "jira-password-a",
      MY_AGENT_PROJECT_DOTENV_B64: "cHJvamVjdC1lbnY=",
      SHOULD_NOT_BE_FORWARDED: "private-value",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("hello");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  server.close();
  assert.equal(code, 0, Buffer.concat(stderr).toString());
});

test("kiro relay cli requires an internal bot id", async () => {
  const child = spawn(process.execPath, ["services/llm-runner/scripts/kiro-relay-cli.mjs", "chat"], {
    env: {
      ...process.env,
      KIRO_RELAY_BOT_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end("hello");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");

  assert.equal(code, 1);
  assert.equal(Buffer.concat(stderr).toString(), "KIRO_RELAY_BOT_ID is required");
});

test("kiro relay cli requires an internal conversation id", async () => {
  const child = spawn(process.execPath, ["services/llm-runner/scripts/kiro-relay-cli.mjs", "chat"], {
    env: {
      ...process.env,
      KIRO_RELAY_BOT_ID: "prd-bot",
      KIRO_RELAY_USER_ID: "user-a",
      KIRO_RELAY_CONVERSATION_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.end("hello");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");

  assert.equal(code, 1);
  assert.equal(Buffer.concat(stderr).toString(), "KIRO_RELAY_CONVERSATION_ID is required");
});
