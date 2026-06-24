import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface BotWorkspacePaths {
  root: string;
  envDir: string;
  skillsDir: string;
  mcpDir: string;
  cacheDir: string;
  logsDir: string;
  tmpDir: string;
}

export function getBotWorkspacePaths(
  root: string,
  botId: string,
): BotWorkspacePaths {
  const botRoot = join(root, requireSinglePathSegment(botId, "bot_id"));
  return {
    root: botRoot,
    envDir: join(botRoot, "env"),
    skillsDir: join(botRoot, "skills"),
    mcpDir: join(botRoot, "mcp"),
    cacheDir: join(botRoot, "cache"),
    logsDir: join(botRoot, "logs"),
    tmpDir: join(botRoot, "tmp"),
  };
}

export function ensureBotWorkspace(
  root: string,
  botId: string,
): BotWorkspacePaths {
  const paths = getBotWorkspacePaths(root, botId);
  mkdirSync(paths.envDir, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.mcpDir, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.tmpDir, { recursive: true });
  return paths;
}

export function createInstallTempDir(root: string, botId: string): string {
  const paths = ensureBotWorkspace(root, botId);
  return mkdtempSync(join(paths.tmpDir, "install-"));
}

export function cleanupInstallTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

export function requireSinglePathSegment(value: string, fieldName: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${fieldName} must be a single path segment`);
  }
  return value;
}
