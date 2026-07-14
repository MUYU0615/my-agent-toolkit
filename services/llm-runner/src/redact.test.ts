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
});
