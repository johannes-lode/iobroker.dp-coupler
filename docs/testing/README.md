# Test specifications

Code-independent, black-box behavioural test specifications for
`iobroker.dp-coupler`. Each document describes *what* is tested, with *which
stimuli*, and the *expected observable result* — without prescribing a test
framework or implementation. The test scaffold and the concrete implementation
are created separately.

> **Repository note:** as of this writing the repo still has **no automated
> tests and no test runner**. That statement changes only once a test scaffold
> exists. These specifications are written ahead of the scaffold on purpose.

## Index

- [initial-synchronization-baseline.testspec.md](initial-synchronization-baseline.testspec.md)
  — the initial baseline transfer (level-triggered one-shot per adapter life)
  and its direct interactions (filter bypass, `enabled`, coercion,
  `propagateAck`, cycle guard, periodic-only mode). Design record:
  [`../design/initial-synchronization-baseline.md`](../design/initial-synchronization-baseline.md).
- [malformed-mapping-entries.testspec.md](malformed-mapping-entries.testspec.md)
  — robustness against incomplete mapping entries: a malformed entry may only be
  dropped with a logged reason, never disturb the other entries or the adapter
  start. Design context:
  [`../design/admin-ui-mapping-table.md`](../design/admin-ui-mapping-table.md) §8.
