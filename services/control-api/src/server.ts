export interface ControlApiConfig {
  dataServiceUrl: string;
  logServiceUrl: string;
  botHostUrl?: string;
  capabilityRunnerUrl?: string;
  fetch: typeof fetch;
}

export interface ControlApiServer {
  fetch(request: Request): Promise<Response>;
}

export function createControlApiServer(config: ControlApiConfig): ControlApiServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "control-api",
          status: "ok",
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(renderChannelWorkbenchPage());
      }

      const roleAdminPageMatch = url.pathname.match(/^\/admin\/roles\/([^/]+)$/);
      if (request.method === "GET" && roleAdminPageMatch) {
        return handleRoleDetailPage(config, roleAdminPageMatch[1]);
      }

      const roleDocumentSaveMatch = url.pathname.match(/^\/admin\/roles\/([^/]+)\/documents\/save$/);
      if (request.method === "POST" && roleDocumentSaveMatch) {
        return handleRoleDocumentSave(request, config, roleDocumentSaveMatch[1]);
      }

      const roleQuestionSaveMatch = url.pathname.match(/^\/admin\/roles\/([^/]+)\/questions\/save$/);
      if (request.method === "POST" && roleQuestionSaveMatch) {
        return handleRoleQuestionSave(request, config, roleQuestionSaveMatch[1]);
      }

      const botConfigPageMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/config$/);
      if (request.method === "GET" && botConfigPageMatch) {
        return handleBotConfigEditorPage(config, botConfigPageMatch[1]);
      }

      const botCapabilitiesPageMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities$/);
      if (request.method === "GET" && botCapabilitiesPageMatch) {
        return handleBotCapabilitiesPage(config, botCapabilitiesPageMatch[1]);
      }

      const botSoulSaveMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/config\/soul$/);
      if (request.method === "POST" && botSoulSaveMatch) {
        return handleBotConfigDocumentSave(request, config, botSoulSaveMatch[1], "soul");
      }

      const botAgentsSaveMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/config\/agents$/);
      if (request.method === "POST" && botAgentsSaveMatch) {
        return handleBotConfigDocumentSave(request, config, botAgentsSaveMatch[1], "agents.md");
      }

      const botCapabilityEnvSaveMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/env\/save$/);
      if (request.method === "POST" && botCapabilityEnvSaveMatch) {
        return handleBotEnvSave(request, config, botCapabilityEnvSaveMatch[1]);
      }

      const botCapabilityEnvDeleteMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/env\/delete$/);
      if (request.method === "POST" && botCapabilityEnvDeleteMatch) {
        return handleBotEnvDelete(request, config, botCapabilityEnvDeleteMatch[1]);
      }

      const botCapabilitySkillInstallMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/skills\/install$/);
      if (request.method === "POST" && botCapabilitySkillInstallMatch) {
        return handleBotSkillInstall(request, config, botCapabilitySkillInstallMatch[1]);
      }

      const botCapabilitySkillDeleteMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/skills\/delete$/);
      if (request.method === "POST" && botCapabilitySkillDeleteMatch) {
        return handleBotSkillDelete(request, config, botCapabilitySkillDeleteMatch[1]);
      }

      const botCapabilityMcpInstallMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/mcps\/install$/);
      if (request.method === "POST" && botCapabilityMcpInstallMatch) {
        return handleBotMcpInstall(request, config, botCapabilityMcpInstallMatch[1]);
      }

      const botCapabilityMcpDeleteMatch = url.pathname.match(/^\/admin\/bots\/([^/]+)\/capabilities\/mcps\/delete$/);
      if (request.method === "POST" && botCapabilityMcpDeleteMatch) {
        return handleBotMcpDelete(request, config, botCapabilityMcpDeleteMatch[1]);
      }

      if (request.method === "GET" && url.pathname === "/v1/global-documents") {
        return proxyGetRequest(`${config.dataServiceUrl}/v1/global-documents`, config);
      }

      if (request.method === "POST" && url.pathname === "/v1/global-documents") {
        return proxyJsonRequest(request, `${config.dataServiceUrl}/v1/global-documents`, config, {
          action: "global_document.upsert",
          targetType: "global_document",
          targetId: (_body, payload) => String(payload.document_id ?? ""),
          metadata: (body, payload) => ({
            slug: payload.slug ?? body.slug,
            enabled: payload.enabled ?? body.enabled,
            sort_order: payload.sort_order ?? body.sort_order,
            title: payload.title ?? body.title,
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/roles") {
        return proxyGetRequest(`${config.dataServiceUrl}/v1/roles`, config);
      }

      if (request.method === "POST" && url.pathname === "/v1/roles") {
        return proxyJsonRequest(request, `${config.dataServiceUrl}/v1/roles`, config, {
          action: "role.upsert",
          targetType: "role",
          targetId: (_body, payload) => String(payload.role_id ?? ""),
          metadata: (body, payload) => ({
            slug: payload.slug ?? body.slug,
            name: payload.name ?? body.name,
            enabled: payload.enabled ?? body.enabled,
            sort_order: payload.sort_order ?? body.sort_order,
          }),
        });
      }

      const roleDocumentsMatch = url.pathname.match(/^\/v1\/roles\/([^/]+)\/documents$/);
      if (request.method === "GET" && roleDocumentsMatch) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleDocumentsMatch[1])}/documents`,
          config,
        );
      }
      if (request.method === "POST" && roleDocumentsMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleDocumentsMatch[1])}/documents`,
          config,
          {
            action: "role_document.upsert",
            targetType: "role",
            targetId: () => roleDocumentsMatch[1],
            metadata: (body, payload) => ({
              role_document_id: payload.role_document_id,
              title: payload.title ?? body.title,
              enabled: payload.enabled ?? body.enabled,
            }),
          },
        );
      }

      const roleQuestionsMatch = url.pathname.match(/^\/v1\/roles\/([^/]+)\/questions$/);
      if (request.method === "GET" && roleQuestionsMatch) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleQuestionsMatch[1])}/questions`,
          config,
        );
      }
      if (request.method === "POST" && roleQuestionsMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleQuestionsMatch[1])}/questions`,
          config,
          {
            action: "role_question.upsert",
            targetType: "role",
            targetId: () => roleQuestionsMatch[1],
            metadata: (body, payload) => ({
              question_id: payload.question_id,
              key: payload.key ?? body.key,
              enabled: payload.enabled ?? body.enabled,
              sort_order: payload.sort_order ?? body.sort_order,
            }),
          },
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/bots") {
        return proxyJsonRequest(request, `${config.dataServiceUrl}/v1/bots`, config, {
          action: "bot.create",
          targetType: "bot",
          targetId: (body, payload) => String(payload.bot_id ?? body.bot_id ?? ""),
          metadata: (body, payload) => ({
            runtime: payload.runtime ?? body.runtime,
            status: payload.status,
            wecom_bot_id: payload.wecom_bot_id ?? body.wecom_bot_id,
            wecom_secret_configured: Boolean(
              payload.wecom_secret_configured ?? body.wecom_secret,
            ),
          }),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/bots") {
        return proxyGetRequest(`${config.dataServiceUrl}/v1/bots`, config);
      }

      if (request.method === "GET" && url.pathname === "/v1/bot-channels") {
        const botId = url.searchParams.get("bot_id");
        const query = botId ? `?bot_id=${encodeURIComponent(botId)}` : "";
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/bot-channels${query}`,
          config,
        );
      }

      const channelRoute = parseWeComChannelRoute(url.pathname);
      if (request.method === "GET" && channelRoute) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/bot-channels/wecom:${encodeURIComponent(channelRoute.botId)}`,
          config,
        );
      }
      if (request.method === "DELETE" && channelRoute) {
        return handleDeleteBotChannel(request, config, channelRoute.botId);
      }

      const botMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)$/);
      if (request.method === "GET" && botMatch) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botMatch[1])}`,
          config,
        );
      }
      if (request.method === "PATCH" && botMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botMatch[1])}`,
          config,
          {
            action: "bot.update",
            targetType: "bot",
            targetId: () => botMatch[1],
            metadata: (body, payload) => ({
              name: payload.name ?? body.name,
              runtime: payload.runtime ?? body.runtime,
              status: payload.status ?? body.status,
              wecom_bot_id: payload.wecom_bot_id ?? body.wecom_bot_id,
              wecom_secret_configured: Boolean(
                payload.wecom_secret_configured ?? body.wecom_secret,
              ),
            }),
          },
        );
      }

      const mcpCapabilitiesMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/mcp-capabilities$/,
      );
      if (request.method === "GET" && mcpCapabilitiesMatch) {
        return handleGetMcpCapabilities(config, mcpCapabilitiesMatch[1]);
      }

      const mcpCapabilityConfigMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/mcp-capabilities\/config$/,
      );
      if (request.method === "PUT" && mcpCapabilityConfigMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(mcpCapabilityConfigMatch[1])}/mcp-capabilities/config`,
          config,
          {
            action: "mcp.capability_config.update",
            targetType: "bot",
            targetId: () => mcpCapabilityConfigMatch[1],
            metadata: (_body, payload) => ({
              tools_enabled: readStringArrayPayload(payload, ["tools", "enabled"]),
              readable_scopes: readStringArrayPayload(payload, ["memory", "readable_scopes"]),
              writable_scopes: readStringArrayPayload(payload, ["memory", "writable_scopes"]),
              directory_refs: readStringArrayPayload(payload, ["directory_refs"]),
            }),
          },
        );
      }

      const botConfigDocumentsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/config-documents$/,
      );
      if (request.method === "GET" && botConfigDocumentsMatch) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botConfigDocumentsMatch[1])}/config-documents`,
          config,
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/bot-config-documents") {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bot-config-documents`,
          config,
          {
            action: "bot_config_document.upsert",
            targetType: "bot",
            targetId: (body, payload) => String(payload.bot_id ?? body.bot_id ?? ""),
            metadata: (body, payload) => ({
              title: payload.title ?? body.title,
            }),
          },
        );
      }

      const wecomTestMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/wecom\/test$/,
      );
      if (request.method === "POST" && wecomTestMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(wecomTestMatch[1])}/wecom/test`,
          config,
          {
            action: "wecom.config.check",
            targetType: "bot",
            targetId: () => wecomTestMatch[1],
            metadata: (_body, payload) => ({
              status: payload.status,
              missing: payload.missing,
              wecom_secret_configured: payload.wecom_secret_configured,
            }),
          },
        );
      }

      const adminClaimsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claims$/,
      );
      if (request.method === "POST" && adminClaimsMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(adminClaimsMatch[1])}/admin/claims`,
          config,
          {
            action: "admin.claim_code.create",
            targetType: "bot",
            targetId: () => adminClaimsMatch[1],
            metadata: () => ({}),
          },
        );
      }

      const adminResetMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/reset$/,
      );
      if (request.method === "POST" && adminResetMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(adminResetMatch[1])}/admin/reset`,
          config,
          {
            action: "admin.reset",
            targetType: "bot",
            targetId: () => adminResetMatch[1],
            metadata: (_body, payload) => ({
              claim_expires_at: payload.expires_at,
            }),
          },
        );
      }

      const adminMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/admin$/);
      if (request.method === "GET" && adminMatch) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(adminMatch[1])}/admin`,
          config,
        );
      }

      const adminTransferMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/transfer$/,
      );
      if (request.method === "POST" && adminTransferMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(adminTransferMatch[1])}/admin/transfer`,
          config,
          {
            action: "admin.transfer",
            targetType: "bot",
            targetId: () => adminTransferMatch[1],
            metadata: (body, payload) => ({
              new_wecom_user_id: payload.wecom_user_id ?? body.new_wecom_user_id,
            }),
          },
        );
      }

      const readyMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/ready$/);
      if (request.method === "POST" && readyMatch) {
        return proxyJsonRequest(
          request,
          `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(readyMatch[1])}/ready`,
          config,
          {
            action: "bot.ready",
            targetType: "bot",
            targetId: () => readyMatch[1],
            metadata: (_body, payload) => ({
              status: payload.status,
            }),
          },
        );
      }

      const resetMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/reset$/);
      if (request.method === "POST" && resetMatch) {
        return handleRestartInitialization(config, resetMatch[1]);
      }

      const restartInitializationMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/initialization\/restart$/,
      );
      if (request.method === "POST" && restartInitializationMatch) {
        return handleRestartInitialization(config, restartInitializationMatch[1]);
      }

      if (request.method === "POST" && url.pathname === "/v1/memory-documents") {
        return handleUpsertMemoryDocument(request, config);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/memory-documents/current"
      ) {
        return proxyGetRequest(
          `${config.dataServiceUrl}/v1/memory-documents/current${url.search}`,
          config,
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/chat-events") {
        return proxyGetRequest(
          `${config.logServiceUrl}/v1/chat-events${url.search}`,
          config,
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/audit-events") {
        return proxyGetRequest(
          `${config.logServiceUrl}/v1/audit-events${url.search}`,
          config,
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/wecom") {
        if (!config.botHostUrl) {
          return jsonResponse({ error: "bot host is not configured" }, 503);
        }
        return proxyJsonRequest(
          request,
          `${config.botHostUrl}/v1/messages/wecom`,
          config,
        );
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleGetMcpCapabilities(
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const encodedBotId = encodeURIComponent(botId);
  const [botResponse, configDocumentsResponse, documentsResponse, memoryResponse, capabilityConfigResponse] = await Promise.all([
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/config-documents`)),
    config.fetch(
      new Request(
        `${config.dataServiceUrl}/internal/documents?scope=bot&owner_id=${encodedBotId}&status=active`,
      ),
    ),
    config.fetch(
      new Request(
        `${config.dataServiceUrl}/internal/memory-stats?scope=bot&owner_id=${encodedBotId}`,
      ),
    ),
    config.fetch(
      new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/mcp-capabilities/config`),
    ),
  ]);

  if (!botResponse.ok) {
    return cloneJsonResponse(botResponse);
  }
  if (!configDocumentsResponse.ok) {
    return cloneJsonResponse(configDocumentsResponse);
  }
  if (!documentsResponse.ok) {
    return cloneJsonResponse(documentsResponse);
  }
  if (!memoryResponse.ok) {
    return cloneJsonResponse(memoryResponse);
  }
  if (!capabilityConfigResponse.ok) {
    return cloneJsonResponse(capabilityConfigResponse);
  }

  const bot = await botResponse.json() as Record<string, unknown>;
  const configDocuments = await configDocumentsResponse.json() as unknown[];
  const documents = await documentsResponse.json() as unknown[];
  const memoryStats = await memoryResponse.json() as Record<string, unknown>;
  const capabilityConfig = await capabilityConfigResponse.json() as Record<string, unknown>;

  return jsonResponse({
    bot_id: String(bot.bot_id ?? botId),
    status: typeof bot.status === "string" ? bot.status : "unknown",
    runtime: typeof bot.runtime === "string" ? bot.runtime : "unknown",
    config_documents: summarizeConfigDocuments(configDocuments),
    documents: summarizeDocuments(documents),
    memory: memoryStats,
    capability_config: capabilityConfig,
  });
}

async function handleRoleDetailPage(
  config: ControlApiConfig,
  roleId: string,
): Promise<Response> {
  const encodedRoleId = encodeURIComponent(roleId);
  const [roleResponse, documentsResponse, questionsResponse] = await Promise.all([
    config.fetch(new Request(`${config.dataServiceUrl}/v1/roles/${encodedRoleId}`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/roles/${encodedRoleId}/documents`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/roles/${encodedRoleId}/questions`)),
  ]);
  if (!roleResponse.ok) {
    return cloneJsonResponse(roleResponse);
  }
  if (!documentsResponse.ok) {
    return cloneJsonResponse(documentsResponse);
  }
  if (!questionsResponse.ok) {
    return cloneJsonResponse(questionsResponse);
  }

  const role = await roleResponse.json() as Record<string, unknown>;
  const documents = await documentsResponse.json() as Array<Record<string, unknown>>;
  const questions = await questionsResponse.json() as Array<Record<string, unknown>>;
  return htmlResponse(renderRoleDetailPage(roleId, role, documents, questions));
}

async function handleBotConfigEditorPage(
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const encodedBotId = encodeURIComponent(botId);
  const [botResponse, documentsResponse] = await Promise.all([
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/config-documents`)),
  ]);
  if (!botResponse.ok) {
    return cloneJsonResponse(botResponse);
  }
  if (!documentsResponse.ok) {
    return cloneJsonResponse(documentsResponse);
  }

  const bot = await botResponse.json() as Record<string, unknown>;
  const documents = await documentsResponse.json() as Array<Record<string, unknown>>;
  return htmlResponse(renderBotConfigEditorPage(botId, bot, documents));
}

