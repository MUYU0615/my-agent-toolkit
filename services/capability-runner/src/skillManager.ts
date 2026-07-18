import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  files?: unknown;
  actor_id?: string;
}

interface UploadedSkillFile {
  path: string;
  content_base64: string;
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
        const sourceRef = sourceType === "local_upload"
          ? "webui-local-upload"
          : requireSinglePathSegment(payload.source_ref ?? name, "source_ref");
        const storedSourceType = sourceType === "local_upload" ? "local" : "builtin";
        const actorId = payload.actor_id?.trim() || "webui";

        if (sourceType !== "builtin" && sourceType !== "local_upload") {
          throw new Error("unsupported skill source type");
        }

        await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
          name,
          source_type: storedSourceType,
          source_ref: sourceRef,
          status: "installing",
          installed_by_wecom_user_id: actorId,
        });

        try {
          if (sourceType === "local_upload") {
            installUploadedSkillPackage(workspaceRoot, context.botId, name, payload.files);
          } else {
            const source = inspectSkillPackage(catalogRoot, sourceRef, name).root;
            installSkillPackage(workspaceRoot, context.botId, name, source);
          }
          await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
            name,
            source_type: storedSourceType,
            source_ref: sourceRef,
            status: "installed",
            installed_by_wecom_user_id: actorId,
          });
        } catch (error) {
          const message = safeErrorMessage(error);
          try {
            await upsertSkillStatus(fetchImplementation, dataServiceUrl, context.botId, {
              name,
              source_type: storedSourceType,
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

  return { root: packageRoot, ...inspectSkillDirectory(packageRoot, expectedName) };
}

function inspectSkillDirectory(packageRoot: string, expectedName: string): { name: string; description: string } {
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
  return metadata;
}

function installUploadedSkillPackage(
  workspaceRoot: string,
  botId: string,
  name: string,
  rawFiles: unknown,
): void {
  const files = normalizeUploadedFiles(rawFiles);
  const botRoot = safeBotRoot(workspaceRoot, botId);
  const sourceRoot = mkdtempSync(join(botRoot, ".skill-upload-"));
  try {
    for (const file of files) {
      const destination = join(sourceRoot, file.path);
      assertInside(sourceRoot, destination, "uploaded skill file");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content, { mode: 0o644 });
    }
    inspectSkillDirectory(sourceRoot, name);
    installSkillPackage(workspaceRoot, botId, name, sourceRoot);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function normalizeUploadedFiles(rawFiles: unknown): Array<{ path: string; content: Buffer }> {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_SKILL_FILES) {
    throw new Error("invalid uploaded skill files");
  }
  const candidates = rawFiles.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid uploaded skill file");
    const file = value as UploadedSkillFile;
    if (typeof file.path !== "string" || typeof file.content_base64 !== "string") {
      throw new Error("invalid uploaded skill file");
    }
    return { path: normalizeUploadedPath(file.path), content: decodeUploadedFile(file.content_base64) };
  });
  const firstSegments = new Set(candidates.map(({ path }) => path.split("/")[0]));
  const hasRootSkillFile = candidates.some(({ path }) => path === "SKILL.md");
  const shouldStripRoot = !hasRootSkillFile && firstSegments.size === 1 && candidates.every(({ path }) => path.includes("/"));
  const files = candidates.map(({ path, content }) => ({
    path: shouldStripRoot ? path.slice(path.indexOf("/") + 1) : path,
    content,
  }));
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("uploaded skill contains duplicate paths");
  }
  const totalBytes = files.reduce((total, file) => total + file.content.length, 0);
  if (totalBytes > MAX_SKILL_BYTES || !files.some(({ path }) => path === "SKILL.md")) {
    throw new Error("uploaded skill package is invalid");
  }
  return files;
}

function normalizeUploadedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("uploaded skill file path is invalid");
  }
  return normalized;
}

function decodeUploadedFile(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("uploaded skill file content is invalid");
  }
  return Buffer.from(value, "base64");
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
  for (const providerDirectory of [".kiro", ".claude"]) {
    installSkillIntoRoot(safeSkillsRoot(workspaceRoot, botId, providerDirectory), name, source);
  }
}

function installSkillIntoRoot(skillsRoot: string, name: string, source: string): void {
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
  for (const providerDirectory of [".kiro", ".claude"]) {
    const destination = join(safeSkillsRoot(workspaceRoot, botId, providerDirectory), name);
    if (!existsSync(destination)) continue;
    assertRealDirectory(destination, "installed skill");
    rmSync(destination, { recursive: true });
  }
}

function safeSkillsRoot(workspaceRoot: string, botId: string, providerDirectory: string): string {
  const botRoot = safeBotRoot(workspaceRoot, botId);
  const skillsRoot = join(botRoot, providerDirectory, "skills");
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
    files: record.files,
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
