#!/usr/bin/env node

import { Agent } from "undici";

const relayUrl = process.env.KIRO_RELAY_URL ?? "http://host.docker.internal:8210/v1/kiro/chat";
const relayStreamUrl = process.env.KIRO_RELAY_STREAM_URL ?? relayUrl.replace(/\/v1\/kiro\/chat$/, "/v1/kiro/chat/stream");
const streamEnabled = process.env.KIRO_RELAY_STREAM === "true";
const botId = process.env.KIRO_RELAY_BOT_ID?.trim();
const userId = process.env.KIRO_RELAY_USER_ID?.trim();
const conversationId = process.env.KIRO_RELAY_CONVERSATION_ID?.trim();
const systemFlow = process.env.KIRO_RELAY_SYSTEM_FLOW === "true";
const flowId = process.env.KIRO_RELAY_FLOW_ID?.trim();
const flowRunId = process.env.KIRO_RELAY_RUN_ID?.trim();
const relayAuthToken = process.env.KIRO_RELAY_AUTH_TOKEN?.trim();
const runtimeEnv = collectRuntimeEnv(process.env);
const provider = process.env.MY_AGENT_CLI_PROVIDER === "claude-code" ? "claude-code" : "kiro";
const relayClientTimeoutMs = Number.parseInt(
  process.env.KIRO_RELAY_CLIENT_TIMEOUT_MS ?? "960000",
  10,
);
const relayDispatcher = new Agent({
  headersTimeout: relayClientTimeoutMs,
  bodyTimeout: relayClientTimeoutMs,
});
const forwardedArgs = process.argv.slice(2);
const chunks = [];
const runtimeMetadataPrefix = "__MY_AGENT_TOOLKIT_RUNTIME_META__";
const kiroSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

try {
  if (systemFlow) {
    if (!flowId) throw new Error("KIRO_RELAY_FLOW_ID is required for a system Flow");
    if (!flowRunId) throw new Error("KIRO_RELAY_RUN_ID is required for a system Flow");
  } else {
    if (!botId) throw new Error("KIRO_RELAY_BOT_ID is required");
    if (!userId) throw new Error("KIRO_RELAY_USER_ID is required");
    if (!conversationId) throw new Error("KIRO_RELAY_CONVERSATION_ID is required");
  }
  if (Object.keys(runtimeEnv).length > 0 && !relayAuthToken) {
    throw new Error("KIRO_RELAY_AUTH_TOKEN is required for credential forwarding");
  }

  if (streamEnabled) {
    await runStream(Buffer.concat(chunks).toString());
    await relayDispatcher.close();
    process.exit(0);
  }

  const response = await fetch(relayUrl, {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({
      ...relayIdentity(),
      provider,
      prompt: Buffer.concat(chunks).toString(),
      args: forwardedArgs,
      runtime_env: runtimeEnv,
    }),
    dispatcher: relayDispatcher,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    payload = undefined;
  }

  if (!response.ok) {
    process.stderr.write(payload?.error ?? text ?? `kiro relay failed with ${response.status}`);
    process.exit(1);
  }

  if (typeof payload?.output !== "string") {
    process.stderr.write("kiro relay returned invalid output");
    process.exit(1);
  }
  if (!isProviderSessionId(payload?.provider_session_id)) {
    process.stderr.write("cli relay returned invalid session id");
    process.exit(1);
  }

  process.stdout.write(payload.output);
  writeRuntimeMetadata(payload.provider_session_id);
  await relayDispatcher.close();
} catch (error) {
  await relayDispatcher.close().catch(() => {});
  process.stderr.write(formatRelayError(error));
  process.exit(1);
}

async function runStream(prompt) {
  const response = await fetch(relayStreamUrl, {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({
      ...relayIdentity(),
      provider,
      prompt,
      args: forwardedArgs,
      runtime_env: runtimeEnv,
    }),
    dispatcher: relayDispatcher,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    process.stderr.write(text || `kiro relay stream failed with ${response.status}`);
    process.exit(1);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let providerSessionId;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      providerSessionId = handleStreamLine(line, providerSessionId);
    }
  }
  if (buffer.trim()) {
    providerSessionId = handleStreamLine(buffer, providerSessionId);
  }
  if (!isProviderSessionId(providerSessionId)) {
    throw new Error("cli relay stream returned invalid session id");
  }
  writeRuntimeMetadata(providerSessionId);
}

function relayIdentity() {
  return systemFlow
    ? { system_flow: true, flow_id: flowId, run_id: flowRunId }
    : { bot_id: botId, user_id: userId, conversation_id: conversationId };
}

function handleStreamLine(line, providerSessionId) {
  if (!line.trim()) {
    return providerSessionId;
  }
  const event = JSON.parse(line);
  if (event.type === "chunk" && typeof event.content === "string") {
    process.stdout.write(event.content);
    return providerSessionId;
  }
  if (event.type === "session" && isProviderSessionId(event.provider_session_id)) {
    return event.provider_session_id;
  }
  if (event.type === "done") {
    return providerSessionId;
  }
  if (event.type === "heartbeat") {
    return providerSessionId;
  }
  if (event.type === "error") {
    throw new Error(event.error ?? "kiro relay stream failed");
  }
  return providerSessionId;
}

function formatRelayError(error) {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  if (cause && typeof cause === "object") {
    if (cause.code === "UND_ERR_HEADERS_TIMEOUT") {
      return `relay response headers timed out after ${relayClientTimeoutMs} ms`;
    }
    if (cause.code === "UND_ERR_BODY_TIMEOUT") {
      return `relay response body timed out after ${relayClientTimeoutMs} ms`;
    }
  }
  return error instanceof Error ? error.message : "kiro relay request failed";
}

function writeRuntimeMetadata(providerSessionId) {
  process.stderr.write(`${runtimeMetadataPrefix}${JSON.stringify({
    provider_session_id: providerSessionId,
  })}\n`);
}

function isProviderSessionId(value) {
  return typeof value === "string" && kiroSessionIdPattern.test(value);
}

function relayHeaders() {
  return {
    "content-type": "application/json",
    ...(relayAuthToken ? { authorization: `Bearer ${relayAuthToken}` } : {}),
  };
}

function collectRuntimeEnv(env) {
  const result = {};
  for (const key of [
    "EASEMOB_JIRA_USERNAME",
    "EASEMOB_JIRA_PASSWORD",
    "EASEMOB_JIRA_REDIRECT_USERNAME",
    "EASEMOB_JIRA_REDIRECT_PASSWORD",
    "MY_AGENT_JIRA_CREDENTIAL_VERSION",
    "MY_AGENT_PROJECT_DOTENV_B64",
  ]) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      result[key] = env[key];
    }
  }
  const userRuntimeKeys = parseUserRuntimeEnvKeys(env.MY_AGENT_USER_RUNTIME_ENV_KEYS_B64);
  for (const key of userRuntimeKeys) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      result[key] = env[key];
    }
  }
  const systemRuntimeKeys = parseUserRuntimeEnvKeys(env.MY_AGENT_SYSTEM_RUNTIME_ENV_KEYS_B64);
  for (const key of systemRuntimeKeys) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      result[key] = env[key];
    }
  }
  return result;
}

function parseUserRuntimeEnvKeys(encodedKeys) {
  if (typeof encodedKeys !== "string" || encodedKeys.length === 0) return [];
  try {
    const keys = JSON.parse(Buffer.from(encodedKeys, "base64").toString("utf8"));
    if (!Array.isArray(keys)) return [];
    return keys.filter((key) => /^[A-Z][A-Z0-9_]{0,127}$/.test(key));
  } catch {
    return [];
  }
}
