import { afterEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
const fetchHandler = vi.fn();
const createBotHostServer = vi.fn(() => ({
  fetch: fetchHandler,
}));

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
  });

  it("starts automatically when executed as the module entrypoint", async () => {
    await import("./botApiMain.js");

    expect(createBotHostServer).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
