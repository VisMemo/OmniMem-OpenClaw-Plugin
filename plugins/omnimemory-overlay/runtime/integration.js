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

function buildSyntheticSessionKey(event, ctx) {
  const agentId =
    normalizeString(ctx?.agentId) ||
    normalizeString(event?.agentId);
  const channelScope =
    normalizeString(ctx?.channelId) ||
    normalizeString(event?.channelId) ||
    normalizeString(ctx?.messageProvider) ||
    normalizeString(event?.messageProvider) ||
    normalizeString(ctx?.trigger) ||
    normalizeString(event?.trigger) ||
    undefined;
  if (!agentId && !channelScope) {
    return undefined;
  }
  return `agent:${agentId || "unknown"}:${channelScope || "default"}`;
}

function resolveHookSessionContext(event, ctx, logger) {
  const sessionKey = normalizeString(ctx?.sessionKey) || normalizeString(event?.sessionKey);
  const directSessionId = normalizeString(ctx?.sessionId) || normalizeString(event?.sessionId);
  if (sessionKey || directSessionId) {
    const source = sessionKey
      ? normalizeString(ctx?.sessionKey)
        ? "ctx.sessionKey"
        : "event.sessionKey"
      : normalizeString(ctx?.sessionId)
        ? "ctx.sessionId"
        : "event.sessionId";
    logger?.info?.(
      `[omnimemory-overlay] resolved session identity from ${source}: sessionKey=${sessionKey || "-"} sessionId=${directSessionId || "-"}`,
    );
    return { sessionKey, sessionId: directSessionId, source };
  }
  const derivedSessionId = deriveSessionIdFromSessionFile(event?.sessionFile);
  if (derivedSessionId) {
    logger?.info?.(`[omnimemory-overlay] derived sessionId from sessionFile: ${derivedSessionId}`);
    return {
      sessionKey: undefined,
      sessionId: derivedSessionId,
      source: "event.sessionFile",
    };
  }
  const syntheticSessionKey = buildSyntheticSessionKey(event, ctx);
  if (syntheticSessionKey) {
    logger?.info?.(`[omnimemory-overlay] using synthetic sessionKey fallback: ${syntheticSessionKey}`);
    return {
      sessionKey: syntheticSessionKey,
      sessionId: undefined,
      source: "synthetic",
    };
  }
  logger?.warn?.("[omnimemory-overlay] no session identity available after fallback resolution");
  return { sessionKey: undefined, sessionId: undefined, source: "missing" };
}

export async function buildOverlayRecallContext({ config, event, ctx, logger }) {
  logger?.info?.(`[omnimemory-overlay] buildOverlayRecallContext called, autoRecall: ${config.autoRecall}`);
  if (!config.autoRecall) {
    logger?.info?.(`[omnimemory-overlay] autoRecall disabled, skipping`);
    return undefined;
  }
  const sessionCtx = resolveHookSessionContext(event, ctx, logger);
  logger?.info?.(
    `[omnimemory-overlay] recall session context: source=${sessionCtx.source} sessionKey=${sessionCtx.sessionKey || "-"} sessionId=${sessionCtx.sessionId || "-"}`,
  );
  const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  logger?.info?.(`[omnimemory-overlay] prompt extracted: "${prompt}", length: ${prompt.length}, minPromptChars: ${config.minPromptChars}`);
  if (!prompt || prompt.length < config.minPromptChars) {
    logger?.info?.(`[omnimemory-overlay] prompt too short or empty, returning system context only`);
    return {
      prependSystemContext: "OmniMemory overlay is active for external long-term memory recall.",
    };
  }
  try {
    const recallScope = config.sessionScope === "global"
      ? "global"
      : sessionCtx.sessionKey || sessionCtx.sessionId || "missing";
    logger?.info?.(
      `[omnimemory-overlay] recall request: scope=${recallScope} query=${JSON.stringify(prompt)} topK=${config.recallTopK} minScore=${config.recallMinScore}`,
    );
    const items = await searchMemory({
      config,
      query: prompt,
      sessionKey: sessionCtx.sessionKey || sessionCtx.sessionId,
      topK: config.recallTopK,
      minScore: config.recallMinScore,
    });
    logger?.info?.(
      `[omnimemory-overlay] recall result: items=${items.length} sample=${JSON.stringify(items.slice(0, 3).map((item, index) => ({
        index,
        score: item?.score ?? null,
        text: typeof item?.text === "string" ? item.text.slice(0, 160) : "",
      })))}`,
    );
    const promptBlock = buildRecallPromptBlock({
      title: config.promptBlockTitle,
      items,
    });
    logger?.info?.(
      `[omnimemory-overlay] recall prompt block: chars=${promptBlock.length} injected=${promptBlock ? "yes" : "no"}`,
    );
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

export async function captureConversation({ config, event, ctx, logger, wait }) {
  logger?.info?.(`[omnimemory-overlay] captureConversation called, autoCapture: ${config.autoCapture}, captureStrategy: ${config.captureStrategy}`);
  if (!config.autoCapture) {
    logger?.info?.(`[omnimemory-overlay] autoCapture disabled, skipping`);
    return { skipped: true, reason: "autoCapture disabled" };
  }
  const sessionCtx = resolveHookSessionContext(event, ctx, logger);
  logger?.info?.(
    `[omnimemory-overlay] capture session context: source=${sessionCtx.source} sessionKey=${sessionCtx.sessionKey || "-"} sessionId=${sessionCtx.sessionId || "-"} sessionScope=${config.sessionScope} eventKeys=${Object.keys(event || {}).join(",")} ctxKeys=${Object.keys(ctx || {}).join(",")}`,
  );
  if (!sessionCtx.sessionKey && !sessionCtx.sessionId) {
    logger?.warn?.("[omnimemory-overlay] skipping capture because no session identity is available");
    return { skipped: true, reason: "missing session identity" };
  }
  const normalized = await resolveCapturableMessages({ config, event });
  logger?.info?.(`[omnimemory-overlay] normalized messages count: ${normalized.length}`);
  const selected = selectMessagesForCapture(normalized, config.captureStrategy);
  logger?.info?.(`[omnimemory-overlay] selected messages count: ${selected.length}, strategy: ${config.captureStrategy}`);
  if (!selected.length) {
    logger?.info?.(`[omnimemory-overlay] no capturable messages, skipping`);
    return { skipped: true, reason: "no capturable messages" };
  }
  try {
    logger?.info?.(`[omnimemory-overlay] calling ingestMessages with ${selected.length} messages`);
    const result = await ingestMessages({
      config,
      sessionKey: sessionCtx.sessionKey,
      sessionId: sessionCtx.sessionId,
      messages: selected,
      statePath: buildPersistentStatePath({
        workspaceDir: ctx?.workspaceDir,
        sessionFile: event?.sessionFile,
        sessionKey: sessionCtx.sessionKey,
        sessionId: sessionCtx.sessionId,
      }),
      wait,
    });
    logger?.info?.(`[omnimemory-overlay] ingestMessages result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logger?.warn?.(`omnimemory capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: true, reason: "ingest failed" };
  }
}

export function createMemorySearchTool({ config, sessionKey }) {
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
