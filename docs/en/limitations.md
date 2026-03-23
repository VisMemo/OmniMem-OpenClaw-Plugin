# Limitations

This project is functional, but a few boundaries still matter for external users.

## Current Limits

1. `Overlay` is prompt augmentation, not a native OpenClaw memory provider replacement
2. `Replacement` is version-sensitive and only supported on validated OpenClaw versions
3. Writeback is best-effort and not yet exactly-once across processes
4. OmniMemory retrieval latency can vary with backend indexing delay
5. `Replacement` still has an optional patch layer for cleaner semantics

## Known Gaps

1. `/new` to `before_reset` propagation is still a known OpenClaw core gap
2. Cross-process concurrency is protected in-process, but not proven exactly-once
3. The backend may return relevant but lower-ranked hits that still need tuning

## What This Means

1. Use `Overlay` if you want the safest default path
2. Use `Replacement` only when you accept version checks and advanced setup
3. Treat the system as production-shaped, but not perfect

## Where To Track Changes

1. [Replacement Compatibility](./replacement-compatibility.md)
2. [Architecture](./architecture.md)
3. [Chinese implementation notes](../zh-CN/实现原则.md)
