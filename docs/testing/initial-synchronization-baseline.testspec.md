# Test specification — Initial synchronization (baseline transfer)

**Feature under test:** the level-triggered one-shot baseline transfer added
2026-07-17, plus its direct interactions.
**Design record:** [`../design/initial-synchronization-baseline.md`](../design/initial-synchronization-baseline.md).
**Style:** black-box / behavioural. Assertions are made only on observable
effects; internal state (`pendingBaseline`, `inFlight`) is verified indirectly
through subsequent observable behaviour.

---

## 1. Scope

In scope — the baseline mechanism and the code paths it shares or bypasses:

- Startup baseline pass (`runBaselinePass()` during `onReady`).
- Event-driven baseline completion (first event of a still-pending source).
- Enable-triggered baseline (`enabled` false→true).
- Compare-then-write vs. forced write.
- Bypass of the `forwardOnAck` and `forwardChangesOnly` filters by the baseline.
- Interaction with `enabled`, type coercion, `propagateAck`, the cycle guard
  (`inFlight`), and periodic-only mode.
- Ephemeral re-evaluation on every adapter start.

Out of scope (not implemented / covered elsewhere): Option C
(connection-event-driven re-check), JSONata transform (Feature B), and a full
regression of ordinary relay/filter/coercion/periodic behaviour beyond the
baseline touch points.

---

## 2. Observation model (required harness capabilities)

The scaffold must provide, in a framework-agnostic way:

**Stimulus**
- **S1** Set any *foreign* source/target state with full control of `val`,
  `ack`, `ts`, `lc`, and `q`, as if written by another adapter. (For a genuine
  "unchanged re-write" set `lc < ts`; for a genuine change set `lc === ts`.)
- **S2** Start / stop / restart the adapter instance with a chosen mapping
  configuration and chosen adapter-level defaults.
- **S3** Write the adapter's own `channels.<id>.enabled` datapoint as a command
  (`ack: false`), to drive enable/disable at runtime.
- **S4** Pre-seed a target/source state *before* the adapter starts.

**Observation**
- **O1** Record **every write the adapter issues to a target/source state** —
  each with its `val`, `ack`, and `q`, and in order. A write must be
  distinguishable from the test's own stimulus writes; the recommended
  black-box discriminator is the state's `from` field
  (`from === "system.adapter.dp-coupler.<instance>"`).
  **Crucial:** the harness must be able to assert *"the adapter issued **no**
  write to T"* — the compare-then-write behaviour is invisible if only the final
  value is inspected (an equal value may already be present).
- **O2** Read the adapter's own `channels.<id>.enabled` and
  `channels.<id>.lastValue` datapoints (value + `ack` + `ts`).
- **O3** Read `info.connection` and await its transition to `true` (adapter
  ready). **The startup baseline pass completes before `info.connection`
  becomes `true`** — a test may inspect startup writes once ready.
- **O4** Capture the adapter log (to assert the baseline summary line, optional
  / secondary).

**Timing note.** Event- and enable-driven cases stimulate *after* `info.connection
= true`. Each assertion should allow the adapter a bounded settle interval; then
assert the recorded write sequence (O1). "No write" assertions verify that no
adapter-originated write to the state was recorded within that interval.

---

## 3. Conventions and default fixture

Unless a case states otherwise:

- One mapping entry: `S → T`, unidirectional, no per-entry overrides.
- Adapter defaults: `forwardOnAckDefault=false`, `forwardChangesOnlyDefault=true`,
  `propagateAckDefault=false`, `coerceTypesDefault=true`,
  `coerceStringsDefault=false`, `syncIntervalValue=0` (periodic sync off),
  `relayOnChange=false`, `enabledDefault=true`.
- `S` and `T` are `number`-typed states (so coercion is a no-op) except in the
  coercion group.
- "**writes V to T**" = the adapter issues exactly one target write carrying
  value `V`; "**no write to T**" = zero adapter-originated writes to `T`.
- Each case is independent: fresh instance, fresh `pendingBaseline`.

Traceability tags reference the design record: D1–D4 (dimensions), §3 (mechanic),
§4 (limits).

---

## 4. Test groups and cases

### Group A — Startup baseline pass (`runBaselinePass`)  [D1-B, D2, §3]

**BSL-START-01 — target differs → one write**
- Pre (S4): `S = 5` (ack true, lc<ts), `T = 0`.
- When: start adapter (S2), await ready (O3).
- Then: adapter **writes 5 to T** exactly once, with `ack:false` (propagateAck
  default). `channels.<S>.lastValue = 5`.

