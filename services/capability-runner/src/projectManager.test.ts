import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectManager } from "./projectManager.js";

function projectBindingResponse(repositoryUrl = "https://github.com/example/im-test-hub.git"): Response {
  return Response.json({
    project_key: "im-test-hub",
    repository_url: repositoryUrl,
    branch: "main",
    access_token: "test-token",
  });
}

function runGit(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function createTestRepository(root: string, userId = "user-a"): { projectRoot: string; baseCommit: string } {
  const userHash = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32);
  const userRoot = join(root, "qa-bot", "users", userHash);
  const projectRoot = join(userRoot, "projects", "im-test-hub");
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["-C", projectRoot, "init", "-b", "main"]);
  writeFileSync(join(projectRoot, "README.md"), "# Test\n");
  runGit(projectRoot, ["add", "README.md"]);
  runGit(projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  const baseCommit = runGit(projectRoot, ["rev-parse", "HEAD"]);
  const syncStateRoot = join(userRoot, ".runtime", "project-sync");
  mkdirSync(syncStateRoot, { recursive: true });
  writeFileSync(join(syncStateRoot, "im-test-hub.json"), `${JSON.stringify({ base_commit: baseCommit })}\n`);
  return { projectRoot, baseCommit };
}

function createBareRemote(root: string): string {
  const seed = join(root, "seed");
  const remote = join(root, "bound-fork.git");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["-C", seed, "init", "-b", "main"]);
  writeFileSync(join(seed, "README.md"), "# Bound fork\n");
  runGit(seed, ["add", "README.md"]);
  runGit(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  execFileSync("git", ["init", "--bare", remote]);
  runGit(seed, ["remote", "add", "origin", remote]);
  runGit(seed, ["push", "origin", "main"]);
  return remote;
}

async function createCloneRepository(_url: string, _branch: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true });
  execFileSync("git", ["-C", destination, "init", "-b", "main"]);
  writeFileSync(join(destination, "README.md"), "# Fork\n");
  runGit(destination, ["add", "README.md"]);
  runGit(destination, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
}

async function noRemotePublishBranch(): Promise<undefined> {
  return undefined;
}

function conversationPublishBranch(projectKey: string, conversationId: string, botId = "qa-bot"): string {
  return `bot/${projectKey}-${createHash("sha256").update(`${botId}\0${conversationId}`, "utf8").digest("hex").slice(0, 12)}`;
}

