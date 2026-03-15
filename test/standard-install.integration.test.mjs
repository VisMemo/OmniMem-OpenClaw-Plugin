import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const pluginRoot = "/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin";
const smokeScript = path.join(pluginRoot, "scripts", "run-standard-install-smoke.mjs");

function runSmoke(mode, port) {
  return spawnSync("node", [smokeScript, "--mode", mode, "--port", String(port)], {
    encoding: "utf8",
    env: process.env,
  });
}

test("replacement standard package install smoke passes", () => {
  const result = runSmoke("replacement", 18930);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.mode, "replacement");
  assert.equal(report.plugin.id, "omnimemory-memory");
  assert.match(report.slot, /omnimemory-memory/);
  assert.ok(report.toolCheck?.search?.result?.details?.results?.length > 0);
});

test("overlay standard package install smoke passes", () => {
  const result = runSmoke("overlay", 18931);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.mode, "overlay");
  assert.equal(report.plugin.id, "omnimemory-overlay");
  assert.match(report.slot, /memory-core/);
  assert.equal(report.toolCheck, null);
});
