import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHandoffState } from "./handoffState.js";

describe("handoff state", () => {
  it("persists a selected and confirmed draft with a notification", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "handoff-")), "state.json");
    const state = createHandoffState(file);
    await state.claim("qa-bot", "u-wang", "王安琦");
    const created = await state.createDraft({ source_bot_id: "bot-a", source_user_id: "u-a", recipient_name: "王安琦", summary: "测试 HIM-22187", jira_links: ["https://j1.private.easemob.com/browse/HIM-22187"], artifact_refs: [] });
    expect(created.target_bots).toEqual([{ bot_id: "qa-bot" }]);
    await state.selectBot(created.draft.draft_id, "qa-bot");
    const sent = await state.confirm(created.draft.draft_id);
    expect(sent.notification.bot_id).toBe("qa-bot");
    expect((await createHandoffState(file).listPendingNotifications())).toHaveLength(1);
  });
});
