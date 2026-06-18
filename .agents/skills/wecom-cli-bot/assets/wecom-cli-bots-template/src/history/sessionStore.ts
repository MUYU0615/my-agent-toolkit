import fs from "node:fs";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { assertInside } from "../security/pathFence.js";

export type Session = {
  id: string;
  userId: string;
  path: string;
  lastMessageAt: number;
  kiroSessionId?: string;
};

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private runtime: BotRuntime) {}

  getOrCreate(userId: string): Session {
    const now = Date.now();
    const ttlMs = this.runtime.config.bot.session_idle_ttl_seconds * 1000;
    const existing = this.sessions.get(userId);
    if (existing && now - existing.lastMessageAt <= ttlMs) {
      existing.lastMessageAt = now;
      return existing;
    }

    const id = new Date(now).toISOString().replace(/[:.]/g, "-");
    const historyDir = assertInside(
      this.runtime.workspaceDir,
      path.join(this.runtime.privateDir, "history", sanitizeSegment(userId))
    );
    fs.mkdirSync(historyDir, { recursive: true });
    const session: Session = {
      id,
      userId,
      lastMessageAt: now,
      path: assertInside(this.runtime.workspaceDir, path.join(historyDir, `${id}.jsonl`))
    };
    this.sessions.set(userId, session);
    return session;
  }

  expire(userId: string): void {
    this.sessions.delete(userId);
  }

  restoreWithKiroSession(userId: string, kiroSessionId: string): void {
    const session = this.getOrCreate(userId);
    session.kiroSessionId = kiroSessionId;
    this.append(session, { role: "system", event: "kiro_session_restored", kiroSessionId });
  }

  append(session: Session, entry: Record<string, unknown>): void {
    fs.appendFileSync(session.path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  }

  setKiroSessionId(session: Session, kiroSessionId: string): void {
    session.kiroSessionId = kiroSessionId;
    this.append(session, { role: "system", event: "kiro_session", kiroSessionId });
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
