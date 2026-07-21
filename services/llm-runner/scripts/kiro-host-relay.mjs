#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const port = Number.parseInt(process.env.KIRO_HOST_RELAY_PORT ?? "8210", 10);
const host = process.env.KIRO_HOST_RELAY_HOST ?? "127.0.0.1";
const command = process.env.KIRO_COMMAND ?? "/Users/dujiepeng/.local/bin/kiro-cli";
const claudeCommand = process.env.CLAUDE_CODE_COMMAND ?? join(homedir(), ".local", "bin", "claude");
const args = parseArgs(process.env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools");
const timeoutMs = Number.parseInt(process.env.KIRO_TIMEOUT_MS ?? "900000", 10);
const streamHeartbeatIntervalMs = Number.parseInt(
  process.env.KIRO_RELAY_HEARTBEAT_INTERVAL_MS ?? "25000",
  10,
);
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
      const provider = providerFromPayload(payload);
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
    let heartbeat;
    let removeDisconnectHandler = () => {};
    try {
      assertRelayAuthorized(request);
      const payload = JSON.parse(await readBody(request));
      const provider = providerFromPayload(payload);
      if (typeof payload.prompt !== "string") {
        writeJson(response, 400, { error: "prompt is required" });
        return;
      }
      const runtimeWorkspace = resolveRuntimeWorkspace(payload);
      const { botRoot, userRoot, workspaceDir, kiroHome } = runtimeWorkspace;
      const runtimeEnv = prepareRuntimeEnv(payload, botRoot, userRoot, workspaceDir, kiroHome);
      const projectCheckpoint = createProjectCheckpoint(userRoot);
      const runKey = runKeyFromPayload(payload);
      const cancelOnDisconnect = () => {
        if (response.writableEnded) return;
        cancelActiveRun(runKey);
      };
      response.once("close", cancelOnDisconnect);
      removeDisconnectHandler = () => response.off("close", cancelOnDisconnect);

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      response.flushHeaders();
      heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
        }
      }, streamHeartbeatIntervalMs);
      heartbeat.unref?.();
      const requestArgs = argsFromPayload(payload, provider);
      const onEvent = (event) => response.write(`${JSON.stringify(event)}\n`);
      const runtimeResult = provider === "claude-code"
        ? await streamClaude(payload.prompt, requestArgs, onEvent, botRoot, workspaceDir, runtimeEnv, runKey, projectCheckpoint)
        : await runWithSessionDiscovery(
          requestArgs,
          workspaceDir,
          runtimeEnv,
          (effectiveArgs, sessionsBefore) => streamKiro(payload.prompt, effectiveArgs, onEvent, sessionsBefore, workspaceDir, runtimeEnv, runKey, projectCheckpoint),
        );
      response.write(`${JSON.stringify({
        type: "session",
        provider_session_id: runtimeResult.provider_session_id,
      })}\n`);
      response.end(`${JSON.stringify({ type: "done" })}\n`);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        });
      }
      if (!response.destroyed && !response.writableEnded) {
        response.end(`${JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : "kiro relay failed",
          ...(error instanceof RelayCancelledError
            ? { code: "runtime_cancelled" }
            : error instanceof RelayTimeoutError
              ? { code: "runtime_timeout" }
              : {}),
        })}\n`);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      removeDisconnectHandler();
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
    const provider = providerFromPayload(payload);
    if (typeof payload.prompt !== "string") {
      writeJson(response, 400, { error: "prompt is required" });
      return;
    }
    const runtimeWorkspace = resolveRuntimeWorkspace(payload);
    const { botRoot, userRoot, workspaceDir, kiroHome } = runtimeWorkspace;
    const runtimeEnv = prepareRuntimeEnv(payload, botRoot, userRoot, workspaceDir, kiroHome);
    const projectCheckpoint = createProjectCheckpoint(userRoot);

    const requestArgs = argsFromPayload(payload, provider);
    const result = provider === "claude-code"
      ? await runClaude(payload.prompt, requestArgs, botRoot, workspaceDir, runtimeEnv, runKeyFromPayload(payload), projectCheckpoint)
      : await runWithSessionDiscovery(
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
          projectCheckpoint,
        ),
      );
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(
      response,
      error instanceof RelayRequestError ? 400 : error instanceof RelayCancelledError ? 409 : error instanceof RelayTimeoutError ? 504 : 502,
      {
      error: error instanceof Error ? error.message : "kiro relay failed",
      ...(error instanceof RelayCancelledError
        ? { code: "runtime_cancelled" }
        : error instanceof RelayTimeoutError
          ? { code: "runtime_timeout" }
          : {}),
      },
    );
  }
});

