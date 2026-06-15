import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { BotRuntime, IncomingWeComMessage, WeComClient } from "../types.js";
import { CliRunner } from "../cli-adapters/cliRunner.js";
import { SessionStore } from "../history/sessionStore.js";
import { buildPrompt } from "./promptBuilder.js";
import { redact } from "../security/redact.js";
import { MemoryClient } from "../memory/memoryClient.js";

export class BotWorker {
  private sessions: SessionStore;
  private cli: CliRunner;
  private memory: MemoryClient;

  constructor(private runtime: BotRuntime, private wecom: WeComClient) {
    this.sessions = new SessionStore(runtime);
    this.cli = new CliRunner(runtime);
    this.memory = new MemoryClient(runtime);
  }

  async start(): Promise<void> {
    this.wecom.onMessage((message) => this.handleMessage(message));
    await this.wecom.connect();
  }

  private async handleMessage(message: IncomingWeComMessage): Promise<void> {
    const text = message.text.trim();
    const stopKeyword = this.runtime.config.bot.stop_keyword;

    if (text === stopKeyword || text === "/stop") {
      const stopped = await this.cli.stop(message.userId);
      await this.wecom.sendText(message.conversationId, stopped ? "已停止当前任务。" : "当前没有正在运行的任务。");
      return;
    }

    // Slash commands
    if (text === "/help") { await this.handleHelp(message); return; }
    if (text === "/history") { await this.handleHistory(message); return; }
    if (text === "/new") { await this.handleNew(message); return; }
    if (text === "/memory") { await this.handleMemoryStats(message); return; }
    if (text === "/skill_list") { await this.handleSkillList(message); return; }

    const openMatch = text.match(/^\/open\s+(\d+)$/);
    if (openMatch) { await this.handleOpen(message, parseInt(openMatch[1], 10)); return; }

    const nameMatch = text.match(/^\/name\s+(.+)$/);
    if (nameMatch) { await this.handleName(message, nameMatch[1].trim()); return; }

    const rememberMatch = text.match(/^\/remember\s+(--shared\s+)?(.+)$/s);
    if (rememberMatch) { await this.handleRemember(message, !!rememberMatch[1], rememberMatch[2].trim()); return; }

    const fetchMatch = text.match(/^\/fetch\s+(https?:\/\/.+)$/);
    if (fetchMatch) { await this.handleFetch(message, fetchMatch[1].trim()); return; }

    const scanMatch = text.match(/^\/scan\s*(.*)$/);
    if (scanMatch && text.startsWith("/scan")) { await this.handleScan(message, scanMatch[1].trim()); return; }

    const forgetMatch = text.match(/^\/forget\s+(.+)$/);
    if (forgetMatch) { await this.handleForget(message, forgetMatch[1].trim()); return; }

    const skillAddMatch = text.match(/^\/skill_add\s+(.+)$/);
    if (skillAddMatch) { await this.handleSkillAdd(message, skillAddMatch[1].trim()); return; }

    const skillRemoveMatch = text.match(/^\/skill_remove\s+(.+)$/);
    if (skillRemoveMatch) { await this.handleSkillRemove(message, skillRemoveMatch[1].trim()); return; }

    if (text === "/soul") { await this.handleGetSoul(message); return; }
    const setSoulMatch = text.match(/^\/set_soul\s+([\s\S]+)$/);
    if (setSoulMatch) { await this.handleSetSoul(message, setSoulMatch[1].trim()); return; }

    // Normal message flow
    if (this.cli.isRunning(message.userId)) {
      await this.wecom.sendText(message.conversationId, this.runtime.config.bot.busy_message);
      return;
    }

    await this.wecom.sendText(message.conversationId, this.runtime.config.bot.thinking_message);
    const session = this.sessions.getOrCreate(message.userId);
    this.sessions.append(session, { role: "user", event: "message", content: text });

    const prompt = await buildPrompt(this.runtime, text, this.memory);
    const stream = await this.wecom.startStream(message.replyKey);

    await this.cli.run(message.userId, prompt, {
      onChunk: async (chunk) => {
        this.sessions.append(session, { role: "assistant", event: "chunk", content: chunk });
        await stream.write(redact(chunk, this.runtime.secrets));
      },
      onDone: async (result) => {
        if (result.kimiSessionId) this.sessions.setKimiSessionId(session, result.kimiSessionId);
        if (result.kiroSessionId) this.sessions.setKiroSessionId(session, result.kiroSessionId);
        this.sessions.append(session, { role: "assistant", event: "completed", content: result.rawOutput });
        await stream.end(redact(result.intermediateOutput || result.rawOutput, this.runtime.secrets));
      },
      onError: async (error) => {
        this.sessions.append(session, { role: "assistant", event: "error", content: error.message });
        await stream.write("任务执行失败，请查看私有日志。");
        await stream.end("任务执行失败，请查看私有日志。");
      }
    }, { resumeSessionId: session.kimiSessionId ?? session.kiroSessionId, userMessage: text });
  }