**BSL-START-02 — target already equals → no write (compare-then-write)**
- Pre: `S = 7`, `T = 7`.
- When: start, await ready.
- Then: **no write to T**. `lastValue = 7`. (Proves compare skips an already
  synced target; the founding "no needless re-actuation" property.)

**BSL-START-03 — target never written (null) → write**
- Pre: `S = 3`; `T` has never been set (val `null`).
- When: start, await ready.
- Then: adapter **writes 3 to T**.

**BSL-START-04 — source unavailable at start → no write, stays pending**
- Pre: `S` never set (val `null`); `T = 0`.
- When: start, await ready.
- Then: **no write to T** at startup. (Pending state proven by BSL-EVENT-04.)

**BSL-START-05 — source disabled at start → no write, stays pending**
- Config: entry `enabled:false` (or pre-set the channel disabled).
- Pre: `S = 9`, `T = 0`.
- When: start, await ready.
- Then: **no write to T**. `channels.<S>.enabled = false`. (Pending proven by
  BSL-ENABLE-01.)

**BSL-START-06 — mixed set → aggregate summary**
- Pre: three entries; S_a available+differs, S_b available+equal, S_c
  unavailable.
- When: start, await ready.
- Then: write to T_a only; none to T_b, T_c. Log summary (O4) reports
  `1 written, 1 pending` (S_b counts as checked-not-written, S_c as pending).
  *(Log assertion secondary; write assertions primary.)*

**BSL-START-07 — baseline runs before `info.connection`**
- Pre: `S = 4`, `T = 0`.
- When: start; capture write order relative to the `info.connection=true`
  transition.
- Then: the write to T is recorded **before** `info.connection` becomes `true`.

### Group B — Event-driven completion (first event of a pending source)  [D1-B, §3]

**BSL-EVENT-01 — first event with ack:true completes baseline (forwardOnAck bypass)**
- Pre: `S` unavailable at start (pending, BSL-START-04 precondition); `T = 0`.
- When: after ready, stimulate `S = 8` with **`ack:true`, `lc===ts`** (S1).
- Then: adapter **writes 8 to T**. (Under normal relay `forwardOnAck=false`
  would filter an ack:true event; the baseline path bypasses it.)

**BSL-EVENT-02 — first event that is an unchanged re-write completes baseline (forwardChangesOnly bypass)**
- Pre: `S` unavailable at start (pending); `T = 0`.
- When: after ready, stimulate `S = 6` with **`ack:false`, `lc < ts`** (an
  unchanged re-write).
- Then: adapter **writes 6 to T**. (Normal relay `forwardChangesOnly=true` would
  filter `lc<ts`; the baseline bypasses it.)

**BSL-EVENT-03 — after completion, normal filters resume**
- Pre: as BSL-EVENT-01 (completes on first ack:true event → writes 8 to T).
- When: stimulate a **second** event `S = 8` again with `ack:true`.
- Then: **no further write to T** for the second event (baseline already done;
  `forwardOnAck=false` now filters the ack:true event). Establishes that the
  bypass is one-shot.

**BSL-EVENT-04 — pending source’s first event is relayed even though it never was at startup**
- This is the observable proof of BSL-START-04 "stays pending".
- Pre + When: BSL-START-04, then a first event `S = 2` (`ack:true`).
- Then: adapter **writes 2 to T** (a plain event would have been filtered).

**BSL-EVENT-05 — first event compares (equal → no write, but completes)**
- Pre: `S` unavailable at start (pending); `T = 5`.
- When: first event `S = 5` (`ack:true`, `lc===ts`).
- Then: **no write to T** (compare equal). Completion proven by follow-up: then
  stimulate a genuine change `S = 6` (`ack:false`, `lc===ts`) → adapter
  **writes 6 to T** via the ordinary relay (i.e., it is no longer treated as
  pending/forced, and the ordinary change is relayed).

**BSL-EVENT-06 — disabled pending source: event does not complete baseline**
- Config/pre: entry `enabled:false`; `S` unavailable at start; `T = 0`.
- When: after ready, first event `S = 4` (`ack:true`).
- Then: **no write to T** (the `enabled` check precedes baseline completion).
  `channels.<S>.lastValue = 4` is still updated (cache updates before the enabled
  check). Remains pending → proven by BSL-ENABLE-02.

**BSL-EVENT-07 — reverse (bidirectional target) event does not trigger baseline**
- Config: entry `bidirectional:true`. Pre: `S` and `T` both unavailable/`0`.
- When: after ready, stimulate a change on **T** (the reverse direction).
- Then: the reverse relay follows ordinary rules; **no baseline-forced write to S**
  occurs on account of pending state (baseline is forward-only). *(This case
  guards the `forwardEntry &&` condition.)*