server.listen(port, host, () => {
  console.log(`kiro host relay listening on http://${host}:${port}`);
  console.log(`kiro workspace root: ${workspaceRoot}`);
});

function runKiro(prompt, requestArgs = args, sessionsBefore, workspaceDir, runtimeEnv = {}, runKey, projectCheckpoint) {
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
      rollbackProjectCheckpoint(projectCheckpoint);
      reject(new RelayTimeoutError());
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
      rollbackProjectCheckpoint(projectCheckpoint);
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
        rollbackProjectCheckpoint(projectCheckpoint);
        reject(new RelayCancelledError());
        return;
      }
      if (code !== 0) {
        rollbackProjectCheckpoint(projectCheckpoint);
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
          rollbackProjectCheckpoint(projectCheckpoint);
          reject(new Error("kiro runtime did not report a session id"));
          return;
        }
        discardProjectCheckpoint(projectCheckpoint);
        resolve({
          output: stripResumeHint(stdoutText),
          provider_session_id: providerSessionId,
        });
      } catch (error) {
        rollbackProjectCheckpoint(projectCheckpoint);
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
  projectCheckpoint,
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
      rollbackProjectCheckpoint(projectCheckpoint);
      reject(new RelayTimeoutError());
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
      rollbackProjectCheckpoint(projectCheckpoint);
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
        rollbackProjectCheckpoint(projectCheckpoint);
        reject(new RelayCancelledError());
        return;
      }
      if (code !== 0) {
        rollbackProjectCheckpoint(projectCheckpoint);
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
          rollbackProjectCheckpoint(projectCheckpoint);
          reject(new Error("kiro runtime did not report a session id"));
          return;
        }
        discardProjectCheckpoint(projectCheckpoint);
        resolve({
          provider_session_id: providerSessionId,
          has_visible_output: stdout.some((chunk) => stripResumeHint(chunk.toString()).trim()),
        });
      } catch (error) {
        rollbackProjectCheckpoint(projectCheckpoint);
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function runClaude(prompt, requestArgs, botRoot, workspaceDir, runtimeEnv = {}, runKey, projectCheckpoint) {
  return runClaudeProcess(prompt, requestArgs, undefined, botRoot, workspaceDir, runtimeEnv, runKey, projectCheckpoint);
}

function streamClaude(prompt, requestArgs, onEvent, botRoot, workspaceDir, runtimeEnv = {}, runKey, projectCheckpoint) {
  return runClaudeProcess(prompt, requestArgs, onEvent, botRoot, workspaceDir, runtimeEnv, runKey, projectCheckpoint);
}

function runClaudeProcess(prompt, requestArgs, onEvent, botRoot, workspaceDir, runtimeEnv, runKey, projectCheckpoint) {
  return new Promise((resolve, reject) => {
    const providerSessionId = extractClaudeSessionId(requestArgs);
    if (!providerSessionId) {
      reject(new RelayRequestError("claude-code requires --session-id or --resume with a UUID"));
      return;
    }
    const cleanupSkills = materializeClaudeSkills(botRoot, workspaceDir);
    const child = spawn(claudeCommand, requestArgs, {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessEnv(runtimeEnv),
    });
    const activeRun = registerActiveRun(runKey, child);
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearActiveRun(runKey, activeRun);
      child.kill("SIGTERM");
      cleanupSkills();
      rollbackProjectCheckpoint(projectCheckpoint);
      reject(new RelayTimeoutError());
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (onEvent) {
        const content = chunk.toString();
        if (content) onEvent({ type: "chunk", content });
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearActiveRun(runKey, activeRun);
      clearTimeout(timeout);
      cleanupSkills();
      rollbackProjectCheckpoint(projectCheckpoint);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearActiveRun(runKey, activeRun);
      cleanupSkills();
      if (activeRun?.cancelled) {
        rollbackProjectCheckpoint(projectCheckpoint);
        reject(new RelayCancelledError());
        return;
      }
      if (code !== 0) {
        rollbackProjectCheckpoint(projectCheckpoint);
        reject(new Error(`claude-code runtime exited with code ${code ?? "unknown"}: ${redact(Buffer.concat(stderr).toString())}`));
        return;
      }
      discardProjectCheckpoint(projectCheckpoint);
      resolve(onEvent
        ? { provider_session_id: providerSessionId, has_visible_output: stdout.some((chunk) => chunk.toString().trim()) }
        : { output: Buffer.concat(stdout).toString(), provider_session_id: providerSessionId });
    });
    child.stdin.end(prompt);
  });
}

