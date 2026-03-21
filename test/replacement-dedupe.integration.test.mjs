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

function getHookHandler(api, hookName) {
  const entry = api.state.hooks.find((hook) => hook.name === hookName);
  assert.ok(entry, `expected hook ${hookName} to be registered`);
  return entry.handler;
}

async function writeSessionTranscript(sessionFile, messages) {
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
}

test("replacement dedupe: identical sessionFile capture is skipped on the second pass", async () => {
  const mock = await startMockOmniServer();
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-replacement-dedupe-same-"));
  const sessionFile = path.join(workspaceDir, "replacement-dedupe-same.jsonl");
  await writeSessionTranscript(sessionFile, [
    { role: "user", content: "same transcript first line" },
    { role: "assistant", content: "same transcript second line" },
  ]);

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
      { messageCount: -1, sessionFile },
      {
        sessionKey: "agent:main:test:replacement-dedupe-same",
        workspaceDir,
      },
    );
    assert.equal(mock.state.ingestRequests.length, 1);

    await beforeCompaction(
      { messageCount: -1, sessionFile },
      {
        sessionKey: "agent:main:test:replacement-dedupe-same",
        workspaceDir,
      },
    );
    assert.equal(mock.state.ingestRequests.length, 1);
  } finally {
    await mock.close();
  }
});

test("replacement dedupe: adding one more line changes the fingerprint and re-ingests", async () => {
  const mock = await startMockOmniServer();
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "omnimem-replacement-dedupe-grow-"));
  const sessionFile = path.join(workspaceDir, "replacement-dedupe-grow.jsonl");
  const sessionKey = "agent:main:test:replacement-dedupe-grow";
  const newMarker = "replacement-dedupe-new-line-marker-001";
  await writeSessionTranscript(sessionFile, [
    { role: "user", content: "initial transcript first line" },
    { role: "assistant", content: "initial transcript second line" },
  ]);

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
      { messageCount: -1, sessionFile },
      {
        sessionKey,
        workspaceDir,
      },
    );
    assert.equal(mock.state.ingestRequests.length, 1);
    assert.equal(mock.state.ingestRequests[0].turns.length, 2);

    await writeSessionTranscript(sessionFile, [
      { role: "user", content: "initial transcript first line" },
      { role: "assistant", content: "initial transcript second line" },
      { role: "user", content: `new line should force re-ingest ${newMarker}` },
    ]);

    await beforeCompaction(
      { messageCount: -1, sessionFile },
      {
        sessionKey,
        workspaceDir,
      },
    );
    assert.equal(mock.state.ingestRequests.length, 2);
    assert.equal(mock.state.ingestRequests[1].turns.length, 3);
    assert.ok(
      mock.state.ingestRequests[1].turns.some((turn) => String(turn?.text || "").includes(newMarker)),
      "expected the re-ingested payload to include the newly appended line",
    );
  } finally {
    await mock.close();
  }
});
