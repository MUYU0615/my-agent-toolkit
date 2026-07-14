#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const port = Number.parseInt(process.env.KIRO_HOST_RELAY_PORT ?? "8210", 10);
const host = process.env.KIRO_HOST_RELAY_HOST ?? "127.0.0.1";
const command = process.env.KIRO_COMMAND ?? "/Users/dujiepeng/.local/bin/kiro-cli";
const args = parseArgs(process.env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools");
const timeoutMs = Number.parseInt(process.env.KIRO_TIMEOUT_MS ?? "300000", 10);
const relayAuthToken = process.env.KIRO_RELAY_AUTH_TOKEN?.trim();
const workspaceRoot = initializeWorkspaceRoot(
  process.env.KIRO_WORKSPACE_ROOT ?? join(homedir(), "Documents", "KiroBotWorkspaces"),
);
const kiroSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kiroResumeIdPattern = /--resume-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const newSessionCreationTails = new Map();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { service: "kiro-host-relay", status: "ok" });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/kiro/chat/stream") {
    try {
      assertRelayAuthorized(request);
      const payload = JSON.parse(await readBody(request));
      if (typeof payload.prompt !== "string") {
        writeJson(response, 400, { error: "prompt is required" });
        return;
      }
      const runtimeWorkspace = resolveRuntimeWorkspace(payload);
      const { botRoot, workspaceDir, kiroHome } = runtimeWorkspace;
      const runtimeEnv = prepareRuntimeEnv(payload, botRoot, kiroHome);

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      const requestArgs = argsFromPayload(payload);
      const providerSessionId = await runWithSessionDiscovery(
        requestArgs,
        workspaceDir,
        runtimeEnv,
        (sessionsBefore) => streamKiro(payload.prompt, requestArgs, (event) => {
          response.write(`${JSON.stringify(event)}\n`);
        }, sessionsBefore, workspaceDir, runtimeEnv),
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
    assertRelayAuthorized(request);
    const payload = JSON.parse(await readBody(request));
    if (typeof payload.prompt !== "string") {
      writeJson(response, 400, { error: "prompt is required" });
      return;
    }
    const runtimeWorkspace = resolveRuntimeWorkspace(payload);
    const { botRoot, workspaceDir, kiroHome } = runtimeWorkspace;
    const runtimeEnv = prepareRuntimeEnv(payload, botRoot, kiroHome);

    const requestArgs = argsFromPayload(payload);
    const result = await runWithSessionDiscovery(
      requestArgs,
      workspaceDir,
      runtimeEnv,
      (sessionsBefore) => runKiro(
        payload.prompt,
        requestArgs,
        sessionsBefore,
        workspaceDir,
        runtimeEnv,
      ),
    );
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, error instanceof RelayRequestError ? 400 : 502, {
      error: error instanceof Error ? error.message : "kiro relay failed",
    });
  }
});

server.listen(port, host, () => {
  console.log(`kiro host relay listening on http://${host}:${port}`);
  console.log(`kiro workspace root: ${workspaceRoot}`);
});

