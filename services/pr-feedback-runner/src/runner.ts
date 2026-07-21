import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import type { FeedbackEvent, ProjectSession, ProjectSessionStore } from "./store.js";

const maxPayloadBytes = 1024 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrFeedbackRunnerConfig {
  store: ProjectSessionStore;
  internalToken: string;
  llmRunnerUrl: string;
  workspaceRoot: string;
  settingsFile?: string;
  webhookSecret?: string;
  executionTimeoutMs: number;
  now?: () => Date;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

export function createPrFeedbackRunner(config: PrFeedbackRunnerConfig) {
  const now = config.now ?? (() => new Date());
  const fetchImpl = config.fetch ?? fetch;
  let active = false;

  const processNext = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      const event = await config.store.next();
      if (!event) return;
      try {
        const session = await config.store.find(event.repository_id, event.pr_number);
        if (!session) throw new Error("project session is no longer bound to this PR");
        await resumeProject(config, session, event, fetchImpl);
        await config.store.complete(event.delivery_id, "succeeded");
      } catch (error) {
        await config.store.complete(event.delivery_id, "failed", describeError(error));
        throw error;
      }
    } catch (error) { config.onError?.(error); } finally { active = false; }
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ service: "pr-feedback-runner", status: "ok", active });
      if (request.method === "POST" && url.pathname === "/internal/project-sessions") {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const input = await request.json().catch(() => undefined);
        const session = parseProjectSession(input, config.workspaceRoot, now().toISOString());
        return Response.json({ session: await config.store.upsert(session) }, { status: 201 });
      }
      const bind = url.pathname.match(/^\/internal\/project-sessions\/([^/]+)\/bind-pr$/);
      if (request.method === "POST" && bind) {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const repositoryId = readId(body?.repository_id, "repository_id");
        const prNumber = readPrNumber(body?.pr_number);
        const session = await config.store.bind(decodeURIComponent(bind[1]), repositoryId, prNumber, now().toISOString());
        return session ? Response.json({ session }) : Response.json({ error: "project session not found" }, { status: 404 });
      }
      if (request.method !== "POST" || url.pathname !== "/webhooks/github") return Response.json({ error: "not found" }, { status: 404 });
      const raw = await request.text();
      if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) return Response.json({ error: "payload is too large" }, { status: 413 });
      if (!hasValidGithubSignature(raw, request.headers.get("x-hub-signature-256"), config.webhookSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (request.headers.get("x-github-event") !== "issue_comment") return Response.json({ accepted: false, ignored: "event is not issue_comment" }, { status: 202 });
      const parsed = parseGithubComment(raw, request.headers.get("x-github-delivery"), now().toISOString());
      if (!parsed) return Response.json({ accepted: false, ignored: "not a human PR comment" }, { status: 202 });
      if (!await config.store.find(parsed.repository_id, parsed.pr_number)) {
        return Response.json({ accepted: false, ignored: "PR is not bound to a project session" }, { status: 202 });
      }
      const recorded = await config.store.record(parsed);
      if (!recorded.duplicate) void processNext();
      return Response.json({ accepted: !recorded.duplicate, duplicate: recorded.duplicate, delivery_id: parsed.delivery_id, status: recorded.event.status }, { status: recorded.duplicate ? 200 : 202 });
    },
    processNext,
    status: () => ({ active }),
  };
}

