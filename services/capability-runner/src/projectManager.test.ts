import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectManager } from "./projectManager.js";

function projectBindingResponse(): Response {
  return Response.json({
    project_key: "im-test-hub",
    repository_url: "https://github.com/example/im-test-hub.git",
    branch: "main",
    access_token: "test-token",
  });
}

function runGit(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function createTestRepository(root: string, userId = "user-a"): { projectRoot: string; baseCommit: string } {
  const userHash = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32);
  const projectRoot = join(root, "qa-bot", "users", userHash, "projects", "im-test-hub");
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["-C", projectRoot, "init", "-b", "main"]);
  writeFileSync(join(projectRoot, "README.md"), "# Test\n");
  runGit(projectRoot, ["add", "README.md"]);
  runGit(projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
  return { projectRoot, baseCommit: runGit(projectRoot, ["rev-parse", "HEAD"]) };
}

describe("project manager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one writable project per Bot user across conversations", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-"));
    roots.push(root);
    const cloneRepository = vi.fn(async (_url: string, _branch: string, destination: string) => {
      mkdirSync(join(destination, ".git"), { recursive: true });
    });
    const cloneWorkspace = vi.fn(async (_baseline: string, _branch: string, destination: string) => {
      mkdirSync(join(destination, ".git"), { recursive: true });
    });
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      cloneRepository,
      cloneWorkspace,
      resolveRevision: vi.fn(async () => "a".repeat(40)),
      baselineRefreshMs: Number.MAX_SAFE_INTEGER,
    });

    const first = await manager.ensure({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });
    const repeated = await manager.ensure({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });
    const otherConversation = await manager.ensure({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-2",
      projectKey: "im-test-hub",
    });
    const otherUser = await manager.ensure({
      botId: "qa-bot",
      userId: "user-b",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });

    expect(first).toEqual({
      project_key: "im-test-hub",
      path: "../../projects/im-test-hub",
      branch: "main",
      base_commit: "a".repeat(40),
      reused: false,
    });
    expect(repeated.reused).toBe(true);
    expect(otherConversation).toMatchObject({
      path: "../../projects/im-test-hub",
      reused: true,
    });
    expect(otherUser.reused).toBe(false);
    expect(cloneRepository).toHaveBeenCalledTimes(2);
    expect(cloneWorkspace).toHaveBeenCalledTimes(2);
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
      cloneRepository: vi.fn(),
    });

    await expect(manager.ensure({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    })).rejects.toThrow("GitHub fork credential service is not configured");
  });

  it("does not materialize project .env in the shared user project workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-"));
    roots.push(root);
    const fetchMock = vi.fn(async () => {
      return projectBindingResponse();
    });
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: fetchMock as typeof fetch,
      cloneRepository: vi.fn(async (_url: string, _branch: string, destination: string) => {
        mkdirSync(join(destination, ".git"), { recursive: true });
      }),
      cloneWorkspace: vi.fn(async (_baseline: string, _branch: string, destination: string) => {
        mkdirSync(join(destination, ".git"), { recursive: true });
      }),
      resolveRevision: vi.fn(async () => "b".repeat(40)),
    });
    const input = {
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    };
    const userHash = createHash("sha256").update("user-a", "utf8").digest("hex").slice(0, 32);
    const projectRoot = join(
      root,
      "qa-bot",
      "users",
      userHash,
      "projects",
      "im-test-hub",
    );

    await manager.ensure(input);
    expect(existsSync(join(projectRoot, ".env"))).toBe(false);

    const runtimeRoot = join(root, "qa-bot", "users", userHash, ".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(projectRoot, ".env"), "legacy-managed-env\n");
    writeFileSync(join(runtimeRoot, "im-test-hub.dotenv-managed"), "managed\n");
    await manager.ensure(input);
    expect(existsSync(join(projectRoot, ".env"))).toBe(false);
  });

  it("migrates the current conversation's legacy project into the shared user workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-manager-"));
    roots.push(root);
    const userHash = createHash("sha256").update("user-a", "utf8").digest("hex").slice(0, 32);
    const conversationRoot = join(root, "qa-bot", "users", userHash, "conversations", "conv-1");
    const legacyProject = join(conversationRoot, "projects", "im-test-hub");
    mkdirSync(join(legacyProject, ".git"), { recursive: true });
    mkdirSync(join(conversationRoot, ".runtime"), { recursive: true });
    writeFileSync(join(legacyProject, "README.md"), "legacy work\n");
    writeFileSync(join(legacyProject, ".env"), "managed\n");
    writeFileSync(join(conversationRoot, ".runtime", "im-test-hub.dotenv-managed"), "managed\n");
    const cloneWorkspace = vi.fn();
    const manager = createProjectManager({
      dataServiceUrl: "http://data-service",
      userCredentialsInternalToken: "internal-token",
      kiroWorkspaceRoot: root,
      fetch: vi.fn(async () => projectBindingResponse()),
      cloneRepository: vi.fn(),
      cloneWorkspace,
      resolveRevision: vi.fn(async () => "c".repeat(40)),
    });

    const result = await manager.ensure({
      botId: "qa-bot",
      userId: "user-a",
      conversationId: "conv-1",
      projectKey: "im-test-hub",
    });

    const sharedProject = join(root, "qa-bot", "users", userHash, "projects", "im-test-hub");
    expect(result).toMatchObject({ path: "../../projects/im-test-hub", reused: true });
    expect(existsSync(join(sharedProject, "README.md"))).toBe(true);
    expect(existsSync(join(sharedProject, ".env"))).toBe(false);
    expect(existsSync(legacyProject)).toBe(false);
    expect(cloneWorkspace).not.toHaveBeenCalled();
  });

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
      branch: "bot/add-new-case",
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
    expect(runGit(projectRoot, ["branch", "--list", "bot/push-fails"])).toBe("");
  });

});
