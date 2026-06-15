const SECRET_PATTERN =
  /\b(?:api[_-]?key|secret|token|authorization|bearer)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-]{32,}\b/g;
const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]/g;
const KIRO_NOISE_PATTERNS = [
  /All tools are now trusted.*\n?/gi,
  /Agents can sometimes do unexpected.*\n?/gi,
  /Learn more at\s*https:\/\/kiro\.dev.*\n?/gi,
  /^\s*▸ Credits:.*\n?/gm,
  /^\s*[>·•] /gm,
];
const KIRO_TOOL_LOG_PATTERNS = [
  /^.*\(using tool: \w+.*\).*\n?/gm,
  /^[✓✗·•].*Completed in.*\n?/gm,
  /^[✓✗·•].*Successfully (?:read|wrote|created|updated|deleted).*\n?/gm,
  /^Reading (?:file|directory):.*\n?/gm,
  /^Writing (?:file|to):.*\n?/gm,
  /^Updating:.*\n?/gm,
  /^Creating:.*\n?/gm,
  /^I'll modify the following file:.*\n?/gm,
  /^\s*\d+,\s*\d+:.*\n?/gm,
  /^[·•]\s*\d+\s*:.*\n?/gm,
  /^·\s+\d+\s+:.*\n?/gm,
];

export function redact(text: string, exactSecrets: string[]): string {
  let output = text;
  output = output.replace(ANSI_PATTERN, "");
  for (const pattern of KIRO_NOISE_PATTERNS) {
    output = output.replace(pattern, "");
  }
  for (const pattern of KIRO_TOOL_LOG_PATTERNS) {
    output = output.replace(pattern, "");
  }
  for (const secret of exactSecrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(SECRET_PATTERN, "[REDACTED]");
  output = output.replace(LONG_TOKEN_PATTERN, "[REDACTED]");
  return output;
}
