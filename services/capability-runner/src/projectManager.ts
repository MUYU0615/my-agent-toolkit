import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export interface EnsureProjectInput {
  botId: string;
  userId: string;
  conversationId: string;
  projectKey?: string;
}

export interface EnsureProjectResult {
  project_key: string;
  path: string;
  branch: string;
  base_commit: string;
  reused: boolean;
}

export interface PublishProjectInput extends EnsureProjectInput {
  branch: string;
  commitMessage: string;
}

export interface PublishJiraProjectInput extends EnsureProjectInput {
  jiraKey: string;
  branch: string;
  commitMessage: string;
}

export interface PublishProjectResult {
  project_key: string;
  branch: string;
  commit: string;
  changed_paths: string[];
  github_url?: string;
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
  fetch?: typeof fetch;
  cloneRepository?: (
    repositoryUrl: string,
    branch: string,
    destination: string,
    accessToken?: string,
  ) => Promise<void>;
  resolveRevision?: (repositoryPath: string) => Promise<string>;
  pushBranch?: (
    repositoryPath: string,
    repositoryUrl: string,
    branch: string,
    accessToken: string,
  ) => Promise<void>;
  /** Test seam for fetching a previously published conversation branch. */
  fetchPublishBranch?: (
    repositoryPath: string,
    repositoryUrl: string,
    branch: string,
    accessToken: string,
  ) => Promise<string | undefined>;
}

export interface ProjectManager {
  sync(input: EnsureProjectInput): Promise<EnsureProjectResult>;
  publish(input: PublishProjectInput): Promise<PublishProjectResult>;
  publishJira(input: PublishJiraProjectInput): Promise<PublishProjectResult>;
}

