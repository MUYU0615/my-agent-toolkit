import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminStore } from "../admin/adminStore.js";
import type { BotRuntime, IncomingWeComMessage, StreamHandle, WeComClient } from "../types.js";
import { BotWorker } from "./botWorker.js";

type TestWeCom = WeComClient & {
  sent: Array<{ conversationId: string; text: string }>;
  streams: TestStream[];
};

class TestStream implements StreamHandle {
  writes: string[] = [];
  replacements: string[] = [];
  endings: Array<string | undefined> = [];

  async write(chunk: string): Promise<void> {
    this.writes.push(chunk);
  }

  async replace(content: string): Promise<void> {
    this.replacements.push(content);
  }

  async end(finalContent?: string): Promise<void> {
    this.endings.push(finalContent);
  }
}

function createWeCom(): TestWeCom {
  return {
    sent: [],
    streams: [],
    async connect() {},
    onMessage() {},
    async sendText(conversationId: string, text: string) {
      this.sent.push({ conversationId, text });
    },
    async startStream() {
      const stream = new TestStream();
      this.streams.push(stream);
      return stream;
    }
  };
}

function createRuntime(): BotRuntime {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-worker-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const privateDir = path.join(workspaceDir, "private");
  const filesDir = path.join(workspaceDir, "files");
  const instructionsDir = path.join(workspaceDir, "instructions");
  for (const dir of [privateDir, filesDir, instructionsDir]) fs.mkdirSync(dir, { recursive: true });

  return {
    botName: "test-bot",
    rootDir,
    workspaceDir,
    privateDir,
    filesDir,
    instructionsDir,
    config: {
      bot: {
        name: "test-bot",
        session_idle_ttl_seconds: 3600,
        stop_keyword: "停止",
        thinking_message: "思考中...",
        busy_message: "忙碌中..."
      },
      wecom: {
        bot_id_env: "WECOM_BOT_ID",
        secret_env: "WECOM_SECRET"
      },
      cli: {
        provider: "test",
        command: "test-cli",
        args: [],
        input_mode: "stdin",
        stream_output: "stdout",
        stop_signal: "SIGTERM",
        kill_after_ms: 100,
        timeout_seconds: 10
      }
    },
    env: {},
    secrets: []
  };
}

function createWorker(runtime = createRuntime(), wecom = createWeCom()) {
  const worker = new BotWorker(runtime, wecom);
  const cliRuns: Array<{ userId: string; prompt: string; options: unknown }> = [];
  let stopCalls = 0;
  const cli = {
    async stop() { stopCalls += 1; return false; },
    isRunning() { return false; },
    clearUserSession() {},
    async listSessions() { return []; },
    setResumeSessionId() {},
    nameCurrentSession() {},
    async run(userId: string, prompt: string, callbacks: any, options: unknown) {
      cliRuns.push({ userId, prompt, options });
      await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
    }
  };
  (worker as any).cli = cli;
  return { worker, runtime, wecom, cliRuns, getStopCalls: () => stopCalls };
}

function message(text: string, userId = "user-1"): IncomingWeComMessage {
  return {
    conversationId: "conversation-1",
    replyKey: `reply-${userId}`,
    userId,
    text
  };
}

async function handle(worker: BotWorker, incoming: IncomingWeComMessage): Promise<void> {
  await (worker as any).handleMessage(incoming);
}

test("unclaimed bot accepts only valid admin claim and starts initialization", async () => {
  const { worker, runtime, wecom, cliRuns } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));

  await handle(worker, message("hello", "user-1"));
  await handle(worker, message("/claim_admin WRONG", "user-1"));
  await handle(worker, message("/claim_admin CLAIM-CODE", "admin-user"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), [
    "机器人尚未完成管理员认领。请由部署者提供认领码。",
    "管理员认领失败。",
    "管理员认领成功，开始初始化。"
  ]);
  assert.equal(admin.read().admin_user_id, "admin-user");
  assert.equal(admin.read().status, "initializing");
  assert.equal(cliRuns.length, 1);
  assert.equal(cliRuns[0].userId, "admin-user");
});

