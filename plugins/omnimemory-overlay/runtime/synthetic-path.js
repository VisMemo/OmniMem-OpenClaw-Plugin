import { createHash } from "node:crypto";

export function buildSyntheticPath(item, index = 0) {
  const hash = createHash("sha1")
    .update(JSON.stringify([item.eventId || "", item.entity || "", item.text || "", index]))
    .digest("hex")
    .slice(0, 12);
  if (item.eventId) {
    return `omni:event:${encodeURIComponent(item.eventId)}:${hash}`;
  }
  if (item.entity) {
    return `omni:entity:${encodeURIComponent(item.entity)}:${hash}`;
  }
  return `omni:item:${hash}`;
}

export function parseSyntheticPath(path) {
  if (typeof path !== "string") {
    return null;
  }
  const trimmed = path.trim();
  if (!trimmed.startsWith("omni:")) {
    return null;
  }
  const parts = trimmed.split(":");
  const kind = parts[1];
  if (kind === "event" && parts[2]) {
    return { kind, value: decodeURIComponent(parts[2]) };
  }
  if (kind === "entity" && parts[2]) {
    return { kind, value: decodeURIComponent(parts[2]) };
  }
  if (kind === "item" && parts[2]) {
    return { kind, value: parts[2] };
  }
  return null;
}

