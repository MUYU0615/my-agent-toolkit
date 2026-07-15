import { describe, expect, it } from "vitest";
import { redactStreamText, redactText } from "./redact.js";

describe("runtime redaction", () => {
  it("preserves stream whitespace while redacting secrets and paths", () => {
    expect(redactStreamText(" first\nsecond /tmp/private.db \n", ["first"]))
      .toBe(" [REDACTED]\nsecond [PATH] \n");
  });

  it("keeps trimmed behavior for completed runtime output", () => {
    expect(redactText("  answer  \n")).toBe("answer");
  });

  it("preserves repository-relative paths while hiding host absolute paths", () => {
    expect(redactText([
      "tests/e2e/imm/test_switch_fixtures.py::TestImmSwitchFixtures::test_snapshot",
      "./e2e_scripts/run_e2e.sh",
      "/Users/example/work/im-test-hub/.env",
    ].join("\n"))).toBe([
      "tests/e2e/imm/test_switch_fixtures.py::TestImmSwitchFixtures::test_snapshot",
      "./e2e_scripts/run_e2e.sh",
      "[PATH]",
    ].join("\n"));
  });

  it("preserves public GitHub URLs", () => {
    expect(redactText("https://github.com/acme/im-test-hub/tree/bot/test-case"))
      .toBe("https://github.com/acme/im-test-hub/tree/bot/test-case");
  });
});
