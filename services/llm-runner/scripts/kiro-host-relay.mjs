#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number.parseInt(process.env.KIRO_HOST_RELAY_PORT ?? "8210", 10);
const host = process.env.KIRO_HOST_RELAY_HOST ?? "127.0.0.1";
const command = process.env.KIRO_COMMAND ?? "/Users/dujiepeng/.local/bin/kiro-cli";
const args = parseArgs(process.env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools");
const timeoutMs = Number.parseInt(process.env.KIRO_TIMEOUT_MS ?? "120000", 10);
const kiroSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kiroResumeIdPattern = /--resume-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
let newSessionCreationTail = Promise.resolve();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { service: "kiro-host-relay", status: "ok" });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/kiro/chat/stream") {
    try {
      const payload = JSON.parse(await readBody(request));
      if (typeof payload.prompt !== "string") {
        writeJson(response, 400, { error: "prompt is required" });
        return;
      }

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      const requestArgs = argsFromPayload(payload);
      const providerSessionId = await runWithSessionDiscovery(
        requestArgs,
        (sessionsBefore) => streamKiro(payload.prompt, requestArgs, (event) => {
          response.write(`${JSON.stringify(event)}\n`);
        }, sessionsBefore),
      );
      response.write(`${JSON.stringify({
        type: "session",
        provider_session_id: providerSessionId,
      })}\n`);
      response.end(`${JSON.stringify({ type: "done" })}\n`);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        });
      }
      response.end(`${JSON.stringify({
        type: "error",
        error: error instanceof Error ? error.message : "kiro relay failed",
      })}\n`);
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/kiro/chat") {
    writeJson(response, 404, { error: "not found" });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request));
    if (typeof payload.prompt !== "string") {
      writeJson(response, 400, { error: "prompt is required" });
      return;
    }

    const requestArgs = argsFromPayload(payload);
    const result = await runWithSessionDiscovery(
      requestArgs,
      (sessionsBefore) => runKiro(payload.prompt, requestArgs, sessionsBefore),
    );
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, 502, {
      error: error instanceof Error ? error.message : "kiro relay failed",
    });
  }
});

server.listen(port, host, () => {
  console.log(`kiro host relay listening on http://${host}:${port}`);
});

