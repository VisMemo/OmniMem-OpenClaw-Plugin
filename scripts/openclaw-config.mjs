import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveConfigPathFromEnv(env = process.env) {
  const configOverride = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (configOverride) {
    return path.resolve(configOverride);
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(path.resolve(stateDir), "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

export function parseConfigText(text, openclawRoot) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const requireFromOpenClaw = createRequire(path.join(openclawRoot, "package.json"));
      const json5 = requireFromOpenClaw("json5");
      return json5.parse(text);
    } catch (error) {
      throw new Error(
        `failed to parse config as JSON/JSON5: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function loadConfigObject(openclawRoot, env = process.env) {
  const configPath = resolveConfigPathFromEnv(env);
  try {
    const text = readFileSync(configPath, "utf8");
    const parsed = parseConfigText(text, openclawRoot);
    return {
      configPath,
      config: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { configPath, config: {} };
    }
    throw error;
  }
}
