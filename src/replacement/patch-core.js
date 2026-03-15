import { createHash } from "node:crypto";

export const SYSTEM_PROMPT_PATCH_MARKER = "OMNIMEM_REPLACEMENT_PATCH_SYSTEM_PROMPT";
export const BOOTSTRAP_PATCH_MARKER = "OMNIMEM_REPLACEMENT_PATCH_BOOTSTRAP";

const NATIVE_MEMORY_LINE =
  'Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.';
const PATCHED_MEMORY_LINE =
  "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on the active memory provider; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";

const MEMORY_SECTION_HEADER = `const lines = [
    "## Memory Recall",`;

const BOOTSTRAP_INSERT_ANCHOR = "export async function resolveBootstrapFilesForRun(params: {";
const BOOTSTRAP_RETURN_BLOCK = `  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
}`;

const BOOTSTRAP_HELPERS = `// ${BOOTSTRAP_PATCH_MARKER}
function shouldSuppressLocalMemoryBootstrap(config?: OpenClawConfig): boolean {
  const memorySlot = (config as any)?.plugins?.slots?.memory;
  if (memorySlot !== "omnimemory-memory") {
    return false;
  }
  const replacementConfig = (config as any)?.plugins?.entries?.["omnimemory-memory"]?.config;
  if (typeof replacementConfig?.suppressLocalMemoryBootstrap === "boolean") {
    return replacementConfig.suppressLocalMemoryBootstrap;
  }
  return true;
}

function isLocalMemoryBootstrapFile(file: WorkspaceBootstrapFile): boolean {
  const normalized = (file.path || "")
    .trim()
    .replace(/\\\\/g, "/")
    .replace(/^\\.\\//, "")
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "memory.md" || normalized.endsWith("/memory.md")) {
    return true;
  }
  if (normalized.startsWith("memory/") || normalized.includes("/memory/")) {
    return true;
  }
  return false;
}

function suppressLocalMemoryBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const kept = files.filter((file) => !isLocalMemoryBootstrapFile(file));
  const removedCount = files.length - kept.length;
  if (removedCount > 0) {
    warn?.(
      \`omnimemory replacement: suppressed \${removedCount} local memory bootstrap file(s) because plugins.slots.memory=omnimemory-memory\`,
    );
  }
  return kept;
}

`;

const BOOTSTRAP_PATCHED_RETURN_BLOCK = `  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  const maybeSuppressed = shouldSuppressLocalMemoryBootstrap(params.config)
    ? suppressLocalMemoryBootstrapFiles(updated, params.warn)
    : updated;
  return sanitizeBootstrapFiles(maybeSuppressed, params.warn);
}`;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function isSystemPromptPatched(source) {
  return source.includes(`// ${SYSTEM_PROMPT_PATCH_MARKER}`);
}

export function isBootstrapPatched(source) {
  return source.includes(`// ${BOOTSTRAP_PATCH_MARKER}`);
}

export function patchSystemPromptSource(source) {
  if (isSystemPromptPatched(source)) {
    return { changed: false, source };
  }
  if (!source.includes(NATIVE_MEMORY_LINE)) {
    throw new Error("system-prompt anchor line changed upstream; cannot apply patch safely");
  }
  if (!source.includes(MEMORY_SECTION_HEADER)) {
    throw new Error("system-prompt memory section header anchor missing; cannot apply patch safely");
  }
  const withMarker = source.replace(
    MEMORY_SECTION_HEADER,
    `// ${SYSTEM_PROMPT_PATCH_MARKER}
  ${MEMORY_SECTION_HEADER}`,
  );
  return {
    changed: true,
    source: withMarker.replace(NATIVE_MEMORY_LINE, PATCHED_MEMORY_LINE),
  };
}

export function patchBootstrapSource(source) {
  if (isBootstrapPatched(source)) {
    return { changed: false, source };
  }
  if (!source.includes(BOOTSTRAP_INSERT_ANCHOR)) {
    throw new Error("bootstrap-files insertion anchor changed upstream; cannot apply patch safely");
  }
  if (!source.includes(BOOTSTRAP_RETURN_BLOCK)) {
    throw new Error("bootstrap-files return block changed upstream; cannot apply patch safely");
  }
  const withHelpers = source.replace(
    BOOTSTRAP_INSERT_ANCHOR,
    `${BOOTSTRAP_HELPERS}${BOOTSTRAP_INSERT_ANCHOR}`,
  );
  return {
    changed: true,
    source: withHelpers.replace(BOOTSTRAP_RETURN_BLOCK, BOOTSTRAP_PATCHED_RETURN_BLOCK),
  };
}
