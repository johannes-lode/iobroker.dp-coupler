# Test specification — Fan-out and coupling identity

**Feature under test:** 1:n distribution of one source to several targets, the
per-coupling `id` that names the channel objects, and the housekeeping around both.
**Design record:** [`../design/fan-out-and-coupling-identity.md`](../design/fan-out-and-coupling-identity.md).
**Style:** black-box / behavioural. Assertions on observable effects only — writes,
objects, states, log output.

---

## 1. Scope

In scope: fan-out relaying, id assignment and validation, channel identity and
metadata, orphan cleanup, the downgrade of bidirectional star branches, per-coupling
`enabled` and baseline, and the sync tick with fan-out.

Out of scope: the deferred bidirectional star (design record §5 phase 2), cycle
detection (backlog), and a full regression of filter/coercion behaviour beyond the
fan-out touch points.

---

## 2. Observation model

**Stimulus** — as in the other specs (S1 set foreign states with full control of
`val`/`ack`/`ts`/`lc`, S2 start/stop with a chosen configuration, S3 write the
adapter's own `channels.<id>.enabled`, S4 pre-seed a target before start), plus:

- **S5** Write `native.mappingsRaw` directly (CLI path), including entries **without**
  an `id` field.

**Observation** — as in the other specs (O1 every write the adapter issues, in order,
with the ability to assert *no* write; O2 `info.connection` and `ready`; O3 enumerate
objects below `channels.`; O4 the log at warn/info; O5 read back
`native.mappingsRaw`), plus:

- **O6** Read an object's `common.name` and `common.desc`.

---

## 3. Test groups

### Group A — Fan-out relaying

| # | Configuration | Stimulus | Expected |
|---|---|---|---|
| A1 | one source S, two targets T1, T2 | S changes | **both** T1 and T2 receive exactly one write |
| A2 | S→T1, S→T2, S→T3 | S changes | all three written; order follows the row order |
| A3 | S→T1 (`on change` = yes), S→T2 (`on change` = no) | unchanged re-write of S (`lc < ts`) | **only T2** written — the filters are per coupling, not per event |
| A4 | S→T1 disabled, S→T2 enabled | S changes | only T2 written; `lastValue` of **both** couplings updated |
| A5 | S→T1, S→T2 | — | two channels exist, each with its own `enabled` and `lastValue` |
| A6 | two sources S1, S2 → same target T (n:1) | both change | both writes reach T (regression: this already worked before fan-out) |

### Group B — Coupling id

| # | Stimulus | Expected |
|---|---|---|
| B1 | entry without `id` via CLI (S5), adapter start | an id is assigned, **written into `native.mappingsRaw`** (O5), and the channel is named after it |
| B2 | restart after B1 | the id is **unchanged** and no second channel appears — the persisted id is reused |
| B3 | entry with `id: "my-coupling"` | channel is `channels.my-coupling.*` |
| B4 | `id: "with.dot"` | rejected as unusable, replaced by a generated id, warning logged (a dot would create sub-channels) |
| B5 | `id: "with space"`, `id: ""`, `id` 33 chars | as B4 |
| B6 | two entries with the same `id` | second entry dropped with a warning naming the id; the first relays; configuration untouched (O5) |
| B7 | two entries with identical `(source, target)` but different ids | second dropped with a warning |
| B8 | 20 entries without ids | 20 **distinct** ids assigned (no collision from the generator) |

### Group C — Channel identity, metadata and cleanup

| # | Stimulus | Expected |
|---|---|---|
| C1 | coupling with `_comment` | channel `common.name` is `"<source> → <target>"`, `common.desc` is the comment (O6) |
| C2 | coupling without `_comment` | `common.name` set, no `desc` |
| C3 | delete a row, restart | that channel and its children are **gone** (O3); the remaining channels untouched |
| C4 | **upgrade case:** pre-0.4.0 channels present (`channels.<source_with_underscores>.*`), new configuration with ids | old channels removed at startup, new ones created; log reports the removal count |
| C5 | change a coupling's `id`, restart | new channel created, old one removed — `enabled` starts from the seed again (documented breaking behaviour) |

### Group D — Bidirectional in a star (rewritten for 0.4.3)

Bidirectional branches are **permitted**; the adapter only warns. D2–D6 replace the
downgrade cases of 0.4.0–0.4.2.

| # | Configuration | Stimulus | Expected |
|---|---|---|---|
| D1 | S↔T1 only (source used once) | T1 changes | relayed back to S; **no** warning |
| D2 | S↔T1 **and** S→T2 | adapter start | exactly **one** warning, naming the source, the number of targets and the bidirectional coupling's id |
| D3 | S↔T1 and S↔T2 | adapter start | **one** warning (per source, not per coupling), naming both ids |
| D4 | S↔T1, S↔T2, **no** periodic sync | T1 changes | S written; **T2 not written** (the documented weakness); warning text says the branches keep their previous value |
| D5 | as D4 but **with** periodic sync | T1 changes, then one tick | S written, then T2 reaches the new value at the tick; warning text names the interval in ms |
| D6 | S↔T1, S↔T2 | T1 and T2 change in quick succession | **non-deterministic by design** — either all three converge on the later value, or source and the later branch hold it while the earlier one keeps its own. The test may only assert that *no* infinite relay occurs and that the source holds one of the two written values; with periodic sync, that everything converges within one tick |

D6 must not be written as a deterministic expectation. `inFlight` is a Set without a
counter, so the outcome depends on whether the first echo arrives before or after the
second write — see the design record's case analysis.

### Group E — Baseline and sync tick with fan-out

| # | Stimulus | Expected |
|---|---|---|
| E1 | S→T1, S→T2, S has a value at start, both targets differ | baseline writes **both** targets (regression for the per-coupling `pendingBaseline`: a per-source key would have served only T1) |
| E2 | S→T1, S→T2, T1 already equals S, T2 differs | only T2 written (compare-then-write, per coupling) |
| E3 | S→T1 disabled at start, S→T2 enabled | T2 baselined; T1 stays pending; enabling T1 later writes it (forced, never baselined this life) |
| E4 | S→T1, S→T2, sync interval active | every tick writes **both** targets |
| E5 | S→T1, S→T2, S has no value yet at start | both stay pending; the first event of S completes both |

### Group F — `lastState` after a write-back (added 2026-09-28)

The cache means "last known value of the source", regardless of who wrote it. These
cases are **independent of fan-out** — they also apply to a plain bidirectional
coupling — and they are the regression guard for the periodic sync undoing a change.

| # | Configuration | Stimulus | Expected |
|---|---|---|---|
| F1 | `S ↔ T`, **sync interval active** | T is changed (so the adapter writes S) | the next tick writes T with the **new** value, not the old one — T keeps what was set there |
| F2 | as F1 | T is changed, then wait for two ticks | T stays at the new value; no oscillation between old and new |
| F3 | `S ↔ T`, no sync interval | T is changed | S is written once; no further writes (the echo is still discarded — the guard keeps working) |
| F4 | `S → T1`, `S → T2` | S changes | unchanged behaviour: one write each, `lastState` reflects S |
| F5 | `S ↔ T`, coupling **disabled** | T is changed | no write to S; but if S changes from outside, `lastValue` still tracks it |
| F6 | a state that is target of a unidirectional coupling **and** source of another (`A → B`, `B → C`) | A changes | B written, then C written from the B echo's cached value — the chain resolves and `inFlight` is left clean (a second A change must relay again) |

**F1 is the case the fault was found for.** Before the fix the tick wrote the stale
cached value back to T, silently undoing the change made there while S kept the new
one. F6 guards the flip side: the cycle guard must still clear its entry for every
incoming id, otherwise the next genuine event is swallowed.

### Group G — `syncCompare` (added 0.5.0)

Per-entry choice between the tick's two purposes. Default **off** = unconditional, the
behaviour of every earlier version.

| # | Configuration | Stimulus | Expected |
|---|---|---|---|
| G1 | `S → T`, sync interval set, `sync cmp` **off**, T already equals S | one tick | **a write happens** — the heartbeat purpose; the timestamp is the point |
| G2 | as G1 but `sync cmp` **on** | one tick | **no write** to T (O1 must assert absence) |
| G3 | as G2 but T differs from S | one tick | T is written once |
| G4 | two couplings on the same source, one `on`, one `off`, both targets equal | one tick | the `off` one is written, the `on` one is not — the setting really is per entry |
| G5 | `sync cmp` = `(def)`, adapter default `on` | one tick, target equal | no write — the default is honoured |
| G6 | `sync cmp` **on**, coupling disabled | one tick | no write, no read either (the enabled check comes first) |
| G7 | `sync cmp` **on**, target read fails | one tick | falls through and **writes** (a failed read must not silence the coupling) |
| G8 | `sync cmp` **on**, bidirectional star, one branch writes back | one tick after the write-back | the sibling branch is written (convergence), the branch that already matches is not |

G1 is the regression guard for the heartbeat: a well-meant "optimization" that compares
everywhere would break watchdog targets silently. G8 is the reason the flag was pulled
ahead of immediate propagation.

---

## 4. Coverage matrix

| Behaviour | Cases |
|---|---|
| Fan-out relaying, per-coupling filters | A1–A5 |
| n:1 regression | A6 |
| Id assignment, persistence, validation | B1–B5, B8 |
| Duplicate id / duplicate pair | B6, B7 |
| Channel naming and metadata | C1, C2 |
| Orphan cleanup, incl. the upgrade | C3–C5 |
| Bidirectional star: warning, weakness, convergence | D1–D5 |
| Non-determinism with two writing branches | D6 |
| Baseline per coupling | E1–E3, E5 |
| Sync tick with fan-out | E4 |
| Cache after a write-back, sync not undoing it | F1, F2, F5 |
| Cycle guard still clearing its entry | F3, F6 |
| Heartbeat stays unconditional | G1 |
| `syncCompare` skips matching targets, per entry | G2–G5 |
| `syncCompare` edge cases (disabled, read failure, star) | G6–G8 |

---

## 5. Notes for the implementer

- **B1/B2 together** are the important pair: assignment alone is not enough, the id
  must survive a restart. If it did not, every start would rename the channels.
- **A3 is the discriminating case** for "filters are per coupling". A test that only
  checks that both targets receive something would pass even if the flags were read
  from the wrong entry.
- **E1** is the regression guard for the baseline bookkeeping change; it fails
  silently in the old per-source design (only the first target gets a value).
- Assert **absence** of writes explicitly (O1) in A3, A4, D2 and E2.
- The repository still has no test scaffold; this specification is written ahead of it.
