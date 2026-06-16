const SECRET_PATTERN =
  /\b(?:api[_-]?key|secret|token|authorization|bearer)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-]{32,}\b/g;
const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]/g;
// Framework-level noise that no CLI should output to users
const FRAMEWORK_NOISE = [
  /All tools are now trusted.*\n?/gi,
  /Agents can sometimes do unexpected.*\n?/gi,
  /Learn more at\s*https:\/\/kiro\.dev.*\n?/gi,
  /^\s*▸ Credits:.*$/gm,
  /^> /gm,
];

export function redact(text: string, exactSecrets: string[]): string {
  let output = text;
  // Strip ANSI escape codes
  output = output.replace(ANSI_PATTERN, "");
  // Strip framework noise
  for (const pattern of FRAMEWORK_NOISE) {
    output = output.replace(pattern, "");
  }
  // Clean excessive blank lines
  output = output.replace(/\n{4,}/g, "\n\n");
  // Redact secrets
  for (const secret of exactSecrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(SECRET_PATTERN, "[REDACTED]");
  output = output.replace(LONG_TOKEN_PATTERN, "[REDACTED]");
  return output;
}
