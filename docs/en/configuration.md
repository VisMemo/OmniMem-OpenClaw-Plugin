# Configuration

This plugin is configured through standard OpenClaw plugin manifests and the project-managed install script.

## Core Fields

1. `apiKey`
2. `baseUrl`
3. `autoRecall`
4. `autoCapture`
5. `captureStrategy`
6. `suppressLocalMemoryBootstrap` for advanced replacement setups

## Mode Overview

`Overlay` and `Replacement` use different OpenClaw integration points, but both rely on the same OmniMemory backend.

## Typical Overlay Config

```json5
{
  "enabled": true,
  "config": {
    "apiKey": "${OMNI_MEMORY_API_KEY}",
    "baseUrl": "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory",
    "autoRecall": true,
    "autoCapture": true,
    "captureStrategy": "last_turn"
  }
}
```

## Typical Replacement Config

```json5
{
  "enabled": true,
  "config": {
    "apiKey": "${OMNI_MEMORY_API_KEY}",
    "baseUrl": "https://zdfdulpnyaci.sealoshzh.site/api/v1/memory",
    "autoCapture": true,
    "captureStrategy": "last_turn",
    "suppressLocalMemoryBootstrap": true
  }
}
```

## Operational Advice

1. Prefer environment variables for secrets
2. Use the bundled management script for install, switch, and rollback
3. Validate the OpenClaw installation before enabling `Replacement`

