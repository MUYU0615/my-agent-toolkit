import { createServer } from "node:http";
import { createDataServiceServer } from "./server.js";
import { createSqliteDataStore, seedDefaultRoleConfig } from "./sqliteStore.js";
import { createWeComSdkVerifier } from "./wecomVerifier.js";
import { createCredentialVault } from "./credentialVault.js";

const port = Number.parseInt(process.env.PORT ?? "8300", 10);
const wecomVerifier = createWeComSdkVerifier();
const store = process.env.DATA_SERVICE_DB_PATH
  ? createSqliteDataStore(process.env.DATA_SERVICE_DB_PATH, { wecomVerifier })
  : undefined;
if (store) {
  seedDefaultRoleConfig(store);
}
const credentialMasterKey = process.env.USER_CREDENTIALS_MASTER_KEY?.trim();
const app = createDataServiceServer(store, {
  ...(credentialMasterKey
    ? { credentialVault: createCredentialVault(credentialMasterKey) }
    : {}),
  ...(process.env.USER_CREDENTIALS_INTERNAL_TOKEN?.trim()
    ? { credentialInternalToken: process.env.USER_CREDENTIALS_INTERNAL_TOKEN.trim() }
    : {}),
  ...(process.env.DATA_SERVICE_INTERNAL_TOKEN?.trim()
    ? { internalServiceToken: process.env.DATA_SERVICE_INTERNAL_TOKEN.trim() }
    : {}),
});

const server = createServer(async (req, res) => {
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
});

server.listen(port, "0.0.0.0", () => {
  console.log(`data-service listening on ${port}`);
});
