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
- [fan-out-and-coupling-identity.md](fan-out-and-coupling-identity.md) — 1:n
  distribution (star) of one source to several targets, and the coupling identity it
  requires: a per-coupling `id` that becomes the channel name, replacing the
  per-source channel layout.
- [admin-ui-mapping-table.md](admin-ui-mapping-table.md) — row-wise table editor
  for the mapping entries in the admin UI, and how a table bound to an array is
  reconciled with the canonical string storage of `mappingsRaw`.
