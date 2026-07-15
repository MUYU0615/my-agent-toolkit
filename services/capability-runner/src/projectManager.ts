import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export interface EnsureProjectInput {
  botId: string;
  userId: string;
  conversationId: string;
  projectKey: string;
}

export interface EnsureProjectResult {
  project_key: string;
  path: string;
  branch: string;
  base_commit: string;
  reused: boolean;
}

interface UserProjectBinding {
  project_key: string;
  project_repository_url: string;
  project_default_branch: string;
  project_directory: string;
  access_token: string;
}

export interface CreateProjectManagerOptions {
  dataServiceUrl: string;
  userCredentialsInternalToken?: string;
  kiroWorkspaceRoot: string;
  repositoryCacheRoot?: string;
  baselineRefreshMs?: number;
  fetch?: typeof fetch;
  cloneRepository?: (
    repositoryUrl: string,
    branch: string,
    destination: string,
    accessToken?: string,
  ) => Promise<void>;
  cloneWorkspace?: (
    baselinePath: string,
    branch: string,
    destination: string,
  ) => Promise<void>;
  refreshRepository?: (repositoryPath: string, branch: string, accessToken?: string) => Promise<void>;
  resolveRevision?: (repositoryPath: string) => Promise<string>;
}

export interface ProjectManager {
  ensure(input: EnsureProjectInput): Promise<EnsureProjectResult>;
}

export function createProjectManager(options: CreateProjectManagerOptions): ProjectManager {
  const fetchImpl = options.fetch ?? fetch;
  const cloneRepository = options.cloneRepository ?? cloneGitRepository;
  const cloneWorkspace = options.cloneWorkspace ?? cloneWorkspaceFromBaseline;
  const refreshRepository = options.refreshRepository ?? refreshGitRepository;
  const resolveRevision = options.resolveRevision ?? resolveGitRevision;
  const workspaceRoot = initializeWorkspaceRoot(options.kiroWorkspaceRoot);
  const cacheRoot = initializeRepositoryCacheRoot(
    options.repositoryCacheRoot ?? join(workspaceRoot, ".project-cache"),
  );
  const baselineRefreshMs = options.baselineRefreshMs ?? 30_000;
  const pending = new Map<string, Promise<EnsureProjectResult>>();
  const pendingBaselines = new Map<string, Promise<PreparedBaseline>>();
  const lastBaselineRefresh = new Map<string, number>();

  async function prepareBaseline(input: { botId: string; userId: string; binding: UserProjectBinding }): Promise<PreparedBaseline> {
    const { binding } = input;
    const branch = requireGitRef(binding.project_default_branch, "project_default_branch");
    const cacheKey = createHash("sha256")
      .update(`${input.botId}\n${input.userId}\n${binding.project_repository_url}\n${branch}`, "utf8")
      .digest("hex");
    const existing = pendingBaselines.get(cacheKey);
    if (existing) {
      return existing;
    }
    const operation = (async () => {
      const destination = resolve(cacheRoot, cacheKey);
      assertPathInside(cacheRoot, destination);
      if (existsSync(destination)) {
        if (!lstatSync(destination).isDirectory() || !existsSync(join(destination, ".git"))) {
          throw new Error("project repository cache contains an unsafe path");
        }
        const lastRefresh = lastBaselineRefresh.get(cacheKey) ?? 0;
        if (Date.now() - lastRefresh >= baselineRefreshMs) {
          await refreshRepository(destination, branch, binding.access_token);
          lastBaselineRefresh.set(cacheKey, Date.now());
        }
      } else {
        const temporaryDestination = join(cacheRoot, `.${cacheKey}.clone-${randomUUID()}`);
        try {
          await cloneRepository(binding.project_repository_url, branch, temporaryDestination, binding.access_token);
          if (!existsSync(join(temporaryDestination, ".git"))) {
            throw new Error("Git clone completed without a .git directory");
          }
          renameSync(temporaryDestination, destination);
          lastBaselineRefresh.set(cacheKey, Date.now());
        } finally {
          if (existsSync(temporaryDestination)) {
            rmSync(temporaryDestination, { recursive: true, force: true });
          }
        }
      }
      return {
        path: destination,
        commit: await resolveRevision(destination),
      };
    })().finally(() => pendingBaselines.delete(cacheKey));
    pendingBaselines.set(cacheKey, operation);
    return operation;
  }

  return {
    async ensure(input) {
      const botId = requireSafeSegment(input.botId, "bot_id");
      const conversationId = requireSafeSegment(input.conversationId, "conversation_id");
      const userId = requireText(input.userId, "user_id");
      const projectKey = requireSafeSegment(input.projectKey, "project_key");
      const binding = await loadUserProjectBinding(fetchImpl, options, botId, userId, projectKey);

      const conversationRoot = ensureConversationRoot(
        workspaceRoot,
        botId,
        userId,
        conversationId,
      );
      const projectsRoot = ensureSafeDirectory(join(conversationRoot, "projects"));
      const destination = resolve(projectsRoot, binding.project_directory);
      assertPathInside(projectsRoot, destination);

      const existing = pending.get(destination);
      if (existing) {
        return existing;
      }
      const operation = (async () => {
        if (existsSync(destination)) {
          if (!lstatSync(destination).isDirectory() || !existsSync(join(destination, ".git"))) {
            throw new Error(`project destination exists but is not a Git repository: ${binding.project_directory}`);
          }
          cleanupManagedProjectDotenv(conversationRoot, destination, binding.project_directory);
          return projectResult(binding, conversationRoot, destination, true, await resolveRevision(destination));
        }
        const baseline = await prepareBaseline({ botId, userId, binding });
        const temporaryDestination = join(
          projectsRoot,
          `.${binding.project_directory}.clone-${randomUUID()}`,
        );
        try {
          await cloneWorkspace(baseline.path, binding.project_default_branch, temporaryDestination);
          if (!existsSync(join(temporaryDestination, ".git"))) {
            throw new Error("Git clone completed without a .git directory");
          }
          renameSync(temporaryDestination, destination);
        } finally {
          if (existsSync(temporaryDestination)) {
            rmSync(temporaryDestination, { recursive: true, force: true });
          }
        }
        cleanupManagedProjectDotenv(conversationRoot, destination, binding.project_directory);
        return projectResult(binding, conversationRoot, destination, false, baseline.commit);
      })().finally(() => pending.delete(destination));
      pending.set(destination, operation);
      return operation;
    },
  };
}

