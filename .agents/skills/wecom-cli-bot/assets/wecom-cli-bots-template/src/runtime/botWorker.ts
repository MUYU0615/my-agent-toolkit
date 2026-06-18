import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BotRuntime, IncomingWeComMessage, WeComClient, StreamHandle } from "../types.js";
import { CliRunner } from "../cli-adapters/cliRunner.js";
import { SessionStore } from "../history/sessionStore.js";
import { buildPrompt } from "./promptBuilder.js";
import { redact } from "../security/redact.js";
import { MemoryClient } from "../memory/memoryClient.js";
import { AdminStore } from "../admin/adminStore.js";
import { assertInside } from "../security/pathFence.js";

type DocumentBuffer = { filename: string; content: string; collecting: boolean };
type DocumentWriteTarget = { writePath: string; isConfig: boolean } | null;

export class BotWorker {
  private sessions: SessionStore;
  private cli: CliRunner;
  private memory: MemoryClient;
  private admin: AdminStore;
  private activeStreams = new Map<string, StreamHandle>();
  private pendingFiles = new Map<string, string[]>(); // userId -> file paths in tmp/
  private docBuffer = new Map<string, DocumentBuffer>();
  private chunkBuffer = new Map<string, string>(); // buffer for incomplete markers

  constructor(private runtime: BotRuntime, private wecom: WeComClient) {
    this.sessions = new SessionStore(runtime);
    this.cli = new CliRunner(runtime);
    this.memory = new MemoryClient(runtime);
    this.admin = new AdminStore(runtime.privateDir);
  }

  async start(): Promise<void> {
    this.wecom.onMessage((message) => this.handleMessage(message));
    await this.wecom.connect();
  }

