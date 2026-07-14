import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const VERSION = "aes-256-gcm:v1";

export interface JiraCredentialPayload {
  provider?: "easemob_jira";
  username: string;
  password: string;
  redirect_username?: string;
  redirect_password?: string;
}

export interface GitHubForkCredentialPayload {
  provider: "github_fork";
  access_token: string;
  repository_url: string;
  branch: string;
}

export type UserCredentialPayload = JiraCredentialPayload | GitHubForkCredentialPayload;

export interface CredentialVault {
  encrypt(payload: UserCredentialPayload): string;
  decrypt(ciphertext: string): UserCredentialPayload;
  encryptText(value: string): string;
  decryptText(ciphertext: string): string;
}

export function createCredentialVault(masterKey: string): CredentialVault {
  const key = decodeMasterKey(masterKey);
  return {
    encrypt(payload) {
      return encryptValue(key, validatePayload(payload));
    },
    decrypt(ciphertext) {
      return validatePayload(decryptValue(key, ciphertext));
    },
    encryptText(value) {
      return encryptValue(key, { kind: "text", value: requireTextSecret(value) });
    },
    decryptText(ciphertext) {
      const payload = decryptValue(key, ciphertext);
      if (!payload || typeof payload !== "object") {
        throw new Error("credential decryption failed");
      }
      const record = payload as Record<string, unknown>;
      if (record.kind !== "text" || typeof record.value !== "string") {
        throw new Error("credential decryption failed");
      }
      return record.value;
    },
  };
}

function encryptValue(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptValue(key: Buffer, ciphertext: string): unknown {
  const [version, ivValue, tagValue, encryptedValue, ...extra] = ciphertext.split(".");
  if (
    version !== VERSION
    || !ivValue
    || !tagValue
    || !encryptedValue
    || extra.length > 0
  ) {
    throw new Error("unsupported credential ciphertext");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("credential decryption failed");
  }
}

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "USER_CREDENTIALS_MASTER_KEY must be a 32-byte base64 or 64-character hex value",
    );
  }
  return key;
}

function validatePayload(value: unknown): UserCredentialPayload {
  if (!value || typeof value !== "object") {
    throw new Error("invalid credential payload");
  }
  const record = value as Record<string, unknown>;
  if (record.provider === "github_fork") {
    return {
      provider: "github_fork",
      access_token: requiredSecret(record.access_token, "access_token"),
      repository_url: requireGitHubRepositoryUrl(record.repository_url),
      branch: requireGitBranch(record.branch),
    };
  }
  if (record.provider !== undefined && record.provider !== "easemob_jira") {
    throw new Error("invalid credential provider");
  }
  const username = requiredSecret(record.username, "username");
  const password = requiredSecret(record.password, "password");
  const redirectUsername = optionalSecret(record.redirect_username);
  const redirectPassword = optionalSecret(record.redirect_password);
  if (Boolean(redirectUsername) !== Boolean(redirectPassword)) {
    throw new Error("redirect username and password must be provided together");
  }
  return {
    provider: "easemob_jira",
    username,
    password,
    ...(redirectUsername ? { redirect_username: redirectUsername } : {}),
    ...(redirectPassword ? { redirect_password: redirectPassword } : {}),
  };
}

function requireGitHubRepositoryUrl(value: unknown): string {
  const url = requiredSecret(value, "repository_url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("repository_url must be a GitHub HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password) {
    throw new Error("repository_url must be a GitHub HTTPS URL without credentials");
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("repository_url must identify one GitHub repository");
  }
  return `https://github.com/${parts[0]}/${parts[1]}.git`;
}

function requireGitBranch(value: unknown): string {
  const branch = requiredSecret(value, "branch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error("branch must be a safe Git branch name");
  }
  return branch;
}

function requiredSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireTextSecret(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("text credential is required");
  }
  return value;
}
