import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const pluginRoot = "/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin";
const openclawRoot = "/Users/zhaoxiang/工作/Openclaw/openclaw";
const installerScript = path.join(
  pluginRoot,
  "skills",
  "omnimemory-installer",
  "scripts",
  "install_omnimemory.mjs",
);

function runNode(args, env = process.env) {
  return spawnSync("node", [installerScript, ...args], {
    encoding: "utf8",
    env: {
      ...env,
      NODE_NO_WARNINGS: "1",
    },
  });
}

function runOpenClaw(args, env) {
  return spawnSync("node", [path.join(openclawRoot, "dist", "index.js"), ...args], {
    encoding: "utf8",
    env: {
      ...env,
      NODE_NO_WARNINGS: "1",
    },
  });
}

test("memory manifest exposes suppressLocalMemoryBootstrap for replacement patch installs", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, "plugins", "omnimemory-memory", "openclaw.plugin.json"), "utf8"),
  );
  assert.equal(manifest.configSchema.properties.suppressLocalMemoryBootstrap.type, "boolean");
  assert.ok(manifest.uiHints.suppressLocalMemoryBootstrap);
});

test("installer dry-run produces overlay and replacement plans", () => {
  const overlay = runNode([
    "--mode",
    "overlay",
    "--plugin-root",
    pluginRoot,
    "--openclaw-root",
    openclawRoot,
    "--dry-run",
  ]);
  assert.equal(overlay.status, 0, overlay.stderr || overlay.stdout);
  const overlayReport = JSON.parse(overlay.stdout);
  assert.equal(overlayReport.mode, "overlay");
  assert.ok(overlayReport.steps.some((step) => step.includes("plugins install")));
  assert.ok(
    overlayReport.steps.some(
      (step) =>
        step.includes("plugins.entries.omnimemory-overlay.config") && step.includes("\"autoRecall\":true"),
    ),
  );

  const replacement = runNode([
    "--mode",
    "replacement",
    "--plugin-root",
    pluginRoot,
    "--openclaw-root",
    openclawRoot,
    "--apply-patch",
    "--dry-run",
  ]);
  assert.equal(replacement.status, 0, replacement.stderr || replacement.stdout);
  const replacementReport = JSON.parse(replacement.stdout);
  assert.equal(replacementReport.mode, "replacement");
  assert.ok(replacementReport.steps.some((step) => step.includes("plugins.slots.memory")));
  assert.ok(replacementReport.steps.some((step) => step.includes("openclaw-replacement-patch.mjs apply")));
});

test("installer installs overlay as a standard plugin package through OpenClaw CLI fallback", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omnimem-installer-test-"));
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: path.join(tmpRoot, "openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(tmpRoot, "state"),
    OMNI_MEMORY_API_KEY: "qbk_test",
  };
  const result = runNode(
    [
      "--mode",
      "overlay",
      "--plugin-root",
      pluginRoot,
      "--openclaw-root",
      openclawRoot,
      "--skip-restart",
    ],
    env,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.validation.valid, true);

  const infoGet = runOpenClaw(["plugins", "info", "omnimemory-overlay", "--json"], env);
  assert.equal(infoGet.status, 0, infoGet.stderr || infoGet.stdout);
  assert.match(infoGet.stdout, /"id": "omnimemory-overlay"/);

  const enabledGet = runOpenClaw(["config", "get", "plugins.entries.omnimemory-overlay.enabled"], env);
  assert.equal(enabledGet.status, 0, enabledGet.stderr || enabledGet.stdout);
  assert.match(enabledGet.stdout, /true/);

  const allowGet = runOpenClaw(["config", "get", "plugins.allow"], env);
  assert.equal(allowGet.status, 0, allowGet.stderr || allowGet.stdout);
  assert.match(allowGet.stdout, /omnimemory-overlay/);
});