  // --- Help ---
  private async handleHelp(message: IncomingWeComMessage): Promise<void> {
    const rows = [
      "指令 | 功能",
      "--- | ---",
      "/stop | 终止当前任务",
      "/new | 开始新会话",
      "/history | 历史会话列表",
      "/open N | 恢复第 N 个会话",
      "/name <名称> | 命名当前会话",
      "/soul | 查看当前 Soul",
      "/set_soul <内容> | 设置新 Soul",
    ];
    if (this.memory.enabled) {
      rows.push(
        "/remember <文本> | 存入记忆",
        "/remember --shared <文本> | 存入共享记忆",
        "/fetch <url> | 抓取 URL 存入",
        "/scan [目录] | 扫描文件存入",
        "/memory | 记忆统计",
        "/forget <关键词> | 删除记忆",
      );
    }
    rows.push(
      "/skill_list | 已装技能列表",
      "/skill_add <git_url> | 安装技能",
      "/skill_remove <name> | 卸载技能",
      "/help | 显示本帮助",
    );
    await this.wecom.sendText(message.conversationId, rows.join("\n"));
  }

  // --- Session commands ---
  private async handleHistory(message: IncomingWeComMessage): Promise<void> {
    const sessions = await this.cli.listSessions(message.userId);
    if (sessions.length === 0) {
      await this.wecom.sendText(message.conversationId, "暂无历史会话。");
      return;
    }
    const lines = sessions.map((s, i) => {
      const name = s.name ? ` [${s.name}]` : "";
      const msg = s.firstMessage ? ` "${s.firstMessage}"` : "";
      return `${i + 1}. ${s.time}${name}${msg} (${s.preview})`;
    });
    await this.wecom.sendText(message.conversationId, `历史会话（/open <编号> 恢复）：\n\n${lines.join("\n")}`);
  }

  private async handleNew(message: IncomingWeComMessage): Promise<void> {
    this.cli.clearUserSession(message.userId);
    this.sessions.expire(message.userId);
    await this.wecom.sendText(message.conversationId, "已开始新会话。");
  }

  private async handleOpen(message: IncomingWeComMessage, index: number): Promise<void> {
    const sessions = await this.cli.listSessions(message.userId);
    if (index < 1 || index > sessions.length) {
      await this.wecom.sendText(message.conversationId, `无效编号，当前有 ${sessions.length} 个历史会话。`);
      return;
    }
    const target = sessions[index - 1];
    this.cli.setResumeSessionId(message.userId, target.id);
    this.sessions.restoreWithKiroSession(message.userId, target.id);
    await this.wecom.sendText(message.conversationId, `已切换到会话 ${index}${target.name ? ` [${target.name}]` : ""}，继续对话即可。`);
  }

  private async handleName(message: IncomingWeComMessage, name: string): Promise<void> {
    this.cli.nameCurrentSession(message.userId, name);
    await this.wecom.sendText(message.conversationId, `当前会话已命名为：${name}`);
  }

