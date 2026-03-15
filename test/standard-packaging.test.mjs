import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const pluginRoot = "/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin";

for (const pluginId of ["omnimemory-overlay", "omnimemory-memory"]) {
  test(`${pluginId} is a standard OpenClaw-installable package root`, async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(pluginRoot, "plugins", pluginId, "package.json"), "utf8"),
    );
    assert.deepEqual(packageJson.openclaw.extensions, ["./index.js"]);
    assert.equal(packageJson.type, "module");

    const manifest = JSON.parse(
      await readFile(path.join(pluginRoot, "plugins", pluginId, "openclaw.plugin.json"), "utf8"),
    );
    assert.equal(manifest.id, pluginId);

    const runtimeConfig = await readFile(
      path.join(pluginRoot, "plugins", pluginId, "runtime", "config.js"),
      "utf8",
    );
    assert.match(runtimeConfig, /DEFAULT_BASE_URL/);

    const sharedResult = await readFile(
      path.join(pluginRoot, "plugins", pluginId, "shared", "result.js"),
      "utf8",
    );
    assert.match(sharedResult, /jsonResult/);
  });
}
