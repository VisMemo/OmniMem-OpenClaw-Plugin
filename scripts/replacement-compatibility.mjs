import { readFileSync } from "node:fs";
import path from "node:path";

export const REPLACEMENT_SUPPORT_MATRIX = Object.freeze([
  Object.freeze({
    version: "2026.3.14",
    status: "supported",
    scope: "replacement",
    notes:
      "Validated on the current branch with replacement hook E2E. Prompt injection verification and live smoke remain tracked in docs/测试与上线收口TODO.md before release signoff.",
  }),
]);

function buildOpenClawPackageJsonPath(openclawRoot) {
  return path.join(openclawRoot, "package.json");
}

export function readOpenClawVersion(openclawRoot) {
  const packageJsonPath = buildOpenClawPackageJsonPath(openclawRoot);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error(`missing version field in ${packageJsonPath}`);
  }
  return {
    packageJsonPath,
    packageName: typeof pkg?.name === "string" ? pkg.name : "openclaw",
    version,
  };
}

export function findReplacementSupportEntry(version) {
  return REPLACEMENT_SUPPORT_MATRIX.find((entry) => entry.version === version) || null;
}

export function resolveReplacementCompatibility(openclawRoot) {
  const openclaw = readOpenClawVersion(openclawRoot);
  const supportEntry = findReplacementSupportEntry(openclaw.version);
  const supportedVersions = REPLACEMENT_SUPPORT_MATRIX.map((entry) => entry.version);
  return {
    openclawRoot,
    ...openclaw,
    supported: Boolean(supportEntry),
    supportEntry,
    supportedVersions,
    reason: supportEntry
      ? `OpenClaw ${openclaw.version} is in the replacement support matrix.`
      : `OpenClaw ${openclaw.version} is not in the replacement support matrix.`,
    impact: supportEntry
      ? "Replacement is allowed to proceed on this version."
      : "Replacement is blocked so we do not install a patch against an unverified OpenClaw build.",
    nextStep: supportEntry
      ? "Proceed with replacement as usual."
      : "Use a validated OpenClaw version from docs/replacement-compatibility.md, or extend the matrix only after running the full replacement verification suite.",
  };
}

export function buildReplacementCompatibilityError(action, report) {
  const lines = [
    `replacement ${action} blocked for OpenClaw ${report.version}`,
    `reason: ${report.reason}`,
    `impact: ${report.impact}`,
    `next step: ${report.nextStep}`,
    `supported versions: ${report.supportedVersions.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

export function assertReplacementCompatibility(openclawRoot, action) {
  const report = resolveReplacementCompatibility(openclawRoot);
  if (!report.supported) {
    throw new Error(buildReplacementCompatibilityError(action, report));
  }
  return report;
}