async function handleBotCapabilitiesPage(
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const encodedBotId = encodeURIComponent(botId);
  const [botResponse, envResponse, skillsResponse, mcpsResponse, policyResponse] = await Promise.all([
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/env`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/skills`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/mcps`)),
    config.fetch(new Request(`${config.dataServiceUrl}/v1/bots/${encodedBotId}/runtime-policy`)),
  ]);
  if (!botResponse.ok) {
    return cloneJsonResponse(botResponse);
  }
  if (!envResponse.ok) {
    return cloneJsonResponse(envResponse);
  }
  if (!skillsResponse.ok) {
    return cloneJsonResponse(skillsResponse);
  }
  if (!mcpsResponse.ok) {
    return cloneJsonResponse(mcpsResponse);
  }
  if (!policyResponse.ok) {
    return cloneJsonResponse(policyResponse);
  }

  const bot = await botResponse.json() as Record<string, unknown>;
  const envPayload = await envResponse.json() as { items?: Array<Record<string, unknown>> };
  const skills = await skillsResponse.json() as Array<Record<string, unknown>>;
  const mcps = await mcpsResponse.json() as Array<Record<string, unknown>>;
  const policy = await policyResponse.json() as Record<string, unknown>;

  return htmlResponse(renderBotCapabilitiesPage(
    botId,
    bot,
    Array.isArray(envPayload.items) ? envPayload.items : [],
    skills,
    mcps,
    policy,
  ));
}

async function handleRoleDocumentSave(
  request: Request,
  config: ControlApiConfig,
  roleId: string,
): Promise<Response> {
  const form = await readUrlEncodedForm(request);
  await proxyJsonRequest(
    new Request(`http://localhost/v1/roles/${encodeURIComponent(roleId)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor_id: form.actor_id,
        title: form.title,
        content: form.content,
        enabled: form.enabled === "true",
      }),
    }),
    `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleId)}/documents`,
    config,
    {
      action: "role_document.upsert",
      targetType: "role",
      targetId: () => roleId,
      metadata: (body, payload) => ({
        role_document_id: payload.role_document_id,
        title: payload.title ?? body.title,
        enabled: payload.enabled ?? body.enabled,
      }),
    },
  );
  return redirectResponse(`/admin/roles/${encodeURIComponent(roleId)}`);
}

