import fs from "node:fs";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { assertInside } from "../security/pathFence.js";

export function buildPrompt(runtime: BotRuntime, userText: string): string {
  const soul = readSafe(runtime, path.join(runtime.privateDir, "soul.md"));
  const agents = readSafe(runtime, path.join(runtime.instructionsDir, "AGENTS.md"));
  return [
    "# Soul",
    soul,
    "# Operating Instructions",
    agents,
    "# Workspace",
    "You may operate only in the current working directory. Do not access parent directories.",
    "# Runtime Constraint",
    "Answer directly from your model knowledge unless the user explicitly asks you to search, browse, fetch URLs, or inspect current live information. Do not start web search or fetch tools for ordinary chat or analysis requests.",
    "# User Message",
    userText
  ].join("\n\n");
}

function readSafe(runtime: BotRuntime, filePath: string): string {
  const safePath = assertInside(runtime.workspaceDir, filePath);
  return fs.existsSync(safePath) ? fs.readFileSync(safePath, "utf8") : "";
}