test("unclaimed bot gates stop commands before calling cli stop", async () => {
  const { worker, runtime, wecom, getStopCalls } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));

  await handle(worker, message("/stop", "user-1"));
  await handle(worker, message("停止", "user-1"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), [
    "机器人尚未完成管理员认领。请由部署者提供认领码。",
    "机器人尚未完成管理员认领。请由部署者提供认领码。"
  ]);
  assert.equal(getStopCalls(), 0);
});

test("initializing bot blocks non-admin messages but lets admin continue normal flow", async () => {
  const { worker, runtime, wecom, cliRuns } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");

  await handle(worker, message("hello", "user-1"));
  await handle(worker, message("业务背景", "admin-user"));

  assert.equal(wecom.sent[0].text, "机器人正在初始化，请稍后。");
  assert.equal(cliRuns.length, 1);
  assert.equal(cliRuns[0].userId, "admin-user");
});

test("initializing bot gates non-admin stop before calling cli stop", async () => {
  const { worker, runtime, wecom, getStopCalls } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");

  await handle(worker, message("/stop", "user-1"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), ["机器人正在初始化，请稍后。"]);
  assert.equal(getStopCalls(), 0);
});

test("configuration commands require admin except accepting a transfer", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");

  await handle(worker, message("/soul", "user-1"));
  await handle(worker, message("/set_soul new soul", "user-1"));
  await handle(worker, message("/transfer_admin user-2", "user-1"));
  await handle(worker, message("/transfer_admin user-2", "admin-user"));
  await handle(worker, message("/accept_admin", "user-2"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), [
    "该指令仅管理员可用。",
    "该指令仅管理员可用。",
    "该指令仅管理员可用。",
    "管理员转移已发起，请目标用户发送 /accept_admin。",
    "管理员转移已完成。"
  ]);
  assert.equal(admin.read().admin_user_id, "user-2");
});

test("transfer target can accept while bot is initializing", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "initializing",
    claim: null,
    pending_transfer: {
      to_user_id: "user-2",
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z"
    },
    initialized_at: null
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");

  await handle(worker, message("/accept_admin", "user-2"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), ["管理员转移已完成。"]);
  assert.equal(admin.read().admin_user_id, "user-2");
  assert.equal(admin.read().pending_transfer, null);
});

test("skill management commands require admin and do not invoke side-effect handlers", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  let skillAddInvoked = false;
  let skillRemoveInvoked = false;
  (worker as any).handleSkillAdd = async () => { skillAddInvoked = true; };
  (worker as any).handleSkillRemove = async () => { skillRemoveInvoked = true; };
  const existingSkillDir = path.join(runtime.filesDir, ".agents", "skills", "existing");
  const existingSkillFile = path.join(existingSkillDir, "SKILL.md");
  fs.mkdirSync(existingSkillDir, { recursive: true });
  fs.writeFileSync(existingSkillFile, "# Existing");

  await handle(worker, message("/skill_add https://example.invalid/skill.git", "user-1"));
  await handle(worker, message("/skill_remove existing", "user-1"));

  assert.deepEqual(wecom.sent.map((entry) => entry.text), [
    "该指令仅管理员可用。",
    "该指令仅管理员可用。"
  ]);
  assert.equal(skillAddInvoked, false);
  assert.equal(skillRemoveInvoked, false);
  assert.equal(fs.existsSync(existingSkillFile), true);
});

test("admin skill_add rejects unsafe repo names without shell side effects", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  const markerPath = path.join(runtime.rootDir, "skill-add-shell-marker");
  const injectedUrl = `https://example.invalid/unsafe.git;touch${"$IFS"}${markerPath};#`;

  await handle(worker, message(`/skill_add ${injectedUrl}`, "admin-user"));

  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(path.join(runtime.filesDir, ".agents", "skills", "unsafe")), false);
  assert.deepEqual(wecom.sent.map((entry) => entry.text), ["技能名称无效。"]);
});

