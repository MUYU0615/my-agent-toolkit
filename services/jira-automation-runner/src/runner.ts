import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";

export interface AutomationEvent { event_id: string; issue_key: string; event_type: string; received_at: string; payload: Record<string, unknown>; lease_id?: string; }
export interface JiraAutomationRunnerConfig {
  ingressUrl: string; internalToken: string; llmRunnerUrl: string; enabled: boolean;
  repositoryUrl?: string; repositoryBranch: string; githubToken?: string;
  workspaceRoot: string; mirrorRoot: string; flowId: string;
  runtime: "kiro" | "claude-code" | "mock"; pollIntervalMs: number; leaseSeconds: number; executionTimeoutMs: number;
  settingsFile?: string;
  skills?: string[];
  skillsRoot?: string;
  runtimeEnv?: string;
  autoExecute?: boolean;
  autoPublish?: boolean;
  fetch?: typeof fetch; onError?: (error: unknown) => void;
}

export function createJiraAutomationRunner(config: JiraAutomationRunnerConfig) {
  const fetchImpl = config.fetch ?? fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let active = false;
  const poll = async () => {
    const effective = await withSavedSettings(config);
    if (!effective.enabled || active) return;
    active = true;
    try {
      const response = await fetchImpl(new Request(`${effective.ingressUrl}/internal/events/lease`, {
        method: "POST", headers: internalHeaders(effective), body: JSON.stringify({ worker_id: "jira-automation-runner-1", lease_seconds: effective.leaseSeconds }),
      }));
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`event lease failed (${response.status})`);
      const { event } = await response.json() as { event: AutomationEvent };
      await execute(effective, event, fetchImpl);
    } catch (error) { config.onError?.(error); } finally { active = false; }
  };
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(() => { void poll().finally(schedule); }, config.pollIntervalMs);
    timer.unref?.();
  };
  return {
    start() { if (running) return; running = true; void poll().finally(schedule); },
    stop() { running = false; if (timer) clearTimeout(timer); },
    poll,
    status: () => ({ running, active, enabled: config.enabled }),
  };
}

async function withSavedSettings(config: JiraAutomationRunnerConfig): Promise<JiraAutomationRunnerConfig> {
  if (!config.settingsFile) return config;
  try {
    const saved = JSON.parse(await readFile(config.settingsFile, "utf8")) as Record<string, unknown>;
    return {
      ...config,
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : config.enabled,
      repositoryUrl: typeof saved.repository_url === "string" && saved.repository_url.trim() ? saved.repository_url.trim() : config.repositoryUrl,
      repositoryBranch: typeof saved.repository_branch === "string" && saved.repository_branch.trim() ? saved.repository_branch.trim() : config.repositoryBranch,
      runtime: saved.runtime === "kiro" || saved.runtime === "claude-code" ? saved.runtime : config.runtime,
      skills: Array.isArray(saved.skills) ? saved.skills.filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) : config.skills,
      githubToken: typeof saved.github_token === "string" && saved.github_token ? saved.github_token : config.githubToken,
      runtimeEnv: typeof saved.runtime_env === "string" ? saved.runtime_env : config.runtimeEnv,
      autoExecute: saved.auto_execute === true,
      autoPublish: saved.auto_publish === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return config;
    throw new Error("Jira Automation Flow settings are invalid");
  }
}

