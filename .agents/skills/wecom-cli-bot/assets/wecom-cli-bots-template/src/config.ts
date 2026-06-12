import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import type { BotConfig, BotRuntime } from "./types.js";
import { assertInside } from "./security/pathFence.js";

export function loadRuntime(rootDir: string, botName: string): BotRuntime {
  const workspaceDir = path.resolve(rootDir, "bots", botName, "workspace");
  const privateDir = assertInside(workspaceDir, path.join(workspaceDir, "private"));
  const filesDir = assertInside(workspaceDir, path.join(workspaceDir, "files"));
  const instructionsDir = assertInside(workspaceDir, path.join(workspaceDir, "instructions"));
  const envPath = assertInside(workspaceDir, path.join(privateDir, ".env"));
  const configPath = assertInside(workspaceDir, path.join(privateDir, "bot.config.yaml"));

  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as BotConfig;
  const secrets = Object.values(env).filter((value) => value.trim().length >= 8);

  return {
    botName,
    rootDir,
    workspaceDir,
    privateDir,
    filesDir,
    instructionsDir,
    config,
    env,
    secrets
  };
}