async function handleRoleQuestionSave(
  request: Request,
  config: ControlApiConfig,
  roleId: string,
): Promise<Response> {
  const form = await readUrlEncodedForm(request);
  await proxyJsonRequest(
    new Request(`http://localhost/v1/roles/${encodeURIComponent(roleId)}/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor_id: form.actor_id,
        key: form.key,
        title: form.title,
        description: form.description ?? "",
        question_type: form.question_type,
        options_json: parseJsonArrayField(form.options_json),
        required: form.required === "true",
        enabled: form.enabled === "true",
        sort_order: Number(form.sort_order ?? 0),
        depends_on_json: parseJsonArrayField(form.depends_on_json),
      }),
    }),
    `${config.dataServiceUrl}/v1/roles/${encodeURIComponent(roleId)}/questions`,
    config,
    {
      action: "role_question.upsert",
      targetType: "role",
      targetId: () => roleId,
      metadata: (body, payload) => ({
        question_id: payload.question_id,
        key: payload.key ?? body.key,
        enabled: payload.enabled ?? body.enabled,
        sort_order: payload.sort_order ?? body.sort_order,
      }),
    },
  );
  return redirectResponse(`/admin/roles/${encodeURIComponent(roleId)}`);
}

async function handleBotConfigDocumentSave(
  request: Request,
  config: ControlApiConfig,
  botId: string,
  title: "soul" | "agents.md",
): Promise<Response> {
  const form = await readUrlEncodedForm(request);
  await proxyJsonRequest(
    new Request("http://localhost/v1/bot-config-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor_id: form.actor_id,
        bot_id: botId,
        title,
        content: form.content,
      }),
    }),
    `${config.dataServiceUrl}/v1/bot-config-documents`,
    config,
    {
      action: "bot_config_document.upsert",
      targetType: "bot",
      targetId: (body, payload) => String(payload.bot_id ?? body.bot_id ?? ""),
      metadata: (body, payload) => ({
        title: payload.title ?? body.title,
      }),
    },
  );
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/config`);
}

async function handleBotEnvSave(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const form = await readUrlEncodedForm(request);
  const response = await proxyJsonRequest(
    new Request(`http://localhost/v1/bots/${encodeURIComponent(botId)}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor_id: form.actor_id,
        key: form.key,
        value_ciphertext: form.value_ciphertext,
        updated_by_wecom_user_id: form.actor_id,
      }),
    }),
    `${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/env`,
    config,
    {
      action: "bot.env.upsert",
      targetType: "bot",
      targetId: () => botId,
      metadata: (body, payload) => ({
        key: payload.key ?? body.key,
        is_set: payload.is_set,
      }),
    },
  );
  if (!response.ok) {
    return response;
  }
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

async function handleBotEnvDelete(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const form = await readUrlEncodedForm(request);
  const key = form.key ?? "";
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/env/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  );
  if (!response.ok && response.status !== 204) {
    return cloneJsonResponse(response);
  }
  await recordAuditEvent(config, {
    actor_id: form.actor_id ?? "system",
    action: "bot.env.delete",
    target_type: "bot",
    target_id: botId,
    metadata: {
      key,
    },
  });
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

async function handleBotSkillInstall(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  if (!config.capabilityRunnerUrl) {
    return jsonResponse({ error: "capability runner is not configured" }, 503);
  }
  const form = await readUrlEncodedForm(request);
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        source_ref: form.source_ref || undefined,
        source_type: form.source_type || undefined,
      }),
    }),
  );
  if (!response.ok) {
    return cloneJsonResponse(response);
  }
  await recordAuditEvent(config, {
    actor_id: form.actor_id ?? "system",
    action: "bot.skill.install",
    target_type: "bot",
    target_id: botId,
    metadata: {
      name: form.name,
      source_ref: form.source_ref,
      source_type: form.source_type,
    },
  });
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

async function handleBotSkillDelete(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  if (!config.capabilityRunnerUrl) {
    return jsonResponse({ error: "capability runner is not configured" }, 503);
  }
  const form = await readUrlEncodedForm(request);
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/skills/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name,
      }),
    }),
  );
  if (!response.ok) {
    return cloneJsonResponse(response);
  }
  await recordAuditEvent(config, {
    actor_id: form.actor_id ?? "system",
    action: "bot.skill.delete",
    target_type: "bot",
    target_id: botId,
    metadata: {
      name: form.name,
    },
  });
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

async function handleBotMcpInstall(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  if (!config.capabilityRunnerUrl) {
    return jsonResponse({ error: "capability runner is not configured" }, 503);
  }
  const form = await readUrlEncodedForm(request);
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/mcps/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        mode: form.mode || undefined,
        source_ref: form.source_ref || undefined,
      }),
    }),
  );
  if (!response.ok) {
    return cloneJsonResponse(response);
  }
  await recordAuditEvent(config, {
    actor_id: form.actor_id ?? "system",
    action: "bot.mcp.install",
    target_type: "bot",
    target_id: botId,
    metadata: {
      name: form.name,
      mode: form.mode,
      source_ref: form.source_ref,
    },
  });
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

async function handleBotMcpDelete(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  if (!config.capabilityRunnerUrl) {
    return jsonResponse({ error: "capability runner is not configured" }, 503);
  }
  const form = await readUrlEncodedForm(request);
  const response = await config.fetch(
    new Request(`${config.capabilityRunnerUrl}/internal/bots/${encodeURIComponent(botId)}/mcps/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name,
      }),
    }),
  );
  if (!response.ok) {
    return cloneJsonResponse(response);
  }
  await recordAuditEvent(config, {
    actor_id: form.actor_id ?? "system",
    action: "bot.mcp.delete",
    target_type: "bot",
    target_id: botId,
    metadata: {
      name: form.name,
    },
  });
  return redirectResponse(`/admin/bots/${encodeURIComponent(botId)}/capabilities`);
}

function summarizeConfigDocuments(documents: unknown[]): {
  soul: { configured: boolean; title?: string };
  agents: { configured: boolean; title?: string };
} {
  const titles = documents
    .map((document) => document && typeof document === "object"
      ? (document as Record<string, unknown>).title
      : undefined)
    .filter((title): title is string => typeof title === "string");
  const soulTitle = titles.find((title) => {
    const normalized = title.trim().toLowerCase();
    return normalized === "soul" || normalized === "soul.md";
  });
  const agentsTitle = titles.find((title) => {
    const normalized = title.trim().toLowerCase();
    return normalized === "agents" || normalized === "agents.md";
  });
  return {
    soul: {
      configured: Boolean(soulTitle),
      ...(soulTitle ? { title: soulTitle } : {}),
    },
    agents: {
      configured: Boolean(agentsTitle),
      ...(agentsTitle ? { title: agentsTitle } : {}),
    },
  };
}

function summarizeDocuments(documents: unknown[]): {
  count: number;
  by_type: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  for (const document of documents) {
    if (!document || typeof document !== "object") {
      continue;
    }
    const docType = (document as Record<string, unknown>).doc_type;
    if (typeof docType !== "string" || docType.trim() === "") {
      continue;
    }
    const normalized = docType.trim();
    byType[normalized] = (byType[normalized] ?? 0) + 1;
  }
  return {
    count: documents.length,
    by_type: Object.fromEntries(Object.entries(byType).sort(([left], [right]) => left.localeCompare(right))),
  };
}

