import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminStore, hashClaimCode } from "./adminStore.js";

function tempPrivateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-store-"));
}

test("verifyClaim promotes matching code and marks initialization", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));

  const result = store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(result, true);
  const state = store.read();
  assert.equal(state.admin_user_id, "wecom-user-1");
  assert.equal(state.status, "initializing");
  assert.equal(state.claim?.used_at !== null, true);
});

test("verifyClaim rejects expired or wrong codes without setting admin", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(store.verifyClaim("wecom-user-1", "WRONG", new Date("2025-01-01T00:00:00.000Z")), false);
  assert.equal(store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2027-01-01T00:00:00.000Z")), false);
  assert.equal(store.read().admin_user_id, null);
  assert.equal(store.read().status, "unclaimed");
});

test("markReady records initialized_at and ready status", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));
  store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  store.markReady(new Date("2026-01-02T00:00:00.000Z"));

  const state = store.read();
  assert.equal(state.status, "ready");
  assert.equal(state.initialized_at, "2026-01-02T00:00:00.000Z");
});

test("markReady rejects unclaimed store", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);

  assert.throws(() => store.markReady(), {
    message: "Cannot mark ready before admin claim"
  });
  assert.equal(store.read().admin_user_id, null);
  assert.equal(store.read().status, "unclaimed");
});

test("transfer requires target acceptance before expiry", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));
  store.verifyClaim("admin-user", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));
  store.startTransfer("admin-user", "new-admin", new Date("2026-01-01T00:00:00.000Z"), 60);

  assert.equal(store.acceptTransfer("wrong-user", new Date("2026-01-01T00:00:10.000Z")), false);
  assert.equal(store.acceptTransfer("new-admin", new Date("2026-01-01T00:00:10.000Z")), true);
  assert.equal(store.read().admin_user_id, "new-admin");
  assert.equal(store.read().pending_transfer, null);
});

test("hashClaimCode is deterministic and does not equal the plain code", () => {
  assert.equal(hashClaimCode("CODE"), hashClaimCode("CODE"));
  assert.notEqual(hashClaimCode("CODE"), "CODE");
});

test("write creates private directory with owner-only permissions", () => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-store-parent-"));
  const privateDir = path.join(parentDir, "private");
  const store = new AdminStore(privateDir);

  store.write(store.read());

  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
});

test("read rejects malformed admin state instead of resetting", () => {
  const privateDir = tempPrivateDir();
  const adminPath = path.join(privateDir, "admin.json");
  fs.writeFileSync(adminPath, "{\"admin_user_id\":", { mode: 0o600 });
  const store = new AdminStore(privateDir);

  assert.throws(
    () => store.read(),
    {
      message: new RegExp(`^Invalid admin state file: ${adminPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
    }
  );
});
