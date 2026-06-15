import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { redact } from "../security/redact.js";

export type RunCallbacks = {
  onChunk(chunk: string): Promise<void>;
  onDone(result: RunResult): Promise<void>;
  onError(error: Error): Promise<void>;
};

export type RunResult = {
  rawOutput: string;
  intermediateOutput: string;
  displayOutput: string;
  kimiSessionId?: string;
  kiroSessionId?: string;
};

export type RunOptions = {
  resumeSessionId?: string;
  userMessage?: string;
  useWorkspaceCwd?: boolean;
};

export type KiroSession = {
  id: string;
  time: string;
  preview: string;
  name?: string;
  firstMessage?: string;
};

const ANSI_STRIP = /\x1B\[[0-9;?]*[A-Za-z]/g;

export class CliRunner {
  private active = new Map<string, ChildProcessWithoutNullStreams>();
  private userHasSession = new Set<string>();
  private userResumeId = new Map<string, string>();
  private sessionNames = new Map<string, Map<string, string>>(); // userId -> (sessionId -> name)
  private sessionFirstMsg = new Map<string, Map<string, string>>(); // userId -> (sessionId -> firstMsg)

  constructor(private runtime: BotRuntime) {}

  isRunning(userId: string): boolean {
    return this.active.has(userId);
  }

  private getUserCwd(userId: string): string {
    const cwd = path.join(this.runtime.filesDir, ".kiro-sessions", sanitizeSegment(userId));
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  private getNamesFile(userId: string): string {
    return path.join(this.getUserCwd(userId), "session-names.json");
  }

  private loadNames(userId: string): Map<string, string> {
    if (this.sessionNames.has(userId)) return this.sessionNames.get(userId)!;
    const file = this.getNamesFile(userId);
    let names = new Map<string, string>();
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        names = new Map(Object.entries(data));
      } catch {}
    }
    this.sessionNames.set(userId, names);
    return names;
  }

  private saveNames(userId: string): void {
    const names = this.sessionNames.get(userId);
    if (!names) return;
    fs.writeFileSync(this.getNamesFile(userId), JSON.stringify(Object.fromEntries(names)));
  }

  private getMetaFile(userId: string): string {
    return path.join(this.getUserCwd(userId), "session-first-msgs.json");
  }

  private loadFirstMsgs(userId: string): Map<string, string> {
    if (this.sessionFirstMsg.has(userId)) return this.sessionFirstMsg.get(userId)!;
    const file = this.getMetaFile(userId);
    let msgs = new Map<string, string>();
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        msgs = new Map(Object.entries(data));
      } catch {}
    }
    this.sessionFirstMsg.set(userId, msgs);
    return msgs;
  }

  private saveFirstMsg(userId: string, sessionId: string, message: string): void {
    const msgs = this.loadFirstMsgs(userId);
    if (!msgs.has(sessionId)) {
      msgs.set(sessionId, message.slice(0, 60));
      fs.writeFileSync(this.getMetaFile(userId), JSON.stringify(Object.fromEntries(msgs)));
    }
  }

  async listSessions(userId: string): Promise<KiroSession[]> {
    const cwd = this.getUserCwd(userId);
    const env = { ...process.env, ...this.runtime.env, ...resolveRelativeEnv(this.runtime.rootDir, this.runtime.config.cli.env ?? {}) };
    try {
      const raw = execSync("kiro-cli chat --list-sessions 2>&1", { cwd, env, encoding: "utf8" as const, timeout: 10000, shell: "/bin/sh" });
      const clean = raw.replace(ANSI_STRIP, "");
      const names = this.loadNames(userId);
      const sessions: KiroSession[] = [];
      const regex = /Chat SessionId:\s*([a-f0-9-]{36})\s*\n\s*(.+?)\s*\|.*?\|\s*(\d+\s*msgs)\s*\|/gm;
      let match;
      while ((match = regex.exec(clean)) !== null) {
        const firstMsgs = this.loadFirstMsgs(userId);
        sessions.push({
          id: match[1],
          time: match[2].trim(),
          preview: match[3].trim(),
          name: names.get(match[1]),
          firstMessage: firstMsgs.get(match[1])
        });
      }
      return sessions;
    } catch {
      return [];
    }
  }

  clearUserSession(userId: string): void {
    this.userHasSession.delete(userId);
    this.userResumeId.delete(userId);
  }

  setResumeSessionId(userId: string, sessionId: string): void {
    this.userResumeId.set(userId, sessionId);
    this.userHasSession.add(userId);
  }

  nameCurrentSession(userId: string, name: string): void {
    const names = this.loadNames(userId);
    // Name the most recent session
    const cwd = this.getUserCwd(userId);
    const env = { ...process.env, ...this.runtime.env, ...resolveRelativeEnv(this.runtime.rootDir, this.runtime.config.cli.env ?? {}) };
    try {
      const raw = execSync("kiro-cli chat --list-sessions 2>&1", { cwd, env, encoding: "utf8" as const, timeout: 10000, shell: "/bin/sh" });
      const clean = raw.replace(ANSI_STRIP, "");
      const match = clean.match(/Chat SessionId:\s*([a-f0-9-]{36})/);
      if (match) {
        names.set(match[1], name);
        this.saveNames(userId);
      }
    } catch {}
  }

  async stop(userId: string): Promise<boolean> {
    const child = this.active.get(userId);
    if (!child) return false;
    child.kill(this.runtime.config.cli.stop_signal);
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, this.runtime.config.cli.kill_after_ms).unref();
    return true;
  }

  async run(userId: string, prompt: string, callbacks: RunCallbacks, options: RunOptions = {}): Promise<void> {
    if (this.active.has(userId)) throw new Error("Task already running for user");

    const cli = this.runtime.config.cli;
    const env = {
      ...process.env,
      ...this.runtime.env,
      ...resolveRelativeEnv(this.runtime.rootDir, cli.env ?? {})
    };

    const args = buildArgs(cli.args ?? [], prompt, cli.prompt_placeholder ?? "{{prompt}}");
    if (options.resumeSessionId && cli.provider === "kimi-code") {
      args.splice(0, 0, "-r", options.resumeSessionId);
    }

    let cwd = this.runtime.filesDir;
    if (cli.provider === "kiro-cli") {
      if (options.useWorkspaceCwd) {
        cwd = this.runtime.workspaceDir;
      } else {
        cwd = this.runtime.filesDir;
      }
      const explicitId = this.userResumeId.get(userId);
      if (explicitId) {
        // Resume a specific session chosen by user via /open
        const chatIdx = args.indexOf("chat");
        args.splice(chatIdx + 1, 0, "--resume-id", explicitId);
        this.userResumeId.delete(userId);
      } else if (options.resumeSessionId && this.userHasSession.has(userId)) {
        const chatIdx = args.indexOf("chat");
        args.splice(chatIdx + 1, 0, "--resume");
      }
    }

    console.log(`[cli] starting provider=${cli.provider} command=${cli.command} args=${JSON.stringify(redactArgs(args))}`);
    const child = spawn(cli.command, args, {
      cwd,
      env,
      stdio: "pipe"
    });

    this.active.set(userId, child);
    let output = "";
    const timeout = setTimeout(() => child.kill(cli.stop_signal), cli.timeout_seconds * 1000);

    child.stdout.on("data", async (data: Buffer) => {
      const chunk = data.toString("utf8");
      output += chunk;
      await callbacks.onChunk(redact(chunk, this.runtime.secrets));
    });

    child.stderr.on("data", async (data: Buffer) => {
      const chunk = data.toString("utf8");
      output += chunk;
      await callbacks.onChunk(redact(chunk, this.runtime.secrets));
    });

    child.on("error", async (error) => {
      clearTimeout(timeout);
      this.active.delete(userId);
      await callbacks.onError(error);
    });

    child.on("close", async () => {
      clearTimeout(timeout);
      this.active.delete(userId);
      let result: RunResult;
      if (cli.provider === "kimi-code") {
        result = parseKimiOutput(output);
      } else if (cli.provider === "kiro-cli") {
        result = parseKiroOutput(output);
        if (!this.userHasSession.has(userId) && options.userMessage) {
          // New session - get its ID from list-sessions (most recent) and save first message
          const sessionsNow = await this.listSessions(userId);
          if (sessionsNow.length > 0) {
            this.saveFirstMsg(userId, sessionsNow[0].id, options.userMessage);
          }
        }
        this.userHasSession.add(userId);
      } else {
        result = { rawOutput: output, intermediateOutput: output, displayOutput: output };
      }
      console.log(`[cli] completed provider=${cli.provider} user=${userId} session=${result.kimiSessionId ?? result.kiroSessionId ?? "resumed"}`);
      await callbacks.onDone(result);
    });

    if (cli.input_mode === "stdin") {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  }
}

