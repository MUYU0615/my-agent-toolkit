import path from "node:path";
import { loadRuntime } from "./config.js";
import { BotWorker } from "./runtime/botWorker.js";
import { WeComLongConnectionClient } from "./wecom/wecomClient.js";

const botName = parseBotName(process.argv);
const rootDir = path.resolve(process.cwd());
const runtime = loadRuntime(rootDir, botName);
const botId = runtime.env[runtime.config.wecom.bot_id_env] ?? "";
const secret = runtime.env[runtime.config.wecom.secret_env] ?? "";

const wecom = new WeComLongConnectionClient({ botId, secret });
const worker = new BotWorker(runtime, wecom);

worker.start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function parseBotName(argv: string[]): string {
  const index = argv.indexOf("--bot");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("Usage: node dist/main.js --bot <bot-name>");
  }
  return value;
}