interface PreparedBaseline {
  path: string;
  commit: string;
}

function cleanupManagedProjectDotenv(
  conversationRoot: string,
  destination: string,
  projectDirectory: string,
): void {
  const runtimeRoot = ensureSafeDirectory(join(conversationRoot, ".runtime"));
  const marker = resolve(runtimeRoot, `${projectDirectory}.dotenv-managed`);
  const dotenvPath = resolve(destination, ".env");
  assertPathInside(runtimeRoot, marker);
  assertPathInside(destination, dotenvPath);

  if (!existsSync(marker)) {
    return;
  }
  if (existsSync(dotenvPath)) {
    const stat = lstatSync(dotenvPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("project .env path is unsafe");
    }
    rmSync(dotenvPath);
  }
  rmSync(marker);
}

function projectResult(
  config: UserProjectBinding,
  conversationRoot: string,
  destination: string,
  reused: boolean,
  baseCommit: string,
): EnsureProjectResult {
  return {
    project_key: config.project_key,
    path: relative(conversationRoot, destination),
    branch: config.project_default_branch,
    base_commit: baseCommit,
    reused,
  };
}

async function loadUserProjectBinding(
  fetchImpl: typeof fetch,
  options: CreateProjectManagerOptions,
  botId: string,
  userId: string,
  projectKey: string,
): Promise<UserProjectBinding> {
  const internalToken = options.userCredentialsInternalToken?.trim();
  if (!internalToken) {
    throw new Error("GitHub fork credential service is not configured");
  }
  const baseUrl = options.dataServiceUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({
    bot_id: botId,
    wecom_user_id: userId,
    provider: "github_fork",
    project_key: projectKey,
  });
  const response = await fetchImpl(
    `${baseUrl}/internal/user-credentials/project-git?${query}`,
    { headers: { authorization: `Bearer ${internalToken}` } },
  );
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "failed to load GitHub fork binding");
  }
  return {
    project_key: requireSafeSegment(body.project_key ?? projectKey, "project_key"),
    project_repository_url: requireText(body.repository_url, "repository_url"),
    project_default_branch: requireText(body.branch, "branch"),
    project_directory: projectKey,
    access_token: requireText(body.access_token, "access_token", false),
  };
}

