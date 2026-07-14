import type { TrustedMcpContext } from "@my-agent-toolkit/contracts";

export interface ProjectClient {
  ensure(
    context: TrustedMcpContext,
    projectKey: string,
  ): Promise<Record<string, unknown>>;
  inspect(
    context: TrustedMcpContext,
    projectKey: string,
  ): Promise<Record<string, unknown>>;
  read(
    context: TrustedMcpContext,
    input: { projectKey: string; path: string; startLine?: number; endLine?: number },
  ): Promise<Record<string, unknown>>;
  search(
    context: TrustedMcpContext,
    input: { projectKey: string; query: string; path?: string },
  ): Promise<Record<string, unknown>>;
}

export function createProjectClient(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): ProjectClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async ensure(context, projectKey) {
      const response = await fetchImpl(
        `${baseUrl}/internal/bots/${encodeURIComponent(context.bot_id)}/projects/ensure`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-project-runner-token": options.token,
          },
          body: JSON.stringify({
            user_id: context.user_id,
            conversation_id: context.conversation_id,
            project_key: projectKey,
          }),
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `project ensure failed: ${response.status}`,
        );
      }
      return body;
    },
    async inspect(context, projectKey) {
      return callProjectEndpoint(fetchImpl, baseUrl, options.token, context, "inspect", {
        user_id: context.user_id,
        project_key: projectKey,
      });
    },
    async read(context, input) {
      return callProjectEndpoint(fetchImpl, baseUrl, options.token, context, "read", {
        user_id: context.user_id,
        project_key: input.projectKey,
        path: input.path,
        ...(input.startLine === undefined ? {} : { start_line: input.startLine }),
        ...(input.endLine === undefined ? {} : { end_line: input.endLine }),
      });
    },
    async search(context, input) {
      return callProjectEndpoint(fetchImpl, baseUrl, options.token, context, "search", {
        user_id: context.user_id,
        project_key: input.projectKey,
        query: input.query,
        ...(input.path === undefined ? {} : { path: input.path }),
      });
    },
  };
}

async function callProjectEndpoint(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  context: TrustedMcpContext,
  action: "inspect" | "read" | "search",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(
    `${baseUrl}/internal/bots/${encodeURIComponent(context.bot_id)}/projects/${action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-runner-token": token,
      },
      body: JSON.stringify(payload),
    },
  );
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `project ${action} failed: ${response.status}`,
    );
  }
  return body;
}