async function handleUpsertMemoryDocument(
  request: Request,
  config: ControlApiConfig,
): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/memory-documents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const responseText = await response.text();

  if (response.ok) {
    const payload = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
    await recordAuditEvent(config, {
      actor_id: typeof body.actor_id === "string" ? body.actor_id : "system",
      action: "memory.upsert",
      target_type: String(payload.scope ?? body.scope ?? "memory"),
      target_id: String(payload.owner_id ?? body.owner_id ?? ""),
      metadata: {
        memory_doc_id: payload.memory_doc_id,
        title: payload.title ?? body.title,
        version: payload.version,
      },
    });
  }

  return new Response(responseText, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function handleDeleteBotChannel(
  request: Request,
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  const response = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bot-channels/wecom:${encodeURIComponent(botId)}`, {
      method: "DELETE",
    }),
  );
  const responseText = await response.text();

  if (response.ok) {
    await syncWeComRuntime(config);
    const body = parseJsonObject(await request.text());
    const payload = parseJsonObject(responseText);
    await recordAuditEvent(config, {
      actor_id: readActorId(body),
      action: "channel.delete",
      target_type: "bot",
      target_id: botId,
      metadata: {
        channel_type: "wecom",
        runtime_enabled: payload.runtime_enabled,
        runtime_status: payload.runtime_status,
      },
    });
  }

  return new Response(responseText, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function handleRestartInitialization(
  config: ControlApiConfig,
  botId: string,
): Promise<Response> {
  if (!config.botHostUrl) {
    return jsonResponse({ error: "bot host is not configured" }, 503);
  }

  const adminResponse = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/admin`),
  );
  if (!adminResponse.ok) {
    return cloneJsonResponse(adminResponse);
  }
  const admin = await adminResponse.json() as { wecom_user_id?: unknown };
  if (typeof admin.wecom_user_id !== "string" || admin.wecom_user_id.trim() === "") {
    return jsonResponse({ error: "admin is not claimed" }, 409);
  }

  const resetResponse = await config.fetch(
    new Request(`${config.dataServiceUrl}/v1/bots/${encodeURIComponent(botId)}/reset`, {
      method: "POST",
    }),
  );
  const resetText = await resetResponse.text();
  if (!resetResponse.ok) {
    return new Response(resetText, {
      status: resetResponse.status,
      headers: {
        "content-type": resetResponse.headers.get("content-type") ?? "application/json",
      },
    });
  }

  const triggerResponse = await config.fetch(
    new Request(`${config.botHostUrl}/internal/bots/${encodeURIComponent(botId)}/initialization/restart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        admin_wecom_user_id: admin.wecom_user_id,
      }),
    }),
  );
  const triggerText = await triggerResponse.text();
  if (triggerResponse.ok) {
    await recordAuditEvent(config, {
      actor_id: admin.wecom_user_id,
      action: "bot.initialization.restart",
      target_type: "bot",
      target_id: botId,
      metadata: {
        status: parseJsonObject(resetText).status,
        admin_wecom_user_id: admin.wecom_user_id,
      },
    });
  }

  return new Response(triggerText, {
    status: triggerResponse.status,
    headers: {
      "content-type": triggerResponse.headers.get("content-type") ?? "application/json",
    },
  });
}

async function syncWeComRuntime(config: ControlApiConfig): Promise<void> {
  if (!config.botHostUrl) {
    return;
  }
  const response = await config.fetch(
    new Request(`${config.botHostUrl}/internal/wecom-runtime/sync`, {
      method: "POST",
    }),
  );
  if (!response.ok) {
    throw new Error("failed to sync wecom runtime");
  }
}

async function recordAuditEvent(
  config: ControlApiConfig,
  event: {
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const response = await config.fetch(
    new Request(`${config.logServiceUrl}/v1/audit-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    }),
  );
  if (!response.ok) {
    throw new Error("failed to record audit event");
  }
}

