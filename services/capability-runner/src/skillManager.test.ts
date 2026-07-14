import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillManager } from "./skillManager.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("skill manager", () => {
  it("lists builtin skills, installs them into the bot Kiro workspace, and records status", async () => {
    const root = createTempRoot();
    const catalogRoot = join(root, "catalog");
    const workspaceRoot = join(root, "workspaces");
    createSkill(catalogRoot, "jira-test", "Analyze Jira for QA");
    mkdirSync(join(catalogRoot, "jira-test", ".venv"));
    writeFileSync(join(catalogRoot, "jira-test", ".venv", "ignored"), "ignore me");

    const statuses: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      statuses.push(await request.json() as Record<string, unknown>);
      return Response.json({ ok: true }, { status: 201 });
    });
    const manager = createSkillManager({
      dataServiceUrl: "http://data-service",
      kiroWorkspaceRoot: workspaceRoot,
      skillCatalogRoot: catalogRoot,
      fetch: fetchMock,
    });

    expect(manager.listCatalog()).toEqual([{
      name: "jira-test",
      description: "Analyze Jira for QA",
      source_type: "builtin",
      source_ref: "jira-test",
    }]);

    await manager.dispatch({
      action: "skills/install",
      botId: "bot-a",
      payload: {
        name: "jira-test",
        source_type: "builtin",
        source_ref: "jira-test",
        actor_id: "admin-a",
      },
    });

    const installedRoot = join(workspaceRoot, "bot-a", ".kiro", "skills", "jira-test");
    expect(readFileSync(join(installedRoot, "SKILL.md"), "utf8")).toContain("name: jira-test");
    expect(existsSync(join(installedRoot, ".venv"))).toBe(false);
    expect(statuses.map((record) => record.status)).toEqual(["installing", "installed"]);
    expect(statuses[1]).toMatchObject({
      installed_by_wecom_user_id: "admin-a",
      source_type: "builtin",
      source_ref: "jira-test",
    });
  });

  it("records a failed status when a package cannot be installed", async () => {
    const root = createTempRoot();
    const catalogRoot = join(root, "catalog");
    const workspaceRoot = join(root, "workspaces");
    createSkill(catalogRoot, "source-folder", "Wrong name", "different-name");

    const statuses: Array<Record<string, unknown>> = [];
    const manager = createSkillManager({
      dataServiceUrl: "http://data-service",
      kiroWorkspaceRoot: workspaceRoot,
      skillCatalogRoot: catalogRoot,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        statuses.push(await request.json() as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
    });

    await expect(manager.dispatch({
      action: "skills/install",
      botId: "bot-a",
      payload: { name: "source-folder", source_ref: "source-folder" },
    })).rejects.toThrow("skill name does not match");

    expect(statuses.map((record) => record.status)).toEqual(["installing", "failed"]);
    expect(statuses[1].last_error).toContain("skill name does not match");
  });

  it("deletes the package and its bot_skills record", async () => {
    const root = createTempRoot();
    const catalogRoot = join(root, "catalog");
    const workspaceRoot = join(root, "workspaces");
    createSkill(catalogRoot, "jira-test", "Analyze Jira for QA");
    const requests: Request[] = [];
    const manager = createSkillManager({
      dataServiceUrl: "http://data-service",
      kiroWorkspaceRoot: workspaceRoot,
      skillCatalogRoot: catalogRoot,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request.clone());
        return request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ ok: true }, { status: 201 });
      },
    });
    await manager.dispatch({
      action: "skills/install",
      botId: "bot-a",
      payload: { name: "jira-test", source_ref: "jira-test" },
    });

    await manager.dispatch({
      action: "skills/delete",
      botId: "bot-a",
      payload: { name: "jira-test" },
    });

    expect(existsSync(join(workspaceRoot, "bot-a", ".kiro", "skills", "jira-test"))).toBe(false);
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(requests.at(-1)?.url).toBe("http://data-service/v1/bots/bot-a/skills/jira-test");
  });

  it("rejects a .kiro symlink that escapes the bot workspace", async () => {
    const root = createTempRoot();
    const catalogRoot = join(root, "catalog");
    const workspaceRoot = join(root, "workspaces");
    const outsideRoot = join(root, "outside");
    createSkill(catalogRoot, "jira-test", "Analyze Jira for QA");
    mkdirSync(join(workspaceRoot, "bot-a"), { recursive: true });
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, join(workspaceRoot, "bot-a", ".kiro"));
    const statuses: Array<Record<string, unknown>> = [];
    const manager = createSkillManager({
      dataServiceUrl: "http://data-service",
      kiroWorkspaceRoot: workspaceRoot,
      skillCatalogRoot: catalogRoot,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        statuses.push(await request.json() as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
    });

    await expect(manager.dispatch({
      action: "skills/install",
      botId: "bot-a",
      payload: { name: "jira-test", source_ref: "jira-test" },
    })).rejects.toThrow("escapes its configured root");
    expect(statuses.map((record) => record.status)).toEqual(["installing", "failed"]);
    expect(existsSync(join(outsideRoot, "skills", "jira-test"))).toBe(false);
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-manager-"));
  tempRoots.push(root);
  return root;
}

function createSkill(
  catalogRoot: string,
  folderName: string,
  description: string,
  frontmatterName = folderName,
): void {
  const skillRoot = join(catalogRoot, folderName);
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), [
    "---",
    `name: ${frontmatterName}`,
    `description: ${description}`,
    "---",
    "",
    `# ${frontmatterName}`,
  ].join("\n"));
  writeFileSync(join(skillRoot, "scripts", "run.sh"), "#!/bin/sh\n");
}