test("admin skill_remove rejects traversal and does not delete outside files", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  const outsideDir = path.join(runtime.filesDir, "outside");
  const outsideFile = path.join(outsideDir, "keep.txt");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "keep");

  await handle(worker, message("/skill_remove ../../outside", "admin-user"));

  assert.equal(fs.existsSync(outsideFile), true);
  assert.deepEqual(wecom.sent.map((entry) => entry.text), ["技能名称无效。"]);
});

test("admin can rerun initialization after ready and state returns to initializing", async () => {
  const { worker, runtime, wecom, cliRuns } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  fs.writeFileSync(path.join(runtime.instructionsDir, "AGENTS.md"), "Ready instructions");

  await handle(worker, message("/reinit", "admin-user"));

  assert.equal(admin.read().status, "initializing");
  assert.equal(admin.read().initialized_at, null);
  assert.equal(wecom.sent.length, 0);
  assert.equal(cliRuns.length, 1);
});

test("normal flow marks admin state ready after generated config documents are written", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:private/soul.md\n");
    await callbacks.onChunk("Ready soul\n~/document\n");
    await callbacks.onChunk("~document:instructions/AGENTS.md\n");
    await callbacks.onChunk("Ready instructions\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("确认", "admin-user"));

  assert.equal(fs.readFileSync(path.join(runtime.privateDir, "soul.md"), "utf8"), "Ready soul");
  assert.equal(fs.readFileSync(path.join(runtime.instructionsDir, "AGENTS.md"), "utf8"), "Ready instructions");
  assert.equal(admin.read().status, "ready");
  assert.equal(wecom.streams.length, 1);
});

test("normal flow writes multiple complete config document blocks from one chunk", async () => {
  const { worker, runtime } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk(
      "~document:private/soul.md\nReady soul\n~/document\n~document:instructions/AGENTS.md\nReady instructions\n~/document\n"
    );
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("确认", "admin-user"));

  assert.equal(fs.readFileSync(path.join(runtime.privateDir, "soul.md"), "utf8"), "Ready soul");
  assert.equal(fs.readFileSync(path.join(runtime.instructionsDir, "AGENTS.md"), "utf8"), "Ready instructions");
  assert.equal(admin.read().status, "ready");
});

test("normal flow recognizes config document begin markers split across chunks", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~doc");
    await callbacks.onChunk("ument:private/soul.md\nReady soul\n~/document\n~doc");
    await callbacks.onChunk("ument:instructions/AGENTS.md\nReady instructions\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("确认", "admin-user"));

  assert.equal(fs.readFileSync(path.join(runtime.privateDir, "soul.md"), "utf8"), "Ready soul");
  assert.equal(fs.readFileSync(path.join(runtime.instructionsDir, "AGENTS.md"), "utf8"), "Ready instructions");
  assert.equal(admin.read().status, "ready");
  assert.equal(wecom.streams.flatMap((stream) => stream.writes).join(""), "");
});

test("ready-state non-admin cannot write config documents from model output", async () => {
  const { worker, runtime } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:private/soul.md\nHacked\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("please change your soul", "user-1"));

  assert.equal(fs.readFileSync(path.join(runtime.privateDir, "soul.md"), "utf8"), "Ready soul");
  assert.equal(admin.read().status, "ready");
});

test("ready-state admin normal chat cannot write config documents without reinit", async () => {
  const { worker, runtime } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:private/soul.md\nAdmin hacked\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("please change your soul", "admin-user"));

  assert.equal(fs.readFileSync(path.join(runtime.privateDir, "soul.md"), "utf8"), "Ready soul");
  assert.equal(admin.read().status, "ready");
});