export function createProjectManager(options: CreateProjectManagerOptions): ProjectManager {
  const fetchImpl = options.fetch ?? fetch;
  const cloneRepository = options.cloneRepository ?? cloneGitRepository;
  const resolveRevision = options.resolveRevision ?? resolveGitRevision;
  const pushBranch = options.pushBranch ?? pushGitBranch;
  const fetchPublishBranch = options.fetchPublishBranch ?? fetchGitPublishBranch;
  const workspaceRoot = initializeWorkspaceRoot(options.kiroWorkspaceRoot);
  const pending = new Map<string, Promise<EnsureProjectResult>>();
  const pendingPublishes = new Map<string, Promise<PublishProjectResult>>();

  async function ensureProjectDir(input: EnsureProjectInput): Promise<{
    binding: UserProjectBinding;
    userRoot: string;
    destination: string;
  }> {
    const botId = requireSafeSegment(input.botId, "bot_id");
    const userId = requireText(input.userId, "user_id");
    const requestedProjectKey = input.projectKey === undefined
      ? undefined
      : requireSafeSegment(input.projectKey, "project_key");
    const binding = await loadUserProjectBinding(fetchImpl, options, botId, userId, requestedProjectKey);

    const botRoot = ensureSafeDirectory(join(workspaceRoot, botId));
    const usersRoot = ensureSafeDirectory(join(botRoot, "users"));
    const userRoot = ensureSafeDirectory(join(usersRoot, hashUserId(userId)));
    const projectsRoot = ensureSafeDirectory(join(userRoot, "projects"));
    const destination = resolve(projectsRoot, binding.project_directory);
    assertPathInside(projectsRoot, destination);
    return { binding, userRoot, destination };
  }

  return {
    async sync(input) {
      const { binding, userRoot, destination } = await ensureProjectDir(input);
      // 目录存在就删，每次全新 clone
      if (existsSync(destination)) {
        rmSync(destination, { recursive: true, force: true });
      }
      const projectsRoot = resolve(destination, "..");
      mkdirSync(projectsRoot, { recursive: true });
      const tmpRoot = ensureSafeDirectory(join(userRoot, ".tmp"));
      const temporaryDestination = join(tmpRoot, `.${binding.project_directory}.clone-${randomUUID()}`);
      try {
        await cloneRepository(binding.project_repository_url, binding.project_default_branch, temporaryDestination, binding.access_token);
        if (!existsSync(join(temporaryDestination, ".git"))) {
          throw new Error("Git clone completed without a .git directory");
        }
        renameSync(temporaryDestination, destination);
      } finally {
        if (existsSync(temporaryDestination)) {
          rmSync(temporaryDestination, { recursive: true, force: true });
        }
      }
      const baseCommit = await resolveRevision(destination);
      writeProjectSyncBaseline(userRoot, binding.project_directory, baseCommit);
      return projectResult(binding, userRoot, destination, false, baseCommit);
    },
    async publish(input) {
      const { binding, userRoot, destination } = await ensureProjectDir(input);
      requirePublishBranch(input.branch, binding.project_default_branch);
      const branch = conversationPublishBranch(binding.project_key, input.botId, input.conversationId);
      const commitMessage = requireCommitMessage(input.commitMessage);
      const existing = pendingPublishes.get(destination);
      if (existing) return existing;
      const operation = (async () => {
        if (!existsSync(destination) || !lstatSync(destination).isDirectory() || !existsSync(join(destination, ".git"))) {
          throw new Error("project workspace is not prepared; run /sync first");
        }
        cleanupManagedProjectDotenv(userRoot, destination, binding.project_directory);
        await assertSafeLocalGitConfig(destination);
        const originalCommit = await resolveRevision(destination);
        const expectedBaseCommit = readProjectSyncBaseline(userRoot, binding.project_directory);
        if (originalCommit !== expectedBaseCommit) {
          throw new Error(
            "project workspace contains a commit not created by project.publish; run /sync before publishing",
          );
        }
        const originalBranch = (await runGit(["-C", destination, "branch", "--show-current"])).trim();
        const changedPaths = await listPublishableChanges(destination);
        if (changedPaths.length > 0) {
          const preparedBranch = await preparePublishBranch(
            destination,
            branch,
            originalBranch,
            binding.project_repository_url,
            binding.access_token,
            fetchPublishBranch,
          );
          try {
            await runGit(["-C", destination, "add", "--all"]);
            const stagedPaths = parseNulSeparated(await runGit([
              "-C", destination, "diff", "--cached", "--name-only", "-z",
            ]));
            validatePublishPaths(destination, stagedPaths);
            await runGit([
              "-C", destination,
              "-c", "user.name=IM Test Hub Bot",
              "-c", "user.email=im-test-hub-bot@users.noreply.github.com",
              "-c", "core.hooksPath=/dev/null",
              "-c", "commit.gpgsign=false",
              "commit", "-m", commitMessage,
            ]);
            await pushBranch(destination, binding.project_repository_url, preparedBranch.branch, binding.access_token);
            const commit = await resolveRevision(destination);
            writeProjectSyncBaseline(userRoot, binding.project_directory, commit);
            const githubUrl = githubBranchUrl(binding.project_repository_url, preparedBranch.branch);
            return {
              project_key: binding.project_key,
              branch: preparedBranch.branch,
              commit,
              changed_paths: stagedPaths.sort(),
              ...(githubUrl ? { github_url: githubUrl } : {}),
            };
          } catch (error) {
            await rollbackPublish(destination, originalBranch, preparedBranch);
            throw error;
          }
        }

        throw new Error("project workspace has no uncommitted changes to publish");
      })().finally(() => pendingPublishes.delete(destination));
      pendingPublishes.set(destination, operation);
      return operation;
    },
    async publishJira(input) {
      const botId = requireSafeSegment(input.botId, "bot_id");
      const userId = requireText(input.userId, "user_id");
      const conversationId = requireSafeSegment(input.conversationId, "conversation_id");
      const jiraKey = requireSafeSegment(input.jiraKey, "jira_key");
      requirePublishBranch(input.branch, "main");
      const branch = conversationPublishBranch(jiraKey, botId, conversationId);
      const commitMessage = requireCommitMessage(input.commitMessage);
      const binding = await loadUserProjectBinding(fetchImpl, options, botId, userId, jiraKey);
      const userRoot = jiraUserRoot(workspaceRoot, botId, userId);
      const conversationRoot = requireExistingSafeDirectory(join(userRoot, "conversations", conversationId), "conversation workspace");
      const source = requireExistingSafeDirectory(join(conversationRoot, jiraKey), "Jira project");
      assertPathInside(conversationRoot, source);
      const operationKey = `${source}:${branch}`;
      const existing = pendingPublishes.get(operationKey);
      if (existing) return existing;

      const operation = (async () => {
        const tmpRoot = ensureSafeDirectory(join(userRoot, ".tmp"));
        const destination = join(tmpRoot, `.jira-publish-${randomUUID()}`);
        try {
          await cloneRepository(
            binding.project_repository_url,
            binding.project_default_branch,
            destination,
            binding.access_token,
          );
          if (!existsSync(join(destination, ".git"))) {
            throw new Error("Git clone completed without a .git directory");
          }
          await assertSafeLocalGitConfig(destination);
          const originalBranch = (await runGit(["-C", destination, "branch", "--show-current"])).trim();
          const preparedBranch = await preparePublishBranch(
            destination,
            branch,
            originalBranch,
            binding.project_repository_url,
            binding.access_token,
            fetchPublishBranch,
          );
          const target = resolve(destination, jiraKey);
          assertPathInside(destination, target);
          if (existsSync(target)) {
            const stat = lstatSync(target);
            if (stat.isSymbolicLink()) throw new Error("remote Jira project path is unsafe");
            rmSync(target, { recursive: true, force: true });
          }
          copySafeJiraProject(source, target);
          await runGit(["-C", destination, "add", "--", jiraKey]);
          const stagedPaths = parseNulSeparated(await runGit([
            "-C", destination, "diff", "--cached", "--name-only", "-z",
          ]));
          if (stagedPaths.length === 0) {
            throw new Error("Jira project has no publishable changes");
          }
          if (stagedPaths.some((path) => path !== jiraKey && !path.startsWith(`${jiraKey}/`))) {
            throw new Error("Jira publish attempted to stage files outside the Jira project");
          }
          validatePublishPaths(destination, stagedPaths);
          await runGit([
            "-C", destination,
            "-c", "user.name=Test-Jira Bot",
            "-c", "user.email=test-jira-bot@users.noreply.github.com",
            "-c", "core.hooksPath=/dev/null",
            "-c", "commit.gpgsign=false",
            "commit", "-m", commitMessage,
          ]);
          await pushBranch(destination, binding.project_repository_url, preparedBranch.branch, binding.access_token);
          const commit = await resolveRevision(destination);
          return {
            project_key: jiraKey,
            branch: preparedBranch.branch,
            commit,
            changed_paths: stagedPaths.sort(),
            ...(githubBranchUrl(binding.project_repository_url, preparedBranch.branch)
              ? { github_url: githubBranchUrl(binding.project_repository_url, preparedBranch.branch) }
              : {}),
          };
        } finally {
          if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        }
      })().finally(() => pendingPublishes.delete(operationKey));
      pendingPublishes.set(operationKey, operation);
      return operation;
    },
  };
}

