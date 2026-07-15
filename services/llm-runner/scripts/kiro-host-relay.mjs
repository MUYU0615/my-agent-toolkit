#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
const activeRuns = new Map();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { service: "kiro-host-relay", status: "ok" });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/kiro/cancel") {
    try {
      assertRelayAuthorized(request);
      const payload = JSON.parse(await readBody(request));
      const key = runKeyFromPayload(payload);
      const activeRun = activeRuns.get(key);
      if (!activeRun) {
        writeJson(response, 200, { cancelled: false });
        return;
      }
      activeRun.cancelled = true;
      activeRun.child.kill("SIGTERM");
      writeJson(response, 200, { cancelled: true });
    } catch (error) {
      writeJson(response, error instanceof RelayRequestError ? 400 : 502, {
        error: error instanceof Error ? error.message : "kiro relay cancellation failed",
      });
    }
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
      const runtimeEnv = prepareRuntimeEnv(payload, botRoot, workspaceDir, kiroHome);

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      const requestArgs = argsFromPayload(payload);
      const runtimeResult = await runWithSessionDiscovery(
        requestArgs,
        workspaceDir,
        runtimeEnv,
        (effectiveArgs, sessionsBefore) => streamKiro(payload.prompt, effectiveArgs, (event) => {
          response.write(`${JSON.stringify(event)}\n`);
        }, sessionsBefore, workspaceDir, runtimeEnv, runKeyFromPayload(payload)),
      );
      response.write(`${JSON.stringify({
        type: "session",
        provider_session_id: runtimeResult.provider_session_id,
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
        ...(error instanceof RelayCancelledError ? { code: "runtime_cancelled" } : {}),
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
    const runtimeEnv = prepareRuntimeEnv(payload, botRoot, workspaceDir, kiroHome);

    const requestArgs = argsFromPayload(payload);
    const result = await runWithSessionDiscovery(
      requestArgs,
      workspaceDir,
      runtimeEnv,
      (effectiveArgs, sessionsBefore) => runKiro(
        payload.prompt,
        effectiveArgs,
        sessionsBefore,
        workspaceDir,
        runtimeEnv,
        runKeyFromPayload(payload),
      ),
    );
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, error instanceof RelayRequestError ? 400 : error instanceof RelayCancelledError ? 409 : 502, {
      error: error instanceof Error ? error.message : "kiro relay failed",
      ...(error instanceof RelayCancelledError ? { code: "runtime_cancelled" } : {}),
    });
  }
});

server.listen(port, host, () => {
  console.log(`kiro host relay listening on http://${host}:${port}`);
  console.log(`kiro workspace root: ${workspaceRoot}`);
});

function runKiro(prompt, requestArgs = args, sessionsBefore, workspaceDir, runtimeEnv = {}, runKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
    });
    const activeRun = registerActiveRun(runKey, child);
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveRun(runKey, activeRun);
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
      clearActiveRun(runKey, activeRun);
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearActiveRun(runKey, activeRun);
      if (activeRun?.cancelled) {
        reject(new RelayCancelledError());
        return;
      }
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
  runKey,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
    });
    const activeRun = registerActiveRun(runKey, child);
    const stderr = [];
    const stdout = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveRun(runKey, activeRun);
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
      clearActiveRun(runKey, activeRun);
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearActiveRun(runKey, activeRun);
      if (activeRun?.cancelled) {
        reject(new RelayCancelledError());
        return;
      }
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
        resolve({
          provider_session_id: providerSessionId,
          has_visible_output: stdout.some((chunk) => stripResumeHint(chunk.toString()).trim()),
        });
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
class RelayCancelledError extends Error {
  constructor() {
    super("kiro runtime cancelled");
  }
}

function runKeyFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new RelayRequestError("request body is required");
  }
  if (
    typeof payload.bot_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.bot_id)
  ) {
    throw new RelayRequestError("bot_id must be a safe path segment");
  }
  if (typeof payload.user_id !== "string" || payload.user_id.trim() === "" || payload.user_id.length > 256) {
    throw new RelayRequestError("user_id is required");
  }
  if (
    typeof payload.conversation_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.conversation_id)
  ) {
    throw new RelayRequestError("conversation_id must be a safe path segment");
  }
  return `${payload.bot_id}:${hashUserId(payload.user_id)}:${payload.conversation_id}`;
}

