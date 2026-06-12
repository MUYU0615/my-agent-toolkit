import type { BotRuntime, IncomingWeComMessage, WeComClient } from "../types.js";
import { CliRunner } from "../cli-adapters/cliRunner.js";
import { SessionStore } from "../history/sessionStore.js";
import { buildPrompt } from "./promptBuilder.js";
import { redact } from "../security/redact.js";

export class BotWorker {
  private sessions: SessionStore;
  private cli: CliRunner;

  constructor(private runtime: BotRuntime, private wecom: WeComClient) {
    this.sessions = new SessionStore(runtime);
    this.cli = new CliRunner(runtime);
  }

  async start(): Promise<void> {
    this.wecom.onMessage((message) => this.handleMessage(message));
    await this.wecom.connect();
  }

  private async handleMessage(message: IncomingWeComMessage): Promise<void> {
    const text = message.text.trim();
    const stopKeyword = this.runtime.config.bot.stop_keyword;

    if (text === stopKeyword) {
      const stopped = await this.cli.stop(message.userId);
      await this.wecom.sendText(message.conversationId, stopped ? "已停止当前任务。" : "当前没有正在运行的任务。");
      return;
    }

    // Slash commands
    if (text === "/history") {
      await this.handleHistory(message);
      return;
    }
    if (text === "/new") {
      await this.handleNew(message);
      return;
    }
    const openMatch = text.match(/^\/open\s+(\d+)$/);
    if (openMatch) {
      await this.handleOpen(message, parseInt(openMatch[1], 10));
      return;
    }
    const nameMatch = text.match(/^\/name\s+(.+)$/);
    if (nameMatch) {
      await this.handleName(message, nameMatch[1].trim());
      return;
    }

    if (this.cli.isRunning(message.userId)) {
      await this.wecom.sendText(message.conversationId, this.runtime.config.bot.busy_message);
      return;
    }

    await this.wecom.sendText(message.conversationId, this.runtime.config.bot.thinking_message);
    const session = this.sessions.getOrCreate(message.userId);
    this.sessions.append(session, { role: "user", event: "message", content: text });

    const prompt = buildPrompt(this.runtime, text);
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
    const reply = `历史会话（发送 /open <编号> 恢复）：\n\n${lines.join("\n")}`;
    await this.wecom.sendText(message.conversationId, reply);
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
}
