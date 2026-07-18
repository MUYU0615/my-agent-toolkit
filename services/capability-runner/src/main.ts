import { createServer } from "node:http";
import { createCapabilityRunnerServer } from "./server.js";
import { createSkillManager } from "./skillManager.js";
import { createProjectManager } from "./projectManager.js";

const port = Number.parseInt(process.env.PORT ?? "8400", 10);
const skillManager = createSkillManager({
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  kiroWorkspaceRoot: process.env.KIRO_WORKSPACE_ROOT ?? "/kiro-workspaces",
  skillCatalogRoot: process.env.SKILL_CATALOG_ROOT ?? "/skill-catalog",
});
const projectManager = createProjectManager({
  dataServiceUrl: process.env.DATA_SERVICE_URL ?? "http://data-service:8300",
  userCredentialsInternalToken: process.env.USER_CREDENTIALS_INTERNAL_TOKEN,
  kiroWorkspaceRoot: process.env.KIRO_WORKSPACE_ROOT ?? "/kiro-workspaces",
});
const app = createCapabilityRunnerServer({
  dispatch: (context) => skillManager.dispatch(context),
  listSkills: () => skillManager.listCatalog(),
  syncProject: (context) => projectManager.sync(context),
  publishProject: (context) => projectManager.publish(context),
  publishJiraProject: (context) => projectManager.publishJira(context),
  projectRunnerToken: process.env.MCP_RUNNER_SECRET,
});

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });

    const response = await app.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal error";
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`capability-runner listening on ${port}`);
});
