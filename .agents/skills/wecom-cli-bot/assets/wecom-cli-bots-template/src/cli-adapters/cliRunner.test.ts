import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedProvider } from "./cliRunner.js";

test("assertSupportedProvider accepts kiro-cli", () => {
  assert.doesNotThrow(() => assertSupportedProvider("kiro-cli"));
});

test("assertSupportedProvider rejects codex with a clear unsupported-provider error", () => {
  assert.throws(() => assertSupportedProvider("codex"), {
    message: "Unsupported CLI provider: codex. Current implementation supports only kiro-cli."
  });
});