function ensureConversationRoot(
  workspaceRoot: string,
  botId: string,
  userId: string,
  conversationId: string,
): string {
  const botRoot = ensureSafeDirectory(join(workspaceRoot, botId));
  const usersRoot = ensureSafeDirectory(join(botRoot, "users"));
  const userRoot = ensureSafeDirectory(join(usersRoot, hashUserId(userId)));
  const conversationsRoot = ensureSafeDirectory(join(userRoot, "conversations"));
  return ensureSafeDirectory(join(conversationsRoot, conversationId));
}

function initializeWorkspaceRoot(configuredRoot: string): string {
  const root = resolve(configuredRoot);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

function initializeRepositoryCacheRoot(configuredRoot: string): string {
  const root = resolve(configuredRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(root);
}

function ensureSafeDirectory(directory: string): string {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("project workspace contains an unsafe path");
    }
  } else {
    mkdirSync(directory);
  }
  return realpathSync(directory);
}

function assertPathInside(parent: string, child: string): void {
  const path = relative(parent, child);
  if (path === "" || path.startsWith("..") || path.startsWith("/")) {
    throw new Error("project path must stay inside the conversation workspace");
  }
}

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32);
}

function requireText(value: unknown, field: string, trim = true): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return trim ? value.trim() : value;
}

function requireSafeSegment(value: unknown, field: string): string {
  const segment = requireText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) {
    throw new Error(`${field} must be a safe path segment`);
  }
  return segment;
}

function requireGitRef(value: unknown, field: string): string {
  const ref = requireText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new Error(`${field} must be a safe Git branch name`);
  }
  return ref;
}

function cloneGitRepository(
  repositoryUrl: string,
  branch: string,
  destination: string,
  accessToken?: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      requireGitRef(branch, "branch"),
      "--",
      repositoryUrl,
      destination,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ...(accessToken ? gitCredentialEnv(accessToken) : { GIT_TERMINAL_PROMPT: "0" }),
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(stderr.trim() || `git clone exited with code ${code ?? "unknown"}`));
    });
  });
}

function gitCredentialEnv(accessToken: string): Record<string, string> {
  const token = requireText(accessToken, "access_token", false);
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

async function cloneWorkspaceFromBaseline(
  baselinePath: string,
  branch: string,
  destination: string,
): Promise<void> {
  await runGit(["clone", "--shared", "--branch", requireGitRef(branch, "branch"), "--", baselinePath, destination]);
}

async function refreshGitRepository(repositoryPath: string, branch: string, accessToken?: string): Promise<void> {
  const safeBranch = requireGitRef(branch, "branch");
  await runGit([
    "-C",
    repositoryPath,
    "fetch",
    "--depth",
    "1",
    "origin",
    `+refs/heads/${safeBranch}:refs/remotes/origin/${safeBranch}`,
  ], accessToken);
  await runGit([
    "-C",
    repositoryPath,
    "reset",
    "--hard",
    `refs/remotes/origin/${safeBranch}`,
  ]);
}

async function resolveGitRevision(repositoryPath: string): Promise<string> {
  const output = await runGit(["-C", repositoryPath, "rev-parse", "HEAD"]);
  const revision = output.trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("Git repository revision is invalid");
  }
  return revision;
}

function runGit(args: string[], accessToken?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(accessToken ? gitCredentialEnv(accessToken) : { GIT_TERMINAL_PROMPT: "0" }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `git exited with code ${code ?? "unknown"}`));
    });
  });
}
