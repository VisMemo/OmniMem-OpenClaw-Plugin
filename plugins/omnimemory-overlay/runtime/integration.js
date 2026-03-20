import { resolveAgentId, resolveRecallScopeId, resolveIngestScopeId } from "./config.js";
import { normalizeOpenClawMessages, selectMessagesForCapture } from "./messages.js";
import { buildRecallPromptBlock, buildMemoryPluginGuidance } from "./prompt-composer.js";
import { ingestMessages, searchMemory, readMemoryItem } from "./omni-client.js";
import { buildSyntheticPath } from "./synthetic-path.js";
import { jsonResult } from "../shared/result.js";
import { readOpenClawSessionMessages } from "./session-transcript.js";
import { buildPersistentStatePath } from "./persistent-state.js";

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deriveSessionIdFromSessionFile(sessionFile) {
  const normalized = normalizeString(sessionFile);
  if (!normalized) {
    return undefined;
  }
  const filename = normalized.split(/[\\/]/).pop();
  if (!filename) {
    return undefined;
  }
  return normalizeString(filename.replace(/\.jsonl(?:\..+)?$/i, ""));
}

function buildSyntheticSessionKey(event, ctx, fallbackAgentId) {
  const agentId = normalizeString(fallbackAgentId) || normalizeString(ctx?.agentId) || normalizeString(event?.agentId);
  const channelScope =
    normalizeString(ctx?.channelId) ||
    normalizeString(event?.channelId) ||
    normalizeString(ctx?.messageProvider) ||
    normalizeString(event?.messageProvider) ||
    normalizeString(ctx?.trigger) ||
    normalizeString(event?.trigger);
  if (!agentId && !channelScope) {
    return undefined;
  }
  return `agent:${agentId || "unknown"}:${channelScope || "default"}`;
}

function resolveHookSessionContext({ config, event, ctx }) {
  const sessionKey = normalizeString(ctx?.sessionKey) || normalizeString(event?.sessionKey);
  const directSessionId = normalizeString(ctx?.sessionId) || normalizeString(event?.sessionId);
  const agentId = resolveAgentId({
    agentId: normalizeString(ctx?.agentId) || normalizeString(event?.agentId),
    sessionKey,
  });
  if (sessionKey || directSessionId || agentId) {
    return {
      sessionKey,
      sessionId: directSessionId,
      agentId,
      recallScopeId: resolveRecallScopeId(config, { sessionKey, sessionId: directSessionId, agentId }),
      ingestScopeId: resolveIngestScopeId(config, { sessionKey, sessionId: directSessionId, agentId }),
      source: sessionKey
        ? normalizeString(ctx?.sessionKey)
          ? "ctx.sessionKey"
          : "event.sessionKey"
        : directSessionId
          ? normalizeString(ctx?.sessionId)
            ? "ctx.sessionId"
            : "event.sessionId"
          : "agentId",
    };
  }
  const derivedSessionId = deriveSessionIdFromSessionFile(event?.sessionFile);
  if (derivedSessionId) {
    return {
      sessionKey: undefined,
      sessionId: derivedSessionId,
      agentId,
      recallScopeId: resolveRecallScopeId(config, { sessionId: derivedSessionId, agentId }),
      ingestScopeId: resolveIngestScopeId(config, { sessionId: derivedSessionId, agentId }),
      source: "event.sessionFile",
    };
  }
  const syntheticSessionKey = buildSyntheticSessionKey(event, ctx, agentId);
  if (syntheticSessionKey) {
    return {
      sessionKey: syntheticSessionKey,
      sessionId: undefined,
      agentId: resolveAgentId({ agentId, sessionKey: syntheticSessionKey }),
      recallScopeId: resolveRecallScopeId(config, {
        sessionKey: syntheticSessionKey,
        agentId: resolveAgentId({ agentId, sessionKey: syntheticSessionKey }),
      }),
      ingestScopeId: resolveIngestScopeId(config, {
        sessionKey: syntheticSessionKey,
        agentId: resolveAgentId({ agentId, sessionKey: syntheticSessionKey }),
      }),
      source: "synthetic",
    };
  }
  return {
    sessionKey: undefined,
    sessionId: undefined,
    agentId,
    recallScopeId: resolveRecallScopeId(config, { agentId }),
    ingestScopeId: resolveIngestScopeId(config, { agentId }),
    source: "missing",
  };
}

async function resolveCapturableMessages({ config, event }) {
  const inlineMessages = normalizeOpenClawMessages(event?.messages, {
    captureRoles: config.captureRoles,
  });
  if (inlineMessages.length > 0) {
    return inlineMessages;
  }
  if (typeof event?.sessionFile === "string" && event.sessionFile.trim()) {
    const transcriptMessages = await readOpenClawSessionMessages(event.sessionFile);
    return normalizeOpenClawMessages(transcriptMessages, {
      captureRoles: config.captureRoles,
    });
  }
  return [];
}

