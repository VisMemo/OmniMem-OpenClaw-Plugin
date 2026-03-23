# Getting Started

OmniMem-OpenClaw-Plugin adds OmniMemory to OpenClaw in two modes:

1. `Overlay` for non-destructive memory augmentation
2. `Replacement` for advanced memory-slot replacement

If you are trying this for the first time, start with `Overlay`.

## Requirements

1. OpenClaw installed or checked out locally
2. Node.js 22+
3. An OmniMemory API key

## Quick Start

```bash
cd OmniMem-OpenClaw-Plugin
node scripts/omnimemory-manage.mjs install --mode overlay
node scripts/omnimemory-manage.mjs status
```

For a stricter memory-slot setup:

```bash
cd OmniMem-OpenClaw-Plugin
node scripts/omnimemory-manage.mjs install --mode replacement
node scripts/omnimemory-manage.mjs status
```

## What You Get

1. A standard OpenClaw plugin package for `overlay`
2. A `memory` slot plugin package for `replacement`
3. Install, switch, rollback, and smoke-test helpers

## Recommended Reading

1. [Overlay Mode](./overlay-mode.md)
2. [Replacement Mode](./replacement-mode.md)
3. [Configuration](./configuration.md)
4. [Architecture](./architecture.md)
5. [Limitations](./limitations.md)
6. [Replacement Compatibility](./replacement-compatibility.md)
7. [Agent Installation](./agent-installation.md)
