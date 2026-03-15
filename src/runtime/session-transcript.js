import { readFile } from "node:fs/promises";

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractMessageFromEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return entry.message;
  }
  return null;
}

export async function readOpenClawSessionMessages(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    return [];
  }
  const raw = await readFile(sessionFile.trim(), "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseJsonLine)
    .map(extractMessageFromEntry)
    .filter(Boolean);
}