function runKiro(prompt, requestArgs = args, sessionsBefore) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("kiro runtime timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`kiro runtime exited with code ${code ?? "unknown"}: ${redact(Buffer.concat(stderr).toString())}`));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();
      try {
        const providerSessionId = await resolveProviderSessionId(
          requestArgs,
          stdoutText,
          stderrText,
          sessionsBefore,
        );
        if (!providerSessionId) {
          reject(new Error("kiro runtime did not report a session id"));
          return;
        }
        resolve({
          output: stripResumeHint(stdoutText),
          provider_session_id: providerSessionId,
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function streamKiro(prompt, requestArgs = args, onEvent, sessionsBefore) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    const stdout = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("kiro runtime timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      const content = stripResumeHint(chunk.toString());
      if (content) {
        onEvent({ type: "chunk", content });
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`kiro runtime exited with code ${code ?? "unknown"}: ${redact(Buffer.concat(stderr).toString())}`));
        return;
      }
      try {
        const providerSessionId = await resolveProviderSessionId(
          requestArgs,
          Buffer.concat(stdout).toString(),
          Buffer.concat(stderr).toString(),
          sessionsBefore,
        );
        if (!providerSessionId) {
          reject(new Error("kiro runtime did not report a session id"));
          return;
        }
        resolve(providerSessionId);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function parseArgs(value) {
  return value.split(" ").map((item) => item.trim()).filter(Boolean);
}

function argsFromPayload(payload) {
  if (!Array.isArray(payload.args)) {
    return validateRequestArgs(args);
  }

  const requestArgs = payload.args.filter((item) => typeof item === "string" && item.length > 0);
  return validateRequestArgs(requestArgs.length > 0 ? requestArgs : args);
}

function validateRequestArgs(requestArgs) {
  if (requestArgs.includes("--resume")) {
    throw new Error("bare --resume is not allowed; use --resume-id");
  }

  const resumeIdIndex = requestArgs.indexOf("--resume-id");
  if (resumeIdIndex >= 0 && !isKiroSessionId(requestArgs[resumeIdIndex + 1])) {
    throw new Error("invalid kiro --resume-id value");
  }

  const inlineResumeId = requestArgs.find((item) => item.startsWith("--resume-id="));
  if (inlineResumeId && !isKiroSessionId(inlineResumeId.slice("--resume-id=".length))) {
    throw new Error("invalid kiro --resume-id value");
  }

  return requestArgs;
}

function extractProviderSessionId(requestArgs, stdout, stderr) {
  const resumeIdIndex = requestArgs.indexOf("--resume-id");
  if (resumeIdIndex >= 0 && isKiroSessionId(requestArgs[resumeIdIndex + 1])) {
    return requestArgs[resumeIdIndex + 1];
  }

  const inlineResumeId = requestArgs.find((item) => item.startsWith("--resume-id="));
  if (inlineResumeId) {
    const value = inlineResumeId.slice("--resume-id=".length);
    if (isKiroSessionId(value)) {
      return value;
    }
  }

  return `${stderr}\n${stdout}`.match(kiroResumeIdPattern)?.[1];
}

async function runWithSessionDiscovery(requestArgs, operation) {
  if (extractProviderSessionId(requestArgs, "", "")) {
    return operation(undefined);
  }

  return withNewSessionCreationLock(async () => {
    const sessionsBefore = await listKiroSessionIds().catch(() => undefined);
    return operation(sessionsBefore);
  });
}

async function resolveProviderSessionId(requestArgs, stdout, stderr, sessionsBefore) {
  const reportedSessionId = extractProviderSessionId(requestArgs, stdout, stderr);
  if (reportedSessionId) {
    return reportedSessionId;
  }
  if (!sessionsBefore) {
    return undefined;
  }

  const sessionsAfter = await listKiroSessionIds();
  const createdSessionIds = [...sessionsAfter].filter((sessionId) => !sessionsBefore.has(sessionId));
  if (createdSessionIds.length > 1) {
    throw new Error("multiple new kiro sessions were discovered");
  }
  return createdSessionIds[0];
}

async function listKiroSessionIds() {
  const output = await runKiroUtility(["chat", "--list-sessions", "--format", "json"]);
  const groups = JSON.parse(output);
  if (!Array.isArray(groups)) {
    throw new Error("kiro session list returned invalid output");
  }

  const sessionIds = new Set();
  for (const group of groups) {
    if (!group || group.cwd !== process.cwd() || !Array.isArray(group.sessions)) {
      continue;
    }
    for (const session of group.sessions) {
      if (isKiroSessionId(session?.sessionId)) {
        sessionIds.add(session.sessionId);
      }
    }
  }
  return sessionIds;
}

function runKiroUtility(utilityArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, utilityArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("kiro session list timed out"));
    }, Math.min(timeoutMs, 10000));

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error("kiro session list failed to start"));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error("kiro session list failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString());
    });
  });
}

async function withNewSessionCreationLock(operation) {
  const previous = newSessionCreationTail;
  let release;
  const ticket = new Promise((resolve) => {
    release = resolve;
  });
  newSessionCreationTail = previous.then(() => ticket);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function stripResumeHint(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => !kiroResumeIdPattern.test(line))
    .join("\n");
}

function isKiroSessionId(value) {
  return typeof value === "string" && kiroSessionIdPattern.test(value);
}

function redact(text) {
  return text
    .replace(/(token|secret|api[_-]?key|password)=\S+/gi, "$1=[REDACTED]")
    .replace(/\/Users\/\S+/g, "[PATH]")
    .trim();
}
