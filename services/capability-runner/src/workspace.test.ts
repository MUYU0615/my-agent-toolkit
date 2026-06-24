import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupInstallTempDir,
  createInstallTempDir,
  ensureBotWorkspace,
  getBotWorkspacePaths,
} from "./workspace.js";

describe("capability-runner workspace", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds isolated bot workspace paths", () => {
    const root = "/runtime/bots";

    expect(getBotWorkspacePaths(root, "bot-a")).toEqual({
      root: "/runtime/bots/bot-a",
      envDir: "/runtime/bots/bot-a/env",
      skillsDir: "/runtime/bots/bot-a/skills",
      mcpDir: "/runtime/bots/bot-a/mcp",
      cacheDir: "/runtime/bots/bot-a/cache",
      logsDir: "/runtime/bots/bot-a/logs",
      tmpDir: "/runtime/bots/bot-a/tmp",
    });
  });

  it("ensures per-bot workspace directories and cleans install temp dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-workspace-"));
    dirs.push(root);

    const first = ensureBotWorkspace(root, "prd-bot");
    const second = ensureBotWorkspace(root, "ops-bot");

    expect(existsSync(first.root)).toBe(true);
    expect(existsSync(first.envDir)).toBe(true);
    expect(existsSync(first.skillsDir)).toBe(true);
    expect(existsSync(first.mcpDir)).toBe(true);
    expect(existsSync(first.cacheDir)).toBe(true);
    expect(existsSync(first.logsDir)).toBe(true);
    expect(existsSync(first.tmpDir)).toBe(true);
    expect(first.root).not.toBe(second.root);

    const tempDir = createInstallTempDir(root, "prd-bot");
    expect(tempDir.startsWith(first.tmpDir)).toBe(true);
    expect(existsSync(tempDir)).toBe(true);

    writeFileSync(join(tempDir, "artifact.txt"), "temp");
    cleanupInstallTempDir(tempDir);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("rejects bot ids that try to escape the bot-private workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-runner-workspace-"));
    dirs.push(root);

    expect(() => getBotWorkspacePaths(root, "../escape")).toThrow(
      "bot_id must be a single path segment",
    );
    expect(() => getBotWorkspacePaths(root, "/absolute")).toThrow(
      "bot_id must be a single path segment",
    );
    expect(() => getBotWorkspacePaths(root, "nested/bot")).toThrow(
      "bot_id must be a single path segment",
    );
  });
});
