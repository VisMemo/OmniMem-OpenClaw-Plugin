import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildPersistentStatePath({ workspaceDir, sessionFile, sessionKey, sessionId }) {
  const workspaceRoot = normalizeString(workspaceDir);
  if (!workspaceRoot) {
    return normalizeString(sessionFile)
      ? `${sessionFile.trim()}.omnimemory-state.json`
      : undefined;
  }
  const baseId = normalizeString(sessionKey) || normalizeString(sessionId);
  if (!baseId) {
    return normalizeString(sessionFile)
      ? `${sessionFile.trim()}.omnimemory-state.json`
      : path.join(workspaceRoot, ".omnimemory", "state", "global.json");
  }
  const digest = createHash("sha1").update(baseId).digest("hex");
  return path.join(workspaceRoot, ".omnimemory", "state", `${digest}.json`);
}

export async function readPersistentState(statePath) {
  if (!normalizeString(statePath)) {
    return undefined;
  }
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writePersistentState(statePath, payload) {
  if (!normalizeString(statePath)) {
    return;
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}
