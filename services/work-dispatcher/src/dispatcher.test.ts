import { describe, expect, it } from "vitest";
import { createWorkDispatcher } from "./dispatcher.js";

describe("work dispatcher", () => {
  it("leases up to its concurrency limit and writes runtime results back", async () => {
    const leases = [
      lease("execution-1", "stage-1", "conv-1"),
      lease("execution-2", "stage-2", "conv-2"),
    ];
    const completions: Array<Record<string, unknown>> = [];
    const runtimeConversations: string[] = [];
    const dispatcher = createWorkDispatcher({
      dataServiceUrl: "http://data-service",
      llmRunnerUrl: "http://llm-runner",
      internalToken: "internal-token",
      workerId: "worker-test",
      pollIntervalMs: 10,
      maxConcurrency: 2,
      leaseSeconds: 1_200,
      executionTimeoutMs: 5_000,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/internal/execution-queue/lease") {
          expect(request.headers.get("authorization")).toBe("Bearer internal-token");
          const next = leases.shift();
          return next ? Response.json(next) : new Response(null, { status: 204 });
        }
        if (url.pathname === "/v1/chat") {
          const body = await request.json() as Record<string, unknown>;
          runtimeConversations.push(String(body.conversation_id));
          if (body.conversation_id === "conv-2") {
            return Response.json({ error: "runtime exited", code: "runtime_exit" }, { status: 502 });
          }
          return Response.json({
            run_id: "runner-run-1",
            runner_session_id: "claude:bot-a:user-a:conv-1",
            output: "执行完成",
          });
        }
        if (/^\/internal\/execution-runs\/[^/]+\/complete$/.test(url.pathname)) {
          completions.push(await request.json() as Record<string, unknown>);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    await dispatcher.poll();
    await dispatcher.waitForIdle();

    expect(runtimeConversations.sort()).toEqual(["conv-1", "conv-2"]);
    expect(completions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "succeeded",
        runner_session_id: "claude:bot-a:user-a:conv-1",
        output: "执行完成",
      }),
      expect.objectContaining({
        status: "failed",
        error_code: "runtime_exit",
        error_message: "runtime exited",
      }),
    ]));
  });
});

function lease(executionId: string, stageId: string, conversationId: string) {
  return {
    queue_item: { queue_id: `queue-${stageId}`, stage_id: stageId, agent_id: `agent-${stageId}` },
    execution: { execution_id: executionId },
    runtime_request: {
      bot_id: "bot-a",
      user_id: "user-a",
      conversation_id: conversationId,
      runtime: "claude-code",
      prompt: `完成 ${stageId}`,
    },
  };
}