  private async handleMessage(message: IncomingWeComMessage): Promise<void> {
    const text = message.text.trim();
    const stopKeyword = this.runtime.config.bot.stop_keyword;

    let adminState;
    try {
      adminState = this.admin.read();
    } catch (error) {
      console.error("[admin state] failed to read admin state", error instanceof Error ? error.message : error);
      await this.wecom.sendText(message.conversationId, "机器人管理员状态异常，请联系部署者处理。");
      return;
    }
    if (adminState.status === "unclaimed") {
      const claimMatch = text.match(/^\/claim_admin\s+(\S+)$/);
      if (!claimMatch) {
        await this.wecom.sendText(message.conversationId, "机器人尚未完成管理员认领。请由部署者提供认领码。");
        return;
      }
      const claimed = this.admin.verifyClaim(message.userId, claimMatch[1]);
      if (!claimed) {
        await this.wecom.sendText(message.conversationId, "管理员认领失败。");
        return;
      }
      await this.wecom.sendText(message.conversationId, "管理员认领成功，开始初始化。");
      await this.handleInit(message);
      return;
    }

    if (text === "/accept_admin") { await this.handleAcceptAdmin(message); return; }

    if (adminState.status === "initializing" && !this.admin.isAdmin(message.userId)) {
      await this.wecom.sendText(message.conversationId, "机器人正在初始化，请稍后。");
      return;
    }

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
    if (text === "/init" || text === "/reinit") {
      if (!(await this.requireAdmin(message))) return;
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
    if (skillAddMatch) {
      if (!(await this.requireAdmin(message))) return;
      await this.handleSkillAdd(message, skillAddMatch[1].trim());
      return;
    }

    const skillRemoveMatch = text.match(/^\/skill_remove\s+(.+)$/);
    if (skillRemoveMatch) {
      if (!(await this.requireAdmin(message))) return;
      await this.handleSkillRemove(message, skillRemoveMatch[1].trim());
      return;
    }

    if (text === "/soul") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleGetSoul(message);
      return;
    }
    const setSoulMatch = text.match(/^\/set_soul\s+([\s\S]+)$/);
    if (setSoulMatch) {
      if (!(await this.requireAdmin(message))) return;
      await this.handleSetSoul(message, setSoulMatch[1].trim());
      return;
    }

    const transferMatch = text.match(/^\/transfer_admin\s+(\S+)$/);
    if (transferMatch) {
      if (!(await this.requireAdmin(message))) return;
      await this.handleTransferAdmin(message, transferMatch[1]);
      return;
    }
    if (text === "/cancel_transfer_admin") {
      if (!(await this.requireAdmin(message))) return;
      await this.handleCancelTransferAdmin(message);
      return;
    }

    if (text === "/confirm") { await this.handleConfirm(message); return; }
    if (text === "/reject") { await this.handleReject(message); return; }

    // Normal message flow - check if initialized
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    if (!fs.existsSync(soulPath) || fs.readFileSync(soulPath, "utf8").trim() === "") {
      await this.wecom.sendText(message.conversationId, "机器人尚未初始化，请联系管理员执行 /init。");
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
        await this.processOutputChunk(message.userId, cleaned, stream);
      },
      onDone: async (result) => {
        this.activeStreams.delete(message.userId);
        if (result.kiroSessionId) this.sessions.setKiroSessionId(session, result.kiroSessionId);
        this.sessions.append(session, { role: "assistant", event: "completed", content: result.rawOutput });
        // If doc was being collected but never closed, flush remaining buffer and write
        const buf = this.docBuffer.get(message.userId);
        if (buf?.collecting) {
          const remaining = this.chunkBuffer.get(message.userId) || "";
          buf.content += remaining;
          if (buf.content.trim()) {
            await this.writeDocumentBuffer(message.userId, buf, stream);
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
    }, { resumeSessionId: session.kiroSessionId, userMessage: text, useWorkspaceCwd: isBootstrap });
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

  private async requireAdmin(message: IncomingWeComMessage): Promise<boolean> {
    if (this.admin.isAdmin(message.userId)) return true;
    await this.wecom.sendText(message.conversationId, "该指令仅管理员可用。");
    return false;
  }

  private async processOutputChunk(userId: string, chunk: string, stream: StreamHandle): Promise<void> {
    let remaining = (this.chunkBuffer.get(userId) || "") + chunk;
    this.chunkBuffer.set(userId, "");

    while (remaining) {
      const buf = this.docBuffer.get(userId);
      if (buf?.collecting) {
        const endMatch = remaining.match(/\n~\/document\s*\n?/);
        if (!endMatch) {
          if (remaining.length > 20) {
            buf.content += remaining.slice(0, -20);
            this.chunkBuffer.set(userId, remaining.slice(-20));
          } else {
            this.chunkBuffer.set(userId, remaining);
          }
          return;
        }

        const endIdx = endMatch.index!;
        buf.content += remaining.slice(0, endIdx);
        await this.writeDocumentBuffer(userId, buf, stream);
        this.docBuffer.delete(userId);
        remaining = remaining.slice(endIdx + endMatch[0].length);
        continue;
      }

      const beginMatch = remaining.match(/~document:(.+?\.md)\s*\n?/);
      if (!beginMatch) {
        if (remaining.includes("~document:") || remaining.includes("~/document")) {
          this.chunkBuffer.set(userId, remaining);
          return;
        }
        const partialBeginLength = partialMarkerPrefixLength(remaining, "~document:");
        if (partialBeginLength > 0) {
          const safeOutput = remaining.slice(0, -partialBeginLength);
          if (safeOutput) await stream.write(safeOutput);
          this.chunkBuffer.set(userId, remaining.slice(-partialBeginLength));
          return;
        }
        await stream.write(remaining);
        return;
      }

      const beginIdx = beginMatch.index!;
      const before = remaining.slice(0, beginIdx).trim();
      if (before) await stream.write(before);

      const filename = beginMatch[1];
      this.docBuffer.set(userId, { filename, content: "", collecting: true });
      if (!this.isAllowedConfigDocument(filename)) {
        await stream.write(`正在生成文档 ${filename}...`);
      }
      remaining = remaining.slice(beginIdx + beginMatch[0].length);
    }
  }

  private async writeDocumentBuffer(userId: string, buf: DocumentBuffer, stream: StreamHandle): Promise<void> {
    const content = buf.content.trim();
    const target = this.resolveDocumentWrite(buf.filename);
    if (!target) return;
    if (target.isConfig && !this.canWriteConfigDocument(userId)) {
      console.error("[document] rejected config document write outside initialization", buf.filename);
      return;
    }
    fs.mkdirSync(path.dirname(target.writePath), { recursive: true });
    fs.writeFileSync(target.writePath, content);
    if (target.isConfig) {
      this.maybeMarkInitialized();
    } else {
      this.pendingFiles.set(userId, [...(this.pendingFiles.get(userId) || []), target.writePath]);
      await stream.replace(content);
    }
  }

  private resolveDocumentWrite(filename: string): DocumentWriteTarget {
    if (this.isAllowedConfigDocument(filename)) {
      return { writePath: path.join(this.runtime.workspaceDir, filename), isConfig: true };
    }
    if (filename.startsWith("private/") || filename.startsWith("instructions/")) {
      console.error("[document] rejected unsafe config document path", filename);
      return null;
    }
    const tmpDir = path.join(this.runtime.filesDir, "tmp");
    return { writePath: path.join(tmpDir, path.basename(filename)), isConfig: false };
  }

  private isAllowedConfigDocument(filename: string): boolean {
    return filename === "private/soul.md" || filename === "instructions/AGENTS.md";
  }

  private canWriteConfigDocument(userId: string): boolean {
    try {
      const state = this.admin.read();
      return state.status === "initializing" && state.admin_user_id === userId;
    } catch (error) {
      console.error("[admin state] rejected config document write after admin state read failure", error instanceof Error ? error.message : error);
      return false;
    }
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
    const docsDir = this.resolveConfirmedDocumentsDir();
    if (!docsDir) {
      await this.wecom.sendText(message.conversationId, "文档目录配置不安全，未保存。");
      return;
    }
    fs.mkdirSync(docsDir, { recursive: true });
    const saved: string[] = [];
    for (const filePath of files) {
      const filename = path.basename(filePath);
      const dest = assertInsideDirectory(docsDir, path.join(docsDir, filename));
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

  private resolveConfirmedDocumentsDir(): string | null {
    const configured = this.runtime.config.documents?.shared_dir?.trim();
    if (!configured) {
      return assertInside(this.runtime.workspaceDir, path.join(this.runtime.filesDir, "docs"));
    }
    const docsDir = path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(this.runtime.rootDir, configured);
    if (this.isSensitiveDocumentDir(docsDir) || this.isSensitiveDocumentDir(resolveExistingPath(docsDir))) {
      console.error("[document] rejected unsafe shared document directory", configured);
      return null;
    }
    return docsDir;
  }

  private isSensitiveDocumentDir(dir: string): boolean {
    const normalized = path.resolve(dir).split(path.sep).join("/");
    if (normalized.includes("/run/cli-auth") || normalized.includes("/host/kiro-auth")) return true;
    if (isInsideOrSame(resolveExistingPath(this.runtime.privateDir), dir)) return true;
    if (isInsideOrSame(resolveExistingPath(path.join(this.runtime.workspaceDir, "cli-home")), dir)) return true;
    return false;
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
    this.admin.markInitializing();
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

  private async handleTransferAdmin(message: IncomingWeComMessage, targetUserId: string): Promise<void> {
    const ok = this.admin.startTransfer(message.userId, targetUserId);
    await this.wecom.sendText(message.conversationId, ok ? "管理员转移已发起，请目标用户发送 /accept_admin。" : "管理员转移失败。");
  }

  private async handleAcceptAdmin(message: IncomingWeComMessage): Promise<void> {
    const ok = this.admin.acceptTransfer(message.userId);
    await this.wecom.sendText(message.conversationId, ok ? "管理员转移已完成。" : "没有可接受的管理员转移。");
  }

  private async handleCancelTransferAdmin(message: IncomingWeComMessage): Promise<void> {
    const ok = this.admin.cancelTransfer(message.userId);
    await this.wecom.sendText(message.conversationId, ok ? "管理员转移已取消。" : "没有可取消的管理员转移。");
  }

  private maybeMarkInitialized(): void {
    const soulPath = path.join(this.runtime.privateDir, "soul.md");
    const agentsPath = path.join(this.runtime.instructionsDir, "AGENTS.md");
    if (!fs.existsSync(soulPath) || !fs.existsSync(agentsPath)) return;
    const soul = fs.readFileSync(soulPath, "utf8");
    if (soul.includes("[BOOTSTRAP]")) return;
    const state = this.admin.read();
    if (state.status === "initializing") this.admin.markReady();
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
    const repoName = this.repoNameFromGitUrl(gitUrl);
    if (!repoName) {
      await this.wecom.sendText(message.conversationId, "技能名称无效。");
      return;
    }
    fs.mkdirSync(skillsDir, { recursive: true });
    const targetDir = path.join(skillsDir, repoName);
    try {
      if (fs.existsSync(targetDir)) {
        this.runGit(["pull"], { cwd: targetDir, timeout: 30000 });
        await this.wecom.sendText(message.conversationId, `技能 ${repoName} 已更新。`);
      } else {
        this.runGit(["clone", gitUrl, targetDir], { timeout: 60000 });
        await this.wecom.sendText(message.conversationId, `技能 ${repoName} 安装成功。`);
      }
    } catch (e: any) {
      await this.wecom.sendText(message.conversationId, `安装失败：${e.message?.slice(0, 100)}`);
    }
  }

  private async handleSkillRemove(message: IncomingWeComMessage, name: string): Promise<void> {
    if (!isSafeSkillName(name)) {
      await this.wecom.sendText(message.conversationId, "技能名称无效。");
      return;
    }
    const skillsDir = path.join(this.runtime.filesDir, ".agents", "skills");
    const targetDir = path.resolve(skillsDir, name);
    const relative = path.relative(skillsDir, targetDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      await this.wecom.sendText(message.conversationId, "技能名称无效。");
      return;
    }
    if (!fs.existsSync(targetDir)) {
      await this.wecom.sendText(message.conversationId, `技能 ${name} 不存在。`);
      return;
    }
    fs.rmSync(targetDir, { recursive: true });
    await this.wecom.sendText(message.conversationId, `技能 ${name} 已卸载。`);
  }

  private repoNameFromGitUrl(gitUrl: string): string | null {
    const repoName = gitUrl.split("/").pop()?.replace(/\.git$/, "") ?? "";
    return isSafeSkillName(repoName) ? repoName : null;
  }

  private runGit(args: string[], options: { cwd?: string; timeout: number }): void {
    execFileSync("git", args, options);
  }
}

function extractTags(text: string): string[] {
  const matches = text.match(/#(\S+)/g);
  return matches ? matches.map(t => t.slice(1)) : [];
}

function isSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith(".") && name !== "..";
}

function isInsideOrSame(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInsideDirectory(root: string, target: string): string {
  const resolved = path.resolve(target);
  if (!isInsideOrSame(root, resolved)) throw new Error(`Path escapes directory: ${target}`);
  return resolved;
}

function resolveExistingPath(target: string): string {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    current = parent;
  }
  const realCurrent = fs.realpathSync(current);
  return path.join(realCurrent, path.relative(current, path.resolve(target)));
}

function partialMarkerPrefixLength(text: string, marker: string): number {
  const maxLength = Math.min(text.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return length;
  }
  return 0;
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

~document:private/soul.md
(生成的正式 soul 内容)
~/document

2. 输出工作规范：

~document:instructions/AGENTS.md
(生成的 AGENTS 内容)
~/document

3. 最后回复："✅ 初始化完成，开始工作。"

## 权限

CRITICAL: 绝对不要使用 write 工具或 shell 工具创建/修改文件。所有配置内容必须通过以下格式在回复中输出：
~document:filename.md
(内容)
~/document
框架会自动处理文件写入。如果你使用了文件工具，初始化将失败。
`;
