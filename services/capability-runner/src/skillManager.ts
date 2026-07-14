import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { CapabilityDispatchContext } from "./server.js";
import { requireSinglePathSegment } from "./workspace.js";

const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([".DS_Store", ".venv", "__pycache__"]);

export interface SkillCatalogItem {
  name: string;
  description: string;
  source_type: "builtin";
  source_ref: string;
}

export interface SkillManagerConfig {
  dataServiceUrl: string;
  kiroWorkspaceRoot: string;
  skillCatalogRoot: string;
  fetch?: typeof fetch;
}

export interface SkillManager {
  listCatalog(): SkillCatalogItem[];
  dispatch(context: CapabilityDispatchContext): Promise<void>;
}

interface SkillMutationPayload {
  name: string;
  source_ref?: string;
  source_type?: string;
  actor_id?: string;
}

export function createSkillManager(config: SkillManagerConfig): SkillManager {
  const fetchImplementation = config.fetch ?? fetch;
  const catalogRoot = ensureRootDirectory(config.skillCatalogRoot);
  const workspaceRoot = ensureRootDirectory(config.kiroWorkspaceRoot);
  const dataServiceUrl = config.dataServiceUrl.replace(/\/+$/, "");

  return {
    listCatalog(): SkillCatalogItem[] {
      return readdirSync(catalogRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .flatMap((entry) => {
          try {
            const metadata = inspectSkillPackage(catalogRoot, entry.name, entry.name);
            return [{
              name: metadata.name,
              description: metadata.description,
              source_type: "builtin" as const,
              source_ref: entry.name,
            }];
          } catch {
            return [];
          }
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async dispatch(context: CapabilityDispatchContext): Promise<void> {
      if (context.action === "skills/install") {
        const payload = readMutationPayload(context.payload);
        const name = requireSinglePathSegment(payload.name, "name");
        const sourceType = payload.source_type ?? "builtin";
        const sourceRef = requireSinglePathSegment(payload.source_ref ?? name, "source_ref");
        const actorId = payload.actor_id?.trim() || "webui";

        if (sourceType !== "builtin") {
          throw new Error("only builtin skill installation is supported");
        }

        await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
          name,
          source_type: "builtin",
          source_ref: sourceRef,
          status: "installing",
          installed_by_wecom_user_id: actorId,
        });

        try {
          const source = inspectSkillPackage(catalogRoot, sourceRef, name).root;
          installSkillPackage(workspaceRoot, context.botId, name, source);
          await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
            name,
            source_type: "builtin",
            source_ref: sourceRef,
            status: "installed",
            installed_by_wecom_user_id: actorId,
          });
        } catch (error) {
          const message = safeErrorMessage(error);
          try {
            await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
              name,
              source_type: "builtin",
              source_ref: sourceRef,
              status: "failed",
              installed_by_wecom_user_id: actorId,
              last_error: message,
            });
          } catch {
            // Preserve the original installation error.
          }
          throw error;
        }
        return;
      }

      if (context.action === "skills/delete") {
        const payload = readMutationPayload(context.payload);
        const name = requireSinglePathSegment(payload.name, "name");
        deleteSkillPackage(workspaceRoot, context.botId, name);
        const response = await fetchImplementation(
          new Request(
            `${dataServiceUrl}/v1/bots/${encodeURIComponent(context.botId)}/skills/${encodeURIComponent(name)}`,
            { method: "DELETE" },
          ),
        );
        if (!response.ok && response.status !== 204) {
          throw new Error(`data-service skill delete failed (${response.status})`);
        }
      }
    },
  };
}