function registerActiveRun(runKey, child) {
  if (!runKey) {
    return undefined;
  }
  const activeRun = { child, cancelled: false };
  activeRuns.set(runKey, activeRun);
  return activeRun;
}

function clearActiveRun(runKey, activeRun) {
  if (runKey && activeRuns.get(runKey) === activeRun) {
    activeRuns.delete(runKey);
  }
}

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

function prepareRuntimeEnv(payload, botRoot, workspaceDir, kiroHome) {
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
  const projectDotenv = result.MY_AGENT_PROJECT_DOTENV_B64;
  delete result.MY_AGENT_PROJECT_DOTENV_B64;
  if (projectDotenv) {
    const managedProjectEnv = materializeProjectDotenv(botRoot, workspaceDir, projectDotenv);
    for (const [key, value] of Object.entries(managedProjectEnv)) {
      if (value && isAllowedRuntimeEnvKey(key) && result[key] === undefined) {
        result[key] = value;
      }
    }
  }
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
  if ([
    "EASEMOB_JIRA_USERNAME",
    "EASEMOB_JIRA_PASSWORD",
    "EASEMOB_JIRA_REDIRECT_USERNAME",
    "EASEMOB_JIRA_REDIRECT_PASSWORD",
    "MY_AGENT_JIRA_CREDENTIAL_VERSION",
    "MY_AGENT_PROJECT_DOTENV_B64",
  ].includes(key)) return true;
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) return false;
  return ![
    "PATH", "HOME", "SHELL", "NODE_OPTIONS", "KIRO_HOME", "KIRO_RELAY_AUTH_TOKEN",
    "USER_CREDENTIALS_MASTER_KEY", "USER_CREDENTIALS_INTERNAL_TOKEN",
  ].includes(key) && !key.startsWith("LD_") && !key.startsWith("DYLD_");
}

function materializeProjectDotenv(botRoot, workspaceDir, encodedContent) {
  let content;
  try {
    content = Buffer.from(encodedContent, "base64").toString("utf8");
  } catch {
    throw new RelayRequestError("project .env payload is invalid");
  }
  if (!content || Buffer.byteLength(content, "utf8") > 256 * 1024) {
    throw new RelayRequestError("project .env payload is invalid");
  }
  const configuredEnv = parseProjectDotenv(content);
  const configuredPython = configuredEnv.IM_TEST_HUB_PYTHON;
  if (configuredPython) {
    const managedPython = createManagedPythonLauncher(botRoot, configuredPython);
    content = replaceDotenvAssignment(content, "IM_TEST_HUB_PYTHON", managedPython);
  }
  const projectsRoot = join(workspaceDir, "projects");
  const runtimePath = join(workspaceDir, ".runtime");
  ensureSafeDirectory(runtimePath);
  const runtimeRoot = realpathSync(runtimePath);
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
    const projectRoot = realpathSync(join(projectsRoot, entry.name));
    if (!isPathInside(projectsRoot, projectRoot)) throw new RelayRequestError("project workspace is unsafe");
    const dotenvPath = join(projectRoot, ".env");
    const markerPath = join(runtimeRoot, `${entry.name}.dotenv-managed`);
    if (existsSync(dotenvPath) && !existsSync(markerPath)) {
      throw new RelayRequestError("project contains an unmanaged .env file");
    }
    writeFileSync(dotenvPath, content, { mode: 0o600 });
    writeFileSync(markerPath, "managed\n", { mode: 0o600 });
  }
  return parseProjectDotenv(content);
}

