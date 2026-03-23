# Replacement Mode

`Replacement` is the advanced mode.

It replaces the native memory slot with OmniMemory and exposes:

1. `memory_search`
2. `memory_get`

## Behavior

1. OpenClaw routes memory tool calls to the plugin
2. The plugin queries OmniMemory for retrieval
3. The plugin can optionally write back captured turns
4. Optional patching can reduce prompt/bootstrap noise on supported OpenClaw versions

## When to Use It

1. You want the memory slot itself to be backed by OmniMemory
2. You accept version gating and compatibility checks
3. You are comfortable with an advanced deployment path

## Important Notes

1. `Replacement` is not the default recommendation
2. `Replacement` is version-sensitive and only supported on validated OpenClaw versions listed in [Replacement Compatibility](./replacement-compatibility.md)
3. `Replacement` should be treated as mutually exclusive with `Overlay` on the same OpenClaw instance

## Patch Positioning

Patch is an optional enhancement layer, not a separate mode.

It is useful for advanced users who want cleaner prompt/bootstrap semantics, but the base `Replacement` mode should still work without forcing patching first.