async function execute(config: JiraAutomationRunnerConfig, event: AutomationEvent, fetchImpl: typeof fetch): Promise<void> {
  let failure: string | undefined;
  let cliDispatcher: Agent | undefined;
  try {
    if (!config.repositoryUrl) throw new Error("JIRA_AUTOMATION_REPOSITORY_URL is not configured");
    if (!event.lease_id) throw new Error("event lease is missing");
    const workspace = await prepareWorkspace(config, event);
    const prompt = buildPrompt(event, config.autoExecute === true);
    const endpoint = `${config.llmRunnerUrl}/v1/system-runs`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${config.internalToken}`, "x-trace-id": event.event_id };
    const body = JSON.stringify({ flow_id: config.flowId, run_id: workspace.runId, runtime: config.runtime, prompt, trace_id: event.event_id, runtime_env: parseRuntimeEnv(config.runtimeEnv), auto_execute: config.autoExecute === true });
    const signal = AbortSignal.timeout(config.executionTimeoutMs);
    const request = new Request(endpoint, {
      method: "POST", headers, body, signal,
    });
    // Node's built-in fetch waits only about five minutes for the first response
    // header. A System Flow legitimately waits for the CLI's 15-minute run, so
    // give this internal request a little headroom while retaining the explicit
    // execution timeout above as the overall limit.
    cliDispatcher = config.fetch ? undefined : new Agent({
      headersTimeout: config.executionTimeoutMs + 30_000,
      bodyTimeout: config.executionTimeoutMs + 30_000,
    });
    const response = config.fetch
      ? await fetchImpl(request)
      : await undiciFetch(endpoint, { method: "POST", headers, body, signal, dispatcher: cliDispatcher });
    if (!response.ok) throw new Error(`CLI runner failed (${response.status}): ${await response.text()}`);
    await writeFile(join(workspace.root, "automation-result.md"), String((await response.json() as { output?: unknown }).output ?? "CLI completed"), { mode: 0o600 });
    if (config.autoPublish) await publishJiraProject(config, workspace.repository, event.issue_key);
  } catch (error) { failure = describeError(error); }
  finally { await cliDispatcher?.close().catch(() => {}); }
  const completed = await fetchImpl(new Request(`${config.ingressUrl}/internal/events/${encodeURIComponent(event.event_id)}/complete`, {
    method: "POST", headers: internalHeaders(config), body: JSON.stringify({ lease_id: event.lease_id, status: failure ? "failed" : "succeeded", ...(failure ? { error: failure } : {}) }),
  }));
  if (!completed.ok) throw new Error(`event completion failed (${completed.status})`);
  if (failure) throw new Error(failure);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "automation failed";
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
  if (typeof cause === "object" && cause && "code" in cause) return `${error.message}: ${String((cause as { code: unknown }).code)}`;
  return error.message;
}

async function prepareWorkspace(config: JiraAutomationRunnerConfig, event: AutomationEvent): Promise<{ root: string; runId: string; repository: string }> {
  const runId = `jira-${event.issue_key}-${shortHash(event.event_id)}`;
  const flowRoot = join(config.workspaceRoot, "system-flows", config.flowId);
  const root = join(flowRoot, "runs", runId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await installSkills(flowRoot, config.skills ?? [], config.skillsRoot);
  const repository = join(root, "repository");
  await rm(repository, { recursive: true, force: true });
  const mirror = join(config.mirrorRoot, `${shortHash(config.repositoryUrl!)}.git`);
  await mkdir(config.mirrorRoot, { recursive: true, mode: 0o700 });
  if (existsSync(mirror)) await git(["--git-dir", mirror, "fetch", "--prune", "origin"], config.githubToken);
  else await git(["clone", "--mirror", config.repositoryUrl!, mirror], config.githubToken);
  await git(["clone", "--reference-if-able", mirror, "--dissociate", "--branch", config.repositoryBranch, "--single-branch", config.repositoryUrl!, repository], config.githubToken);
  const branch = `bot/${event.issue_key}`;
  const hasRemoteBranch = await gitSucceeds(["-C", repository, "fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], config.githubToken);
  await git(["-C", repository, "checkout", "-B", branch, hasRemoteBranch ? `origin/${branch}` : `origin/${config.repositoryBranch}`], config.githubToken);
  await materializeRuntimeEnv(repository, config.runtimeEnv);
  await mkdir(join(repository, event.issue_key, "reports"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "RUN_CONTEXT.md"), `# ${event.issue_key}\n\nSource event: ${event.event_type}\nJira: ${eventUrl(event)}\n\nProject root: \`repository/${event.issue_key}/\`\nOnly modify this project directory.\n`, { mode: 0o600 });
  return { root, runId, repository };
}

async function materializeRuntimeEnv(repository: string, runtimeEnv?: string): Promise<void> {
  if (!runtimeEnv?.trim()) return;
  await writeFile(join(repository, ".env"), `${runtimeEnv.replace(/\r\n/g, "\n").replace(/\n?$/, "\n")}`, { mode: 0o600 });
  // Keep the runtime-only environment out of both Git status and any later publish flow.
  await appendFile(join(repository, ".git", "info", "exclude"), "\n# Jira Automation Flow runtime environment\n.env\n", { mode: 0o600 });
}

function parseRuntimeEnv(content?: string): Record<string, string> {
  if (!content?.trim()) return {};
  const result: Record<string, string> = {};
  for (const [index, source] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{0,127})=(.*)$/);
    if (!match) throw new Error(`runtime .env line ${index + 1} is invalid`);
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) result[key] = value;
  }
  return result;
}