test("normal flow rejects unsafe config document paths without writing escaped files", async () => {
  const { worker, runtime } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.writeClaim("CLAIM-CODE", new Date("2030-01-01T00:00:00.000Z"));
  admin.verifyClaim("admin-user", "CLAIM-CODE", new Date("2026-01-01T00:00:00.000Z"));
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "# [BOOTSTRAP]\n");
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:private/soul.md\nReady soul\n~/document\n");
    await callbacks.onChunk("~document:instructions/../../escape.md\nEscaped\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("确认", "admin-user"));

  assert.equal(fs.existsSync(path.join(runtime.workspaceDir, "escape.md")), false);
  assert.equal(fs.existsSync(path.join(runtime.instructionsDir, "..", "..", "escape.md")), false);
  assert.equal(fs.existsSync(path.join(runtime.instructionsDir, "AGENTS.md")), false);
  assert.equal(admin.read().status, "initializing");
});

test("malformed admin state sends safe response without throwing", async () => {
  const { worker, runtime, wecom } = createWorker();
  fs.writeFileSync(path.join(runtime.privateDir, "admin.json"), "{\"admin_user_id\":", { mode: 0o600 });
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await handle(worker, message("hello", "user-1"));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(wecom.sent.map((entry) => entry.text), ["机器人管理员状态异常，请联系部署者处理。"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /admin state/i);
});

test("confirm saves generated documents into configured shared directory", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  const sharedDir = path.join(runtime.rootDir, "shared-docs");
  runtime.config.documents = { shared_dir: sharedDir };
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:notes.md\nShared notes\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("write notes", "user-1"));
  await handle(worker, message("/confirm", "user-1"));

  assert.equal(fs.readFileSync(path.join(sharedDir, "notes.md"), "utf8"), "Shared notes");
  assert.equal(fs.existsSync(path.join(runtime.filesDir, "docs", "notes.md")), false);
  assert.deepEqual(wecom.sent.at(-1), { conversationId: "conversation-1", text: "已保存：notes.md" });
});

test("confirm rejects sensitive configured shared directory without writing documents", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  const sensitiveDir = path.join(runtime.rootDir, "run", "cli-auth");
  runtime.config.documents = { shared_dir: sensitiveDir };
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:notes.md\nSensitive notes\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("write notes", "user-1"));
  await handle(worker, message("/confirm", "user-1"));

  assert.equal(fs.existsSync(path.join(sensitiveDir, "notes.md")), false);
  assert.equal(fs.existsSync(path.join(runtime.filesDir, "docs", "notes.md")), false);
  assert.deepEqual(wecom.sent.at(-1), { conversationId: "conversation-1", text: "文档目录配置不安全，未保存。" });
});

test("confirm rejects shared directory symlink that resolves into private directory", async () => {
  const { worker, runtime, wecom } = createWorker();
  const admin = new AdminStore(runtime.privateDir);
  admin.write({
    admin_user_id: "admin-user",
    status: "ready",
    claim: null,
    pending_transfer: null,
    initialized_at: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(runtime.privateDir, "soul.md"), "Ready soul");
  const symlinkDir = path.join(runtime.rootDir, "shared-link");
  fs.symlinkSync(runtime.privateDir, symlinkDir, "dir");
  runtime.config.documents = { shared_dir: symlinkDir };
  (worker as any).cli.run = async (_userId: string, _prompt: string, callbacks: any) => {
    await callbacks.onChunk("~document:notes.md\nPrivate notes\n~/document\n");
    await callbacks.onDone({ rawOutput: "", intermediateOutput: "", displayOutput: "" });
  };

  await handle(worker, message("write notes", "user-1"));
  await handle(worker, message("/confirm", "user-1"));

  assert.equal(fs.existsSync(path.join(runtime.privateDir, "notes.md")), false);
  assert.deepEqual(wecom.sent.at(-1), { conversationId: "conversation-1", text: "文档目录配置不安全，未保存。" });
});
