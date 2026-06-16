import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { BotRuntime, IncomingWeComMessage, WeComClient, StreamHandle } from "../types.js";
import { CliRunner } from "../cli-adapters/cliRunner.js";
import { SessionStore } from "../history/sessionStore.js";
import { buildPrompt } from "./promptBuilder.js";
import { redact } from "../security/redact.js";
import { MemoryClient } from "../memory/memoryClient.js";

export class BotWorker {
  private sessions: SessionStore;
  private cli: CliRunner;
  private memory: MemoryClient;
  private activeStreams = new Map<string, StreamHandle>();
  private pendingFiles = new Map<string, string[]>(); // userId -> file paths in tmp/
  private docBuffer = new Map<string, { filename: string; content: string; collecting: boolean }>();
  private chunkBuffer = new Map<string, string>(); // buffer for incomplete markers

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
      const stream = this.activeStreams.get(message.userId);
      if (stream) {
        await stream.end("已停止。");
        this.activeStreams.delete(message.userId);
      }
      await this.wecom.sendText(message.conversationId, stopped ? "已停止当前任务。" : "当前没有正在运行的任务。");
      return;
    }

    // Slash commands
    if (text === "/help") { await this.handleHelp(message); return; }
    if (text === "/init") {
      const soulPath = path.join(this.runtime.privateDir, "soul.md");
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, "utf8").trim() : "";
      if (soulContent && !soulContent.includes("[BOOTSTRAP]")) {
        await this.wecom.sendText(message.conversationId, "机器人已完成初始化，无法重复执行。");
        return;
      }
      await this.handleInit(message);
      return;
    }
    if (text === "/history") { await this.handleHistory(message); return; }
    if (text === "/new") { await this.handleNew(message); return; }
    if (text === "/memory") { await this.handleMemoryStats(message); return; }
    if (text === "/skill_list") { await this.handleSkillList(message); return; }

    const openMatch = text.match(/^\/open\s+(\d+)$/);
    if (openMatch) { await this.handleOpen(message, parseInt(openMatch[1], 10)); return; }

    const nameMatch = text.match(/^\/name\s+(.+)$/);
    if (nameMatch) { await this.handleName(message, nameMatch[1].trim()); return; }

    const rememberMatch = text.match(/^\/remember(?:\s+(--shared\s+)?([\s\S]*))?$/);
    if (rememberMatch && text.startsWith("/remember")) { await this.handleRemember(message, !!rememberMatch[1], (rememberMatch[2] ?? "").trim()); return; }

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

    if (text === "/confirm") { await this.handleConfirm(message); return; }
    if (text === "/reject") { await this.handleReject(message); return; }

    // Normal message flow - check if initialized
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    if (!fs.existsSync(soulPath) || fs.readFileSync(soulPath, "utf8").trim() === "") {
      await this.wecom.sendText(message.conversationId, "机器人尚未初始化，请发送 /init 开始配置。");
      return;
    }

    if (this.cli.isRunning(message.userId)) {
      await this.wecom.sendText(message.conversationId, this.runtime.config.bot.busy_message);
      return;
    }

    await this.wecom.sendText(message.conversationId, this.runtime.config.bot.thinking_message);
    const session = this.sessions.getOrCreate(message.userId);
    this.sessions.append(session, { role: "user", event: "message", content: text });

    const prompt = await buildPrompt(this.runtime, text, this.memory);
    const soulContent = fs.existsSync(path.join(this.runtime.privateDir, "soul.md"))
      ? fs.readFileSync(path.join(this.runtime.privateDir, "soul.md"), "utf8") : "";
    const isBootstrap = soulContent.includes("[BOOTSTRAP]");
    const stream = await this.wecom.startStream(message.replyKey);
    this.activeStreams.set(message.userId, stream);

    await this.cli.run(message.userId, prompt, {
      onChunk: async (chunk) => {
        this.sessions.append(session, { role: "assistant", event: "chunk", content: chunk });
        const cleaned = redact(chunk, this.runtime.secrets);
        
        // Accumulate into chunk buffer for marker detection
        const prevBuf = this.chunkBuffer.get(message.userId) || "";
        const full = prevBuf + cleaned;
        
        const buf = this.docBuffer.get(message.userId);
        
        if (buf?.collecting) {
          // Currently collecting document content - look for END marker
          const endMatch = full.match(/---END---/);
          if (endMatch) {
            const endIdx = endMatch.index!;
            buf.content += full.slice(0, endIdx);
            buf.collecting = false;
            this.chunkBuffer.set(message.userId, "");
            
            // Write file
            const isConfig = buf.filename.startsWith("private/") || buf.filename.startsWith("instructions/");
            let writePath: string;
            if (isConfig) {
              writePath = path.join(this.runtime.workspaceDir, buf.filename);
            } else {
              const tmpDir = path.join(this.runtime.filesDir, "tmp");
              fs.mkdirSync(tmpDir, { recursive: true });
              writePath = path.join(tmpDir, path.basename(buf.filename));
              this.pendingFiles.set(message.userId, [...(this.pendingFiles.get(message.userId) || []), writePath]);
            }
            fs.mkdirSync(path.dirname(writePath), { recursive: true });
            fs.writeFileSync(writePath, buf.content.trim());
            
            if (!isConfig) {
              await stream.replace(buf.content.trim());
            }
            
            // Process remaining after END marker - put back to buffer for next BEGIN detection
            const remaining = full.slice(endIdx + endMatch[0].length);
            this.chunkBuffer.set(message.userId, remaining);
          } else {
            // Keep buffering - but flush safe content (keep last 20 chars in case marker is split)
            if (full.length > 20) {
              buf.content += full.slice(0, -20);
              this.chunkBuffer.set(message.userId, full.slice(-20));
            } else {
              this.chunkBuffer.set(message.userId, full);
            }
          }
          return;
        }
        
        // Not collecting - look for BEGIN marker
        const beginMatch = full.match(/---BEGIN:(.+?\.md)---\s*\n?/);
        if (beginMatch) {
          const beginIdx = beginMatch.index!;
          // Send everything before the marker
          const before = full.slice(0, beginIdx).trim();
          if (before) await stream.write(before);
          
          // Start collecting
          const filename = beginMatch[1];
          const isConfig = filename.startsWith("private/") || filename.startsWith("instructions/");
          this.docBuffer.set(message.userId, { filename, content: "", collecting: true });
          if (!isConfig) {
            await stream.write(`正在生成文档 ${filename}...`);
          }
          
          // Buffer content after the marker
          const afterMarker = full.slice(beginIdx + beginMatch[0].length);
          this.chunkBuffer.set(message.userId, afterMarker);
          return;
        }
        
        // No markers - check if we might have a partial marker at the end
        if (full.includes("---BEGIN:") || full.includes("---END")) {
          if (!full.match(/---BEGIN:.+?\.md---/) && !full.match(/---END---/)) {
            this.chunkBuffer.set(message.userId, full);
            return;
          }
        }
        
        // Normal output
        this.chunkBuffer.set(message.userId, "");
        await stream.write(cleaned);
      },
      onDone: async (result) => {
        this.activeStreams.delete(message.userId);
        if (result.kimiSessionId) this.sessions.setKimiSessionId(session, result.kimiSessionId);
        if (result.kiroSessionId) this.sessions.setKiroSessionId(session, result.kiroSessionId);
        this.sessions.append(session, { role: "assistant", event: "completed", content: result.rawOutput });
        // If doc was being collected but never closed, flush remaining buffer and write
        const buf = this.docBuffer.get(message.userId);
        if (buf?.collecting) {
          const remaining = this.chunkBuffer.get(message.userId) || "";
          buf.content += remaining;
          if (buf.content.trim()) {
            const isConfig = buf.filename.startsWith("private/") || buf.filename.startsWith("instructions/");
            let writePath: string;
            if (isConfig) {
              writePath = path.join(this.runtime.workspaceDir, buf.filename);
            } else {
              const tmpDir = path.join(this.runtime.filesDir, "tmp");
              fs.mkdirSync(tmpDir, { recursive: true });
              writePath = path.join(tmpDir, path.basename(buf.filename));
              this.pendingFiles.set(message.userId, [...(this.pendingFiles.get(message.userId) || []), writePath]);
            }
            fs.mkdirSync(path.dirname(writePath), { recursive: true });
            fs.writeFileSync(writePath, buf.content.trim());
            if (!isConfig) {
              await stream.replace(buf.content.trim());
            }
          }
        }
        this.docBuffer.delete(message.userId);
        this.chunkBuffer.delete(message.userId);
        await stream.end();
        // Check for pending files
        if (this.pendingFiles.has(message.userId) && (this.pendingFiles.get(message.userId)?.length ?? 0) > 0) {
          await this.wecom.sendText(message.conversationId, "发送 /confirm 保存文档，/reject 丢弃。");
        }
      },
      onError: async (error) => {
        this.activeStreams.delete(message.userId);
        this.sessions.append(session, { role: "assistant", event: "error", content: error.message });
        await stream.write("任务执行失败，请查看私有日志。");
        await stream.end("任务执行失败，请查看私有日志。");
      }
    }, { resumeSessionId: session.kimiSessionId ?? session.kiroSessionId, userMessage: text, useWorkspaceCwd: isBootstrap });
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
      "/confirm | 确认保存文档",
      "/reject | 丢弃文档",
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
      "/init | 重新初始化机器人配置",
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
    // If content is empty but has quoted text, use the quoted text
    let text = content;
    if (!text && message.quotedText) {
      text = message.quotedText;
    } else if (message.quotedText) {
      // If both exist, combine: content as tags/context, quoted as the memory
      text = `${content}\n\n${message.quotedText}`;
    }
    if (!text) { await this.wecom.sendText(message.conversationId, "请提供要记住的内容。"); return; }
    const tags = extractTags(text);
    const cleaned = text.replace(/#\S+\s*/g, "").trim();
    const id = shared ? await this.memory.storeShared(cleaned, tags) : await this.memory.store(cleaned, tags);
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

  // --- Tmp file workflow ---

  private async handleConfirm(message: IncomingWeComMessage): Promise<void> {
    const files = this.pendingFiles.get(message.userId);
    if (!files || files.length === 0) {
      await this.wecom.sendText(message.conversationId, "没有待确认的文档。");
      return;
    }
    const docsDir = path.join(this.runtime.filesDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const saved: string[] = [];
    for (const filePath of files) {
      const filename = path.basename(filePath);
      const dest = path.join(docsDir, filename);
      fs.renameSync(filePath, dest);
      saved.push(filename);
      // Index to memory if enabled
      if (this.memory.enabled) {
        const content = fs.readFileSync(dest, "utf8");
        await this.memory.store(content, [filename.replace(/\.md$/, "")], "core");
      }
    }
    this.pendingFiles.delete(message.userId);
    await this.wecom.sendText(message.conversationId, `已保存：${saved.join(", ")}`);
  }

  private async handleReject(message: IncomingWeComMessage): Promise<void> {
    const files = this.pendingFiles.get(message.userId);
    if (!files || files.length === 0) {
      await this.wecom.sendText(message.conversationId, "没有待确认的文档。");
      return;
    }
    for (const filePath of files) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    this.pendingFiles.delete(message.userId);
    await this.wecom.sendText(message.conversationId, "已丢弃。");
  }

  // --- Init ---
  private async handleInit(message: IncomingWeComMessage): Promise<void> {
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    const bootstrapPath = path.join(this.runtime.rootDir, "bootstrap-soul.md");
    let bootstrap: string;
    if (fs.existsSync(bootstrapPath)) {
      bootstrap = fs.readFileSync(bootstrapPath, "utf8");
    } else {
      bootstrap = BOOTSTRAP_SOUL;
    }
    fs.writeFileSync(soulPath, bootstrap);
    // Clear instructions
    const agentsPath = path.join(this.runtime.instructionsDir, "AGENTS.md");
    if (fs.existsSync(agentsPath)) fs.unlinkSync(agentsPath);
    // Reset session
    this.cli.clearUserSession(message.userId);
    this.sessions.expire(message.userId);

    // Trigger first guided question
    const session = this.sessions.getOrCreate(message.userId);
    const prompt = await buildPrompt(this.runtime, "开始初始化", this.memory);
    const stream = await this.wecom.startStream(message.replyKey);
    this.activeStreams.set(message.userId, stream);

    await this.cli.run(message.userId, prompt, {
      onChunk: async (chunk) => {
        await stream.write(redact(chunk, this.runtime.secrets));
      },
      onDone: async (result) => {
        this.activeStreams.delete(message.userId);
        if (result.kiroSessionId) this.sessions.setKiroSessionId(session, result.kiroSessionId);
        await stream.end(redact(result.intermediateOutput || result.rawOutput, this.runtime.secrets));
      },
      onError: async (error) => {
        this.activeStreams.delete(message.userId);
        await stream.end("初始化启动失败，请重试 /init");
      }
    }, { userMessage: "开始初始化", useWorkspaceCwd: true });
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

const BOOTSTRAP_SOUL = `# [BOOTSTRAP]

你是一个 Bot 初始化引导助手。当前机器人尚未配置，你的任务是通过一问一答的方式帮助用户完成初始化。

## 引导规则

- 每次只问一个问题，等待用户回答后再问下一个。
- 所有选项必须用数字编号（1/2/3...），绝对不要用bullet point或文字列表。用户回复数字即可，支持多选（如"1,3,5"）。
- 标注"可跳过"的步骤，用户回复"跳过"即进入下一步。
- 严格按照引导步骤中定义的问题和选项提问，不要自由发挥或合并问题。

## 引导步骤

1. **业务背景**（可跳过） — "先了解一下业务背景：你所在的公司/团队是什么？主营业务是什么？（可回复'跳过'）"
2. **角色定位** — "你希望这个机器人扮演什么角色？例如：1.产品经理 2.QA测试 3.技术文档 4.项目管理 5.其他（请说明）"
3. **核心职责** — "它主要负责哪些事情？（多选，回复数字如1,2,4）1.撰写/维护PRD 2.竞品分析 3.需求评审与拆解 4.用户故事编写 5.功能优先级排序 6.数据指标定义 7.其他（请补充）"
4. **交互模式** — "当需要澄清需求时，你希望机器人如何与你交互？1.逐句引导（一问一答，适合复杂需求） 2.批量引导（一次列出所有问题，你一次性回答，适合效率优先）"
5. **选项引导** — "澄清需求时，是否需要提供若干选项供你选择？（也可以直接输入自己的答案）1.是 2.否"
6. **文档与记忆**（可跳过） — "是否需要文档管理和长期记忆？（Bot 产出文档经你确认后会保存、版本追踪并可检索）1.是 2.否"
7. **特殊要求**（可跳过） — "还有其他规则或约束吗？比如PRD必须包含某些字段。（可回复'跳过'）"
8. **确认** — 汇总所有配置为简表，让用户确认或修改。

## 确认后操作

用户确认后，用 document block 格式输出配置文件（不要使用文件写入工具）：

1. 输出 soul 配置（不包含 [BOOTSTRAP] 标记）：
   - 如果用户提供了业务背景，写在 soul 开头作为"业务背景"段。
   - 将交互模式写入 soul（逐句引导 or 批量引导）。
   - 如果用户选择了"提供选项"，在交互规则中注明：澄清时提供若干选项供选择，用户也可直接输入自己的答案。

---BEGIN:private/soul.md---
(生成的正式 soul 内容)
---END---

2. 输出工作规范：

---BEGIN:instructions/AGENTS.md---
(生成的 AGENTS 内容)
---END---

3. 最后回复："✅ 初始化完成，开始工作。"

## 权限

CRITICAL: 绝对不要使用 write 工具或 shell 工具创建/修改文件。所有配置内容必须通过以下格式在回复中输出：
---BEGIN:filename.md---
(内容)
---END---
框架会自动处理文件写入。如果你使用了文件工具，初始化将失败。
`;