function jiraUserRoot(workspaceRoot: string, botId: string, userId: string): string {
  const botRoot = ensureSafeDirectory(join(workspaceRoot, botId));
  const usersRoot = ensureSafeDirectory(join(botRoot, "users"));
  return ensureSafeDirectory(join(usersRoot, hashUserId(userId)));
}

function requireExistingSafeDirectory(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} is not available in the current conversation`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} path is unsafe`);
  return realpathSync(path);
}

function copySafeJiraProject(source: string, target: string): void {
  const sourceRoot = requireExistingSafeDirectory(source, "Jira project");
  mkdirSync(target, { recursive: true });
  copySafeJiraDirectory(sourceRoot, target, sourceRoot);
}

function copySafeJiraDirectory(source: string, target: string, sourceRoot: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (isExcludedJiraArtifact(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Jira project contains a symlink: ${relative(sourceRoot, sourcePath)}`);
    if (stat.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copySafeJiraDirectory(sourcePath, targetPath, sourceRoot);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Jira project contains an unsupported file: ${relative(sourceRoot, sourcePath)}`);
    copyFileSync(sourcePath, targetPath);
  }
}

function isExcludedJiraArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  if ([".git", ".runtime", ".venv", "node_modules", ".pytest_cache", "__pycache__", "log", "logs", "output", "allure-results", "allure-report"].includes(lower)) return true;
  if (lower.startsWith(".env") && ![".env.example", ".env.template"].includes(lower)) return true;
  if (["credentials.json", "cookies.json"].includes(lower)) return true;
  if ([".pem", ".key", ".p12", ".pfx"].some((suffix) => lower.endsWith(suffix))) return true;
  return false;
}

