import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginSkillInstall,
  finalizeSkillInstall,
  rollbackSkillInstall,
} from "./installer.js";
import { ensureBotWorkspace } from "./workspace.js";

describe("capability-runner installer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("begins skill install in bot-private temp space", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-installer-"));
    dirs.push(root);

    const started = beginSkillInstall(root, "prd-bot", "repo-analyzer");

    expect(started.status).toBe("staged");
    expect(started.botId).toBe("prd-bot");
    expect(started.targetName).toBe("repo-analyzer");
    expect(started.stageDir.startsWith(ensureBotWorkspace(root, "prd-bot").tmpDir)).toBe(true);
    expect(started.finalDir).toBe(ensureBotWorkspace(root, "prd-bot").skillsDir + "/repo-analyzer");
    expect(existsSync(started.stageDir)).toBe(true);
  });

  it("rejects skill names that try to escape the bot-private workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-installer-"));
    dirs.push(root);

    expect(() => beginSkillInstall(root, "prd-bot", "../repo-analyzer")).toThrow(
      "target_name must be a single path segment",
    );
    expect(() => beginSkillInstall(root, "prd-bot", "/repo-analyzer")).toThrow(
      "target_name must be a single path segment",
    );
    expect(() => beginSkillInstall(root, "prd-bot", "nested/repo-analyzer")).toThrow(
      "target_name must be a single path segment",
    );
  });

  it("finalizes skill install by moving staged contents into the target dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-installer-"));
    dirs.push(root);

    const started = beginSkillInstall(root, "prd-bot", "repo-analyzer");
    writeFileSync(join(started.stageDir, "skill.txt"), "installed");

    const finalized = finalizeSkillInstall(started);

    expect(finalized.status).toBe("installed");
    expect(existsSync(started.stageDir)).toBe(false);
    expect(existsSync(join(finalized.finalDir, "skill.txt"))).toBe(true);
    expect(readFileSync(join(finalized.finalDir, "skill.txt"), "utf8")).toBe("installed");
  });

  it("rolls back staged install by removing temp dir and partial final target", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-installer-"));
    dirs.push(root);

    const started = beginSkillInstall(root, "prd-bot", "repo-analyzer");
    writeFileSync(join(started.stageDir, "skill.txt"), "installed");
    writeFileSync(started.finalDir, "partial");

    const rolledBack = rollbackSkillInstall(started);

    expect(rolledBack.status).toBe("rolled_back");
    expect(existsSync(started.stageDir)).toBe(false);
    expect(existsSync(started.finalDir)).toBe(false);
  });
});
