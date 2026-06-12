const SECRET_PATTERN =
  /\b(?:api[_-]?key|secret|token|authorization|bearer)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-]{32,}\b/g;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-9;?]*[ -/]*[@-~])/g;

export function redact(text: string, exactSecrets: string[]): string {
  let output = text;
  output = output.replace(ANSI_PATTERN, "");
  for (const secret of exactSecrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(SECRET_PATTERN, "[REDACTED]");
  output = output.replace(LONG_TOKEN_PATTERN, "[REDACTED]");
  return output;
}