function projectSyncStatePath(userRoot: string, projectDirectory: string): string {
  const runtimeRoot = ensureSafeDirectory(join(userRoot, ".runtime"));
  const syncRoot = ensureSafeDirectory(join(runtimeRoot, "project-sync"));
  const statePath = resolve(syncRoot, `${requireSafeSegment(projectDirectory, "project_directory")}.json`);
  assertPathInside(syncRoot, statePath);
  return statePath;
}

function writeProjectSyncBaseline(userRoot: string, projectDirectory: string, commit: string): void {
  const statePath = projectSyncStatePath(userRoot, projectDirectory);
  if (existsSync(statePath)) {
    const stat = lstatSync(statePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("project sync state path is unsafe");
    }
  }
  writeFileSync(statePath, `${JSON.stringify({ base_commit: requireGitCommit(commit) })}\n`, { mode: 0o600 });
}

function readProjectSyncBaseline(userRoot: string, projectDirectory: string): string {
  const statePath = projectSyncStatePath(userRoot, projectDirectory);
  if (!existsSync(statePath)) {
    throw new Error("project workspace is not synchronized; run /sync first");
  }
  const stat = lstatSync(statePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("project sync state path is unsafe");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error("project sync state is invalid; run /sync first");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("project sync state is invalid; run /sync first");
  }
  return requireGitCommit((parsed as { base_commit?: unknown }).base_commit);
}

function cleanupManagedProjectDotenv(
  userRoot: string,
  destination: string,
  projectDirectory: string,
): void {
  const runtimeRoot = ensureSafeDirectory(join(userRoot, ".runtime"));
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
  userRoot: string,
  destination: string,
  reused: boolean,
  baseCommit: string,
): EnsureProjectResult {
  return {
    project_key: config.project_key,
    path: relative(userRoot, destination),
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
  projectKey?: string,
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
  });
  if (projectKey) query.set("project_key", projectKey);
  const response = await fetchImpl(
    `${baseUrl}/internal/user-credentials/project-git?${query}`,
    { headers: { authorization: `Bearer ${internalToken}` } },
  );
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "failed to load GitHub fork binding");
  }
  const resolvedProjectKey = requireSafeSegment(body.project_key ?? projectKey, "project_key");
  return {
    project_key: resolvedProjectKey,
    project_repository_url: requireText(body.repository_url, "repository_url"),
    project_default_branch: requireText(body.branch, "branch"),
    project_directory: resolvedProjectKey,
    access_token: requireText(body.access_token, "access_token", false),
  };
}

function initializeWorkspaceRoot(configuredRoot: string): string {
  const root = resolve(configuredRoot);
  mkdirSync(root, { recursive: true });
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

function requireGitCommit(value: unknown): string {
  const commit = requireText(value, "base_commit");
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("project sync state is invalid; run /sync first");
  }
  return commit;
}

function requirePublishBranch(value: unknown, defaultBranch: string): string {
  const branch = requireGitRef(value, "branch");
  if (!branch.startsWith("bot/") || branch.length > 200) {
    throw new Error("publish branch must start with bot/ and contain at most 200 characters");
  }
  if (branch === requireGitRef(defaultBranch, "project_default_branch")) {
    throw new Error("publishing directly to the default branch is not allowed");
  }
  return branch;
}

function requireCommitMessage(value: unknown): string {
  const message = requireText(value, "commit_message");
  if (message.length > 200 || /[\r\n]/.test(message)) {
    throw new Error("commit_message must be a single line of at most 200 characters");
  }
  return message;
}