async function resumeProject(config: PrFeedbackRunnerConfig, session: ProjectSession, event: FeedbackEvent, fetchImpl: typeof fetch): Promise<void> {
  const runId = `pr-${session.project_id}-${event.comment_id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const prompt = `你正在恢复 Project Agent Session，不是普通 Bot，也不与用户聊天。\n\n项目：${session.project_id}\nJira：${session.jira_key}\nPR：#${event.pr_number}\n分支：${session.branch}\n\n当前 GitHub PR 评论：\n${event.comment_body}\n\n规则：\n1. 这是同一持久工作目录和同一 CLI 对话的后续回合；先阅读当前 repository/ 代码与已有报告。\n2. 仅处理该评论明确要求的事项；若范围不明确，写出澄清问题到 feedback/ 报告，禁止猜测。\n3. 本地验证阶段允许修改 repository/${session.jira_key}/ 并执行测试，但不得 push、创建 PR 或调用 GitHub API。\n4. 将本轮结论写入 feedback/${event.comment_id}.md，包含评论、修改、测试结果及待办。`;
  const dispatcher = config.fetch ? undefined : new Agent({ headersTimeout: config.executionTimeoutMs + 30_000, bodyTimeout: config.executionTimeoutMs + 30_000 });
  try {
    const endpoint = `${config.llmRunnerUrl.replace(/\/+$/, "")}/v1/system-runs`;
    const body = JSON.stringify({ flow_id: session.flow_id, run_id: runId, workspace_id: session.workspace_id, runtime: session.runtime, prompt, provider_session_id: session.provider_session_id, runtime_env: await loadRuntimeEnv(config.settingsFile), auto_execute: true });
    const request = new Request(endpoint, { method: "POST", headers: internalHeaders(config.internalToken), body, signal: AbortSignal.timeout(config.executionTimeoutMs) });
    const response = config.fetch ? await fetchImpl(request) : await undiciFetch(endpoint, { method: "POST", headers: internalHeaders(config.internalToken), body, signal: AbortSignal.timeout(config.executionTimeoutMs), dispatcher });
    if (!response.ok) throw new Error(`CLI resume failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { output?: unknown; provider_session_id?: unknown };
    const reportDir = join(session.workspace_root, "feedback");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await writeFile(join(reportDir, `${event.comment_id}.md`), `# PR #${event.pr_number} Feedback\n\nComment: ${event.comment_body}\n\n## Agent output\n\n${String(result.output ?? "CLI completed")}\n`, { mode: 0o600 });
    if (typeof result.provider_session_id === "string" && sessionPattern.test(result.provider_session_id)) {
      await config.store.upsert({ ...session, provider_session_id: result.provider_session_id, updated_at: new Date().toISOString() });
    }
  } finally { await dispatcher?.close().catch(() => {}); }
}

function parseProjectSession(value: unknown, workspaceRoot: string, timestamp: string): ProjectSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project session must be an object");
  const input = value as Record<string, unknown>;
  const workspaceRootPath = resolve(workspaceRoot);
  const workspacePath = resolve(readText(input.workspace_root, "workspace_root"));
  if (relative(workspaceRootPath, workspacePath).startsWith("..")) throw new Error("workspace_root is outside the system Flow workspace");
  const runtime = input.runtime;
  if (runtime !== "kiro" && runtime !== "claude-code" && runtime !== "mock") throw new Error("runtime is invalid");
  const providerSessionId = typeof input.provider_session_id === "string" ? input.provider_session_id : undefined;
  if (providerSessionId && !sessionPattern.test(providerSessionId)) throw new Error("provider_session_id is invalid");
  return {
    project_id: readProjectId(input.project_id), jira_key: readProjectId(input.jira_key), flow_id: readProjectId(input.flow_id), workspace_id: readProjectId(input.workspace_id),
    workspace_root: workspacePath, repository: readText(input.repository, "repository"), branch: readText(input.branch, "branch"), runtime,
    ...(providerSessionId ? { provider_session_id: providerSessionId } : {}), head_sha: readText(input.head_sha, "head_sha"), updated_at: timestamp,
  };
}

async function loadRuntimeEnv(settingsFile?: string): Promise<Record<string, string>> {
  if (!settingsFile) return {};
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { runtime_env?: unknown };
    if (typeof settings.runtime_env !== "string") return {};
    const result: Record<string, string> = {};
    for (const [index, source] of settings.runtime_env.replace(/\r\n/g, "\n").split("\n").entries()) {
      const line = source.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{0,127})=(.*)$/);
      if (!match) throw new Error(`runtime .env line ${index + 1} is invalid`);
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value) result[match[1]] = value;
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function parseGithubComment(raw: string, delivery: string | null, receivedAt: string): FeedbackEvent | undefined {
  if (!delivery || !idPattern.test(delivery)) throw new Error("x-github-delivery is required");
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;
  if (!issue?.pull_request || sender?.type === "Bot" || !repository || !comment) return undefined;
  return { delivery_id: delivery, event_type: "issue_comment", repository_id: readId(repository.id, "repository.id"), pr_number: readPrNumber(issue.number), comment_id: readId(comment.id, "comment.id"), comment_body: readText(comment.body, "comment.body"), received_at: receivedAt, status: "pending" };
}

function hasValidGithubSignature(raw: string, signature: string | null, secret: string | undefined): boolean {
  if (!secret?.trim()) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const left = Buffer.from(expected); const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
function hasInternalToken(request: Request, token: string): boolean { return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`; }
function internalHeaders(token: string): Record<string, string> { return { "content-type": "application/json", authorization: `Bearer ${token}` }; }
function readText(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function readProjectId(value: unknown): string { const id = readText(value, "project_id"); if (!projectPattern.test(id)) throw new Error("project id is invalid"); return id; }
function readId(value: unknown, field: string): string { const id = String(value ?? "").trim(); if (!id || !idPattern.test(id)) throw new Error(`${field} is invalid`); return id; }
function readPrNumber(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error("pr_number is invalid"); return value as number; }
function describeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 4000) : "PR feedback failed"; }
