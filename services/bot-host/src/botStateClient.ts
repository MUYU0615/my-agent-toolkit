import type { BotHostConfig } from "./server.js";

export interface InitializationSessionDto {
  session_id: string;
  bot_id: string;
  wecom_user_id: string;
  conversation_id: string;
  phase: "soul" | "agents";
  soul_answers: string[];
  agents_answers: string[];
  generation_in_progress?: "soul" | "agents";
  status: "active" | "completed" | "cancelled";
}

export async function getActiveInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<InitializationSessionDto | undefined> {
  const response = await config.fetch(new Request(activeInitializationSessionUrl(config, input)));
  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildInitializationSessionError("get active initialization session", response, errorPayload(payload)));
  }
  const payload = await response.json() as InitializationSessionDto | null;
  return payload === null ? undefined : payload as InitializationSessionDto;
}

export async function upsertInitializationSession(
  config: BotHostConfig,
  input: Omit<InitializationSessionDto, "session_id">,
): Promise<InitializationSessionDto> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/internal/initialization-sessions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(buildInitializationSessionError("upsert initialization session", response, errorPayload(payload)));
  }
  const payload = await response.json() as InitializationSessionDto;
  return payload as InitializationSessionDto;
}

export async function clearInitializationSession(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): Promise<void> {
  const response = await config.fetch(
    new Request(activeInitializationSessionUrl(config, input), { method: "DELETE" }),
  );
  if (response.ok || response.status === 404) {
    return;
  }
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  throw new Error(buildInitializationSessionError("clear initialization session", response, payload));
}

function activeInitializationSessionUrl(
  config: BotHostConfig,
  input: { bot_id: string; wecom_user_id: string; conversation_id: string },
): string {
  const query = [
    `bot_id=${encodeURIComponent(input.bot_id)}`,
    `wecom_user_id=${encodeURIComponent(input.wecom_user_id)}`,
    `conversation_id=${encodeURIComponent(input.conversation_id)}`,
  ].join("&");
  return `${config.dataServiceUrl}/internal/initialization-sessions/active?${query}`;
}

function buildInitializationSessionError(
  action: string,
  response: Response,
  payload: { error?: string } | undefined,
): string {
  const detail = payload?.error ? `: ${payload.error}` : "";
  return `failed to ${action}: ${response.status} ${response.statusText}${detail}`;
}

function errorPayload(payload: unknown): { error?: string } | undefined {
  return payload && typeof payload === "object" && "error" in payload
    ? payload as { error?: string }
    : undefined;
}
