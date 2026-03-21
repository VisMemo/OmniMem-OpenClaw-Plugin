import { randomUUID } from "node:crypto";
import { requireApiKey, resolveRecallScopeId, resolveIngestScopeId } from "./config.js";
import { buildSyntheticPath, parseSyntheticPath } from "./synthetic-path.js";
import { rememberToolResult, getToolResult } from "./tool-cache.js";
import { fingerprintMessages } from "./messages.js";
import { readPersistentState, writePersistentState } from "./persistent-state.js";

const sessionWriteState = new Map();
const sessionWriteLocks = new Map();

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function runWithSessionWriteLock(scopeId, task) {
  const previous = sessionWriteLocks.get(scopeId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  sessionWriteLocks.set(scopeId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sessionWriteLocks.get(scopeId) === current) {
      sessionWriteLocks.delete(scopeId);
    }
  }
}

async function requestJson({ config, path, method = "GET", body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": requireApiKey(config),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`${method} ${path} failed: ${response.status} ${text}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function coerceSearchItems(payload) {
  const rawItems = Array.isArray(payload?.evidence_details)
    ? payload.evidence_details
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  return rawItems
    .map((raw) => {
      const text = normalizeString(raw?.text);
      if (!text) {
        return null;
      }
      const entities = normalizeArray(raw?.entities).filter((entry) => typeof entry === "string");
      return {
        text,
        score: typeof raw?.score === "number" ? raw.score : 0,
        timestamp: normalizeString(raw?.timestamp),
        source: normalizeString(raw?.source),
        eventId:
          normalizeString(raw?.tkg_event_id) ||
          normalizeString(raw?.event_id) ||
          normalizeString(raw?.eventId),
        entity: entities[0],
        entities,
      };
    })
    .filter(Boolean);
}

function formatReadText(item) {
  const lines = [];
  if (item.eventId) {
    lines.push(`Event ID: ${item.eventId}`);
  }
  if (item.timestamp) {
    lines.push(`Timestamp: ${item.timestamp}`);
  }
  if (item.source) {
    lines.push(`Source: ${item.source}`);
  }
  if (item.entities?.length) {
    lines.push(`Entities: ${item.entities.join(", ")}`);
  }
  if (lines.length) {
    lines.push("");
  }
  lines.push(item.text);
  return lines.join("\n");
}

function applyWindow(text, from, lines) {
  if (typeof text !== "string" || !text) {
    return text || "";
  }
  const split = text.split("\n");
  const start = typeof from === "number" && from > 0 ? Math.floor(from) - 1 : 0;
  const count = typeof lines === "number" && lines > 0 ? Math.floor(lines) : undefined;
  return split.slice(start, count ? start + count : undefined).join("\n");
}

export async function searchMemory({ config, query, sessionKey, sessionId, agentId, topK, minScore = 0 }) {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (!trimmedQuery) {
    return [];
  }
  const resolvedScopeId = resolveRecallScopeId(config, { sessionKey, sessionId, agentId });
  const body = {
    memory_domain: "dialog",
    ...(resolvedScopeId && resolvedScopeId !== "global" ? { run_id: resolvedScopeId } : {}),
    query: trimmedQuery,
    strategy: "dialog_v2",
    topk: topK || config.searchLimit,
    task: "GENERAL",
    with_answer: false,
    backend: "tkg",
    tkg_explain: true,
  };
  const payload = await requestJson({
    config,
    path: "/retrieval",
    method: "POST",
    body,
  });
  const items = coerceSearchItems(payload).filter((item) => item.score >= minScore);
  items.forEach((item, index) => {
    const path = buildSyntheticPath(item, index);
    rememberToolResult(path, {
      text: formatReadText(item),
      item,
    });
    item.syntheticPath = path;
  });
  return items;
}

export async function readMemoryItem({ path, from, lines, config }) {
  const cached = getToolResult(path);
  if (cached?.text) {
    return {
      path,
      text: applyWindow(cached.text, from, lines),
    };
  }
  const parsed = parseSyntheticPath(path);
  if (!parsed) {
    throw new Error("unknown OmniMemory path");
  }
  if (parsed.kind === "event") {
    const payload = await requestJson({
      config,
      path: `/graph/v0/explain/event/${encodeURIComponent(parsed.value)}`,
      method: "GET",
    });
    const item = payload?.item && typeof payload.item === "object" ? payload.item : payload;
    const utterances = normalizeArray(item?.utterances)
      .map((entry) => normalizeString(entry?.raw_text) || normalizeString(entry?.text))
      .filter(Boolean);
    const knowledge = normalizeArray(item?.knowledge)
      .map((entry) => normalizeString(entry?.summary) || normalizeString(entry?.text))
      .filter(Boolean);
    const text = [...knowledge, ...utterances].filter(Boolean).join("\n");
    return { path, text: applyWindow(text, from, lines) };
  }
  if (parsed.kind === "entity") {
    const payload = await requestJson({
      config,
      path: `/graph/v0/entities/resolve?name=${encodeURIComponent(parsed.value)}&limit=1`,
      method: "GET",
    });
    const entity = Array.isArray(payload?.items) ? payload.items[0] : undefined;
    const entityId = normalizeString(entity?.entity_id) || normalizeString(entity?.id);
    if (!entityId) {
      throw new Error("entity not found");
    }
    const timeline = await requestJson({
      config,
      path: `/graph/v0/entities/${encodeURIComponent(entityId)}/timeline?limit=20`,
      method: "GET",
    });
    const text = normalizeArray(timeline?.items)
      .map((entry) => normalizeString(entry?.text) || normalizeString(entry?.raw_text))
      .filter(Boolean)
      .join("\n");
    return { path, text: applyWindow(text, from, lines) };
  }
  throw new Error("cached OmniMemory item missing; rerun memory_search first");
}

async function getSessionStatus({ config, sessionId }) {
  try {
    return await requestJson({
      config,
      path: `/ingest/sessions/${encodeURIComponent(sessionId)}`,
      method: "GET",
    });
  } catch (error) {
    if (error?.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function waitForJob({ config, jobId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const payload = await requestJson({
      config,
      path: `/ingest/jobs/${encodeURIComponent(jobId)}`,
      method: "GET",
    });
    const status = normalizeString(payload?.status) || "";
    if (status.toUpperCase() === "COMPLETED") {
      return payload;
    }
    if (["FAILED", "ERROR"].includes(status.toUpperCase())) {
      throw new Error(`Omni ingest job failed: ${JSON.stringify(payload?.last_error || payload)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Omni ingest wait timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function ingestMessages({
  config,
  sessionKey,
  sessionId,
  agentId,
  messages,
  statePath,
  wait = false,
}) {
  const resolvedScopeId = resolveIngestScopeId(config, { sessionKey, sessionId, agentId });
  if (!resolvedScopeId) {
    throw new Error("session-scoped ingest requires sessionKey or sessionId");
  }
  return await runWithSessionWriteLock(resolvedScopeId, async () => {
    const turns = Array.isArray(messages) ? messages : [];
    if (!turns.length) {
      return { skipped: true, reason: "no turns" };
    }
    const fingerprint = fingerprintMessages(turns);
    const stateKey = resolvedScopeId;
    const lastState = sessionWriteState.get(stateKey);
    const persistedState = await readPersistentState(statePath);
    const previousFingerprint =
      (lastState?.sessionId === resolvedScopeId ? lastState.fingerprint : undefined) ||
      (persistedState?.sessionId === resolvedScopeId ? persistedState.fingerprint : undefined);
    if (previousFingerprint === fingerprint) {
      return { skipped: true, reason: "duplicate" };
    }

    const session = await getSessionStatus({ config, sessionId: resolvedScopeId });
    const baseTurnId = normalizeString(session?.cursor_committed);
    const currentIndex = baseTurnId && /^t(\d+)$/i.test(baseTurnId) ? Number(baseTurnId.slice(1)) : 0;
    const payloadTurns = turns.map((turn, index) => ({
      turn_id: `t${String(currentIndex + index + 1).padStart(4, "0")}`,
      role: turn.role,
      name: turn.name || null,
      speaker: turn.name || null,
      timestamp_iso: turn.timestampIso || new Date().toISOString(),
      text: turn.text,
      attachments: null,
      meta: null,
    }));

    const payload = await requestJson({
      config,
      path: "/ingest",
      method: "POST",
      body: {
        session_id: resolvedScopeId,
        memory_domain: "dialog",
        turns: payloadTurns,
        commit_id: randomUUID(),
        cursor: { base_turn_id: baseTurnId || null },
      },
    });
    const nextState = {
      fingerprint,
      count: payloadTurns.length,
      sessionId: resolvedScopeId,
      updatedAt: new Date().toISOString(),
    };
    sessionWriteState.set(stateKey, nextState);
    await writePersistentState(statePath, nextState);
    const jobId = normalizeString(payload?.job_id);
    if (wait && jobId) {
      await waitForJob({ config, jobId, timeoutMs: Math.max(config.timeoutMs, 60_000) });
    }
    return {
      skipped: false,
      sessionId: resolvedScopeId,
      committedTurns: payloadTurns.length,
      jobId,
    };
  });
}
