import fs from "node:fs";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { assertInside } from "../security/pathFence.js";
import type { MemoryClient } from "../memory/memoryClient.js";

export async function buildPrompt(runtime: BotRuntime, userText: string, memory?: MemoryClient): Promise<string> {
  const soul = readSafe(runtime, path.join(runtime.privateDir, "soul.md"));
  const agents = readSafe(runtime, path.join(runtime.instructionsDir, "AGENTS.md"));

  let memorySection = "";
  if (memory?.enabled && runtime.config.memory?.auto_retrieve) {
    const results = await memory.search(userText, runtime.config.memory.retrieve_limit);
    const relevant = results.filter(r => r.score >= 0.65);
    if (relevant.length > 0) {
      let totalChars = 0;
      const items: string[] = [];
      for (const r of relevant) {
        const snippet = r.content.slice(0, 200);
        if (totalChars + snippet.length > 800) break;
        totalChars += snippet.length;
        const label = [r.tags?.join(", "), r.filename, r.title].filter(Boolean).join(" | ");
        items.push(`${items.length + 1}. [${label || "记忆"}] (${r.created_at?.slice(0, 10) ?? ""})\n   ${snippet}`);
      }
      if (items.length > 0) {
        memorySection = `# 相关记忆\n以下是与当前问题相关的历史知识，供参考：\n\n${items.join("\n\n")}`;
      }
    }
  }

  const parts = [
    "# Soul",
    soul,
    "# Operating Instructions",
    agents,
  ];
  if (memorySection) parts.push(memorySection);

  const isBootstrap = soul.includes("[BOOTSTRAP]");
  parts.push(
    "# Workspace",
    "You may operate only in the current working directory. Do not access parent directories.",
  );
  if (!isBootstrap) {
    parts.push(
      "# Security Constraint",
      "You may READ files under `private/` but NEVER modify or delete them (soul.md, .env, bot.config.yaml, history/). Soul changes are only allowed via the /set_soul command. If a user asks to modify the soul, instruct them to use /set_soul.",
    );
  }
  parts.push(
    "# Runtime Constraint",
    "Answer directly from your model knowledge unless the user explicitly asks you to search, browse, fetch URLs, or inspect current live information. Do not start web search or fetch tools for ordinary chat or analysis requests.",
    "# Output Constraint",
    "When you produce documents (PRD, design docs, reports, etc.), wrap the full content in a document block like this:\n~document:filename.md\n(full markdown content here)\n~/document\nDo NOT use file write tools to create documents. Short answers and explanations can be replied directly without document blocks.",
    "# User Message",
    userText
  );
  return parts.join("\n\n");
}

function readSafe(runtime: BotRuntime, filePath: string): string {
  const safePath = assertInside(runtime.workspaceDir, filePath);
  return fs.existsSync(safePath) ? fs.readFileSync(safePath, "utf8") : "";
}