### Group C — Enable-triggered baseline (`enabled` false→true)  [D4, §3]

**BSL-ENABLE-01 — disabled-at-start, values equal → FORCED write on enable**
- Config/pre: entry `enabled:false`; `S = 5`, `T = 5` (already equal).
- When: after ready (no startup write, BSL-START-05), enable the channel via
  command (S3: write `channels.<S>.enabled = true`, `ack:false`).
- Then: adapter **writes 5 to T** exactly once **despite equality** (force,
  because the source was never baselined this life). This is the intuitive
  "enable pushes the value" behaviour and the once-per-life guarantee.

**BSL-ENABLE-02 — disabled-at-start, source changed while disabled → forced write of latest value**
- Config/pre: entry `enabled:false`; `S = 1`, `T = 0`.
- When: after ready, stimulate `S = 9` while still disabled (updates cache, no
  write — BSL-EVENT-06 semantics); then enable via command.
- Then: adapter **writes 9 to T** (the latest cached value, forced).

**BSL-ENABLE-03 — already-baselined channel, re-enable with drift → compare writes**
- Config/pre: entry enabled; `S = 3`, `T = 0` → startup writes 3 to T
  (BSL-START-01). Then disable via command. Then stimulate `S = 8` while
  disabled (cache updates, no write).
- When: re-enable via command.
- Then: adapter **writes 8 to T** (compare-then-write: differs, and this time
  *not* forced because the channel was already baselined at startup — but the
  observable write is the same; distinguish force vs compare via BSL-ENABLE-04).

**BSL-ENABLE-04 — already-baselined channel, re-enable without drift → NO write (compare)**
- Config/pre: entry enabled; `S = 3`, `T = 0` → startup writes 3 (pending
  cleared). Then disable; **no** change to S while disabled (cache stays 3,
  target still 3 from the startup write).
- When: re-enable via command.
- Then: **no write to T** (compare equal, and force is `false` because already
  baselined). Contrast with BSL-ENABLE-01, where an equal target *was* written
  because the channel was never baselined — this pair isolates force vs. compare.

**BSL-ENABLE-05 — enable confirmation does not double-trigger**
- Config/pre: entry `enabled:false`; `S = 5`, `T = 0`.
- When: enable via command (`ack:false`). The adapter confirms the enable DP
  with `ack:true`, which re-enters the state handler.
- Then: exactly **one** write to T results from the enable transition (the
  `prev === false` guard suppresses a second trigger on the ack:true
  confirmation). Also: `channels.<S>.enabled` ends at `true` with `ack:true`.

**BSL-ENABLE-06 — enable with no cached source value → no write**
- Config/pre: entry `enabled:false`; `S` never set (`null`); `T = 0`.
- When: enable via command.
- Then: **no write to T** (guard: no cached value). Source remains pending; a
  later first event still completes it (as BSL-EVENT-04, now enabled).

### Group D — Coercion interaction  [Feature A × baseline, §3]

**BSL-COERCE-01 — baseline coerces value to target type**
- Config/pre: `S` is `boolean`, `T` is `number`; `coerceTypesDefault=true`.
  `S = true`, `T = 0`.
- When: start, await ready.
- Then: adapter **writes 1 to T** (bool→number, C convention).

**BSL-COERCE-02 — compare is done on the coerced value (equal → no write)**
- Config/pre: `S` `boolean`, `T` `number`; `S = true`, `T = 1`.
- When: start, await ready.
- Then: **no write to T** (coerced `1` equals target `1`; the compare must run
  after coercion, otherwise `true !== 1` would falsely trigger a write).

**BSL-COERCE-03 — forced enable write also coerces**
- Config/pre: entry `enabled:false`; `S` `boolean = false`, `T` `number = 0`
  (equal after coercion).
- When: after ready, enable via command.
- Then: adapter **writes 0 to T** (forced, coerced from `false`).

### Group E — `propagateAck` interaction  [§3]

**BSL-ACK-01 — default: target written with ack:false**
- Pre: `S = 5` (`ack:true`), `T = 0`; `propagateAckDefault=false`.
- When: start, await ready.
- Then: write to T carries **`ack:false`** (command semantics), regardless of
  the source ack.

**BSL-ACK-02 — propagateAck true: source ack is carried**
- Config: entry `propagateAck:true`. Pre: `S = 5` (`ack:true`), `T = 0`.
- When: start, await ready.
- Then: write to T carries **`ack:true`** (mirrors source). *(Optionally assert
  `q` is propagated from source to target.)*

