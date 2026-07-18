import type { WorkDispatcher } from "./dispatcher.js";

export function createWorkDispatcherServer(dispatcher: WorkDispatcher): {
  fetch(request: Request): Promise<Response>;
} {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ service: "work-dispatcher", status: "ok", ...dispatcher.status() });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
}
