import { createHash } from "node:crypto";

const INJECTED_MEMORY_LINES = new Set([
  "OmniMemory overlay is active for external long-term memory recall.",
  "Active memory provider: OmniMemory.",
  "Use memory_search before answering questions about prior work, dates, people, preferences, or todos.",
  "Use memory_get only after memory_search when you need more detail.",
  "Do not assume memories come from local MEMORY.md files.",
]);

function normalizeRole(value) {
  if (typeof value !== "string") {
    return null;
  }
  const role = value.trim().toLowerCase();
  return ["user", "assistant", "tool", "system"].includes(role) ? role : null;
}

function extractText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object")
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          return block.text.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

export function sanitizeCapturedText(text) {
  if (typeof text !== "string") {
    return "";
  }
  const withoutRecallBlocks = text.replace(/<omnimemory-recall\b[\s\S]*?<\/omnimemory-recall>/gi, " ");
  const withoutInjectedLines = withoutRecallBlocks
    .split("\n")
    .filter((line) => !INJECTED_MEMORY_LINES.has(line.trim()))
    .join("\n");
  return withoutInjectedLines
    .replace(/\n[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function normalizeOpenClawMessages(messages, options = {}) {
  const allowedRoles = new Set(options.captureRoles || ["user", "assistant"]);
  const normalized = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const role = normalizeRole(raw.role);
    if (!role || !allowedRoles.has(role)) {
      continue;
    }
    const text = sanitizeCapturedText(extractText(raw.content));
    if (!text) {
      continue;
    }
    normalized.push({
      role,
      text,
      name: typeof raw.name === "string" ? raw.name.trim() || undefined : undefined,
      timestampIso:
        typeof raw.timestamp === "string"
          ? raw.timestamp
          : typeof raw.timestampIso === "string"
            ? raw.timestampIso
            : undefined,
    });
  }
  return normalized;
}

export function selectMessagesForCapture(messages, strategy = "last_turn") {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  if (strategy === "full_session") {
    return [...messages];
  }
  const lastUserIndex = [...messages].map((msg) => msg.role).lastIndexOf("user");
  if (lastUserIndex === -1) {
    return messages.slice(-2);
  }
  const selected = [messages[lastUserIndex]];
  for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg.role === "user") {
      break;
    }
    selected.push(msg);
  }
  return selected;
}

export function fingerprintMessages(messages) {
  return createHash("sha1").update(JSON.stringify(messages)).digest("hex");
}
