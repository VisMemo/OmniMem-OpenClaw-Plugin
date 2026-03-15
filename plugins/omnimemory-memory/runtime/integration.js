import { normalizeOpenClawMessages, selectMessagesForCapture } from "./messages.js";
import { buildRecallPromptBlock, buildMemoryPluginGuidance } from "./prompt-composer.js";
import { ingestMessages, searchMemory, readMemoryItem } from "./omni-client.js";
import { buildSyntheticPath } from "./synthetic-path.js";
import { jsonResult } from "../shared/result.js";
import { readOpenClawSessionMessages } from "./session-transcript.js";
import { buildPersistentStatePath } from "./persistent-state.js";

export async function buildOverlayRecallContext({ config, event, ctx, logger }) {
  if (!config.autoRecall) {
    return undefined;
  }
  const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (!prompt || prompt.length < config.minPromptChars) {
    return {
      prependSystemContext: "OmniMemory overlay is active for external long-term memory recall.",
    };
  }
  try {
    const items = await searchMemory({
      config,
      query: prompt,
      sessionKey: ctx?.sessionKey,
      topK: config.recallTopK,
      minScore: config.recallMinScore,
    });
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
  if (!config.autoCapture) {
    return { skipped: true, reason: "autoCapture disabled" };
  }
  const normalized = await resolveCapturableMessages({ config, event });
  const selected = selectMessagesForCapture(normalized, config.captureStrategy);
  if (!selected.length) {
    return { skipped: true, reason: "no capturable messages" };
  }
  try {
    return await ingestMessages({
      config,
      sessionKey: ctx?.sessionKey,
      sessionId: ctx?.sessionId,
      messages: selected,
      statePath: buildPersistentStatePath({
        workspaceDir: ctx?.workspaceDir,
        sessionFile: event?.sessionFile,
        sessionKey: ctx?.sessionKey,
        sessionId: ctx?.sessionId,
      }),
      wait,
    });
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