function createManagedPythonLauncher(botRoot, interpreterPath) {
  if (!isAbsolute(interpreterPath) || !existsSync(interpreterPath)) {
    throw new RelayRequestError("IM_TEST_HUB_PYTHON must be an existing absolute path");
  }
  const runtimeRoot = join(botRoot, ".runtime");
  const launchersRoot = join(runtimeRoot, "python-launchers");
  const launcherRoot = join(
    launchersRoot,
    createHash("sha256").update(interpreterPath, "utf8").digest("hex").slice(0, 24),
  );
  for (const directory of [runtimeRoot, launchersRoot, launcherRoot]) {
    ensurePrivateDirectory(directory);
  }
  const launcherPath = join(launcherRoot, "python");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nexec ${shellQuote(interpreterPath)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(launcherPath, 0o700);
  return launcherPath;
}

function replaceDotenvAssignment(content, key, value) {
  const assignment = new RegExp(`^(\\s*(?:export\\s+)?${key}=).*$`);
  let replaced = false;
  const result = content.split(/\r?\n/).map((line) => {
    if (!assignment.test(line)) return line;
    replaced = true;
    return line.replace(assignment, `$1${value}`);
  }).join("\n");
  if (!replaced) throw new RelayRequestError(`${key} is missing from project .env`);
  return result;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseProjectDotenv(content) {
  const env = {};
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new RelayRequestError(`project .env line ${index + 1} is invalid`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
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

function extractRequestedProviderSessionId(requestArgs) {
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

  return undefined;
}

function extractReportedProviderSessionId(stdout, stderr) {
  const matches = [...`${stderr}\n${stdout}`.matchAll(
    new RegExp(kiroResumeIdPattern.source, "ig"),
  )];
  return matches.length > 0 ? matches.at(-1)?.[1] : undefined;
}

function extractProviderSessionId(requestArgs, stdout, stderr) {
  // Kiro may compact a resumed conversation into a successor session. Its
  // completion hint is authoritative; the requested id is only a fallback.
  return extractReportedProviderSessionId(stdout, stderr)
    ?? extractRequestedProviderSessionId(requestArgs);
}

async function runWithSessionDiscovery(requestArgs, workspaceDir, runtimeEnv, operation) {
  const requestedSessionId = extractRequestedProviderSessionId(requestArgs);
  if (requestedSessionId) {
    const result = await operation(requestArgs, undefined);
    if (
      !hasVisibleRuntimeOutput(result)
      && result?.provider_session_id === requestedSessionId
    ) {
      const successorSessionId = await findSuccessorSessionId(
        requestedSessionId,
        workspaceDir,
        sessionUtilityEnv(runtimeEnv),
      ).catch(() => undefined);
      if (successorSessionId) {
        return operation(replaceResumeId(requestArgs, successorSessionId), undefined);
      }
    }
    return result;
  }

  return withNewSessionCreationLock(workspaceDir, async () => {
    const sessionsBefore = await listKiroSessionIds(
      workspaceDir,
      sessionUtilityEnv(runtimeEnv),
    ).catch(() => undefined);
    return operation(requestArgs, sessionsBefore);
  });
}

function hasVisibleRuntimeOutput(result) {
  if (typeof result?.output === "string") {
    return result.output.trim().length > 0;
  }
  return result?.has_visible_output === true;
}

function replaceResumeId(requestArgs, providerSessionId) {
  const nextArgs = [...requestArgs];
  const resumeIdIndex = nextArgs.indexOf("--resume-id");
  if (resumeIdIndex >= 0) {
    nextArgs[resumeIdIndex + 1] = providerSessionId;
    return nextArgs;
  }
  const inlineResumeIdIndex = nextArgs.findIndex((item) => item.startsWith("--resume-id="));
  if (inlineResumeIdIndex >= 0) {
    nextArgs[inlineResumeIdIndex] = `--resume-id=${providerSessionId}`;
  }
  return nextArgs;
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

async function findSuccessorSessionId(requestedSessionId, workspaceDir, runtimeEnv) {
  const sessions = await listKiroSessions(workspaceDir, runtimeEnv);
  const requestedSession = sessions.find((session) => session.sessionId === requestedSessionId);
  const candidates = sessions
    .filter((session) => session.sessionId !== requestedSessionId)
    .filter((session) => !requestedSession || session.updatedAt >= requestedSession.updatedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return candidates[0]?.sessionId;
}

async function listKiroSessionIds(workspaceDir, runtimeEnv = {}) {
  const sessions = await listKiroSessions(workspaceDir, runtimeEnv);
  return new Set(sessions.map((session) => session.sessionId));
}

async function listKiroSessions(workspaceDir, runtimeEnv = {}) {
  const output = await runKiroUtility(["chat", "--list-sessions", "--format", "json"], workspaceDir, runtimeEnv);
  const groups = JSON.parse(output);
  if (!Array.isArray(groups)) {
    throw new Error("kiro session list returned invalid output");
  }

  const sessions = [];
  for (const group of groups) {
    if (!group || group.cwd !== workspaceDir || !Array.isArray(group.sessions)) {
      continue;
    }
    for (const session of group.sessions) {
      if (isKiroSessionId(session?.sessionId)) {
        sessions.push({
          sessionId: session.sessionId,
          updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : "",
        });
      }
    }
  }
  return sessions;
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
