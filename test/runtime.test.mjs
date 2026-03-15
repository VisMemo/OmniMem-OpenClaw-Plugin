import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveOmniCommonConfig } from "../src/runtime/config.js";
import { buildSyntheticPath, parseSyntheticPath } from "../src/runtime/synthetic-path.js";
import { normalizeOpenClawMessages, selectMessagesForCapture } from "../src/runtime/messages.js";
import { buildRecallPromptBlock, buildMemoryPluginGuidance } from "../src/runtime/prompt-composer.js";
import { readOpenClawSessionMessages } from "../src/runtime/session-transcript.js";
import { buildPersistentStatePath } from "../src/runtime/persistent-state.js";

test("resolveOmniCommonConfig resolves env template and defaults", () => {
  const config = resolveOmniCommonConfig(
    {
      apiKey: "${OMNI_MEMORY_API_KEY}",
      recallTopK: 7,
    },
    { OMNI_MEMORY_API_KEY: "qbk_test" },
  );
  assert.equal(config.apiKey, "qbk_test");
  assert.equal(config.recallTopK, 7);
  assert.equal(config.captureStrategy, "last_turn");
  assert.deepEqual(config.captureRoles, ["user"]);
  assert.equal(config.baseUrl, "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory");
});

test("synthetic path roundtrip works for events", () => {
  const path = buildSyntheticPath({ eventId: "evt_123", text: "hello" }, 0);
  const parsed = parseSyntheticPath(path);
  assert.deepEqual(parsed, { kind: "event", value: "evt_123" });
});

test("normalizeOpenClawMessages extracts text blocks and filters roles", () => {
  const normalized = normalizeOpenClawMessages(
    [
      { role: "system", content: "ignore" },
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      { role: "assistant", content: "world" },
    ],
    { captureRoles: ["user", "assistant"] },
  );
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((entry) => entry.text), ["hello", "world"]);
});

test("selectMessagesForCapture returns trailing turn", () => {
  const selected = selectMessagesForCapture(
    [
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
      { role: "user", text: "c" },
      { role: "assistant", text: "d" },
    ],
    "last_turn",
  );
  assert.deepEqual(
    selected.map((entry) => entry.text),
    ["c", "d"],
  );
});

test("readOpenClawSessionMessages loads message entries from jsonl transcript", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnimem-session-test-"));
  const sessionFile = path.join(dir, "session.jsonl");
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "custom_message", customType: "noop", content: "x" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello from transcript" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
      }),
    ].join("\n"),
    "utf8",
  );
  const messages = await readOpenClawSessionMessages(sessionFile);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
});

test("buildPersistentStatePath uses workspace dir and stable session hash", () => {
  const statePath = buildPersistentStatePath({
    workspaceDir: "/tmp/workspace",
    sessionKey: "agent:main:test",
  });
  assert.match(statePath, /\/tmp\/workspace\/\.omnimemory\/state\/[a-f0-9]+\.json$/);
});

test("buildRecallPromptBlock formats grouped prompt sections", () => {
  const block = buildRecallPromptBlock({
    title: "Recall",
    items: [
      { text: "User prefers tea." },
      { text: "Meeting booked for Friday." },
      { text: "Caroline lives in Hangzhou." },
    ],
  });
  assert.match(block, /<preferences>/);
  assert.match(block, /<plans>/);
  assert.match(block, /<facts>/);
});

test("buildMemoryPluginGuidance references memory_search and memory_get", () => {
  const text = buildMemoryPluginGuidance();
  assert.match(text, /memory_search/);
  assert.match(text, /memory_get/);
});