function ensureRootDirectory(root: string): string {
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

function inspectSkillPackage(
  catalogRoot: string,
  sourceRef: string,
  expectedName: string,
): { root: string; name: string; description: string } {
  const safeRef = requireSinglePathSegment(sourceRef, "source_ref");
  const candidate = resolve(catalogRoot, safeRef);
  assertInside(catalogRoot, candidate, "skill source");
  assertRealDirectory(candidate, "skill source");
  const packageRoot = realpathSync(candidate);
  assertInside(catalogRoot, packageRoot, "skill source");

  let fileCount = 0;
  let totalBytes = 0;
  walkPackage(packageRoot, (file) => {
    fileCount += 1;
    totalBytes += lstatSync(file).size;
    if (fileCount > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
      throw new Error("skill package exceeds the allowed size");
    }
  });

  const skillFile = join(packageRoot, "SKILL.md");
  if (!existsSync(skillFile) || !lstatSync(skillFile).isFile()) {
    throw new Error("skill package must contain SKILL.md");
  }
  const metadata = readSkillFrontmatter(readFileSync(skillFile, "utf8"));
  if (metadata.name !== expectedName) {
    throw new Error("skill name does not match SKILL.md frontmatter");
  }
  return { root: packageRoot, ...metadata };
}

function walkPackage(root: string, onFile: (file: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error("skill packages may not contain symbolic links");
    }
    if (stats.isDirectory()) {
      walkPackage(path, onFile);
    } else if (stats.isFile()) {
      onFile(path);
    }
  }
}

function readSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const name = readFrontmatterField(match[1], "name");
  const description = readFrontmatterField(match[1], "description");
  return {
    name: requireSinglePathSegment(name, "skill frontmatter name"),
    description,
  };
}

function readFrontmatterField(frontmatter: string, field: string): string {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) {
    throw new Error(`SKILL.md frontmatter is missing ${field}`);
  }
  return match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}

function installSkillPackage(
  workspaceRoot: string,
  botId: string,
  name: string,
  source: string,
): void {
  const skillsRoot = safeSkillsRoot(workspaceRoot, botId);

  const destination = join(skillsRoot, name);
  const staging = join(skillsRoot, `.install-${name}-${randomUUID()}`);
  const backup = join(skillsRoot, `.backup-${name}-${randomUUID()}`);
  let hasBackup = false;

  try {
    cpSync(source, staging, {
      recursive: true,
      preserveTimestamps: true,
      filter: (sourcePath) => !shouldExclude(basename(sourcePath)),
    });
    if (existsSync(destination)) {
      assertRealDirectory(destination, "installed skill");
      renameSync(destination, backup);
      hasBackup = true;
    }
    renameSync(staging, destination);
    if (hasBackup) {
      rmSync(backup, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (hasBackup && !existsSync(destination)) {
      renameSync(backup, destination);
    }
    throw error;
  }
}

function deleteSkillPackage(workspaceRoot: string, botId: string, name: string): void {
  const destination = join(safeSkillsRoot(workspaceRoot, botId), name);
  if (!existsSync(destination)) {
    return;
  }
  assertRealDirectory(destination, "installed skill");
  rmSync(destination, { recursive: true });
}

function safeSkillsRoot(workspaceRoot: string, botId: string): string {
  const botRoot = safeBotRoot(workspaceRoot, botId);
  const skillsRoot = join(botRoot, ".kiro", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  assertRealDirectory(skillsRoot, "bot skills directory");
  const realSkillsRoot = realpathSync(skillsRoot);
  assertInside(botRoot, realSkillsRoot, "bot skills directory");
  return realSkillsRoot;
}

function safeBotRoot(workspaceRoot: string, botId: string): string {
  const safeBotId = requireSinglePathSegment(botId, "bot_id");
  const botRoot = join(workspaceRoot, safeBotId);
  mkdirSync(botRoot, { recursive: true });
  assertRealDirectory(botRoot, "bot workspace");
  const realBotRoot = realpathSync(botRoot);
  assertInside(workspaceRoot, realBotRoot, "bot workspace");
  return realBotRoot;
}

function assertRealDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")) {
    return;
  }
  throw new Error(`${label} escapes its configured root`);
}

function shouldExclude(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.endsWith(".pyc");
}

function readMutationPayload(payload: unknown): SkillMutationPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("skill mutation payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.name !== "string") {
    throw new Error("name is required");
  }
  return {
    name: record.name,
    source_ref: typeof record.source_ref === "string" ? record.source_ref : undefined,
    source_type: typeof record.source_type === "string" ? record.source_type : undefined,
    actor_id: typeof record.actor_id === "string" ? record.actor_id : undefined,
  };
}

async function upsertSkillStatus(
  fetchImplementation: typeof fetch,
  dataServiceUrl: string,
  botId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const response = await fetchImplementation(
    new Request(`${dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    }),
  );
  if (!response.ok) {
    throw new Error(`data-service skill update failed (${response.status})`);
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "skill installation failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
