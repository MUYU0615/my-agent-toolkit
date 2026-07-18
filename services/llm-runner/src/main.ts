import { createLlmRunnerServer } from "./server.js";
import { createLlmRunnerNodeServer } from "./nodeServer.js";

const port = Number.parseInt(process.env.PORT ?? "8200", 10);
const app = createLlmRunnerServer();

createLlmRunnerNodeServer(port, app);
