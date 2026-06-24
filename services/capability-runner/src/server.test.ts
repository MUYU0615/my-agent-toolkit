import { describe, expect, it, vi } from "vitest";
import { createCapabilityRunnerServer } from "./server.js";

describe("capability-runner server", () => {
  it("responds to health checks", async () => {
    const server = createCapabilityRunnerServer();

    const response = await server.fetch(
      new Request("http://localhost/health"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("dispatches bot skill install requests with structured payload", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/prd-bot/skills/install", {
        method: "POST",
        body: JSON.stringify({
          name: "repo-analyzer",
          source_type: "github",
          source_ref: "https://github.com/acme/repo-analyzer",
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      action: "skills/install",
      botId: "prd-bot",
      payload: {
        name: "repo-analyzer",
        source_type: "github",
        source_ref: "https://github.com/acme/repo-analyzer",
      },
    });
  });

  it("dispatches bot skill delete requests with structured payload", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/prd-bot/skills/delete", {
        method: "POST",
        body: JSON.stringify({ name: "repo-analyzer" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      action: "skills/delete",
      botId: "prd-bot",
      payload: { name: "repo-analyzer" },
    });
  });

  it("dispatches bot mcp install requests with structured payload", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/prd-bot/mcps/install", {
        method: "POST",
        body: JSON.stringify({ name: "filesystem-mcp" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      action: "mcps/install",
      botId: "prd-bot",
      payload: { name: "filesystem-mcp" },
    });
  });

  it("dispatches bot mcp delete requests with structured payload", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/prd-bot/mcps/delete", {
        method: "POST",
        body: JSON.stringify({ name: "filesystem-mcp" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      action: "mcps/delete",
      botId: "prd-bot",
      payload: { name: "filesystem-mcp" },
    });
  });

  it("returns 400 for malformed bot id encoding on install route", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/bot%ZZ/skills/install", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "bot_id path segment is malformed",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed bot id encoding on other capability routes", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const server = createCapabilityRunnerServer({ dispatch });

    const responses = await Promise.all([
      server.fetch(
        new Request("http://localhost/internal/bots/bot%ZZ/skills/delete", {
          method: "POST",
        }),
      ),
      server.fetch(
        new Request("http://localhost/internal/bots/bot%ZZ/mcps/install", {
          method: "POST",
        }),
      ),
      server.fetch(
        new Request("http://localhost/internal/bots/bot%ZZ/mcps/delete", {
          method: "POST",
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "bot_id path segment is malformed",
      });
    }

    expect(dispatch).not.toHaveBeenCalled();
  });
});