async function assertSafeLocalGitConfig(repositoryPath: string): Promise<void> {
  const keys = (await runGit([
    "-C", repositoryPath, "config", "--local", "--no-includes", "--name-only", "--list",
  ])).split(/\r?\n/).map((key) => key.trim().toLowerCase()).filter(Boolean);
  const unsafeKey = keys.find((key) => (
    key === "core.hookspath"
    || key === "core.fsmonitor"
    || key === "core.attributesfile"
    || key === "core.sshcommand"
    || key === "credential.helper"
    || key === "include.path"
    || (key.startsWith("includeif.") && key.endsWith(".path"))
    || (key.startsWith("filter.") && [".clean", ".smudge", ".process"].some((suffix) => key.endsWith(suffix)))
    || (key.startsWith("diff.") && [".command", ".textconv"].some((suffix) => key.endsWith(suffix)))
    || (key.startsWith("url.") && [".insteadof", ".pushinsteadof"].some((suffix) => key.endsWith(suffix)))
    || (key.startsWith("http.") && [".extraheader", ".proxy"].some((suffix) => key.endsWith(suffix)))
  ));
  if (unsafeKey) {
    throw new Error(`project Git config contains a blocked setting: ${unsafeKey}`);
  }
}

async function listPublishableChanges(repositoryPath: string): Promise<string[]> {
  const records = parseNulSeparated(await runGit([
    "-C", repositoryPath, "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ]));
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("project Git status is invalid");
    }
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
      const sourcePath = records[index + 1];
      if (!sourcePath) throw new Error("project Git rename status is invalid");
      paths.push(sourcePath);
      index += 1;
    }
  }
  return validatePublishPaths(repositoryPath, [...new Set(paths)]);
}

function validatePublishPaths(repositoryPath: string, paths: string[]): string[] {
  if (paths.length > 100) {
    throw new Error("project publish contains more than 100 changed paths");
  }
  let totalBytes = 0;
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const basename = segments.at(-1)?.toLowerCase() ?? "";
    if (
      normalized.startsWith("/")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || segments.some((segment) => [".git", ".runtime", ".venv", "node_modules"].includes(segment))
      || ["output", "log", "logs", "allure-results", "allure-report"].includes(segments[0])
      || (basename.startsWith(".env") && ![".env.example", ".env.template"].includes(basename))
      || ["credentials.json", "cookies.json"].includes(basename)
      || [".pem", ".key", ".p12", ".pfx"].some((suffix) => basename.endsWith(suffix))
    ) {
      throw new Error(`project publish contains a blocked path: ${normalized}`);
    }
    const absolutePath = resolve(repositoryPath, normalized);
    assertPathInside(repositoryPath, absolutePath);
    if (existsSync(absolutePath)) {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`project publish cannot include symlinks: ${normalized}`);
      }
      if (stat.isFile()) {
        if (stat.size > 1024 * 1024) {
          throw new Error(`project publish file exceeds 1 MiB: ${normalized}`);
        }
        totalBytes += stat.size;
      }
    }
  }
  if (totalBytes > 5 * 1024 * 1024) {
    throw new Error("project publish exceeds the 5 MiB changed-file limit");
  }
  return paths;
}

function parseNulSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

interface PreparedPublishBranch {
  branch: string;
  created: boolean;
  /** Commit to restore when a reused branch fails to publish. */
  rollbackCommit: string;
}

async function preparePublishBranch(
  repositoryPath: string,
  targetBranch: string,
  currentBranch: string,
  repositoryUrl: string,
  accessToken: string,
  fetchPublishBranch: NonNullable<CreateProjectManagerOptions["fetchPublishBranch"]>,
): Promise<PreparedPublishBranch> {
  const remoteRef = await fetchPublishBranch(repositoryPath, repositoryUrl, targetBranch, accessToken);
  const localBranchExists = await gitRefExists(repositoryPath, `refs/heads/${targetBranch}`);

  if (localBranchExists) {
    if (currentBranch !== targetBranch) {
      await runGit(["-C", repositoryPath, "switch", targetBranch]);
    }
    if (remoteRef) {
      await fastForwardPublishBranch(repositoryPath, remoteRef);
    }
    return {
      branch: targetBranch,
      created: false,
      rollbackCommit: await resolveGitRevision(repositoryPath),
    };
  }

  if (remoteRef) {
    await runGit(["-C", repositoryPath, "switch", "-c", targetBranch, remoteRef]);
  } else {
    await runGit(["-C", repositoryPath, "switch", "-c", targetBranch]);
  }
  return {
    branch: targetBranch,
    created: true,
    rollbackCommit: await resolveGitRevision(repositoryPath),
  };
}