function runKiro(prompt, requestArgs = args, sessionsBefore, workspaceDir, runtimeEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
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
          workspaceDir,
          runtimeEnv,
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

function streamKiro(
  prompt,
  requestArgs = args,
  onEvent,
  sessionsBefore,
  workspaceDir,
  runtimeEnv = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
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
          workspaceDir,
          runtimeEnv,
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

class RelayRequestError extends Error {}

function assertRelayAuthorized(request) {
  if (!relayAuthToken) {
    return;
  }
  const expected = Buffer.from(`Bearer ${relayAuthToken}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new RelayRequestError("unauthorized relay request");
  }
}

function prepareRuntimeEnv(payload, botRoot, kiroHome) {
  if (
    payload.runtime_env !== undefined
    && (!payload.runtime_env || typeof payload.runtime_env !== "object" || Array.isArray(payload.runtime_env))
  ) {
    throw new RelayRequestError("runtime_env must be an object");
  }
  const result = {};
  for (const [key, value] of Object.entries(payload.runtime_env ?? {})) {
    if (!isAllowedRuntimeEnvKey(key) || typeof value !== "string" || value.length === 0) {
      throw new RelayRequestError("runtime_env contains an unsupported value");
    }
    result[key] = value;
  }
  if (Object.keys(result).length > 0 && !relayAuthToken) {
    throw new RelayRequestError("relay auth token is required for credential forwarding");
  }
  result.MY_AGENT_RUNTIME = "wecom";
  result.KIRO_HOME = kiroHome;
  if (result.EASEMOB_JIRA_USERNAME || result.EASEMOB_JIRA_PASSWORD) {
    if (!result.EASEMOB_JIRA_USERNAME || !result.EASEMOB_JIRA_PASSWORD) {
      throw new RelayRequestError("Jira username and password must be provided together");
    }
    const userHash = hashUserId(payload.user_id);
    const credentialVersion = result.MY_AGENT_JIRA_CREDENTIAL_VERSION ?? "legacy";
    const credentialHash = createHash("sha256")
      .update(credentialVersion, "utf8")
      .digest("hex")
      .slice(0, 16);
    delete result.MY_AGENT_JIRA_CREDENTIAL_VERSION;
    const jiraRoot = join(botRoot, ".runtime", "users", userHash, "jira");
    const jiraDirectory = join(jiraRoot, credentialHash);
    ensurePrivateDirectory(join(botRoot, ".runtime"));
    ensurePrivateDirectory(join(botRoot, ".runtime", "users"));
    ensurePrivateDirectory(join(botRoot, ".runtime", "users", userHash));
    ensurePrivateDirectory(jiraRoot);
    ensurePrivateDirectory(jiraDirectory);
    result.EASEMOB_JIRA_COOKIE_FILE = join(jiraDirectory, "cookies.json");
  }
  return result;
}

function isAllowedRuntimeEnvKey(key) {
  return [
    "EASEMOB_JIRA_USERNAME",
    "EASEMOB_JIRA_PASSWORD",
    "EASEMOB_JIRA_REDIRECT_USERNAME",
    "EASEMOB_JIRA_REDIRECT_PASSWORD",
    "MY_AGENT_JIRA_CREDENTIAL_VERSION",
  ].includes(key);
}

function ensurePrivateDirectory(directory) {
  ensureSafeDirectory(directory);
  chmodSync(directory, 0o700);
}

function childProcessEnv(runtimeEnv) {
  const env = { ...process.env };
  delete env.KIRO_RELAY_AUTH_TOKEN;
  delete env.USER_CREDENTIALS_MASTER_KEY;
  delete env.USER_CREDENTIALS_INTERNAL_TOKEN;
  return {
    ...env,
    ...runtimeEnv,
    NO_COLOR: "1",
    KIRO_LOG_NO_COLOR: "1",
  };
}

function initializeWorkspaceRoot(configuredRoot) {
  const absoluteRoot = resolve(configuredRoot);
  mkdirSync(absoluteRoot, { recursive: true });
  return realpathSync(absoluteRoot);
}

function resolveBotWorkspace(botId) {
  if (
    typeof botId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(botId)
  ) {
    throw new RelayRequestError("bot_id must be a safe path segment");
  }

  const candidate = resolve(workspaceRoot, botId);
  if (!isPathInside(workspaceRoot, candidate)) {
    throw new RelayRequestError("bot workspace must stay inside KIRO_WORKSPACE_ROOT");
  }

  ensureSafeDirectory(candidate);
  ensureSafeDirectory(join(candidate, ".kiro"));
  ensureSafeDirectory(join(candidate, ".kiro", "agents"));
  ensureSafeDirectory(join(candidate, ".kiro", "skills"));
  return realpathSync(candidate);
}

function resolveRuntimeWorkspace(payload) {
  const botRoot = resolveBotWorkspace(payload.bot_id);
  if (
    typeof payload.user_id !== "string"
    || payload.user_id.trim() === ""
    || payload.user_id.length > 256
  ) {
    throw new RelayRequestError("user_id is required");
  }
  if (
    typeof payload.conversation_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.conversation_id)
  ) {
    throw new RelayRequestError("conversation_id must be a safe path segment");
  }

  const userHash = hashUserId(payload.user_id);
  const usersRoot = join(botRoot, "users");
  const userRoot = join(usersRoot, userHash);
  const conversationsRoot = join(userRoot, "conversations");
  const workspaceDir = join(conversationsRoot, payload.conversation_id);
  for (const directory of [usersRoot, userRoot, conversationsRoot, workspaceDir]) {
    ensureSafeDirectory(directory);
  }
  ensureSafeDirectory(join(workspaceDir, "projects"));
  ensureSafeDirectory(join(workspaceDir, "artifacts"));

  return {
    botRoot,
    workspaceDir: realpathSync(workspaceDir),
    kiroHome: realpathSync(join(botRoot, ".kiro")),
  };
}

function hashUserId(userId) {
  return createHash("sha256")
    .update(userId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function ensureSafeDirectory(directory) {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RelayRequestError("bot workspace contains an unsafe path");
    }
  } else {
    mkdirSync(directory);
  }

  const realDirectory = realpathSync(directory);
  if (!isPathInside(workspaceRoot, realDirectory)) {
    throw new RelayRequestError("bot workspace must stay inside KIRO_WORKSPACE_ROOT");
  }
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
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

async function runWithSessionDiscovery(requestArgs, workspaceDir, runtimeEnv, operation) {
  if (extractProviderSessionId(requestArgs, "", "")) {
    return operation(undefined);
  }

  return withNewSessionCreationLock(workspaceDir, async () => {
    const sessionsBefore = await listKiroSessionIds(
      workspaceDir,
      sessionUtilityEnv(runtimeEnv),
    ).catch(() => undefined);
    return operation(sessionsBefore);
  });
}

async function resolveProviderSessionId(
  requestArgs,
  stdout,
  stderr,
  sessionsBefore,
  workspaceDir,
  runtimeEnv,
) {
  const reportedSessionId = extractProviderSessionId(requestArgs, stdout, stderr);
  if (reportedSessionId) {
    return reportedSessionId;
  }
  if (!sessionsBefore) {
    return undefined;
  }

  const sessionsAfter = await listKiroSessionIds(
    workspaceDir,
    sessionUtilityEnv(runtimeEnv),
  );
  const createdSessionIds = [...sessionsAfter].filter((sessionId) => !sessionsBefore.has(sessionId));
  if (createdSessionIds.length > 1) {
    throw new Error("multiple new kiro sessions were discovered");
  }
  return createdSessionIds[0];
}

async function listKiroSessionIds(workspaceDir, runtimeEnv = {}) {
  const output = await runKiroUtility(["chat", "--list-sessions", "--format", "json"], workspaceDir, runtimeEnv);
  const groups = JSON.parse(output);
  if (!Array.isArray(groups)) {
    throw new Error("kiro session list returned invalid output");
  }

  const sessionIds = new Set();
  for (const group of groups) {
    if (!group || group.cwd !== workspaceDir || !Array.isArray(group.sessions)) {
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

function sessionUtilityEnv(runtimeEnv) {
  return typeof runtimeEnv.KIRO_HOME === "string"
    ? { KIRO_HOME: runtimeEnv.KIRO_HOME }
    : {};
}

function runKiroUtility(utilityArgs, workspaceDir, runtimeEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, utilityArgs, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
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

async function withNewSessionCreationLock(workspaceDir, operation) {
  const previous = newSessionCreationTails.get(workspaceDir) ?? Promise.resolve();
  let release;
  const ticket = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => ticket);
  newSessionCreationTails.set(workspaceDir, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (newSessionCreationTails.get(workspaceDir) === tail) {
      newSessionCreationTails.delete(workspaceDir);
    }
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