export async function buildOverlayRecallContext({ config, event, ctx, logger }) {
  if (!config.autoRecall) {
    return undefined;
  }
  const sessionCtx = resolveHookSessionContext({ config, event, ctx });
  const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  logger?.info?.(
    `[omnimemory-overlay] recall start: source=${sessionCtx.source} scope=${sessionCtx.recallScopeId || "-"} promptChars=${prompt.length}`,
  );
  if (!prompt || prompt.length < config.minPromptChars) {
    return {
      prependSystemContext: "OmniMemory overlay is active for external long-term memory recall.",
    };
  }
  try {
    const items = await searchMemory({
      config,
      query: prompt,
      sessionKey: sessionCtx.sessionKey,
      sessionId: sessionCtx.sessionId,
      agentId: sessionCtx.agentId,
      topK: config.recallTopK,
      minScore: config.recallMinScore,
    });
    logger?.info?.(
      `[omnimemory-overlay] recall complete: scope=${sessionCtx.recallScopeId || "-"} items=${items.length}`,
    );
    const promptBlock = buildRecallPromptBlock({
      title: config.promptBlockTitle,
      items,
    });
    return {
      prependContext: promptBlock || undefined,
      prependSystemContext: "OmniMemory overlay is active for external long-term memory recall.",
    };
  } catch (error) {
    logger?.warn?.(`omnimemory-overlay recall failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      prependSystemContext: "OmniMemory overlay is active for external long-term memory recall.",
    };
  }
}

export async function captureConversation({ config, event, ctx, logger, wait }) {
  if (!config.autoCapture) {
    return { skipped: true, reason: "autoCapture disabled" };
  }
  const sessionCtx = resolveHookSessionContext({ config, event, ctx });
  if (!sessionCtx.ingestScopeId) {
    logger?.warn?.("[omnimemory-overlay] skipping capture because no scope identity is available");
    return { skipped: true, reason: "missing session identity" };
  }
  const normalized = await resolveCapturableMessages({ config, event });
  const selected = selectMessagesForCapture(normalized, config.captureStrategy);
  logger?.info?.(
    `[omnimemory-overlay] capture start: source=${sessionCtx.source} scope=${sessionCtx.ingestScopeId} normalized=${normalized.length} selected=${selected.length}`,
  );
  if (!selected.length) {
    return { skipped: true, reason: "no capturable messages" };
  }
  try {
    return await ingestMessages({
      config,
      sessionKey: sessionCtx.sessionKey,
      sessionId: sessionCtx.sessionId,
      agentId: sessionCtx.agentId,
      messages: selected,
      statePath: buildPersistentStatePath({
        workspaceDir: ctx?.workspaceDir,
        sessionFile: event?.sessionFile,
        sessionKey: sessionCtx.sessionKey,
        sessionId: sessionCtx.sessionId,
        scopeId: sessionCtx.ingestScopeId,
      }),
      wait,
    });
  } catch (error) {
    logger?.warn?.(`omnimemory capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: true, reason: "ingest failed" };
  }
}

export function createMemorySearchTool({ config, sessionKey, sessionId, agentId }) {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search long-term memory from OmniMemory for prior work, decisions, dates, people, preferences, or todos.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        minScore: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      try {
        const items = await searchMemory({
          config,
          query: params?.query,
          sessionKey,
          sessionId,
          agentId,
          topK: params?.maxResults,
          minScore: params?.minScore,
        });
        const results = items.map((item, index) => ({
          path: item.syntheticPath || buildSyntheticPath(item, index),
          startLine: 1,
          endLine: 1,
          score: item.score,
          snippet: item.text,
          source: "memory",
        }));
        return jsonResult({ results, provider: "omnimemory" });
      } catch (error) {
        if (config.failSilent) {
          return jsonResult({
            results: [],
            provider: "omnimemory",
            disabled: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
  };
}

export function createMemoryGetTool({ config }) {
  return {
    name: "memory_get",
    label: "Memory Get",
    description: "Read detailed evidence for an OmniMemory search result.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "number" },
        lines: { type: "number" },
      },
      required: ["path"],
    },
    async execute(_id, params) {
      const result = await readMemoryItem({
        config,
        path: params?.path,
        from: params?.from,
        lines: params?.lines,
      });
      return jsonResult(result);
    },
  };
}

export function buildMemoryModePromptHookResult() {
  return {
    appendSystemContext: buildMemoryPluginGuidance(),
  };
}