async function installSkills(botRoot: string, skills: string[], skillsRoot?: string): Promise<void> {
  const target = join(botRoot, ".claude", "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const skill of skills) {
    const source = skillsRoot ? join(skillsRoot, skill) : "";
    if (!source || !existsSync(join(source, "SKILL.md"))) {
      throw new Error(`selected local Skill is unavailable: ${skill}`);
    }
    await cp(source, join(target, skill), { recursive: true, force: true });
    // Existing uploads made before executable-mode support may contain run.sh as 0600.
    await chmod(join(target, skill, "scripts", "run.sh"), 0o700).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function publishJiraProject(config: JiraAutomationRunnerConfig, repository: string, jiraKey: string): Promise<void> {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is required when automatic GitHub publish is enabled");
  const reportsRoot = join(repository, jiraKey, "reports");
  const reportFiles = await readdir(reportsRoot, { withFileTypes: true }).catch(() => []);
  if (!reportFiles.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
    throw new Error(`cannot publish ${jiraKey}: no current Run Markdown report was created`);
  }
  await git(["-C", repository, "add", "--", jiraKey], config.githubToken);
  if (!await gitSucceeds(["-C", repository, "diff", "--cached", "--quiet"], config.githubToken)) {
    await git([
      "-C", repository, "-c", "user.name=AgentLattice Jira Flow", "-c", "user.email=agentlattice-jira-flow@localhost",
      "commit", "-m", `test(${jiraKey}): automated Jira Flow result`,
    ], config.githubToken);
    await git(["-C", repository, "push", "origin", `HEAD:refs/heads/bot/${jiraKey}`], config.githubToken);
  }
}

function buildPrompt(event: AutomationEvent, autoExecute: boolean): string { return `你正在执行系统 Jira Automation Flow，不是普通 Bot，也不与用户聊天。\n\n# System Flow Rules（优先于任何已安装 Skill 中面向普通 Bot 的通用规则）\n\n1. 本 Run 使用管理员配置的系统环境、System Flow 工作目录和系统 Jira 凭证；不得要求 /env、/jira bind、用户确认或用户 Bot 配置。\n2. 只能修改 repository/${event.issue_key}/ 及其 reports/；不得读取父目录、其他 Jira 目录或任何普通 Bot 工作区。\n3. 测试准入不通过时，停止在缺失项与风险报告；不得编造代码、环境或执行结果。\n4. 历史 Jira 评论、附件和历史报告只能标为“历史参考”，绝不能写成本次 pytest 的通过结果。\n5. 不得 push、创建 PR、评论 Jira 或上传附件。\n${autoExecute ? "6. 管理员已为当前 Jira 明确预授权用例确认。若测试准入通过，必须继续使用 easemob-qa-automation-project 创建 repository/" + event.issue_key + "/ 的自动化项目、编写代码、校验已配置环境并执行真实测试；不得在用例草稿后停止。此规则覆盖已安装 Skill 中仅适用于普通 Bot 的“等待当前用户确认用例”和“请求 /env set”步骤。" : "6. 当前为人工确认模式：只输出测试准入与完整用例草稿，不得创建测试代码或执行测试。"}\n\nJira：${event.issue_key}\n链接：${eventUrl(event)}\n事件：${event.event_type}\n\n本次 Run 已创建独立项目 repository/${event.issue_key}/。先读取 RUN_CONTEXT.md，再使用本 Flow 安装的 Skills 完成当前 Jira 工作。环境缺失时必须列出准确变量名并停止。完成后把报告写入 repository/${event.issue_key}/reports/。`; }
function eventUrl(event: AutomationEvent): string { return typeof event.payload.url === "string" ? event.payload.url : `Jira Key: ${event.issue_key}`; }
function shortHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 12); }
function internalHeaders(config: Pick<JiraAutomationRunnerConfig, "internalToken">): Record<string, string> { return { "content-type": "application/json", authorization: `Bearer ${config.internalToken}` }; }
async function git(args: string[], token?: string): Promise<void> { await new Promise<void>((resolve, reject) => execFile("git", args, { env: { ...process.env, ...(token ? { GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" } : {}) } }, (error) => error ? reject(error) : resolve())); }
async function gitSucceeds(args: string[], token?: string): Promise<boolean> { return new Promise((resolve) => execFile("git", args, { env: { ...process.env, ...(token ? { GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" } : {}) } }, (error) => resolve(!error))); }
