import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillRoot = path.resolve(__dirname, "..");
const pluginRoot = path.resolve(skillRoot, "../..");
const manageScript = path.join(pluginRoot, "scripts", "omnimemory-manage.mjs");

const passthroughArgs = process.argv.slice(2);
const result = spawnSync("node", [manageScript, "install", ...passthroughArgs], {
  encoding: "utf8",
  env: process.env,
});
if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.status ?? 1;
