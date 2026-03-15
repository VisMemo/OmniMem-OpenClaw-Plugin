import { createHash } from "node:crypto";

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
    const text = extractText(raw.content);
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

