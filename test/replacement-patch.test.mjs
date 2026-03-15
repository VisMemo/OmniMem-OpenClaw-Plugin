import test from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_PROMPT_PATCH_MARKER,
  BOOTSTRAP_PATCH_MARKER,
  patchSystemPromptSource,
  patchBootstrapSource,
} from "../src/replacement/patch-core.js";

const SYSTEM_PROMPT_FIXTURE = `
function buildMemorySection(params: { isMinimal: boolean }) {
  const lines = [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
  ];
  return lines;
}
`;

const BOOTSTRAP_FIXTURE = `
import type { OpenClawConfig } from "../config/config.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}) {
  const rawFiles = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = filterBootstrapFilesForSession(rawFiles, "abc");
  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
}
`;

test("patchSystemPromptSource patches native MEMORY.md wording and is idempotent", () => {
  const first = patchSystemPromptSource(SYSTEM_PROMPT_FIXTURE);
  assert.equal(first.changed, true);
  assert.match(first.source, new RegExp(SYSTEM_PROMPT_PATCH_MARKER));
  assert.match(first.source, /run memory_search on the active memory provider/);
  assert.doesNotMatch(first.source, /run memory_search on MEMORY\.md \+ memory\/\*\.md/);

  const second = patchSystemPromptSource(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("patchBootstrapSource injects suppression helper and is idempotent", () => {
  const first = patchBootstrapSource(BOOTSTRAP_FIXTURE);
  assert.equal(first.changed, true);
  assert.match(first.source, new RegExp(BOOTSTRAP_PATCH_MARKER));
  assert.match(first.source, /function shouldSuppressLocalMemoryBootstrap/);
  assert.match(first.source, /const maybeSuppressed = shouldSuppressLocalMemoryBootstrap/);

  const second = patchBootstrapSource(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("patchSystemPromptSource throws when upstream anchor changes", () => {
  assert.throws(() => patchSystemPromptSource("const lines = [];"), {
    message: /anchor line changed upstream/,
  });
});
