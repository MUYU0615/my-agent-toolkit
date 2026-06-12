export type CliConfig = {
  provider: string;
  command: string;
  args: string[];
  input_mode: "stdin" | "arg";
  prompt_placeholder?: string;
  stream_output: "stdout";
  stop_signal: NodeJS.Signals;
  kill_after_ms: number;
  timeout_seconds: number;
  env?: Record<string, string>;
};

export type BotConfig = {
  bot: {
    name: string;
    session_idle_ttl_seconds: number;
    stop_keyword: string;
    thinking_message: string;
    busy_message: string;
  };
  wecom: {
    bot_id_env: string;
    secret_env: string;
  };
  cli: CliConfig;
};

export type BotRuntime = {
  botName: string;
  rootDir: string;
  workspaceDir: string;
  privateDir: string;
  filesDir: string;
  instructionsDir: string;
  config: BotConfig;
  env: Record<string, string>;
  secrets: string[];
};

export type IncomingWeComMessage = {
  conversationId: string;
  replyKey: string;
  userId: string;
  text: string;
};

export type StreamHandle = {
  write(chunk: string): Promise<void>;
  replace(content: string): Promise<void>;
  end(finalContent?: string): Promise<void>;
};

export type WeComClient = {
  connect(): Promise<void>;
  onMessage(handler: (message: IncomingWeComMessage) => Promise<void>): void;
  sendText(conversationId: string, text: string): Promise<void>;
  startStream(replyKey: string): Promise<StreamHandle>;
};
