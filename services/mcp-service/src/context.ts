import { createHmac, timingSafeEqual } from "node:crypto";
import { parseTrustedMcpContext, type TrustedMcpContext } from "@my-agent-toolkit/contracts";

export interface ExpectedMcpPathContext {
  bot_id: string;
  conversation_id: string;
}

export function signRunnerToken(
  secret: string,
  context: TrustedMcpContext,
): string {
  const payload = base64UrlEncode(JSON.stringify({
    ...parseTrustedMcpContext(context),
    iat: Math.floor(Date.now() / 1000),
  }));
  const signature = signPayload(secret, payload);
  return `${payload}.${signature}`;
}

export function verifyRunnerToken(
  secret: string,
  token: string,
  expected: ExpectedMcpPathContext,
): TrustedMcpContext {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new Error("runner token is invalid");
  }
  const expectedSignature = signPayload(secret, payload);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new Error("runner token signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw new Error("runner token is invalid");
  }
  const context = parseTrustedMcpContext(decoded);
  if (
    context.bot_id !== expected.bot_id ||
    context.conversation_id !== expected.conversation_id
  ) {
    throw new Error("runner token context does not match request path");
  }
  return context;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", requireSecret(secret))
    .update(payload)
    .digest("base64url");
}

function requireSecret(secret: string): string {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new Error("runner secret is required");
  }
  return secret;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
