import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type { TextMessage, WsFrame, WsFrameHeaders } from "@wecom/aibot-node-sdk";
import type { IncomingWeComMessage, StreamHandle, WeComClient } from "../types.js";

export class WeComLongConnectionClient implements WeComClient {
  private handler?: (message: IncomingWeComMessage) => Promise<void>;
  private client!: WSClient;
  private frames = new Map<string, WsFrameHeaders>();

  constructor(private options: { botId: string; secret: string }) {}

  async connect(): Promise<void> {
    if (!this.options.botId || !this.options.secret) {
      throw new Error("Missing WeCom bot credentials");
    }
    this.client = new WSClient({
      botId: this.options.botId,
      secret: this.options.secret,
      maxReconnectAttempts: -1,
      logger: {
        debug: () => {},
        info: console.log,
        warn: console.warn,
        error: console.error
      }
    });

    this.client.on("message.text", (frame: WsFrame<TextMessage>) => {
      void this.handleTextFrame(frame);
    });

    this.client.on("error", (error: Error) => {
      console.error("[wecom] sdk error", error);
    });

    this.client.connect();
  }

  onMessage(handler: (message: IncomingWeComMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendText(_conversationId: string, text: string): Promise<void> {
    await this.client.sendMessage(_conversationId, {
      msgtype: "markdown",
      markdown: { content: text }
    } as any);
  }

  async startStream(replyKey: string): Promise<StreamHandle> {
    const frame = this.frames.get(replyKey);
    if (!frame) {
      throw new Error(`No WeCom frame available for reply key: ${replyKey}`);
    }
    const streamId = generateReqId("stream");
    let content = "";
    let lastFlushAt = 0;
    let pendingFlush: Promise<void> | undefined;
    const minFlushIntervalMs = 900;
    const flush = async () => {
      const now = Date.now();
      if (now - lastFlushAt < minFlushIntervalMs) return;
      lastFlushAt = now;
      await this.client.replyStreamNonBlocking(frame, streamId, content || " ", false);
    };
    return {
      write: async (chunk: string) => {
        if (!chunk) return;
        content += chunk;
        pendingFlush = flush();
        await pendingFlush;
      },
      replace: async (nextContent: string) => {
        content = nextContent;
        lastFlushAt = 0;
        pendingFlush = flush();
        await pendingFlush;
      },
      end: async (finalContent?: string) => {
        if (pendingFlush) await pendingFlush;
        const finalText = finalContent?.trim() || content.trim() || " ";
        await this.client.replyStream(frame, streamId, finalText, true);
      }
    };
  }

  private async handleTextFrame(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body;
    if (!body?.from?.userid || !body.text?.content) return;
    const conversationId = body.chatid ?? body.from.userid;
    const replyKey = `${conversationId}:${body.from.userid}:${body.msgid}`;
    this.frames.set(replyKey, frame);
    await this.handler?.({
      conversationId,
      replyKey,
      userId: body.from.userid,
      text: body.text.content
    });
  }
}
