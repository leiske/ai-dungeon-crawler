import { getOAuthApiKey } from "@mariozechner/pi-ai";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { OPENAI_CODEX_MODEL_PROVIDER } from "./model.ts";

const DEFAULT_AUTH_PATH = "~/.codex/auth.json";

type JsonRecord = Record<string, unknown>;

interface OAuthCredentialLocation {
  container: JsonRecord;
  key: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHomePath(path: string): string {
  if (!path.startsWith("~/")) {
    return path;
  }

  const home = Bun.env.HOME;
  if (!home) {
    throw new Error("Cannot resolve '~' in auth path because HOME is not set.");
  }

  return `${home}/${path.slice(2)}`;
}

function readOptionalString(obj: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function readOptionalNumber(obj: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function normalizeExpiry(expires: number): number {
  return expires < 10_000_000_000 ? expires * 1000 : expires;
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payload = parts[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized);
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return null;
    }

    const exp = parsed.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      return null;
    }

    return exp * 1000;
  } catch {
    return null;
  }
}

function toOAuthCredentials(value: unknown): OAuthCredentials | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type !== undefined && value.type !== "oauth") {
    return null;
  }

  const access = readOptionalString(value, ["access", "accessToken", "access_token", "token"]);
  const refresh = readOptionalString(value, ["refresh", "refreshToken", "refresh_token"]);
  const expiresRaw = readOptionalNumber(value, ["expires", "expiresAt", "expires_at"]);

  if (!access || !refresh) {
    return null;
  }

  const decodedExpiry = decodeJwtExpiryMs(access);
  const expires = expiresRaw === null ? decodedExpiry : normalizeExpiry(expiresRaw);
  if (expires === null) {
    return null;
  }

  return {
    ...value,
    access,
    refresh,
    expires,
  };
}

function toDirectAccessToken(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return readOptionalString(value, ["access", "accessToken", "access_token", "token", "apiKey"]);
}

function findCredentialLocation(authJson: JsonRecord): OAuthCredentialLocation | null {
  const providerEntry = authJson[OPENAI_CODEX_MODEL_PROVIDER];
  if (isRecord(providerEntry)) {
    return {
      container: authJson,
      key: OPENAI_CODEX_MODEL_PROVIDER,
    };
  }

  const oauthEntry = authJson.oauth;
  if (isRecord(oauthEntry) && isRecord(oauthEntry[OPENAI_CODEX_MODEL_PROVIDER])) {
    return {
      container: oauthEntry,
      key: OPENAI_CODEX_MODEL_PROVIDER,
    };
  }

  const tokensEntry = authJson.tokens;
  if (isRecord(tokensEntry)) {
    return {
      container: authJson,
      key: "tokens",
    };
  }

  if (
    readOptionalString(authJson, ["access", "accessToken", "access_token", "token"]) &&
    readOptionalString(authJson, ["refresh", "refreshToken", "refresh_token"])
  ) {
    return {
      container: authJson,
      key: "",
    };
  }

  return null;
}

function getValueAtLocation(location: OAuthCredentialLocation): unknown {
  if (!location.key) {
    return location.container;
  }
  return location.container[location.key];
}

function setValueAtLocation(location: OAuthCredentialLocation, value: JsonRecord): void {
  if (!location.key) {
    for (const key of Object.keys(location.container)) {
      if (key !== "type" && key !== "accountId") {
        delete location.container[key];
      }
    }
    for (const [key, item] of Object.entries(value)) {
      location.container[key] = item;
    }
    return;
  }

  location.container[location.key] = value;
}

async function loadAuthJson(authPath: string): Promise<JsonRecord> {
  const file = Bun.file(authPath);
  if (!(await file.exists())) {
    throw new Error(
      `OAuth auth file not found at '${authPath}'. Set DUNGEON_AUTH_PATH or create this file.`,
    );
  }

  const raw = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse OAuth auth file at '${authPath}': ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`OAuth auth file at '${authPath}' must contain a JSON object.`);
  }

  return parsed;
}

async function saveAuthJson(authPath: string, data: JsonRecord): Promise<void> {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await Bun.write(authPath, payload);
}

export interface OpenAICodexAuthResult {
  authPath: string;
  apiKey: string;
}

export async function getOpenAICodexApiKey(authPathOverride?: string): Promise<OpenAICodexAuthResult> {
  const configuredPath = authPathOverride ?? Bun.env.DUNGEON_AUTH_PATH ?? DEFAULT_AUTH_PATH;
  const authPath = expandHomePath(configuredPath);
  const authJson = await loadAuthJson(authPath);

  const credentialLocation = findCredentialLocation(authJson);
  const credentialSource = credentialLocation ? getValueAtLocation(credentialLocation) : null;

  const existingCredentials = toOAuthCredentials(credentialSource);
  if (!existingCredentials) {
    const directToken = toDirectAccessToken(credentialSource);
    if (directToken) {
      return {
        authPath,
        apiKey: directToken,
      };
    }

    throw new Error(
      `No valid '${OPENAI_CODEX_MODEL_PROVIDER}' OAuth credentials found in '${authPath}'. ` +
        "Expected either provider-scoped OAuth credentials or direct access token fields.",
    );
  }

  const credentialMap: Record<string, OAuthCredentials> = {
    [OPENAI_CODEX_MODEL_PROVIDER]: existingCredentials,
  };

  const result = await getOAuthApiKey(OPENAI_CODEX_MODEL_PROVIDER, credentialMap);
  if (!result) {
    throw new Error(`Unable to resolve OAuth API key for provider '${OPENAI_CODEX_MODEL_PROVIDER}'.`);
  }

  const updatedCredentials: JsonRecord = {
    type: "oauth",
    ...result.newCredentials,
  };

  if (credentialLocation?.key === "tokens" && isRecord(authJson.tokens)) {
    const existingTokens = authJson.tokens;
    existingTokens.access_token = result.newCredentials.access;
    existingTokens.refresh_token = result.newCredentials.refresh;
    if (typeof result.newCredentials.accountId === "string" && result.newCredentials.accountId.length > 0) {
      existingTokens.account_id = result.newCredentials.accountId;
    }
    authJson.last_refresh = new Date().toISOString();
  } else if (credentialLocation) {
    setValueAtLocation(credentialLocation, updatedCredentials);
  } else {
    authJson[OPENAI_CODEX_MODEL_PROVIDER] = updatedCredentials;
  }

  await saveAuthJson(authPath, authJson);

  return {
    authPath,
    apiKey: result.apiKey,
  };
}
