# Design records

Durable design-rationale documents (ADR-style) for `iobroker.dp-coupler`.

Unlike `WORKPLAN.md` (a living, prunable task list), these records are meant to
be **append-only history**: they capture the problem framing, *all* design
options that were weighed — including the ones that were rejected or deferred —
and the reasons for the decision. The goal is that a future discussion, even
from a fresh repo clone with no chat history, can reconstruct *why* the code is
shaped the way it is and *what alternatives were already considered*.

When a decision is later revisited, do not delete the old record — add a new one
that supersedes it and cross-link the two.

## Index

- [initial-synchronization-baseline.md](initial-synchronization-baseline.md) —
  one-shot baseline (level-triggered) state transfer at adapter start, so
  datapoints that rarely or never change reach their target at least once per
  adapter lifetime.
