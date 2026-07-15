import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("project manager", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the current user's bound fork and creates writable copies only per conversation", async () => {
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
    const otherUser = await manager.ensure({
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
    expect(repeated.reused).toBe(true);
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

  it("does not materialize project .env in the Kiro conversation workspace", async () => {
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
      "conversations",
      "conv-1",
      "projects",
      "im-test-hub",
    );

    await manager.ensure(input);
    expect(existsSync(join(projectRoot, ".env"))).toBe(false);

    const runtimeRoot = join(root, "qa-bot", "users", userHash, "conversations", "conv-1", ".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(projectRoot, ".env"), "legacy-managed-env\n");
    writeFileSync(join(runtimeRoot, "im-test-hub.dotenv-managed"), "managed\n");
    await manager.ensure(input);
    expect(existsSync(join(projectRoot, ".env"))).toBe(false);
  });

});