describe("project manager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes one writable project per Bot user across conversations", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-"));
    roots.push(root);
    const cloneRepository = vi.fn(async (_url: string, _branch: string, destination: string) => {
      mkdirSync(join(destination, ".git"), { recursive: true });
    });
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      cloneRepository,
      resolveRevision: vi.fn(async () => "a".repeat(40)),
    });

    const first = await manager.sync({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });
    const repeated = await manager.sync({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });
    const otherConversation = await manager.sync({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-2",
      projectKey: "im-test-hub",
    });
    const otherUser = await manager.sync({
      botId: "qa-bot",
      userId: "user-b",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });

    expect(first).toEqual({
      project_key: "im-test-hub",
      path: "projects/im-test-hub",
      branch: "main",
      base_commit: "a".repeat(40),
      reused: false,
    });
    expect(repeated.reused).toBe(false);
    expect(otherConversation).toMatchObject({
      path: "projects/im-test-hub",
      reused: false,
    });
    expect(otherUser.reused).toBe(false);
    expect(cloneRepository).toHaveBeenCalledTimes(4);
    for (const call of cloneRepository.mock.calls) {
      expect(existsSync(join(call[2], ".git"))).toBe(false);
    }
  });

  it("requires the GitHub fork credential service to be configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-"));
    roots.push(root);
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      cloneRepository: vi.fn(),
    });

    await expect(manager.sync({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    })).rejects.toThrow("GitHub fork credential service is not configured");
  });

  // .env cleanup and legacy migration tests removed — project preparation
  // now runs on the shared user project directory directly.

  it("commits validated changes and pushes a new bot branch to the bound fork", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-publish-"));
    roots.push(root);
    const { projectRoot } = createTestRepository(root);
    mkdirSync(join(projectRoot, "tests"), { recursive: true });
    writeFileSync(join(projectRoot, "tests", "test_new_case.py"), "def test_new_case():\n    assert True\n");
    const pushBranch = vi.fn(async () => undefined);
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      pushBranch,
    });

    const result = await manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
      branch: "bot/add-new-case",
      commitMessage: "test: add new case",
    });

    expect(result).toMatchObject({
      project_key: "im-test-hub",
      branch: conversationPublishBranch("im-test-hub", "conv-1"),
      changed_paths: ["tests/test_new_case.py"],
    });
    expect(result.github_url).toBe(`https://github.com/example/im-test-hub/tree/${result.branch}`);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pushBranch).toHaveBeenCalledWith(
      realpathSync(projectRoot),
      "https://github.com/example/im-test-hub.git",
      result.branch,
      "test-token",
    );
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe(result.branch);
    expect(runGit(projectRoot, ["status", "--porcelain"])).toBe("");
  });

  it("appends repeated im-test-hub publishes from one conversation to its stable branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-repeat-shared-"));
    roots.push(root);
    const remote = createBareRemote(root);
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse(remote)),
    });
    await manager.sync({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-repeat",
      projectKey: "im-test-hub",
    });
    const userHash = createHash("sha256").update("user-a", "utf8").digest("hex").slice(0, 32);
    const projectRoot = join(root, "qa-bot", "users", userHash, "projects", "im-test-hub");
    mkdirSync(join(projectRoot, "tests"), { recursive: true });
    writeFileSync(join(projectRoot, "tests", "test_repeat.py"), "def test_repeat(): assert 1\n");

    const first = await manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-repeat",
      projectKey: "im-test-hub",
      branch: "bot/ignored-by-backend",
      commitMessage: "test: first repeat publish",
    });
    writeFileSync(join(projectRoot, "tests", "test_repeat.py"), "def test_repeat(): assert 2\n");
    const second = await manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-repeat",
      projectKey: "im-test-hub",
      branch: "bot/a-different-model-suggestion",
      commitMessage: "test: second repeat publish",
    });

    const branch = conversationPublishBranch("im-test-hub", "conv-repeat");
    expect(first.branch).toBe(branch);
    expect(second.branch).toBe(branch);
    expect(second.commit).not.toBe(first.commit);
    expect(execFileSync("git", ["--git-dir", remote, "rev-list", "--count", branch], { encoding: "utf8" }).trim()).toBe("3");
    expect(execFileSync("git", ["--git-dir", remote, "show", `${branch}:tests/test_repeat.py`], { encoding: "utf8" }))
      .toContain("assert 2");
  });

  it("publishes only the current conversation Jira project without /sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-jira-publish-"));
    roots.push(root);
    const userHash = createHash("sha256").update("user-a", "utf8").digest("hex").slice(0, 32);
    const source = join(root, "qa-bot", "users", userHash, "conversations", "conv-1", "HIM-22187");
    mkdirSync(join(source, "tests"), { recursive: true });
    mkdirSync(join(source, "reports"), { recursive: true });
    mkdirSync(join(source, "env"), { recursive: true });
    writeFileSync(join(source, "README.md"), "# HIM-22187\n");
    writeFileSync(join(source, "tests", "test_group_sync.py"), "def test_group_sync(): pass\n");
    writeFileSync(join(source, "env", ".env.qa"), "TOKEN=secret\n");
    writeFileSync(join(source, "reports", "report.md"), "private evidence\n");
    const pushBranch = vi.fn(async () => undefined);
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      cloneRepository: createCloneRepository,
      pushBranch,
    });

    const result = await manager.publishJira({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      jiraKey: "HIM-22187",
      branch: "bot/HIM-22187-case",
      commitMessage: "test: add HIM-22187 automation",
    });

    expect(result).toMatchObject({
      project_key: "HIM-22187",
      branch: conversationPublishBranch("HIM-22187", "conv-1"),
      changed_paths: [
        "HIM-22187/README.md",
        "HIM-22187/reports/report.md",
        "HIM-22187/tests/test_group_sync.py",
      ],
    });
    expect(result.changed_paths).not.toContain("HIM-22187/env/.env.qa");
    expect(result.changed_paths).toContain("HIM-22187/reports/report.md");
    expect(pushBranch).toHaveBeenCalledWith(
      expect.stringContaining(".jira-publish-"),
      "https://github.com/example/im-test-hub.git",
      conversationPublishBranch("HIM-22187", "conv-1"),
      "test-token",
    );
  });

  it("appends repeated Jira publishes from one conversation to its stable remote branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-repeat-jira-"));
    roots.push(root);
    const remote = createBareRemote(root);
    const userHash = createHash("sha256").update("user-a", "utf8").digest("hex").slice(0, 32);
    const source = join(root, "qa-bot", "users", userHash, "conversations", "conv-repeat", "HIM-22187");
    mkdirSync(join(source, "tests"), { recursive: true });
    writeFileSync(join(source, "README.md"), "# HIM-22187\n");
    writeFileSync(join(source, "tests", "test_group_sync.py"), "def test_group_sync(): assert 1\n");
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse(remote)),
    });

    const first = await manager.publishJira({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-repeat",
      jiraKey: "HIM-22187",
      branch: "bot/HIM-22187-case",
      commitMessage: "test: first Jira publish",
    });
    writeFileSync(join(source, "tests", "test_group_sync.py"), "def test_group_sync(): assert 2\n");
    const second = await manager.publishJira({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-repeat",
      jiraKey: "HIM-22187",
      branch: "bot/another-suggestion",
      commitMessage: "test: second Jira publish",
    });

    const branch = conversationPublishBranch("HIM-22187", "conv-repeat");
    expect(first.branch).toBe(branch);
    expect(second.branch).toBe(branch);
    expect(second.commit).not.toBe(first.commit);
    expect(execFileSync("git", ["--git-dir", remote, "rev-list", "--count", branch], { encoding: "utf8" }).trim()).toBe("3");
    expect(execFileSync("git", ["--git-dir", remote, "show", `${branch}:HIM-22187/tests/test_group_sync.py`], { encoding: "utf8" }))
      .toContain("assert 2");
  });

  it("blocks sensitive files before creating a publish branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-publish-"));
    roots.push(root);
    const { projectRoot } = createTestRepository(root);
    writeFileSync(join(projectRoot, ".env"), "CLIENT_SECRET=secret\n");
    const pushBranch = vi.fn();
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      pushBranch,
    });

    await expect(manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
      branch: "bot/unsafe-case",
      commitMessage: "test: unsafe",
    })).rejects.toThrow("blocked path: .env");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe("main");
  });

  it("rejects commits created outside project.publish", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-publish-"));
    roots.push(root);
    const { projectRoot } = createTestRepository(root);
    writeFileSync(join(projectRoot, "case.py"), "assert True\n");
    runGit(projectRoot, ["add", "case.py"]);
    runGit(projectRoot, ["-c", "user.name=CLI", "-c", "user.email=cli@example.com", "commit", "-m", "direct commit"]);
    const pushBranch = vi.fn();
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      pushBranch,
    });

    await expect(manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
      branch: "bot/direct-commit",
      commitMessage: "test: direct commit",
    })).rejects.toThrow("commit not created by project.publish");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe("main");
  });

  it("blocks executable local Git configuration before staging changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-publish-"));
    roots.push(root);
    const { projectRoot } = createTestRepository(root);
    writeFileSync(join(projectRoot, "case.py"), "assert True\n");
    runGit(projectRoot, ["config", "filter.unsafe.clean", "touch /tmp/should-not-run"]);
    const pushBranch = vi.fn();
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      pushBranch,
    });

    await expect(manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
      branch: "bot/unsafe-config",
      commitMessage: "test: unsafe config",
    })).rejects.toThrow("blocked setting: filter.unsafe.clean");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe("main");
  });

  it("restores uncommitted changes when GitHub push fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-publish-"));
    roots.push(root);
    const { projectRoot } = createTestRepository(root);
    writeFileSync(join(projectRoot, "case.py"), "assert True\n");
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      fetchPublishBranch: noRemotePublishBranch,
      pushBranch: vi.fn(async () => { throw new Error("push rejected"); }),
    });

    await expect(manager.publish({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
      branch: "bot/push-fails",
      commitMessage: "test: preserve changes",
    })).rejects.toThrow("push rejected");
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe("main");
    expect(runGit(projectRoot, ["status", "--porcelain"])).toContain("?? case.py");
    expect(runGit(projectRoot, ["branch", "--list", conversationPublishBranch("im-test-hub", "conv-1")])).toBe("");
  });

});