### Group F — Cycle guard interaction  [§3]

**BSL-CYCLE-01 — bidirectional baseline write does not echo back to source**
- Config: entry `bidirectional:true`. Pre: `S = 5`, `T = 0`.
- When: start, await ready. The startup baseline writes 5 to T; the resulting
  `onStateChange(T)` echo must be swallowed by `inFlight`.
- Then: adapter **writes 5 to T** once and issues **no reverse write to S** as a
  consequence. (A missing guard would relay T back to S.)

### Group G — Periodic-only mode interaction  [§3, `relayOnChange`]

**BSL-PERIODIC-01 — baseline runs immediately even in periodic-only mode**
- Config: `syncIntervalValue` large (e.g. 3600 s), `syncUnit:"s"`,
  `relayOnChange=false` (periodic-only). Pre: `S = 5`, `T = 0`.
- When: start, await ready — **before** the first periodic tick elapses.
- Then: adapter **writes 5 to T** at startup (baseline), not waiting for the
  first tick. (Baseline is independent of the periodic timer.)

**BSL-PERIODIC-02 — event completion works in periodic-only mode**
- Config: as BSL-PERIODIC-01. Pre: `S` unavailable at start (pending); `T = 0`.
- When: after ready, first event `S = 8` (`ack:true`), before any tick.
- Then: adapter **writes 8 to T** (baseline completion sits before the
  periodic-only guard). Contrast: a *non-pending* source event in periodic-only
  mode would be suppressed by that guard.

### Group H — Ephemeral re-evaluation across restart  [§4]

**BSL-EPHEMERAL-01 — restart re-evaluates; target still equal → no write**
- Pre: run BSL-START-01 (writes 5 to T; T now 5). Then restart the adapter (S2)
  without changing S or T.
- When: await ready after restart.
- Then: **no write to T** on the second start (baseline re-evaluated,
  compare equal). Proves the state is ephemeral yet compare-safe.

**BSL-EPHEMERAL-02 — restart re-evaluates; target changed externally → write**
- Pre: run BSL-START-01 (T=5). Externally set `T = 0` (S1). Restart adapter.
- When: await ready after restart.
- Then: adapter **writes 5 to T** again (baseline detects the drift on the new
  start). Proves baseline is re-attempted every start.

---

## 5. Coverage matrix (case → behaviour)

| Behaviour | Cases |
|---|---|
| Startup write when differing / null target | BSL-START-01, -03 |
| Compare-then-write skip (equal) | BSL-START-02, -06; BSL-EVENT-05; BSL-ENABLE-04; BSL-COERCE-02; BSL-EPHEMERAL-01 |
| Stays pending (unavailable / disabled) | BSL-START-04, -05, -06; proven via BSL-EVENT-04, BSL-ENABLE-01/-02 |
| Event completion + filter bypass | BSL-EVENT-01, -02, -04 |
| One-shot bypass (filters resume after) | BSL-EVENT-03, -05 |
| `enabled` gates completion | BSL-EVENT-06 |
| Forward-only (no reverse baseline) | BSL-EVENT-07 |
| Enable force vs. compare | BSL-ENABLE-01/-02 (force) vs. -03/-04 (compare) |
| Enable confirmation guard (no double) | BSL-ENABLE-05 |
| Enable guards (no cached value) | BSL-ENABLE-06 |
| Coercion in baseline + compare + force | BSL-COERCE-01, -02, -03 |
| `propagateAck` semantics | BSL-ACK-01, -02 |
| Cycle guard (no echo) | BSL-CYCLE-01 |
| Runs before `info.connection` | BSL-START-07 |
| Periodic-only independence | BSL-PERIODIC-01, -02 |
| Ephemeral per-start re-evaluation | BSL-EPHEMERAL-01, -02 |

---

## 6. Notes for the implementer

- The single most important harness capability is **O1** — attributing and
  counting adapter-originated writes (via `state.from`), including asserting
  *zero* writes. Every compare-then-write and force distinction depends on it.
- Prefer driving sources/targets as **foreign** states (S1) over the adapter's
  own namespace, mirroring production (sources live in other adapters).
- Enable/disable must be driven as **commands** (`ack:false`, S3) to exercise
  the real confirmation path (BSL-ENABLE-05).
- Force-vs-compare is not directly observable on a single write; it is isolated
  by **pairs** (BSL-ENABLE-01 vs. -04) — keep both when trimming.
- These cases assume the current defaults (§3). If a case changes a default,
  state it explicitly so the scaffold can set it per test.
