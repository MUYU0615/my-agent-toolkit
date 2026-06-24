import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupInstallTempDir,
  createInstallTempDir,
  ensureBotWorkspace,
  requireSinglePathSegment,
} from "./workspace.js";

export interface InstallerOperation {
  botId: string;
  targetName: string;
  stageDir: string;
  finalDir: string;
  status: "staged" | "installed" | "rolled_back";
}

export function beginSkillInstall(
  root: string,
  botId: string,
  skillName: string,
): InstallerOperation {
  const paths = ensureBotWorkspace(root, botId);
  const targetName = requireSinglePathSegment(skillName, "target_name");
  return {
    botId,
    targetName,
    stageDir: createInstallTempDir(root, botId),
    finalDir: join(paths.skillsDir, targetName),
    status: "staged",
  };
}

export function finalizeSkillInstall(
  operation: InstallerOperation,
): InstallerOperation {
  if (operation.status !== "staged") {
    return operation;
  }
  rmSync(operation.finalDir, { recursive: true, force: true });
  mkdirSync(join(operation.finalDir, ".."), { recursive: true });
  renameSync(operation.stageDir, operation.finalDir);
  return {
    ...operation,
    status: "installed",
  };
}

export function rollbackSkillInstall(
  operation: InstallerOperation,
): InstallerOperation {
  if (operation.status === "staged") {
    cleanupInstallTempDir(operation.stageDir);
    rmSync(operation.finalDir, { recursive: true, force: true });
  }
  return {
    ...operation,
    status: "rolled_back",
  };
}
