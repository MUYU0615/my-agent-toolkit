const secretPatterns = [
  /\btoken=([^\s]+)/gi,
  /\bsecret=([^\s]+)/gi,
  /\bapi[_-]?key=([^\s]+)/gi,
  /\bpassword=([^\s]+)/gi,
];

const pathPattern = /(?<![A-Za-z0-9._:/-])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g;

export function redactText(value: string, exactSecrets: string[] = []): string {
  return redactValue(value, exactSecrets).trim();
}

export function redactStreamText(
  value: string,
  exactSecrets: string[] = [],
): string {
  return redactValue(value, exactSecrets);
}

function redactValue(value: string, exactSecrets: string[]): string {
  let redacted = value;
  for (const secret of [...new Set(exactSecrets)].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED]`;
    });
  }

  return redacted.replace(pathPattern, "[PATH]");
}
