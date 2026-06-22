import {
  parseDocumentCreateInput,
  type DocumentCreateInput,
  type TrustedMcpContext,
} from "@my-agent-toolkit/contracts";
import type { DataServiceClient } from "./dataClient.js";

export interface McpToolCall {
  tool: string;
  input: unknown;
}

export interface McpToolDependencies {
  dataClient: Pick<DataServiceClient, "createDocument">;
}

export type McpToolResult =
  | {
    ok: true;
    result: unknown;
  }
  | {
    ok: false;
    error: {
      code: "permission_denied" | "validation_error" | "storage_unavailable";
      message: string;
    };
  };

export async function callMcpTool(
  context: TrustedMcpContext,
  deps: McpToolDependencies,
  call: McpToolCall,
): Promise<McpToolResult> {
  try {
    if (call.tool === "document.create") {
      const input = parseDocumentCreateInput(call.input);
      assertDocumentWritePermission(context, input);
      return {
        ok: true,
        result: await deps.dataClient.createDocument(input),
      };
    }

    return toolError("validation_error", `unsupported MCP tool: ${call.tool}`);
  } catch (error) {
    return toolError(errorCodeFor(error), errorMessageFor(error));
  }
}

function assertDocumentWritePermission(
  context: TrustedMcpContext,
  input: DocumentCreateInput,
): void {
  if (input.scope === "system") {
    throw new PermissionError("system scope is read only");
  }
  if (input.scope === "shared") {
    throw new PermissionError("shared scope writes require explicit authorization");
  }
  if (input.scope === "bot" && input.owner_id !== context.bot_id) {
    throw new PermissionError("bot scope owner must match trusted bot_id");
  }
  if (input.scope === "user" && input.owner_id !== context.user_id) {
    throw new PermissionError("user scope owner must match trusted user_id");
  }
  if (input.scope === "session" && input.owner_id !== context.conversation_id) {
    throw new PermissionError("session scope owner must match trusted conversation_id");
  }
}

function toolError(
  code: "permission_denied" | "validation_error" | "storage_unavailable",
  message: string,
): McpToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function errorCodeFor(
  error: unknown,
): "permission_denied" | "validation_error" | "storage_unavailable" {
  if (error instanceof PermissionError) {
    return "permission_denied";
  }
  return "validation_error";
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : "invalid MCP tool request";
}

class PermissionError extends Error {}
