# Overlay Mode

`Overlay` is the default recommended mode.

It augments OpenClaw through hooks without taking over the native memory slot.

## Behavior

1. `before_prompt_build` injects recalled memory into the prompt
2. `agent_end` captures conversation turns for writeback
3. `before_compaction` can flush from the session transcript before compaction
4. `before_reset` can preserve memory before a `/new` or `/reset` style transition

## Why Use It

1. Lowest risk
2. Easy to roll back
3. Works well for trials, evaluation, and incremental adoption

## What It Does Not Do

1. It does not replace `plugins.slots.memory`
2. It does not change OpenClaw's native memory provider contract
3. It does not require core patching

## Best Fit

Use `Overlay` if you want memory augmentation first and operational safety second.