  // --- Memory commands ---
  private async handleRemember(message: IncomingWeComMessage, shared: boolean, content: string): Promise<void> {
    if (!this.memory.enabled) { await this.wecom.sendText(message.conversationId, "记忆功能未启用。"); return; }
    const tags = extractTags(content);
    const text = content.replace(/#\S+\s*/g, "").trim();
    const id = shared ? await this.memory.storeShared(text, tags) : await this.memory.store(text, tags);
    await this.wecom.sendText(message.conversationId, id ? `已记住${shared ? "（共享）" : ""}。` : "存入失败。");
  }

  private async handleFetch(message: IncomingWeComMessage, url: string): Promise<void> {
    if (!this.memory.enabled) { await this.wecom.sendText(message.conversationId, "记忆功能未启用。"); return; }
    const id = await this.memory.fetchUrl(url);
    await this.wecom.sendText(message.conversationId, id ? `已抓取并存入记忆。` : "抓取失败。");
  }

  private async handleScan(message: IncomingWeComMessage, dir: string): Promise<void> {
    if (!this.memory.enabled) { await this.wecom.sendText(message.conversationId, "记忆功能未启用。"); return; }
    const directory = dir || this.runtime.filesDir;
    const count = await this.memory.scan(directory);
    await this.wecom.sendText(message.conversationId, `扫描完成，已索引 ${count} 个文件。`);
  }

  private async handleMemoryStats(message: IncomingWeComMessage): Promise<void> {
    if (!this.memory.enabled) { await this.wecom.sendText(message.conversationId, "记忆功能未启用。"); return; }
    const stats = await this.memory.stats();
    if (!stats) { await this.wecom.sendText(message.conversationId, "获取统计失败。"); return; }
    await this.wecom.sendText(message.conversationId, `记忆统计：\n记忆条数：${stats.total_memories}\n文本块数：${stats.total_chunks}`);
  }

  private async handleForget(message: IncomingWeComMessage, keyword: string): Promise<void> {
    if (!this.memory.enabled) { await this.wecom.sendText(message.conversationId, "记忆功能未启用。"); return; }
    const count = await this.memory.forget([keyword]);
    await this.wecom.sendText(message.conversationId, `已删除 ${count} 条记忆。`);
  }

  // --- Soul commands ---
  private async handleGetSoul(message: IncomingWeComMessage): Promise<void> {
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    if (!fs.existsSync(soulPath)) {
      await this.wecom.sendText(message.conversationId, "当前未设置 Soul。");
      return;
    }
    const content = fs.readFileSync(soulPath, "utf8");
    await this.wecom.sendText(message.conversationId, content.slice(0, 2000));
  }

  private async handleSetSoul(message: IncomingWeComMessage, content: string): Promise<void> {
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    fs.writeFileSync(soulPath, content);
    await this.wecom.sendText(message.conversationId, "Soul 已更新。");
  }

  // --- Skill commands ---
  private async handleSkillList(message: IncomingWeComMessage): Promise<void> {
    const skillsDir = path.join(this.runtime.filesDir, ".agents", "skills");
    if (!fs.existsSync(skillsDir)) {
      await this.wecom.sendText(message.conversationId, "暂无已安装技能。");
      return;
    }
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length === 0) {
      await this.wecom.sendText(message.conversationId, "暂无已安装技能。");
      return;
    }
    const lines = entries.map(e => {
      const skillFile = path.join(skillsDir, e.name, "SKILL.md");
      let desc = "";
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, "utf8");
        const match = content.match(/description:\s*"?([^"\n]+)"?/);
        if (match) desc = ` - ${match[1].slice(0, 60)}`;
      }
      return `• ${e.name}${desc}`;
    });
    await this.wecom.sendText(message.conversationId, `已安装技能：\n\n${lines.join("\n")}`);
  }

  private async handleSkillAdd(message: IncomingWeComMessage, gitUrl: string): Promise<void> {
    const skillsDir = path.join(this.runtime.filesDir, ".agents", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const repoName = gitUrl.split("/").pop()?.replace(/\.git$/, "") ?? "skill";
    const targetDir = path.join(skillsDir, repoName);
    try {
      if (fs.existsSync(targetDir)) {
        execSync("git pull", { cwd: targetDir, timeout: 30000 });
        await this.wecom.sendText(message.conversationId, `技能 ${repoName} 已更新。`);
      } else {
        execSync(`git clone ${gitUrl} ${targetDir}`, { timeout: 60000 });
        await this.wecom.sendText(message.conversationId, `技能 ${repoName} 安装成功。`);
      }
    } catch (e: any) {
      await this.wecom.sendText(message.conversationId, `安装失败：${e.message?.slice(0, 100)}`);
    }
  }

  private async handleSkillRemove(message: IncomingWeComMessage, name: string): Promise<void> {
    const targetDir = path.join(this.runtime.filesDir, ".agents", "skills", name);
    if (!fs.existsSync(targetDir)) {
      await this.wecom.sendText(message.conversationId, `技能 ${name} 不存在。`);
      return;
    }
    fs.rmSync(targetDir, { recursive: true });
    await this.wecom.sendText(message.conversationId, `技能 ${name} 已卸载。`);
  }
}

function extractTags(text: string): string[] {
  const matches = text.match(/#(\S+)/g);
  return matches ? matches.map(t => t.slice(1)) : [];
}
