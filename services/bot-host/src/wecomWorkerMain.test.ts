import { afterEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn(async () => undefined);
const start = vi.fn(() => Promise.resolve());
const restartInitialization = vi.fn();
const listen = vi.fn();

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({
    listen,
  })),
}));

vi.mock("./server.js", () => ({
  createBotHostSupervisor: vi.fn(() => ({
    start,
    sync,
    restartInitialization,
  })),
}));

vi.mock("./wecomClient.js", () => ({
  WeComLongConnectionClient: vi.fn(),
}));

describe("wecom worker entrypoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("serves only worker health and runtime sync endpoints", async () => {
    const { createWeComWorkerApp } = await import("./wecomWorkerMain.js");

    const { app } = createWeComWorkerApp();

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "wecom-worker",
      status: "ok",
      git_sha: "unknown",
      build_time: "unknown",
    });

    const syncResponse = await app.fetch(new Request("http://localhost/internal/wecom-runtime/sync", {
      method: "POST",
    }));
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({ synced: true });
    expect(sync).toHaveBeenCalledTimes(1);

    restartInitialization.mockResolvedValueOnce({
      bot_id: "prd-bot",
      admin_wecom_user_id: "admin-a",
      output: "Soul 引导 1/2：我是谁？",
    });
    const restartResponse = await app.fetch(new Request("http://localhost/internal/bots/prd-bot/initialization/restart", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        admin_wecom_user_id: "admin-a",
      }),
    }));
    expect(restartResponse.status).toBe(200);
    expect(await restartResponse.json()).toEqual({
      bot_id: "prd-bot",
      admin_wecom_user_id: "admin-a",
      output: "Soul 引导 1/2：我是谁？",
    });
    expect(restartInitialization).toHaveBeenCalledWith({
      botId: "prd-bot",
      adminWeComUserId: "admin-a",
    });

    const apiRoute = await app.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "hello",
        runtime: "mock",
      }),
      headers: {
        "content-type": "application/json",
      },
    }));
    expect(apiRoute.status).toBe(404);
    expect(await apiRoute.json()).toEqual({ error: "not found" });
  });
});