async function proxyJsonRequest(
  request: Request,
  url: string,
  config: ControlApiConfig,
  audit?: AuditDescriptor,
): Promise<Response> {
  const bodyText = await request.text();
  const response = await config.fetch(
    new Request(url, {
      method: request.method,
      headers: {
        "content-type": "application/json",
      },
      body: bodyText === "" ? undefined : bodyText,
    }),
  );
  const responseText = await response.text();
  if (response.ok && audit) {
    const body = parseJsonObject(bodyText);
    const payload = parseJsonObject(responseText);
    await recordAuditEvent(config, {
      actor_id: readActorId(body),
      action: audit.action,
      target_type: audit.targetType,
      target_id: audit.targetId(body, payload),
      metadata: audit.metadata(body, payload),
    });
  }

  return new Response(responseText, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function proxyGetRequest(
  url: string,
  config: ControlApiConfig,
): Promise<Response> {
  const response = await config.fetch(new Request(url));
  return cloneJsonResponse(response);
}

async function cloneJsonResponse(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

interface AuditDescriptor {
  action: string;
  targetType: string;
  targetId: (
    body: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => string;
  metadata: (
    body: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (text.trim() === "") {
    return {};
  }
  const value = JSON.parse(text) as unknown;
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function parseWeComChannelRoute(pathname: string): { botId: string } | undefined {
  const match = pathname.match(/^\/v1\/bot-channels\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const channelId = decodeURIComponent(match[1]);
  if (!channelId.startsWith("wecom:")) {
    return undefined;
  }
  const botId = channelId.slice("wecom:".length);
  return botId ? { botId } : undefined;
}

function readActorId(body: Record<string, unknown>): string {
  if (typeof body.actor_id === "string") {
    return body.actor_id;
  }
  if (typeof body.current_wecom_user_id === "string") {
    return body.current_wecom_user_id;
  }
  return "system";
}

function readStringArrayPayload(
  payload: Record<string, unknown>,
  path: string[],
): string[] {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return [];
    }
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : [];
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "pragma": "no-cache",
    },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
    },
  });
}

async function readUrlEncodedForm(request: Request): Promise<Record<string, string>> {
  const formData = await request.formData();
  const result: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    result[key] = String(value);
  }
  return result;
}

function parseJsonArrayField(raw: string | undefined): unknown[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function escapeHtmlValue(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtmlValue(title)} - Bot Control</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f6f7f9; color: #17202e; }
    main { width: min(1080px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 40px; display: grid; gap: 16px; }
    .card { background: #fff; border: 1px solid #d9e1ea; border-radius: 8px; padding: 16px; }
    h1, h2, h3 { margin: 0; }
    .muted { color: #647184; font-size: 13px; }
    .stack { display: grid; gap: 10px; }
    textarea, input { width: 100%; box-sizing: border-box; border: 1px solid #d9e1ea; border-radius: 8px; padding: 10px 12px; font: inherit; background: #fff; }
    textarea { min-height: 180px; resize: vertical; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #d9e1ea; padding: 10px 8px; text-align: left; vertical-align: top; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    pre { white-space: pre-wrap; word-break: break-word; background: #111827; color: #eef4ff; border-radius: 8px; padding: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 8px; text-decoration: none; border: 1px solid #d9e1ea; background: #fff; color: #17202e; font-weight: 600; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function renderRoleDetailPage(
  roleId: string,
  role: Record<string, unknown>,
  documents: Array<Record<string, unknown>>,
  questions: Array<Record<string, unknown>>,
): string {
  const firstDocument = documents[0];
  return pageShell("角色详情", [
    `<section class="card stack">`,
    `<div class="actions"><a class="btn" href="/">返回 Channel 管理</a></div>`,
    `<h1>角色详情</h1>`,
    `<div class="muted">${escapeHtmlValue(roleId)}</div>`,
    `<h2>${escapeHtmlValue(role.name)}</h2>`,
    `<div class="muted">${escapeHtmlValue(role.description)}</div>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>角色规则文档</h2>`,
    `<div class="muted">提交目标：/v1/roles/${escapeHtmlValue(roleId)}/documents</div>`,
    `<label class="stack"><span class="muted">role.md</span><textarea>${escapeHtmlValue(firstDocument?.content ?? "")}</textarea></label>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>角色问题</h2>`,
    `<div class="muted">提交目标：/v1/roles/${escapeHtmlValue(roleId)}/questions</div>`,
    `<table><thead><tr><th>key</th><th>标题</th><th>类型</th><th>排序</th></tr></thead><tbody>`,
    ...questions.map((question) => `<tr><td><code>${escapeHtmlValue(question.key)}</code></td><td>${escapeHtmlValue(question.title)}</td><td>${escapeHtmlValue(question.question_type)}</td><td>${escapeHtmlValue(question.sort_order)}</td></tr>`),
    `</tbody></table>`,
    `</section>`,
  ].join(""));
}

function renderBotConfigEditorPage(
  botId: string,
  bot: Record<string, unknown>,
  documents: Array<Record<string, unknown>>,
): string {
  const soul = documents.find((document) => {
    const title = String(document.title ?? "").toLowerCase();
    return title === "soul" || title === "soul.md";
  });
  const agents = documents.find((document) => {
    const title = String(document.title ?? "").toLowerCase();
    return title === "agents" || title === "agents.md";
  });
  return pageShell("Bot 配置编辑", [
    `<section class="card stack">`,
    `<div class="actions"><a class="btn" href="/">返回 Channel 管理</a></div>`,
    `<h1>Bot 配置编辑</h1>`,
    `<h2>${escapeHtmlValue(bot.name ?? botId)}</h2>`,
    `<div class="muted">${escapeHtmlValue(botId)}</div>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>Soul</h2>`,
    `<div class="muted">提交目标：/v1/bot-config-documents</div>`,
    `<div class="actions"><span class="btn">保存 Soul</span></div>`,
    `<textarea>${escapeHtmlValue(soul?.content ?? "")}</textarea>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>Agents</h2>`,
    `<div class="muted">提交目标：/v1/bot-config-documents</div>`,
    `<div class="actions"><span class="btn">保存 Agents</span></div>`,
    `<textarea>${escapeHtmlValue(agents?.content ?? "")}</textarea>`,
    `</section>`,
  ].join(""));
}

function renderBotCapabilitiesPage(
  botId: string,
  bot: Record<string, unknown>,
  envItems: Array<Record<string, unknown>>,
  skills: Array<Record<string, unknown>>,
  mcps: Array<Record<string, unknown>>,
  policy: Record<string, unknown>,
): string {
  return pageShell("Bot 能力管理", [
    `<section class="card stack">`,
    `<div class="actions"><a class="btn" href="/">返回 Channel 管理</a><a class="btn" href="/admin/bots/${escapeHtmlValue(botId)}/config">编辑配置</a></div>`,
    `<h1>Bot 能力管理</h1>`,
    `<h2>${escapeHtmlValue(bot.name ?? botId)}</h2>`,
    `<div class="muted">${escapeHtmlValue(botId)}</div>`,
    `<div class="muted">skill_install_policy：${escapeHtmlValue(policy.skill_install_policy ?? "-")}</div>`,
    `<div class="muted">mcp_manage_policy：${escapeHtmlValue(policy.mcp_manage_policy ?? "-")}</div>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>环境变量</h2>`,
    `<table><thead><tr><th>Key</th><th>状态</th><th>展示值</th><th>更新时间</th></tr></thead><tbody>`,
    ...(envItems.length === 0
      ? [`<tr><td colspan="4" class="muted">暂无环境变量</td></tr>`]
      : envItems.map((item) => `<tr><td><code>${escapeHtmlValue(item.key)}</code></td><td>${escapeHtmlValue(item.is_set ? "已设置" : "未设置")}</td><td>****</td><td>${escapeHtmlValue(item.updated_at)}</td></tr>`)),
    `</tbody></table>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>Skills</h2>`,
    `<table><thead><tr><th>名称</th><th>来源</th><th>状态</th></tr></thead><tbody>`,
    ...(skills.length === 0
      ? [`<tr><td colspan="3" class="muted">暂无 Skills</td></tr>`]
      : skills.map((skill) => `<tr><td>${escapeHtmlValue(skill.name)}</td><td>${escapeHtmlValue(skill.source_ref ?? skill.source_type ?? "-")}</td><td>${escapeHtmlValue(skill.status)}</td></tr>`)),
    `</tbody></table>`,
    `</section>`,
    `<section class="card stack">`,
    `<h2>MCP</h2>`,
    `<table><thead><tr><th>名称</th><th>来源</th><th>状态</th></tr></thead><tbody>`,
    ...(mcps.length === 0
      ? [`<tr><td colspan="3" class="muted">暂无 MCP</td></tr>`]
      : mcps.map((mcp) => `<tr><td>${escapeHtmlValue(mcp.name)}</td><td>${escapeHtmlValue(mcp.source_ref ?? mcp.mode ?? "-")}</td><td>${escapeHtmlValue(mcp.status)}</td></tr>`)),
    `</tbody></table>`,
    `</section>`,
  ].join(""));
}

function renderChannelWorkbenchPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Channel 管理 - Bot Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-soft: #f1f4f7;
      --text: #17202e;
      --muted: #647184;
      --line: #d9e1ea;
      --primary: #145f53;
      --primary-strong: #0d493f;
      --accent: #1f9d72;
      --warn: #8a5a10;
      --danger: #a63a32;
      --code: #111827;
      --focus: rgba(20, 95, 83, .26);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
      font-size: 16px;
      line-height: 1.5;
    }
    button, input, select, textarea { font: inherit; }
    button {
      min-height: 44px;
      border: 0;
      border-radius: 8px;
      padding: 0 14px;
      background: var(--primary);
      color: #fff;
      font-weight: 650;
      cursor: pointer;
      transition: background .18s ease, border-color .18s ease, color .18s ease;
    }
    button:hover { background: var(--primary-strong); }
    button.secondary {
      color: var(--text);
      background: var(--surface-soft);
      border: 1px solid var(--line);
    }
    button.secondary:hover { background: #e7edf3; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #842f28; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    input, select, textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 11px;
      color: var(--text);
      background: #fff;
    }
    textarea { min-height: 110px; resize: vertical; }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.94);
      backdrop-filter: blur(8px);
    }
    .top {
      width: min(1440px, calc(100vw - 32px));
      min-height: 68px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    .brand p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
    main {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 18px 0 34px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(420px, 0.92fr) minmax(520px, 1.08fr);
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 14px 12px;
      border-bottom: 1px solid var(--line);
    }
    .panel-head h2, .section h3 { margin: 0; font-size: 15px; letter-spacing: 0; }
    .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .filters {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }
    .channel-list { display: grid; gap: 0; max-height: calc(100dvh - 214px); overflow: auto; }
    .channel-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      width: 100%;
      min-height: auto;
      border-radius: 0;
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      text-align: left;
      color: var(--text);
      background: #fff;
    }
    .channel-row:hover, .channel-row.active { background: #eef8f5; }
    .channel-row.active { box-shadow: inset 3px 0 0 var(--primary); }
    .channel-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .channel-title strong { font-size: 14px; }
    .channel-meta { margin-top: 5px; color: var(--muted); font-size: 12px; word-break: break-all; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 0 9px;
      font-size: 12px;
      font-weight: 700;
      background: var(--surface-soft);
      color: var(--muted);
      white-space: nowrap;
    }
    .badge.ok { color: #0f6b4d; background: #e5f5ee; }
    .badge.warn { color: var(--warn); background: #fff2d8; }
    .badge.bad { color: var(--danger); background: #ffe8e3; }
    .detail { display: grid; gap: 14px; }
    .hero {
      padding: 16px;
      display: grid;
      gap: 10px;
      border-bottom: 1px solid var(--line);
    }
    .hero-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .hero-title h2 { margin: 0; font-size: 18px; }
    .subtle { color: var(--muted); font-size: 13px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 3px; font-size: 13px; word-break: break-all; }
    .section {
      margin: 0 14px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }
    .section-body { padding: 12px; display: grid; gap: 10px; }
    .kv {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: 10px;
      font-size: 13px;
    }
    .kv span:first-child { color: var(--muted); }
    .kv span:last-child { word-break: break-word; }
    .doc-list { display: grid; gap: 8px; }
    .doc-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }
    .doc-item summary { cursor: pointer; font-weight: 700; }
    .doc-item pre {
      margin: 8px 0 0;
      max-height: 220px;
      overflow: auto;
      padding: 10px;
      border-radius: 8px;
      background: var(--code);
      color: #eef4ff;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }
    .config-note {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .config-status {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #eef8f5;
    }
    .config-note div {
      display: grid;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      font-size: 13px;
    }
    .config-note span { color: var(--muted); }
    .capability-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .capability-card {
      display: grid;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      min-width: 0;
    }
    .capability-card strong { font-size: 13px; }
    .capability-card span { color: var(--muted); font-size: 12px; word-break: break-word; }
    .chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 8px;
      background: #fff;
      color: var(--text);
      font-size: 12px;
      font-weight: 650;
    }
    .choice-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .choice-grid label {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font-size: 13px;
    }
    .choice-grid input { width: auto; min-height: auto; }
    .field-group {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
    }
    .field-group legend {
      padding: 0 4px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .form-grid { display: grid; gap: 10px; }
    .row-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .empty { padding: 28px 16px; color: var(--muted); text-align: center; }
    .empty h2 { margin: 0 0 6px; color: var(--text); font-size: 18px; }
    .empty p { margin: 0 auto 14px; max-width: 460px; }
    .claim-card {
      display: grid;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfd;
    }
    .claim-card code {
      display: block;
      padding: 9px 10px;
      overflow: auto;
      color: #eef4ff;
      background: var(--code);
    }
    .timeline { display: grid; gap: 8px; }
    .timeline-step {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      font-size: 13px;
    }
    .timeline-step span:first-child {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      color: #fff;
      background: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .timeline-step.ok span:first-child { background: var(--primary); }
    .timeline-step.warn span:first-child { background: var(--warn); }
    .timeline-step.bad span:first-child { background: var(--danger); }
    .toast { min-height: 24px; color: var(--muted); font-size: 13px; }
    .toast.error { color: var(--danger); }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      place-items: center;
      padding: 18px;
      background: rgba(15, 23, 42, .42);
      z-index: 20;
    }
    .modal-backdrop.open { display: grid; }
    .modal {
      width: min(620px, 100%);
      max-height: calc(100dvh - 36px);
      overflow: auto;
      background: #fff;
      border-radius: 8px;
      border: 1px solid var(--line);
      box-shadow: 0 20px 80px rgba(15, 23, 42, .18);
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }
    .modal-head h2 { margin: 0; font-size: 16px; }
    .modal-body { padding: 14px; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: var(--surface-soft);
      border-radius: 6px;
      padding: 2px 5px;
    }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      .channel-list { max-height: none; }
    }
    @media (max-width: 680px) {
      .top { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      main { width: min(100vw - 20px, 1440px); }
      .filters, .grid-2, .row-2, .config-note, .capability-grid, .choice-grid { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 1fr; gap: 2px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div class="brand">
        <h1>Channel 管理</h1>
        <p>管理企业微信 Channel、管理员认领、Bot 初始化和文档上下文。</p>
      </div>
      <div class="tools">
        <a href="/admin/global-documents">全局配置</a>
        <a href="/admin/roles">角色管理</a>
        <span class="toast" id="toast">等待操作。</span>
        <button type="button" class="secondary" id="refreshButton">刷新</button>
        <button type="button" id="newChannelButton">新增 Channel</button>
      </div>
    </div>
  </header>
  <main class="layout">
    <section class="panel">
      <div class="panel-head">
        <h2>Channel 列表</h2>
        <span class="subtle" id="channelCount">0 个 Channel</span>
      </div>
      <div class="filters">
        <input id="searchInput" type="search" placeholder="搜索 Bot、企业微信Bot ID、状态">
        <select id="statusFilter" aria-label="筛选运行状态">
          <option value="all">全部状态</option>
          <option value="enabled">运行中</option>
          <option value="missing_secret">缺少 Secret</option>
          <option value="missing_bot_id">未配对</option>
          <option value="failed">认证失败</option>
        </select>
      </div>
      <div class="channel-list" id="channelList"></div>
    </section>
    <section class="panel detail" id="detailPanel">
      <div class="empty">选择左侧 Channel 查看详情。</div>
    </section>
  </main>

  <div class="modal-backdrop" id="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal">
      <div class="modal-head">
        <h2 id="modalTitle">新增 Channel</h2>
        <button type="button" class="secondary" id="closeModalButton">关闭</button>
      </div>
      <div class="modal-body">
        <form id="channelForm" class="form-grid">
          <input name="bot_id" type="hidden">
          <div class="row-2">
            <label>名称<input name="name" required placeholder="PRD Bot"></label>
            <label>LLM<select name="runtime"><option value="kiro">kiro</option><option value="mock">mock</option></select></label>
          </div>
          <label>企业微信Bot ID<input name="wecom_bot_id" required placeholder="企业微信后台的 Bot ID"></label>
          <label>企业微信 Secret<input name="wecom_secret" type="password" autocomplete="new-password" placeholder="新建必填；更新时留空不修改"></label>
          <div class="tools">
            <button type="submit">保存并生成验证码</button>
            <button type="button" class="secondary" id="cancelModalButton">取消</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <script>
    const state = {
      bots: [],
      channels: [],
      details: new Map(),
      selectedChannelId: null,
    };

    const channelList = document.querySelector("#channelList");
    const detailPanel = document.querySelector("#detailPanel");
    const toast = document.querySelector("#toast");
    const channelCount = document.querySelector("#channelCount");
    const searchInput = document.querySelector("#searchInput");
    const statusFilter = document.querySelector("#statusFilter");
    const modalBackdrop = document.querySelector("#modalBackdrop");
    const modalTitle = document.querySelector("#modalTitle");
    const modalBody = document.querySelector(".modal-body");

    const MCP_SCOPES = ["system", "shared", "bot", "user", "session"];
    const MCP_TOOLS = [
      "document.create",
      "document.ingest_file",
      "document.ingest_url",
      "document.scan",
      "memory.write",
      "memory.ingest_file",
      "memory.ingest_url",
      "memory.scan",
      "memory.delete",
      "memory.search",
      "memory.stats",
      "search.query",
    ];

    function setToast(message, isError = false) {
      toast.textContent = message;
      toast.classList.toggle("error", isError);
    }

    async function requestJson(path, options = {}) {
      setToast("请求中");
      const response = await fetch(path, options);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      setToast(response.ok ? "已同步" : "请求失败", !response.ok);
      if (!response.ok) throw payload;
      return payload;
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function badge(text, kind = "warn") {
      return '<span class="badge ' + kind + '">' + escapeHtml(text) + '</span>';
    }

    function statusKind(value) {
      if (value === "ready" || value === "verified" || value === "enabled") return "ok";
      if (value === "failed" || value === "missing_config") return "bad";
      return "warn";
    }

    function channelLabel(channel) {
      if (channel.runtime_status === "enabled") return "运行中";
      if (channel.runtime_status === "missing_secret") return "缺少 Secret";
      if (channel.runtime_status === "missing_bot_id") return "未配对";
      return channel.runtime_status || "未知";
    }

    function createBotId(name) {
      const normalized = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return (normalized || "bot") + "-" + Date.now().toString(36).slice(-6);
    }

    function botName(botId) {
      return state.bots.find((bot) => bot.bot_id === botId)?.name || botId;
    }

    function filteredChannels() {
      const query = searchInput.value.trim().toLowerCase();
      const filter = statusFilter.value;
      return state.channels.filter((channel) => {
        const haystack = [
          channel.bot_id,
          botName(channel.bot_id),
          channel.wecom_bot_id,
          channel.runtime_status,
          channel.connection_status,
        ].join(" ").toLowerCase();
        const matchesQuery = !query || haystack.includes(query);
        const matchesFilter = filter === "all" ||
          channel.runtime_status === filter ||
          filter === "failed" && channel.connection_status === "failed";
        return matchesQuery && matchesFilter;
      });
    }

    function renderList() {
      const channels = filteredChannels();
      channelCount.textContent = channels.length + " 个 Channel";
      if (channels.length === 0) {
        channelList.innerHTML = '<div class="empty"><h2>暂无 Channel</h2><p>新增 Channel 后会保存企业微信配置，并立即生成管理员认领码。</p><button type="button" data-action="empty-new">新增 Channel</button></div>';
        return;
      }
      channelList.innerHTML = channels.map((channel) => {
        const active = channel.channel_id === state.selectedChannelId ? " active" : "";
        return '<button type="button" class="channel-row' + active + '" data-channel-id="' + escapeHtml(channel.channel_id) + '">' +
          '<div>' +
          '<div class="channel-title"><strong>' + escapeHtml(botName(channel.bot_id)) + '</strong>' +
          badge(channelLabel(channel), statusKind(channel.runtime_status)) +
          badge(channel.connection_status || "unchecked", statusKind(channel.connection_status)) +
          '</div>' +
          '<div class="channel-meta">' + escapeHtml(channel.bot_id) + '</div>' +
          '<div class="channel-meta">企业微信Bot ID: ' + escapeHtml(channel.wecom_bot_id || "未配置") + '</div>' +
          '</div>' +
          '<div>' + badge(channel.channel_type || "wecom", "warn") + '</div>' +
          '</button>';
      }).join("");
    }

    function renderDetail(detail) {
      const channel = detail.channel;
      const bot = detail.bot;
      const admin = detail.admin;
      const docs = detail.memory_documents || [];
      const configDocs = detail.config_documents || [];
      const capabilities = detail.mcp_capabilities;
      const soul = configDocs.find((doc) => docTitle(doc) === "soul");
      const agents = configDocs.find((doc) => docTitle(doc) === "agents" || docTitle(doc) === "agents.md");
      const normalDocs = docs.filter((doc) => !isBotConfigDocument(doc));
      const configUpdatedAt = latestTimestamp(configDocs);
      detailPanel.innerHTML = [
        '<div class="hero">',
          '<div class="hero-title"><h2>' + escapeHtml(bot.name) + '</h2>' + badge(channelLabel(channel), statusKind(channel.runtime_status)) + badge(bot.status, statusKind(bot.status)) + '</div>',
          '<div class="subtle">' + escapeHtml(bot.bot_id) + '</div>',
          '<div class="grid-2">',
            metric("企业微信Bot ID", channel.wecom_bot_id || "未配置"),
            metric("管理员", admin?.wecom_user_id || "未认领"),
            metric("认证状态", channel.connection_status || "unchecked"),
            metric("运行状态", channel.runtime_status || "unknown"),
          '</div>',
          '<div class="tools"><button type="button" class="secondary" data-action="edit-channel">编辑配置</button></div>',
        '</div>',
        section("生命周期", lifecycle(channel, bot, admin, configDocs)),
        section("Channel 信息", [
          kv("Channel", channel.channel_type),
          kv("Secret", channel.secret_configured ? "已配置" : "未配置"),
          kv("最近检查", channel.last_check_at || "-"),
          kv("最近错误", channel.last_error || "-"),
        ].join("")),
        sectionWithActions("管理员", [
          kv("管理人", admin?.wecom_user_id || "未认领"),
          kv("认领时间", admin?.claimed_at || "-"),
          '<div id="claimResult"></div>',
        ].join(""), '<button type="button" class="secondary" data-action="reset-admin">重置管理员</button>'),
        sectionWithActions("Bot 初始化", [
          kv("状态", bot.status),
          kv("LLM", bot.runtime),
        ].join(""), '<button type="button" class="secondary" data-action="restart-initialization">重置引导</button>'),
        section("机器人配置", [
          '<div class="config-status">',
            badge(configDocs.length + "/2 已生成", configDocs.length >= 2 ? "ok" : "warn"),
            '<span class="subtle">最近更新：' + escapeHtml(configUpdatedAt || "-") + '</span>',
          '</div>',
          '<div class="config-note">',
            '<div><strong>Soul</strong><span>Soul：机器人是谁，包括身份、性格、沟通风格、价值观和人格边界。</span></div>',
            '<div><strong>Agents</strong><span>Agents：机器人如何工作，包括能力范围、行为规则、任务流程、工具与文档规范。</span></div>',
          '</div>',
          configDocPreview("soul", soul),
          configDocPreview("agents.md", agents),
        ].join("")),
        sectionWithActions("能力状态", renderCapabilities(capabilities), '<button type="button" class="secondary" data-action="edit-capabilities">编辑能力</button>'),
        section("文档", normalDocs.length ? normalDocs.map((doc) => docPreview(doc.title, doc)).join("") : '<div class="subtle">暂无普通文档。</div>'),
        sectionWithActions("危险操作", '<div class="subtle">删除 Channel 会清除企业微信 Bot ID 和 Secret，使 runtime 不再拉起该 Channel；不会删除 Bot、聊天记录、机器人配置或普通文档。</div>', '<button type="button" class="danger" data-action="delete-channel">删除 Channel</button>'),
      ].join("");
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value || "-") + '</strong></div>';
    }

    function kv(label, value) {
      return '<div class="kv"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value || "-") + '</span></div>';
    }

    function section(title, body) {
      return '<section class="section"><div class="section-head"><h3>' + escapeHtml(title) + '</h3></div><div class="section-body">' + body + '</div></section>';
    }

    function sectionWithActions(title, body, actions) {
      return '<section class="section"><div class="section-head"><h3>' + escapeHtml(title) + '</h3><div class="tools">' + actions + '</div></div><div class="section-body">' + body + '</div></section>';
    }

    function lifecycle(channel, bot, admin, docs) {
      const hasConfig = Boolean(channel.wecom_bot_id && channel.secret_configured);
      const hasAdmin = Boolean(admin?.wecom_user_id);
      const hasMemory = docs.some((doc) => docTitle(doc) === "soul") &&
        docs.some((doc) => docTitle(doc) === "agents" || docTitle(doc) === "agents.md");
      const isRunning = channel.runtime_status === "enabled" && bot.status === "ready";
      const steps = [
        { label: "企业微信配置", value: hasConfig ? "Bot ID 和 Secret 已保存" : "需要保存企业微信Bot ID 和 Secret", ok: hasConfig },
        { label: "管理员认领", value: hasAdmin ? admin.wecom_user_id : "等待管理员发送认领码", ok: hasAdmin },
        { label: "Bot 引导", value: hasMemory ? "Soul 和 agents.md 已生成" : "等待管理员逐步回答引导问题", ok: hasMemory },
        { label: "运行状态", value: isRunning ? "已接入消息处理" : (channel.runtime_status || bot.status || "等待"), ok: isRunning },
      ];
      return '<div class="timeline">' + steps.map((step, index) => {
        const kind = step.ok ? "ok" : "warn";
        return '<div class="timeline-step ' + kind + '"><span>' + (index + 1) + '</span><div><strong>' + escapeHtml(step.label) + '</strong><div class="subtle">' + escapeHtml(step.value) + '</div></div></div>';
      }).join("") + '</div>';
    }

    function renderCapabilities(capabilities) {
      if (!capabilities) {
        return '<div class="subtle">能力状态暂未加载。</div>';
      }
      const capability_config = capabilities.capability_config || {};
      const memory = capabilities.memory || {};
      const documents = capabilities.documents || {};
      const tools = capability_config.tools?.enabled || [];
      const readableScopes = capability_config.memory?.readable_scopes || [];
      const writableScopes = capability_config.memory?.writable_scopes || [];
      const directoryRefs = capability_config.directory_refs || [];
      return [
        '<div class="capability-grid">',
          capabilityCard("MCP Tools", tools.length + " 个工具", tools.slice(0, 6).join("、") + (tools.length > 6 ? " 等" : "")),
          capabilityCard("文档能力", documents.count + " 个普通文档", formatTypeStats(documents.by_type)),
          capabilityCard("记忆索引", memory.memories + " 条记忆 / " + memory.chunks + " 个 chunk", "资产 " + memory.assets + "，记忆文档 " + memory.memory_documents),
        '</div>',
        '<div class="chip-list">',
          '<span class="chip">读：' + escapeHtml(readableScopes.join(" / ") || "-") + '</span>',
          '<span class="chip">写：' + escapeHtml(writableScopes.join(" / ") || "-") + '</span>',
          '<span class="chip">目录：' + escapeHtml(directoryRefs.join(" / ") || "未授权") + '</span>',
        '</div>',
      ].join("");
    }

    function capabilityCard(title, value, detail) {
      return '<div class="capability-card"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(value || "-") + '</span><span>' + escapeHtml(detail || "-") + '</span></div>';
    }

    function formatTypeStats(stats) {
      if (!stats || Object.keys(stats).length === 0) return "暂无类型统计";
      return Object.entries(stats)
        .map(([type, count]) => type + " " + count)
        .join("、");
    }

    function docPreview(label, doc) {
      if (!doc) return '<div class="doc-item"><strong>' + escapeHtml(label) + '</strong><div class="subtle">未配置。</div></div>';
      return '<details class="doc-item"><summary>' + escapeHtml(label) + ' · v' + escapeHtml(doc.version) + '</summary>' +
        '<div class="subtle">' + escapeHtml(doc.memory_doc_id || "") + '</div>' +
        '<pre>' + escapeHtml(doc.content || "") + '</pre></details>';
    }

    function configDocPreview(label, doc) {
      if (!doc) return '<div class="doc-item"><strong>' + escapeHtml(label) + '</strong><div class="subtle">未生成。</div></div>';
      return '<details class="doc-item" open><summary>' + escapeHtml(label) + '</summary>' +
        '<div class="subtle">更新时间：' + escapeHtml(doc.updated_at || doc.created_at || "-") + '</div>' +
        '<pre>' + escapeHtml(doc.content || "") + '</pre></details>';
    }

    function docTitle(doc) {
      return String(doc?.title || "").toLowerCase();
    }

    function latestTimestamp(docs) {
      return docs
        .map((doc) => doc.updated_at || doc.created_at)
        .filter(Boolean)
        .sort()
        .at(-1);
    }

    function isBotConfigDocument(doc) {
      const title = docTitle(doc);
      return title === "soul" || title === "agents" || title === "agents.md";
    }

    async function refreshAll(selectChannelId = state.selectedChannelId) {
      const [bots, channels] = await Promise.all([
        requestJson("/v1/bots"),
        requestJson("/v1/bot-channels"),
      ]);
      state.bots = bots;
      state.channels = channels;
      const nextSelected = selectChannelId && channels.some((channel) => channel.channel_id === selectChannelId)
        ? selectChannelId
        : channels[0]?.channel_id || null;
      state.selectedChannelId = nextSelected;
      renderList();
      if (nextSelected) {
        await loadDetail(nextSelected);
      } else {
        detailPanel.innerHTML = '<div class="empty">暂无 Channel。点击右上角新增。</div>';
      }
    }

    async function loadDetail(channelId) {
      state.selectedChannelId = channelId;
      renderList();
      const detail = await requestJson("/v1/bot-channels/" + encodeURIComponent(channelId));
      if (detail?.bot?.bot_id) {
        const botId = encodeURIComponent(detail.bot.bot_id);
        const [configDocuments, mcpCapabilities] = await Promise.all([
          requestJson("/v1/bots/" + botId + "/config-documents"),
          requestJson("/v1/bots/" + botId + "/mcp-capabilities"),
        ]);
        detail.config_documents = configDocuments;
        detail.mcp_capabilities = mcpCapabilities;
      }
      state.details.set(channelId, detail);
      renderDetail(detail);
    }

    function openModal(bot) {
      modalTitle.textContent = bot ? "编辑 Channel" : "新增 Channel";
      modalBody.innerHTML = renderChannelForm();
      const channelForm = document.querySelector("#channelForm");
      channelForm.reset();
      channelForm.elements.bot_id.value = bot?.bot_id || "";
      channelForm.elements.name.value = bot?.name || "";
      channelForm.elements.runtime.value = bot?.runtime || "kiro";
      channelForm.elements.wecom_bot_id.value = bot?.wecom_bot_id || "";
      modalBackdrop.classList.add("open");
      channelForm.elements.name.focus();
    }

    function renderChannelForm() {
      return '<form id="channelForm" class="form-grid">' +
        '<input name="bot_id" type="hidden">' +
        '<div class="row-2">' +
          '<label>名称<input name="name" required placeholder="PRD Bot"></label>' +
          '<label>LLM<select name="runtime"><option value="kiro">kiro</option><option value="mock">mock</option></select></label>' +
        '</div>' +
        '<label>企业微信Bot ID<input name="wecom_bot_id" required placeholder="企业微信后台的 Bot ID"></label>' +
        '<label>企业微信 Secret<input name="wecom_secret" type="password" autocomplete="new-password" placeholder="新建必填；更新时留空不修改"></label>' +
        '<div class="tools">' +
          '<button type="submit">保存并生成验证码</button>' +
          '<button type="button" class="secondary" data-action="modal-cancel">取消</button>' +
        '</div>' +
      '</form>';
    }

    function openCapabilityModal(detail) {
      const config = detail?.mcp_capabilities?.capability_config;
      if (!config) {
        setToast("能力配置尚未加载。", true);
        return;
      }
      modalTitle.textContent = "编辑能力";
      modalBody.innerHTML = renderCapabilityForm(config);
      modalBackdrop.classList.add("open");
      document.querySelector("#capabilityForm input")?.focus();
    }

    function renderCapabilityForm(config) {
      return '<form id="capabilityForm" class="form-grid">' +
        '<fieldset class="field-group"><legend>MCP Tools</legend><div class="choice-grid">' +
          MCP_TOOLS.map((tool) => checkbox("mcp-tool", tool, config.tools?.enabled?.includes(tool))).join("") +
        '</div></fieldset>' +
        '<fieldset class="field-group"><legend>Memory 可读 Scope</legend><div class="choice-grid">' +
          MCP_SCOPES.map((scope) => checkbox("memory-readable-scope", scope, config.memory?.readable_scopes?.includes(scope))).join("") +
        '</div></fieldset>' +
        '<fieldset class="field-group"><legend>Memory 可写 Scope</legend><div class="choice-grid">' +
          MCP_SCOPES.map((scope) => checkbox("memory-writable-scope", scope, config.memory?.writable_scopes?.includes(scope))).join("") +
        '</div></fieldset>' +
        '<fieldset class="field-group"><legend>Document 可写 Scope</legend><div class="choice-grid">' +
          MCP_SCOPES.map((scope) => checkbox("document-writable-scope", scope, config.documents?.writable_scopes?.includes(scope))).join("") +
        '</div></fieldset>' +
        '<label>directory_refs<textarea name="directory_refs" placeholder="每行一个 directory ref">' + escapeHtml((config.directory_refs || []).join("\\n")) + '</textarea></label>' +
        '<div class="tools">' +
          '<button type="submit">保存能力配置</button>' +
          '<button type="button" class="secondary" data-action="modal-cancel">取消</button>' +
        '</div>' +
      '</form>';
    }

    function checkbox(name, value, checked) {
      return '<label><input type="checkbox" name="' + escapeHtml(name) + '" value="' + escapeHtml(value) + '"' + (checked ? " checked" : "") + '> <span>' + escapeHtml(value) + '</span></label>';
    }

    function closeModal() {
      modalBackdrop.classList.remove("open");
    }

    async function createClaimCode(botId) {
      const claim = await requestJson("/v1/bots/" + encodeURIComponent(botId) + "/admin/claims", { method: "POST" });
      const target = document.querySelector("#claimResult");
      if (target) {
        const command = "/claim_admin " + claim.code;
        target.innerHTML = '<div class="claim-card"><div><strong>管理员认领码</strong><div class="subtle">复制后发送给企业微信 Bot。</div></div>' +
          '<code>' + escapeHtml(command) + '</code>' +
          '<div class="tools"><button type="button" class="secondary" data-copy="' + escapeHtml(command) + '">复制认领命令</button></div>' +
          '<div class="subtle">有效期至 ' + escapeHtml(new Date(claim.expires_at).toLocaleString()) + '</div></div>';
      }
      return claim;
    }

    channelList.addEventListener("click", async (event) => {
      const emptyNewButton = event.target.closest("button[data-action='empty-new']");
      if (emptyNewButton) {
        openModal();
        return;
      }
      const row = event.target.closest(".channel-row");
      if (!row) return;
      try { await loadDetail(row.dataset.channelId); } catch (error) { setToast(error.error || "加载失败", true); }
    });

    detailPanel.addEventListener("click", async (event) => {
      const copyButton = event.target.closest("button[data-copy]");
      if (copyButton) {
        try {
          await navigator.clipboard.writeText(copyButton.dataset.copy || "");
          setToast("认领命令已复制。");
        } catch (_error) {
          setToast("复制失败，请手动复制。", true);
        }
        return;
      }
      const button = event.target.closest("button[data-action]");
      if (!button || !state.selectedChannelId) return;
      const detail = state.details.get(state.selectedChannelId);
      const botId = detail?.bot?.bot_id;
      if (!botId) return;
      try {
        if (button.dataset.action === "edit-channel") {
          openModal(detail.bot);
          return;
        }
        if (button.dataset.action === "edit-capabilities") {
          openCapabilityModal(detail);
          return;
        }
        if (button.dataset.action === "reset-admin") {
          const claim = await requestJson("/v1/bots/" + encodeURIComponent(botId) + "/admin/reset", { method: "POST" });
          await loadDetail(state.selectedChannelId);
          const target = document.querySelector("#claimResult");
          if (target) {
            const command = "/claim_admin " + claim.code;
            target.innerHTML = '<div class="claim-card"><div><strong>管理员认领码</strong><div class="subtle">复制后发送给企业微信 Bot。</div></div>' +
              '<code>' + escapeHtml(command) + '</code>' +
              '<div class="tools"><button type="button" class="secondary" data-copy="' + escapeHtml(command) + '">复制认领命令</button></div>' +
              '<div class="subtle">有效期至 ' + escapeHtml(new Date(claim.expires_at).toLocaleString()) + '</div></div>';
          }
          setToast("管理员已重置，新的验证码已生成。");
        }
        if (button.dataset.action === "restart-initialization") {
          await requestJson("/v1/bots/" + encodeURIComponent(botId) + "/initialization/restart", { method: "POST" });
          await refreshAll(state.selectedChannelId);
          setToast("已向管理员发送初始化引导。");
        }
        if (button.dataset.action === "delete-channel") {
          if (!confirm("确认删除这个 Channel 配置？Bot、聊天记录和文档会保留。")) return;
          await requestJson("/v1/bot-channels/" + encodeURIComponent(state.selectedChannelId), { method: "DELETE" });
          await refreshAll(state.selectedChannelId);
          setToast("Channel 已删除。");
        }
      } catch (error) {
        setToast(error.error || "操作失败", true);
      }
    });

    modalBody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='modal-cancel']");
      if (button) closeModal();
    });

    modalBody.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.target.id === "capabilityForm") {
        await submitCapabilityForm(event.target);
        return;
      }
      if (event.target.id !== "channelForm") return;
      const channelForm = event.target;
      const form = Object.fromEntries(new FormData(channelForm).entries());
      const botId = form.bot_id || createBotId(form.name);
      const body = {
        name: form.name,
        runtime: form.runtime,
        wecom_bot_id: form.wecom_bot_id,
      };
      if (form.wecom_secret) body.wecom_secret = form.wecom_secret;
      try {
        const saved = form.bot_id
          ? await requestJson("/v1/bots/" + encodeURIComponent(botId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
          : await requestJson("/v1/bots", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, bot_id: botId }),
          });
        await requestJson("/v1/bots/" + encodeURIComponent(saved.bot_id) + "/wecom/test", { method: "POST" });
        closeModal();
        await refreshAll("wecom:" + saved.bot_id);
        await createClaimCode(saved.bot_id);
        setToast("Channel 已保存，验证码已生成。");
      } catch (error) {
        setToast(error.error || "保存失败", true);
      }
    });

    async function submitCapabilityForm(formElement) {
      if (!state.selectedChannelId) return;
      const detail = state.details.get(state.selectedChannelId);
      const botId = detail?.bot?.bot_id;
      if (!botId) return;
      const currentConfig = detail?.mcp_capabilities?.capability_config || {};
      const formData = new FormData(formElement);
      const payload = {
        actor_id: detail.admin?.wecom_user_id || "system",
        version: currentConfig.version || 1,
        memory: {
          enabled: currentConfig.memory?.enabled !== false,
          readable_scopes: formData.getAll("memory-readable-scope"),
          writable_scopes: formData.getAll("memory-writable-scope"),
        },
        documents: {
          enabled: currentConfig.documents?.enabled !== false,
          writable_scopes: formData.getAll("document-writable-scope"),
        },
        tools: {
          enabled: formData.getAll("mcp-tool"),
        },
        directory_refs: String(formData.get("directory_refs") || "")
          .split(/\\r?\\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      };
      await requestJson("/v1/bots/" + encodeURIComponent(botId) + "/mcp-capabilities/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      closeModal();
      await loadDetail(state.selectedChannelId);
      setToast("能力配置已保存。");
    }

    document.querySelector("#newChannelButton").addEventListener("click", () => openModal());
    document.querySelector("#closeModalButton").addEventListener("click", closeModal);
    document.querySelector("#refreshButton").addEventListener("click", () => refreshAll().catch((error) => setToast(error.error || "刷新失败", true)));
    searchInput.addEventListener("input", renderList);
    statusFilter.addEventListener("change", renderList);

    setInterval(() => {
      if (!state.selectedChannelId || document.hidden) return;
      loadDetail(state.selectedChannelId).catch((error) => setToast(error.error || "刷新失败", true));
    }, 5000);

    refreshAll().catch((error) => setToast(error.error || "加载失败", true));
  </script>
</body>
</html>`;
}
