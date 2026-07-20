import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SimpleTaskRouter {
  handle(input: { botId: string; userId: string; text: string }): Promise<{ reply?: string; continueText?: string }>;
  registerBots(bots: Array<{ botId: string; name: string }>): void;
}

/** Deliberately small chat-first task handoff MVP. Persistence/workflow rules come later. */
export function createSimpleTaskRouter(notify: (input: { botId: string; userId: string; text: string }) => Promise<void>, dataServiceUrl?: string): SimpleTaskRouter {
  const owners = new Map<string, string>();
  const profiles = new Map<string, string>();
  const botNames = new Map<string, string>();
  let sequence = 0;
  const stateFile = process.env.SIMPLE_TASK_STATE_FILE ?? "/data/simple-task-router.json";
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { owners?: Array<[string, string]>; profiles?: Array<[string, string]>; sequence?: number };
      for (const [key, value] of state.owners ?? []) owners.set(key, value);
      for (const [key, value] of state.profiles ?? []) profiles.set(key, value);
      sequence = state.sequence ?? 0;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[simple-task-router] state load failed", error); }
  };
  const save = async () => {
    await mkdir(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ owners: [...owners], profiles: [...profiles], sequence }), { mode: 0o600 });
    await rename(temporary, stateFile);
  };
  const backend = async (pathname: string, body: unknown) => {
    if (!dataServiceUrl) return;
    const response = await fetch(`${dataServiceUrl.replace(/\/+$/, "")}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("handoff backend request failed");
  };
  return {
    async handle(input) {
      await load();
      const text = input.text.trim();
      if (text === "我的ID") {
        return { reply: `你的企业微信用户 ID：${input.userId}` };
      }
      const setName = text.match(/^设置名字\s+(.+)$/s);
      if (setName) {
        const name = setName[1].trim();
        if (name.length < 1 || name.length > 40) return { reply: "名字长度应为 1–40 个字符。" };
        profiles.set(input.userId, name);
        await backend("/internal/handoff/profiles", { user_id: input.userId, display_name: name });
        await save();
        return { reply: `已设置显示名：${name}` };
      }
      if (text === "认领") {
        const owner = owners.get(input.botId);
        if (owner && owner !== input.userId) return { reply: "这个 Bot 已被其他用户认领。" };
        owners.set(input.botId, input.userId);
        await backend("/internal/handoff/claim", { bot_id: input.botId, user_id: input.userId, display_name: profiles.get(input.userId) });
        await save();
        return { reply: `认领成功。你现在可以使用 Bot ${input.botId}；同一个账号可继续认领其他 Bot。` };
      }
      return {};
    },
    registerBots(bots) { for (const bot of bots) botNames.set(bot.botId, bot.name); },
  };
}