function materializeClaudeSkills(botRoot, workspaceDir) {
  const source = join(botRoot, ".claude", "skills");
  const claudeRoot = join(workspaceDir, ".claude");
  const destination = join(claudeRoot, "skills");
  ensureSafeDirectory(claudeRoot);
  rmSync(destination, { recursive: true, force: true });
  if (existsSync(source)) {
    cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  } else {
    mkdirSync(destination);
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(destination, { recursive: true, force: true });
  };
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
class RelayTimeoutError extends Error {
  constructor() {
    super("任务执行超过时间限制，已自动停止并丢弃本次更改");
  }
}

function createProjectCheckpoint(userRoot) {
  const projectsRoot = join(userRoot, "projects");
  const checkpointRoot = mkdtempSync(join(tmpdir(), "kiro-project-checkpoint-"));
  const repositories = [];
  try {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const repositoryRoot = join(projectsRoot, entry.name);
      if (!existsSync(join(repositoryRoot, ".git"))) continue;
      const head = gitOutput(repositoryRoot, ["rev-parse", "HEAD"]).trim();
      const branch = gitOutput(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], true).trim();
      const stashCommit = gitOutput(repositoryRoot, ["stash", "create", "kiro-runtime-checkpoint"], true).trim();
      const untrackedFiles = gitOutput(
        repositoryRoot,
        ["ls-files", "--others", "--exclude-standard", "-z"],
      ).split("\0").filter(Boolean);
      const untrackedRoot = join(checkpointRoot, String(repositories.length), "untracked");
      for (const file of untrackedFiles) {
        const source = join(repositoryRoot, file);
        const destination = join(untrackedRoot, file);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { recursive: true, preserveTimestamps: true, dereference: false });
      }
      repositories.push({ repositoryRoot, head, branch, stashCommit, untrackedFiles, untrackedRoot });
    }
    return { checkpointRoot, repositories, settled: false };
  } catch (error) {
    rmSync(checkpointRoot, { recursive: true, force: true });
    throw new RelayRequestError(
      `无法创建任务回滚点：${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function rollbackProjectCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.settled) return;
  checkpoint.settled = true;
  try {
    for (const repository of checkpoint.repositories) {
      if (repository.branch) {
        gitOutput(repository.repositoryRoot, ["checkout", "--force", repository.branch]);
      } else {
        gitOutput(repository.repositoryRoot, ["checkout", "--detach", "--force", repository.head]);
      }
      gitOutput(repository.repositoryRoot, ["reset", "--hard", repository.head]);
      gitOutput(repository.repositoryRoot, ["clean", "-fd"]);
      if (repository.stashCommit) {
        gitOutput(repository.repositoryRoot, ["stash", "apply", "--index", repository.stashCommit]);
      }
      for (const file of repository.untrackedFiles) {
        const source = join(repository.untrackedRoot, file);
        const destination = join(repository.repositoryRoot, file);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { recursive: true, preserveTimestamps: true, dereference: false });
      }
    }
  } catch (error) {
    console.error("kiro project rollback failed", error);
  } finally {
    rmSync(checkpoint.checkpointRoot, { recursive: true, force: true });
  }
}

function discardProjectCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.settled) return;
  checkpoint.settled = true;
  rmSync(checkpoint.checkpointRoot, { recursive: true, force: true });
}

function gitOutput(repositoryRoot, gitArgs, allowFailure = false) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function runKeyFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new RelayRequestError("request body is required");
  }
  if (payload.system_flow === true) {
    const { flowId, runId } = requireSystemFlowIdentity(payload);
    return `flow:${flowId}:${runId}`;
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

function cancelActiveRun(runKey) {
  const activeRun = activeRuns.get(runKey);
  if (!activeRun) return false;
  activeRun.cancelled = true;
  activeRun.child.kill("SIGTERM");
  return true;
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

function prepareRuntimeEnv(payload, botRoot, userRoot, workspaceDir, kiroHome) {
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
  result.MY_AGENT_RUNTIME = payload.system_flow === true ? "system-flow" : "wecom";
  result.KIRO_HOME = kiroHome;
  result.MY_AGENT_GIT_GUARD_PATH = createGitCommandGuard(botRoot);
  const projectDotenv = result.MY_AGENT_PROJECT_DOTENV_B64;
  delete result.MY_AGENT_PROJECT_DOTENV_B64;
  if (projectDotenv) {
    const managedProjectEnv = materializeProjectDotenv(botRoot, userRoot, projectDotenv);
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
    const userHash = payload.system_flow === true
      ? createHash("sha256").update(requireSystemFlowIdentity(payload).flowId, "utf8").digest("hex").slice(0, 32)
      : hashUserId(payload.user_id);
    const credentialVersion = result.MY_AGENT_JIRA_CREDENTIAL_VERSION ?? "legacy";
    const credentialHash = createHash("sha256")
      .update(credentialVersion, "utf8")
      .digest("hex")
      .slice(0, 16);
    delete result.MY_AGENT_JIRA_CREDENTIAL_VERSION;
    const jiraRoot = payload.system_flow === true
      ? join(botRoot, ".runtime", "jira")
      : join(botRoot, ".runtime", "users", userHash, "jira");
    const jiraDirectory = join(jiraRoot, credentialHash);
    ensurePrivateDirectory(join(botRoot, ".runtime"));
    if (payload.system_flow !== true) {
      ensurePrivateDirectory(join(botRoot, ".runtime", "users"));
      ensurePrivateDirectory(join(botRoot, ".runtime", "users", userHash));
    }
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

function materializeProjectDotenv(botRoot, userRoot, encodedContent) {
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
  const projectsRoot = join(userRoot, "projects");
  const runtimePath = join(userRoot, ".runtime");
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

function createGitCommandGuard(botRoot) {
  const runtimeRoot = join(botRoot, ".runtime");
  const guardRoot = join(runtimeRoot, "git-guard");
  for (const directory of [runtimeRoot, guardRoot]) {
    ensurePrivateDirectory(directory);
  }
  const guardPath = join(guardRoot, "git");
  if (existsSync(guardPath)) {
    const stat = lstatSync(guardPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RelayRequestError("managed Git guard path is unsafe");
    }
  }
  const systemGit = "/usr/bin/git";
  if (!existsSync(systemGit)) {
    throw new RelayRequestError("host Git executable is unavailable");
  }
  writeFileSync(
    guardPath,
    [
      "#!/bin/sh",
      "for argument in \"$@\"; do",
      "  case \"$argument\" in",
      "    commit|push)",
      "      echo 'Direct git commit and git push are disabled. Use project.publish through MCP.' >&2",
      "      exit 126",
      "      ;;",
      "  esac",
      "done",
      `exec ${shellQuote(systemGit)} \"$@\"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(guardPath, 0o700);
  return guardRoot;
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
  const env = { ...process.env, ...runtimeEnv };
  const gitGuardPath = env.MY_AGENT_GIT_GUARD_PATH;
  delete env.MY_AGENT_GIT_GUARD_PATH;
  for (const key of Object.keys(env)) {
    if (
      [
        "KIRO_RELAY_AUTH_TOKEN",
        "USER_CREDENTIALS_MASTER_KEY",
        "USER_CREDENTIALS_INTERNAL_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_PAT",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "GIT_SSH_COMMAND",
        "SSH_AUTH_SOCK",
        "GIT_CREDENTIAL_HELPER",
      ].includes(key)
      || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...(typeof gitGuardPath === "string" && gitGuardPath
      ? { PATH: `${gitGuardPath}:${env.PATH ?? "/usr/bin:/bin"}` }
      : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
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
  if (payload?.system_flow === true) return resolveSystemFlowWorkspace(payload);
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
  ensureSafeDirectory(join(userRoot, "projects"));
  ensureSafeDirectory(join(userRoot, ".runtime"));
  ensureSafeDirectory(join(workspaceDir, "artifacts"));

  return {
    botRoot,
    userRoot: realpathSync(userRoot),
    workspaceDir: realpathSync(workspaceDir),
    kiroHome: realpathSync(join(botRoot, ".kiro")),
  };
}

function resolveSystemFlowWorkspace(payload) {
  const { flowId, runId, workspaceId } = requireSystemFlowIdentity(payload);
  const flowsRoot = join(workspaceRoot, "system-flows");
  const flowRoot = join(flowsRoot, flowId);
  const workspacesRoot = join(flowRoot, "projects");
  const workspaceDir = join(workspacesRoot, workspaceId ?? runId);
  for (const directory of [flowsRoot, flowRoot, workspacesRoot, workspaceDir]) ensureSafeDirectory(directory);
  ensureSafeDirectory(join(flowRoot, ".kiro"));
  ensureSafeDirectory(join(flowRoot, ".kiro", "agents"));
  ensureSafeDirectory(join(flowRoot, ".kiro", "skills"));
  ensureSafeDirectory(join(flowRoot, "projects"));
  ensureSafeDirectory(join(workspaceDir, "artifacts"));
  return {
    botRoot: realpathSync(flowRoot),
    userRoot: realpathSync(flowRoot),
    workspaceDir: realpathSync(workspaceDir),
    kiroHome: realpathSync(join(flowRoot, ".kiro")),
  };
}

function requireSystemFlowIdentity(payload) {
  const flowId = typeof payload.flow_id === "string" ? payload.flow_id.trim() : "";
  const runId = typeof payload.run_id === "string" ? payload.run_id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flowId)) throw new RelayRequestError("flow_id is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new RelayRequestError("run_id is invalid");
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id.trim() : undefined;
  if (workspaceId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new RelayRequestError("workspace_id is invalid");
  return { flowId, runId, workspaceId };
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

function providerFromPayload(payload) {
  if (payload?.provider === "claude-code") return "claude-code";
  if (payload?.provider === undefined || payload?.provider === "kiro") return "kiro";
  throw new RelayRequestError("unsupported CLI provider");
}

function argsFromPayload(payload, provider = "kiro") {
  if (!Array.isArray(payload.args)) {
    return validateRequestArgs(args, provider);
  }

  const requestArgs = payload.args.filter((item) => typeof item === "string" && item.length > 0);
  return validateRequestArgs(requestArgs.length > 0 ? requestArgs : args, provider);
}

function validateRequestArgs(requestArgs, provider = "kiro") {
  if (provider === "claude-code") {
    if (!extractClaudeSessionId(requestArgs)) {
      throw new RelayRequestError("claude-code requires an explicit UUID session");
    }
    return requestArgs;
  }
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

function extractClaudeSessionId(requestArgs) {
  for (const flag of ["--session-id", "--resume"]) {
    const index = requestArgs.indexOf(flag);
    if (index >= 0 && isKiroSessionId(requestArgs[index + 1])) return requestArgs[index + 1];
    const inline = requestArgs.find((item) => item.startsWith(`${flag}=`));
    const value = inline?.slice(flag.length + 1);
    if (value && isKiroSessionId(value)) return value;
  }
  return undefined;
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
