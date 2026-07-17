import type { TrustedMcpContext } from "@my-agent-toolkit/contracts";

export interface ProjectClient {
  publish(
    context: TrustedMcpContext,
    input: {
      projectKey: string;
      branch: string;
      commitMessage: string;
    },
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
    async publish(context, input) {
      const response = await fetchImpl(
        `${baseUrl}/internal/bots/${encodeURIComponent(context.bot_id)}/projects/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-project-runner-token": options.token,
          },
          body: JSON.stringify({
            user_id: context.user_id,
            conversation_id: context.conversation_id,
            project_key: input.projectKey,
            branch: input.branch,
            commit_message: input.commitMessage,
          }),
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `project publish failed: ${response.status}`,
        );
      }
      return body;
    },
  };
}
