#!/usr/bin/env node

const relayUrl = process.env.KIRO_RELAY_URL ?? "http://host.docker.internal:8210/v1/kiro/chat";
const relayStreamUrl = process.env.KIRO_RELAY_STREAM_URL ?? relayUrl.replace(/\/v1\/kiro\/chat$/, "/v1/kiro/chat/stream");
const streamEnabled = process.env.KIRO_RELAY_STREAM === "true";
const botId = process.env.KIRO_RELAY_BOT_ID?.trim();
const userId = process.env.KIRO_RELAY_USER_ID?.trim();
const conversationId = process.env.KIRO_RELAY_CONVERSATION_ID?.trim();
const relayAuthToken = process.env.KIRO_RELAY_AUTH_TOKEN?.trim();
const runtimeEnv = collectRuntimeEnv(process.env);
const forwardedArgs = process.argv.slice(2);
const chunks = [];
const runtimeMetadataPrefix = "__MY_AGENT_TOOLKIT_RUNTIME_META__";
const kiroSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

try {
  if (!botId) {
    throw new Error("KIRO_RELAY_BOT_ID is required");
  }
  if (!userId) {
    throw new Error("KIRO_RELAY_USER_ID is required");
  }
  if (!conversationId) {
    throw new Error("KIRO_RELAY_CONVERSATION_ID is required");
  }
  if (Object.keys(runtimeEnv).length > 0 && !relayAuthToken) {
    throw new Error("KIRO_RELAY_AUTH_TOKEN is required for credential forwarding");
  }

  if (streamEnabled) {
    await runStream(Buffer.concat(chunks).toString());
    process.exit(0);
  }

  const response = await fetch(relayUrl, {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({
      bot_id: botId,
      user_id: userId,
      conversation_id: conversationId,
      prompt: Buffer.concat(chunks).toString(),
      args: forwardedArgs,
      runtime_env: runtimeEnv,
    }),
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
  if (!isKiroSessionId(payload?.provider_session_id)) {
    process.stderr.write("kiro relay returned invalid session id");
    process.exit(1);
  }

  process.stdout.write(payload.output);
  writeRuntimeMetadata(payload.provider_session_id);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "kiro relay request failed");
  process.exit(1);
}

async function runStream(prompt) {
  const response = await fetch(relayStreamUrl, {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({
      bot_id: botId,
      user_id: userId,
      conversation_id: conversationId,
      prompt,
      args: forwardedArgs,
      runtime_env: runtimeEnv,
    }),
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
  if (!isKiroSessionId(providerSessionId)) {
    throw new Error("kiro relay stream returned invalid session id");
  }
  writeRuntimeMetadata(providerSessionId);
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
  if (event.type === "session" && isKiroSessionId(event.provider_session_id)) {
    return event.provider_session_id;
  }
  if (event.type === "done") {
    return providerSessionId;
  }
  if (event.type === "error") {
    throw new Error(event.error ?? "kiro relay stream failed");
  }
  return providerSessionId;
}

function writeRuntimeMetadata(providerSessionId) {
  process.stderr.write(`${runtimeMetadataPrefix}${JSON.stringify({
    provider_session_id: providerSessionId,
  })}\n`);
}

function isKiroSessionId(value) {
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
  ]) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      result[key] = env[key];
    }
  }
  return result;
}