function buildArgs(args: string[], prompt: string, placeholder: string): string[] {
  return args.map((arg) => (arg === placeholder ? prompt : arg));
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => (arg.length > 240 ? `${arg.slice(0, 240)}...` : arg));
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseKimiOutput(output: string): RunResult {
  const sessionMatch = output.match(/To resume this session:\s*kimi\s+-r\s+(session_[a-z0-9-]+)/i);
  const kimiSessionId = sessionMatch?.[1];
  const withoutResume = output
    .split(/\r?\n/)
    .filter((line) => !/^\s*To resume this session:/i.test(line))
    .filter((line) => !/^\s*kimi\s+-r\s+/i.test(line))
    .join("\n")
    .trim();
  const displayOutput = extractFinalAnswer(withoutResume);
  return { rawOutput: output, intermediateOutput: withoutResume, displayOutput, kimiSessionId };
}

function extractFinalAnswer(output: string): string {
  const bulletMatches = [...output.matchAll(/^•\s*([\s\S]*?)(?=^•\s|\s*$)/gm)];
  const lastBullet = bulletMatches.at(-1)?.[1]?.trim();
  return lastBullet || output;
}

function parseKiroOutput(output: string): RunResult {
  const displayOutput = output
    .split(/\r?\n/)
    .filter((line) => !/All tools are now trusted/i.test(line))
    .filter((line) => !/Agents can sometimes do unexpected/i.test(line))
    .filter((line) => !/Learn more at/i.test(line))
    .filter((line) => !/^\s*▸ Credits:/i.test(line))
    .join("\n")
    .trim();
  return { rawOutput: output, intermediateOutput: displayOutput, displayOutput, kiroSessionId: "active" };
}

function resolveRelativeEnv(rootDir: string, env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.startsWith("./") ? path.resolve(rootDir, value) : value;
    if (key.endsWith("_HOME")) fs.mkdirSync(resolved[key], { recursive: true });
  }
  return resolved;
}
