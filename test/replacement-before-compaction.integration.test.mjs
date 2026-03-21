import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import memoryPlugin from "../plugins/omnimemory-memory/index.js";
import { startMockOmniServer } from "../scripts/lib/mock-omni-server.mjs";

function createMockApi(pluginConfig = {}) {
  const state = {
    hooks: [],
    tools: [],
    services: [],
  };
  return {
    state,
    pluginConfig,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    on(name, handler) {
      state.hooks.push({ name, handler });
    },
    registerTool(tool, opts) {
      state.tools.push({ tool, opts });
    },
    registerService(service) {
      state.services.push(service);
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 200, message = "condition timeout" } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await wait(intervalMs);
  }
  throw new Error(message);
}

function getHookHandler(api, hookName) {
  const entry = api.state.hooks.find((hook) => hook.name === hookName);
  assert.ok(entry, `expected hook ${hookName} to be registered`);
  return entry.handler;
}

async function writeSessionTranscript({ dir, filename = "session.jsonl", messages }) {
  const sessionFile = path.join(dir, filename);
  const lines = (Array.isArray(messages) ? messages : []).map((message, index) =>
    JSON.stringify({
      type: "message",
      message: {
        role: message.role,
        content: [{ type: "text", text: String(message.content) }],
        timestamp: message.timestamp || new Date(Date.now() + index).toISOString(),
      },
    }),
  );
  await writeFile(sessionFile, lines.join("\n"), "utf8");
  return sessionFile;
}

test("replacement before_compaction prefers inline event.messages over sessionFile fallback", async () => {
  const mock = await startMockOmniServer();
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-replacement-before-compaction-inline-"));
  const fileMarker = "before-compaction-file-marker-001";
  const inlineMarker = "before-compaction-inline-marker-001";
  const sessionFile = await writeSessionTranscript({
    dir: workspaceDir,
    filename: "replacement-inline.jsonl",
    messages: [
      { role: "user", content: `session file fallback should stay unused ${fileMarker}` },
      { role: "assistant", content: "session file assistant context" },
    ],
  });

  const api = createMockApi({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    autoCapture: true,
    captureRoles: ["user", "assistant"],
    captureStrategy: "full_session",
  });
  memoryPlugin.register(api);
  const beforeCompaction = getHookHandler(api, "before_compaction");

  try {
    await beforeCompaction(
      {
        messageCount: 2,
        messages: [
          {
            role: "user",
            content: `inline before_compaction payload should win ${inlineMarker}`,
            timestamp: "2026-03-21T07:30:00.000Z",
          },
          {
            role: "assistant",
            content: "inline assistant context",
            timestamp: "2026-03-21T07:30:01.000Z",
          },
        ],
        sessionFile,
      },
      {
        sessionKey: "agent:main:test:replacement-before-compaction-inline",
        workspaceDir,
      },
    );

    await waitFor(() => mock.state.ingestRequests.length === 1, {
      message: "expected exactly one ingest request for inline before_compaction capture",
    });

    const capturedText = mock.state.ingestRequests[0].turns.map((turn) => turn.text).join("\n");
    assert.match(capturedText, new RegExp(inlineMarker));
    assert.doesNotMatch(capturedText, new RegExp(fileMarker));
  } finally {
    await mock.close();
  }
});

test("replacement before_compaction falls back to sessionFile when messages are unavailable", async () => {
  const mock = await startMockOmniServer();
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-replacement-before-compaction-file-"));
  const fileMarker = "before-compaction-file-fallback-marker-002";
  const sessionFile = await writeSessionTranscript({
    dir: workspaceDir,
    filename: "replacement-file.jsonl",
    messages: [
      { role: "user", content: `session file fallback should capture ${fileMarker}` },
      { role: "assistant", content: "session file assistant context" },
    ],
  });

  const api = createMockApi({
    apiKey: "test-key",
    baseUrl: mock.baseUrl,
    autoCapture: true,
    captureRoles: ["user", "assistant"],
    captureStrategy: "full_session",
  });
  memoryPlugin.register(api);
  const beforeCompaction = getHookHandler(api, "before_compaction");

  try {
    await beforeCompaction(
      {
        messageCount: -1,
        sessionFile,
      },
      {
        sessionKey: "agent:main:test:replacement-before-compaction-file",
        workspaceDir,
      },
    );

    await waitFor(() => mock.state.ingestRequests.length === 1, {
      message: "expected exactly one ingest request for sessionFile fallback capture",
    });

    const ingest = mock.state.ingestRequests[0];
    const capturedText = ingest.turns.map((turn) => turn.text).join("\n");
    assert.match(capturedText, new RegExp(fileMarker));
    assert.equal(ingest.session_id, "agent:main:test:replacement-before-compaction-file");
  } finally {
    await mock.close();
  }
});
