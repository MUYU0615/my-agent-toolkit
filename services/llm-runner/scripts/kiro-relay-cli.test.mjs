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
      prompt: "hello",
      args: ["chat", "--no-interactive"],
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
      prompt: "hello",
      args: ["chat", "--resume-id", providerSessionId, "--no-interactive"],
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
