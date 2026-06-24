import { afterEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
const fetchHandler = vi.fn();
const createBotHostServer = vi.fn(() => ({
  fetch: fetchHandler,
}));
const fetchMock = vi.fn();

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({
    listen,
  })),
}));

vi.mock("./server.js", () => ({
  createBotHostServer,
}));

describe("bot api entrypoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts automatically when executed as the module entrypoint", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await import("./botApiMain.js");

    expect(createBotHostServer).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("configures restart initialization to proxy to wecom-worker", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        bot_id: "bot-1",
        admin_wecom_user_id: "admin-1",
        output: "Soul 引导 1/2：我是谁？",
      }),
    }));

    await import("./botApiMain.js");

    expect(createBotHostServer.mock.calls.length).toBeGreaterThan(0);
    const calls = createBotHostServer.mock.calls as unknown as Array<[unknown]>;
    const firstCall = calls.at(0);
    expect(firstCall).toBeDefined();
    const config = firstCall?.[0] as {
      initializationController: {
        restartInitialization(input: {
          botId: string;
          adminWeComUserId: string;
        }): Promise<{
          bot_id: string;
          admin_wecom_user_id: string;
          output: string;
        }>;
      };
    };
    expect(config?.initializationController).toBeTruthy();

    await expect(
      config.initializationController.restartInitialization({
        botId: "bot-1",
        adminWeComUserId: "admin-1",
      }),
    ).resolves.toEqual({
      bot_id: "bot-1",
      admin_wecom_user_id: "admin-1",
      output: "Soul 引导 1/2：我是谁？",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://wecom-worker:8401/internal/bots/bot-1/initialization/restart",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