async function fastForwardPublishBranch(repositoryPath: string, remoteRef: string): Promise<void> {
  const localCommit = await resolveGitRevision(repositoryPath);
  const remoteCommit = (await runGit(["-C", repositoryPath, "rev-parse", remoteRef])).trim();
  if (localCommit === remoteCommit || await gitIsAncestor(repositoryPath, remoteCommit, localCommit)) {
    return;
  }
  if (!await gitIsAncestor(repositoryPath, localCommit, remoteCommit)) {
    throw new Error("publish branch has diverged from its remote branch; no changes were pushed");
  }
  try {
    await runGit(["-C", repositoryPath, "merge", "--ff-only", remoteRef]);
  } catch {
    throw new Error("remote publish branch advanced while local changes are pending; no changes were pushed");
  }
}

async function gitRefExists(repositoryPath: string, ref: string): Promise<boolean> {
  try {
    await runGit(["-C", repositoryPath, "show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function gitIsAncestor(repositoryPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["-C", repositoryPath, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function rollbackPublish(
  repositoryPath: string,
  originalBranch: string,
  preparedBranch: PreparedPublishBranch,
): Promise<void> {
  try {
    await runGit(["-C", repositoryPath, "reset", "--mixed", preparedBranch.rollbackCommit]);
    if (originalBranch) {
      await runGit(["-C", repositoryPath, "switch", originalBranch]);
    } else {
      await runGit(["-C", repositoryPath, "switch", "--detach", preparedBranch.rollbackCommit]);
    }
    if (preparedBranch.created) {
      await runGit(["-C", repositoryPath, "branch", "-D", preparedBranch.branch]);
    }
  } catch {
    // Preserve the original publish error. The repository remains available for manual recovery.
  }
}

function conversationPublishBranch(projectKey: string, botId: string, conversationId: string): string {
  const key = requireSafeSegment(projectKey, "project_key");
  const bot = requireSafeSegment(botId, "bot_id");
  const conversation = requireSafeSegment(conversationId, "conversation_id");
  const scope = `${bot}\0${conversation}`;
  return `bot/${key}-${createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 12)}`;
}

function githubBranchUrl(repositoryUrl: string, branch: string): string | undefined {
  let repositoryPath: string | undefined;
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol === "https:" && url.hostname.toLowerCase() === "github.com") {
      repositoryPath = url.pathname.replace(/^\/+|\/+$/g, "");
    }
  } catch {
    const match = repositoryUrl.match(/^git@github\.com:([^\s]+)$/i);
    repositoryPath = match?.[1];
  }
  if (!repositoryPath) return undefined;
  repositoryPath = repositoryPath.replace(/\.git$/i, "");
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repositoryPath}/tree/${encodedBranch}`;
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
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
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

async function pushGitBranch(
  repositoryPath: string,
  repositoryUrl: string,
  branch: string,
  accessToken: string,
): Promise<void> {
  await runGit([
    "-C", repositoryPath,
    "push",
    "--porcelain",
    repositoryUrl,
    `HEAD:refs/heads/${requireGitRef(branch, "branch")}`,
  ], accessToken);
}

async function fetchGitPublishBranch(
  repositoryPath: string,
  repositoryUrl: string,
  branch: string,
  accessToken: string,
): Promise<string | undefined> {
  const safeBranch = requireGitRef(branch, "branch");
  const remoteRef = `refs/remotes/bot-publish/${safeBranch}`;
  try {
    await runGit([
      "-C", repositoryPath,
      "fetch",
      "--no-tags",
      "--depth", "1",
      repositoryUrl,
      `+refs/heads/${safeBranch}:${remoteRef}`,
    ], accessToken);
    return remoteRef;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("couldn't find remote ref") || message.includes("remote ref does not exist")) {
      return undefined;
    }
    throw error;
  }
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
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...(accessToken ? gitCredentialEnv(accessToken) : { GIT_TERMINAL_PROMPT: "0" }),
      },
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
