import { describe, expect, it } from "vitest";
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

  it("accepts bot skill install requests", async () => {
    const server = createCapabilityRunnerServer();

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
  });

  it("returns 400 for malformed bot id encoding on install route", async () => {
    const server = createCapabilityRunnerServer();

    const response = await server.fetch(
      new Request("http://localhost/internal/bots/bot%ZZ/skills/install", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "bot_id path segment is malformed",
    });
  });
});
