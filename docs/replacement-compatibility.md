# Replacement Compatibility

`Replacement` is an advanced mode. It is only supported on OpenClaw versions that are explicitly listed here.

## Supported Versions

| OpenClaw Version | Status | Notes |
| --- | --- | --- |
| `2026.3.14` | supported | Validated on the current branch with replacement hook E2E. Prompt injection verification and live smoke are still tracked as release-signoff items in [测试与上线收口TODO.md](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/docs/测试与上线收口TODO.md). |

## Rules

1. If a version is not listed above, `Replacement` must be treated as unsupported.
2. `Overlay` remains the default recommended mode.
3. `manage:replacement`, `patch:apply`, and `doctor` must fail closed on unsupported versions.
4. `patch:status` should always show the current OpenClaw version and whether it matches this matrix.

## Why So Strict

`Replacement` depends on source-level patch anchors in OpenClaw core. That makes it powerful, but also version-sensitive.
The matrix is intentionally narrow so we do not silently ship a partially compatible patch.
