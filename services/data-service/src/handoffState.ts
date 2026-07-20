import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HandoffDraft = { draft_id: string; source_bot_id: string; source_user_id: string; recipient_name: string; summary: string; jira_links: string[]; artifact_refs: string[]; target_user_id?: string; target_bot_id?: string; status: "selecting_bot" | "ready_to_confirm" | "sent"; created_at: string };
export type HandoffNotification = { notification_id: string; task_id: string; bot_id: string; user_id: string; text: string; status: "pending" | "delivered"; created_at: string };

type State = { profiles: Record<string, string>; claims: Record<string, string>; drafts: Record<string, HandoffDraft>; notifications: Record<string, HandoffNotification>; sequence: number };

/** Durable, append-safe MVP state owned by Data Service. It is intentionally
 * isolated from Bot Host so MCP calls and WeCom delivery share one source of truth. */
export function createHandoffState(path = process.env.HANDOFF_STATE_FILE ?? "/data/handoff-state.json") {
  let state: State = { profiles: {}, claims: {}, drafts: {}, notifications: {}, sequence: 0 };
  let loaded = false;
  const load = async () => { if (loaded) return; loaded = true; try { state = { ...state, ...JSON.parse(await readFile(path, "utf8")) }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
  const save = async () => { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, path); };
  const next = (prefix: string) => `${prefix}-${String(++state.sequence).padStart(6, "0")}`;
  return {
    async claim(botId: string, userId: string, displayName?: string) { await load(); const owner = state.claims[botId]; if (owner && owner !== userId) throw new Error("bot is already claimed"); state.claims[botId] = userId; if (displayName) state.profiles[userId] = displayName; await save(); return { bot_id: botId, user_id: userId, display_name: state.profiles[userId] }; },
    async setName(userId: string, displayName: string) { await load(); state.profiles[userId] = displayName; await save(); return { user_id: userId, display_name: displayName }; },
    async createDraft(input: Omit<HandoffDraft, "draft_id" | "status" | "created_at" | "target_user_id" | "target_bot_id">) { await load(); const matches = Object.entries(state.profiles).filter(([, name]) => name === input.recipient_name); if (matches.length !== 1) throw new Error(matches.length ? "recipient name is ambiguous" : "recipient not found"); const [targetUser] = matches[0]; const targetBots = Object.entries(state.claims).filter(([, user]) => user === targetUser).map(([bot_id]) => ({ bot_id })); if (!targetBots.length) throw new Error("recipient has no claimed Bot"); const draft: HandoffDraft = { ...input, draft_id: next("DRAFT"), target_user_id: targetUser, status: "selecting_bot", created_at: new Date().toISOString() }; state.drafts[draft.draft_id] = draft; await save(); return { draft, target_bots: targetBots }; },
    async selectBot(draftId: string, botId: string) { await load(); const draft = state.drafts[draftId]; if (!draft || draft.status !== "selecting_bot") throw new Error("draft is not selectable"); if (state.claims[botId] !== draft.target_user_id) throw new Error("target Bot is not claimed by recipient"); draft.target_bot_id = botId; draft.status = "ready_to_confirm"; await save(); return draft; },
    async confirm(draftId: string) { await load(); const draft = state.drafts[draftId]; if (!draft || draft.status !== "ready_to_confirm" || !draft.target_bot_id || !draft.target_user_id) throw new Error("draft is not ready to send"); const taskId = next("TASK"); const notification: HandoffNotification = { notification_id: next("NOTIFY"), task_id: taskId, bot_id: draft.target_bot_id, user_id: draft.target_user_id, text: `你收到 ${taskId}\n事项：${draft.summary}\n回复“处理 ${taskId}”开始。`, status: "pending", created_at: new Date().toISOString() }; draft.status = "sent"; state.notifications[notification.notification_id] = notification; await save(); return { draft, task_id: taskId, notification }; },
    async listPendingNotifications() { await load(); return Object.values(state.notifications).filter((item) => item.status === "pending"); },
    async markDelivered(notificationId: string) { await load(); const n = state.notifications[notificationId]; if (!n) throw new Error("notification not found"); n.status = "delivered"; await save(); },
  };
}
