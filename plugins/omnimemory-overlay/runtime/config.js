const DEFAULT_BASE_URL = "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory";

export const COMMON_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  recallScope: "global",
  ingestScope: "session",
  searchLimit: 8,
  failSilent: true,
  timeoutMs: 10_000,
  autoRecall: true,
  autoCapture: true,
  recallTopK: 20,
  recallMinScore: 0,
  minPromptChars: 8,
  captureStrategy: "last_turn",
  captureRoles: ["user"],
  writeWait: false,
  promptBlockTitle: "OmniMemory Recall",
});

function parseEnvTemplate(value, env = process.env) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^\$\{([A-Z0-9_]+)\}$/i.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const resolved = env[match[1]];
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value, fallback, { min = undefined } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (typeof min === "number" && value < min) {
    return fallback;
  }
  return value;
}

function normalizeString(value, fallback = undefined) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value);
  return normalized && allowed.includes(normalized) ? normalized : fallback;
}

function normalizeRoles(value) {
  if (!Array.isArray(value)) {
    return [...COMMON_DEFAULTS.captureRoles];
  }
  const allowed = new Set(["user", "assistant", "tool", "system"]);
  const roles = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => allowed.has(entry));
  return roles.length > 0 ? roles : [...COMMON_DEFAULTS.captureRoles];
}

function parseAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) {
    return undefined;
  }
  const match = /^agent:([^:]+):/i.exec(normalized);
  return normalizeString(match?.[1]);
}

function resolveLegacyScope(rawConfig, defaultScope) {
  return normalizeEnum(rawConfig.sessionScope, ["global", "agent", "session"], defaultScope);
}

export function resolveOmniCommonConfig(rawConfig = {}, env = process.env) {
  const apiKey = parseEnvTemplate(rawConfig.apiKey, env);
  const baseUrl = normalizeString(rawConfig.baseUrl, COMMON_DEFAULTS.baseUrl)?.replace(/\/+$/, "");
  const recallScope = normalizeEnum(
    rawConfig.recallScope,
    ["global", "agent", "session"],
    resolveLegacyScope(rawConfig, COMMON_DEFAULTS.recallScope),
  );
  const ingestScope = normalizeEnum(
    rawConfig.ingestScope,
    ["global", "agent", "session"],
    resolveLegacyScope(rawConfig, COMMON_DEFAULTS.ingestScope),
  );
  return {
    apiKey,
    baseUrl,
    recallScope,
    ingestScope,
    searchLimit: Math.floor(
      normalizeNumber(rawConfig.searchLimit, COMMON_DEFAULTS.searchLimit, { min: 1 }),
    ),
    failSilent: normalizeBoolean(rawConfig.failSilent, COMMON_DEFAULTS.failSilent),
    timeoutMs: Math.floor(normalizeNumber(rawConfig.timeoutMs, COMMON_DEFAULTS.timeoutMs, { min: 1 })),
    autoRecall: normalizeBoolean(rawConfig.autoRecall, COMMON_DEFAULTS.autoRecall),
    autoCapture: normalizeBoolean(rawConfig.autoCapture, COMMON_DEFAULTS.autoCapture),
    recallTopK: Math.floor(
      normalizeNumber(rawConfig.recallTopK, COMMON_DEFAULTS.recallTopK, { min: 1 }),
    ),
    recallMinScore: normalizeNumber(rawConfig.recallMinScore, COMMON_DEFAULTS.recallMinScore),
    minPromptChars: Math.floor(
      normalizeNumber(rawConfig.minPromptChars, COMMON_DEFAULTS.minPromptChars, { min: 0 }),
    ),
    captureStrategy: normalizeEnum(
      rawConfig.captureStrategy,
      ["last_turn", "full_session"],
      COMMON_DEFAULTS.captureStrategy,
    ),
    captureRoles: normalizeRoles(rawConfig.captureRoles),
    writeWait: normalizeBoolean(rawConfig.writeWait, COMMON_DEFAULTS.writeWait),
    promptBlockTitle: normalizeString(rawConfig.promptBlockTitle, COMMON_DEFAULTS.promptBlockTitle),
  };
}

export function resolveAgentId(ctx = {}) {
  return parseAgentIdFromSessionKey(ctx.sessionKey) || normalizeString(ctx.agentId);
}

export function requireApiKey(config) {
  if (!config.apiKey) {
    throw new Error(
      'OmniMemory API key is missing. Set plugins.entries.<plugin>.config.apiKey, or use apiKey: "${OMNI_MEMORY_API_KEY}" and export OMNI_MEMORY_API_KEY before starting OpenClaw.',
    );
  }
  return config.apiKey;
}

export function resolveScopeId(scope, ctx = {}) {
  if (scope === "global") {
    return "global";
  }
  if (scope === "agent") {
    const agentId = resolveAgentId(ctx);
    return agentId ? `agent:${agentId}` : normalizeString(ctx.sessionId) || normalizeString(ctx.sessionKey);
  }
  return normalizeString(ctx.sessionId) || normalizeString(ctx.sessionKey);
}

export function resolveRecallScopeId(config, ctx = {}) {
  return resolveScopeId(config.recallScope, ctx);
}

export function resolveIngestScopeId(config, ctx = {}) {
  return resolveScopeId(config.ingestScope, ctx);
}

export function resolveSessionId(config, ctx = {}) {
  return resolveIngestScopeId(config, ctx);
}
