# Initial synchronization (baseline transfer)

**Status:** decided 2026-07-17; B implemented (C-ready) 2026-07-17, field test pending.
**Scope:** `src/main.ts` — `onReady()`, `onStateChange()`, `runBaselinePass()`,
`baselineWrite()`, one new ephemeral field (`pendingBaseline`).
**Test spec:** [`../testing/initial-synchronization-baseline.testspec.md`](../testing/initial-synchronization-baseline.testspec.md)
(black-box; scaffold to be built separately).

---

## 1. Problem

dp-coupler today is a purely **edge-triggered** relay: it forwards *changes*
(`forwardChangesOnly`, detected via `state.lc !== state.ts`), not *states*. It
reacts only to `onStateChange` events.

An edge-only stream has a fundamental deficiency, well known in communications
engineering: a receiver that has just come online (adapter start, target reset)
can only learn its correct state from the stream **if an edge happens to
occur**. Datapoints that never — or only rarely — change emit no edge, so the
target stays uninitialized, possibly forever.

Concrete field case: a PLC delivers several values over OPC-UA. One never
changes, two change very rarely. With change-only relaying they are never
forwarded, so the target never reflects the source. The coupler behaves
"correctly" per its rules, yet the practical result is wrong.

What is missing is the classic **baseline / snapshot transfer** — in fieldbuses
called *initial refresh*, *General Interrogation* (IEC 60870), or *retain /
republish-on-connect* (MQTT): a one-time **level-triggered** transfer that
brings the target to the current source value at the start of the datapoint's
life, independent of edges.

### What the code already had

- **The data is already present.** `onReady()` pre-fills `lastState` via
  `getForeignStateAsync` for every source — the current value is in memory even
  though no edge ever arrived.
- **The write path already exists.** `onSyncTick()` performs exactly this
  level-triggered refresh (unconditional, filter-free, respecting
  `enabled` / `propagateAck` / coercion).
- **But** `onSyncTick()` runs only when periodic sync is enabled
  (`syncIntervalMs > 0`) *and* only after the first interval elapses. With the
  field configuration (no periodic sync, change-only relay) it never runs.

So the gap is small and well-bounded: a **one-time initial baseline pass at
start**, decoupled from the periodic timer.

---

## 2. Design dimensions and options

Three independent dimensions were weighed. Each lists all options considered;
the chosen one is marked **[CHOSEN]**, rejected/deferred ones are kept for
future reference.

### Dimension 1 — Source availability (the upstream race)

The hard part of real synchronization: a one-shot at start assumes the source
already holds a valid value at that instant. With OPC-UA/PLC the upstream
adapter may not yet be connected when dp-coupler starts, so
`getForeignStateAsync` returns `null`. Synchronization is not a moment but a
handshake: "transfer once *both* ends are ready."

- **Option A — Pure one-shot at end of `onReady()`.**
  Uses the already-filled `lastState` cache, writes once. Simplest.
  *Weakness:* sources not yet connected at start are skipped and **never**
  retried — exactly the never-changing value falls through on unlucky timing.
  *Rejected: not robust enough.*

- **Option B — Startup pass + "pending baseline" completed by the first
  arriving event. [CHOSEN]**
  A baseline means, semantically, "align the target to the source once —
  regardless of how." Mechanics:
  - An ephemeral `Set<sourceId> pendingBaseline`, initialized with all sources.
  - Startup pass: for each source that already has a cached value → baseline
    write (with compare, see Dimension 2), then remove from `pendingBaseline`.
  - Sources without a value stay pending. When the upstream connects later and
    writes the value for the first time, `onStateChange` fires; there we detect
    the source is still pending, treat that event as the baseline (bypassing the
    `forwardChangesOnly` / `forwardOnAck` filters), and clear pending.

  The baseline burst is completed by the startup pass *or* the first event,
  whichever comes first — no polling, no timer. Maximum robustness for minimal
  machinery, and it fits the "ephemeral state, may be lost on restart" choice.

- **Option C — B plus an event-driven re-check.**
  Re-run the baseline check for still-pending sources (and, during normal
  operation, for reconnecting sources) when an **upstream-availability event**
  fires — explicitly **not** on a timer (a monoflop is rejected as the trigger).
  Covers the residual corner case where a source *had* a value before start *and*
  the upstream does not re-write it on reconnect, and additionally re-synchronizes
  after a temporary upstream connection loss. See §5 for the trigger design and
  the open auto-discovery-vs-config question. *Deferred: optional future
  hardening, not built now; B is deliberately built "C-ready" so C stays
  additive.*

### Dimension 2 — Write semantics / side effect of the first write

The forward write defaults to `ack: false` (command semantics). A baseline
write at start therefore potentially **actuates** something (re-triggers a
setpoint / switch command) even when nothing changed.

- **Option 1 — Unconditional write** (as `onSyncTick` does today).
  Simplest, but re-actuates on every start without need. *Rejected for the
  baseline path.*

- **Option 2 — Compare, then write. [CHOSEN]**
  Read `getForeignStateAsync(target)`, compare the **coerced** source value
  (exactly what would be written, via `resolveValue`) against `target.val`,
  write **only on inequality**. Two subtleties:
  - Compare *after* coercion, else a type difference (bool vs. number) falsely
    reads as "unequal".
  - Compare only `.val` (not `ack` / `ts`). `target.val === null` (never
    written) ⇒ unequal ⇒ write.

  This is exactly what synchronization means — "make target equal source"; if
  already equal, nothing to do. As a side effect it minimizes actuation risk to
  the genuinely-needed cases.

- **Option 3 — Compare + a distinct ack semantics for the baseline.**
  Even when writing, choose `ack: true` (status, no actuation) vs. `ack: false`
  (command). *Rejected:* do not invent a third write behavior; the baseline
  follows the existing `propagateAck` (default `ack: false`), consistent with
  the normal relay and sync paths. The compare already gates the write.

### Dimension 3 — Configurability

- **Option — Switch, default on.** New native/jsonConfig flag (e.g.
  `initialSyncDefault = true`) via a `CONFIG_VERSION` bump. *Rejected:* adds
  config surface for a robustness fix that is low-risk thanks to compare-then-
  write.

- **Option — Always active, no switch. [CHOSEN]**
  Baseline is built in unconditionally. Simpler; no `CONFIG_VERSION` bump. The
  compare keeps it safe, so an opt-out is not warranted. An opt-out remains
  purely additive should a real need ever surface.

### Dimension 4 — Re-enabling a channel (added 2026-07-17)

A channel can be disabled at adapter start (per-channel `enabled = false`). The
startup pass then skips it and it stays pending (never baselined this life). It
can also be disabled, then re-enabled at runtime, during which the source may
have drifted (`lastState` is updated even while disabled, because
`onStateChange` caches the value before the enabled check).

The question: what should happen on the `enabled` false→true transition? A bare
enable that does nothing is unintuitive — a user enabling a channel expects the
current value to be pushed.

- **Option — Do nothing on enable.** *Rejected:* leaves a disabled-at-start,
  never-changing channel uninitialized until an unrelated event arrives; a
  manual enable feels inert. (This was the original "known limit" before this
  dimension was added.)

- **Option — Transfer on enable when values differ **or** the "never
  transferred this life" flag is set. [CHOSEN]**
  On false→true:
  - If the source is still pending (never baselined this life — e.g. disabled at
    start) → **force** a write (guarantees the once-per-lifetime push the
    founding requirement asks for), and clear pending.
  - Else (already baselined earlier this life) → compare-then-write: write only
    if the source value differs from the target (drift correction after a
    disable interval).

  So `pendingBaseline` doubles as the "never transferred this life" flag. The
  asymmetry to the startup pass (which only compares, never forces) is
  intentional: startup is automatic and should avoid needless re-actuation,
  whereas a manual enable is a deliberate user action that should push the
  value.

---

## 3. Resulting target mechanic

**New ephemeral state**

- `pendingBaseline: Set<string>` — sourceIds whose baseline is still outstanding
  in *this* adapter life. Not persisted; no `onUnload` handling needed.

**Shared helper `baselineWrite(entry, sourceVal, q, ack, force)`**
(compare-then-write, or force-write)

1. `outVal = resolveValue(entry, "forward", sourceVal, entry.target)` — coercion
   as usual.
2. If **not** `force`: `current = await getForeignStateAsync(entry.target)`; if
   `current && current.val === outVal` → equal → **no write** (baseline still
   counts as fulfilled). `current.val === null` (never written) ⇒ unequal ⇒
   write.
3. If `force` (used only on manual enable of a never-baselined channel, see
   Dimension 4): skip the compare and write unconditionally.
4. `inFlight.add(target)` → `setForeignStateAsync` (ack semantics via
   `propagateAck`, as in the normal path) → `catch` removes `inFlight`.

**`onReady()` — startup pass** (after `subscribeForeignStatesAsync` and the
`lastState` pre-fill, before `info.connection = true`)

The pass body is implemented as a **reusable method `runBaselinePass()`**, not an
inline loop — deliberate foresight so Option C (§5) can re-invoke it without a
refactor.

- `pendingBaseline = new Set(sourceIndex.keys())`.
- Iterate a **snapshot copy** of the keys (the Set may be mutated by events
  arriving during the pass). Per source:
  - `unloading` → break; no longer pending → skip; `enabled === false` → skip
    (**stays pending**); no `lastState` value → skip (**stays pending**, awaits
    first event).
  - else: remove from `pendingBaseline` → `await baselineWrite(..., force=false)`.
- Log a summary: `initial baseline: N written/checked, M pending (source not yet
  available)`.

**`onStateChange()` — event completion** (forward direction, inserted *after*
the `enabled` check, *before* the periodic-only / `forwardOnAck` /
`forwardChangesOnly` filters):

```ts
if (forwardEntry && this.pendingBaseline.has(id)) {
    this.pendingBaseline.delete(id);
    await this.baselineWrite(entry, state.val, state.q, state.ack); // filters bypassed by design
    return;
}
```

- The first arriving event of a still-pending source fulfills the baseline
  (bypassing `forwardOnAck` / `forwardChangesOnly`); all subsequent events
  follow the normal rules again.
- Reverse events (bidirectional targets) are excluded by `forwardEntry &&` —
  baseline is forward-only, consistent with `onSyncTick`.
- Because the baseline check sits *before* the periodic-only guard, baseline
  works in periodic-only mode too (and writes immediately at start instead of
  waiting for the first tick).

**`onStateChange()` — enable-triggered completion** (the existing
`enabledDpToSource` branch, on a false→true transition):

```ts
const prev   = this.enabledMap.get(enabledSource);
const newVal = Boolean(state.val);
this.enabledMap.set(enabledSource, newVal);
if (newVal && prev === false) {                          // enable transition
    const entry  = this.sourceIndex.get(enabledSource);
    const cached = this.lastState.get(enabledSource);
    if (entry && cached) {
        const force = this.pendingBaseline.delete(enabledSource); // true ⇒ never baselined this life
        await this.baselineWrite(entry, cached.val, cached.q, cached.ack, force);
    }
}
// ... existing ack-confirmation, then return
```

- `Set.delete` returns `true` if the id was present, giving `force` directly:
  never-baselined-this-life ⇒ force write; already baselined ⇒ compare-then-
  write (drift correction).
- The `prev === false` guard prevents a re-trigger loop: the adapter confirms
  the enable command with `ack: true`, which re-enters `onStateChange`, but by
  then `prev` is already `true`.

**Unchanged**

`onSyncTick()` stays unconditional (explicit decision — periodic heartbeat must
always write); `resolveValue` / `coerceValue`, the `inFlight` guard, the
`lastValue` DP, and `CONFIG_VERSION` (no new config field) are untouched.

---

## 4. Deliberate limits and deferrals

- **Disabled-at-start + never-changing + enabled-later:** handled by the
  enable-triggered completion (Dimension 4) — the false→true transition forces
  the baseline write. (This was a known limit in the first draft of this record;
  the enable trigger was added on 2026-07-17 to remove it.)
- **Option C corner case** (value exists before start, upstream sends no event
  on reconnect, and the channel is enabled so no enable trigger fires either)
  remains open; noted as an optional future hardening, not built. Its trigger and
  extensibility are sketched in §5.
- **Ephemeral by design:** the baseline is re-evaluated on **every** adapter
  start; there is no persistent "ever transferred" bookkeeping. State lost on
  restart is acceptable and intended.

---

## 5. Extensibility for Option C (recorded 2026-07-17)

### Build B "C-ready"

The startup pass is factored into a reusable method `runBaselinePass()` (see §3)
instead of an inline loop. This costs nothing now and makes Option C **almost
purely additive** later.

Estimated footprint of C **on top of** B: **~20–30 lines, isolated**. C reuses
`pendingBaseline`, `baselineWrite`, `lastState`, and the `inFlight` guard, and
does **not** touch `onStateChange`, the relay filters, `baselineWrite` internals,
or the enable trigger. As long as the pass stays factored, deferring C incurs no
rework debt — `onReady()` only gains a subscription/scheduling call and
`onUnload()` a teardown line; both are pure additions.

When C is built, `runBaselinePass()` will likely gain an optional source-subset
argument (and a compare-only mode), so the same method serves the startup pass,
the reconnect re-check, and any future re-sync trigger. Keep the signature ready
for that.

### Trigger: event-driven, not a timer

Decision steer (2026-07-17): the re-check trigger must **not** be a timer /
monoflop. Instead, detect an event that signals upstream availability and re-run
the baseline check on it. Natural candidates in ioBroker:

- `system.adapter.<adapter>.<instance>.alive` — js-controller-managed, universal,
  but only says the adapter *process* runs, not that its device link is up.
- the upstream adapter's `info.connection` datapoint (role `indicator.connected`)
  — convention for device-link adapters (OPC-UA, MODBUS, …), but neither
  guaranteed to exist nor uniformly named/located.

On a false→true transition of such a flag, re-run `runBaselinePass()` over the
affected sources (compare-then-write). This broadens C beyond a startup-only
hardening: it also **re-synchronizes during normal operation** when an upstream
adapter temporarily loses and regains its connection — strictly better than any
bounded startup retry, and it is genuinely edge-driven rather than polled.

A timer is **not absolutely excluded** — it remains the *last* resort, to be
reached for only after all event-based triggers have been exhausted, never as the
first or second choice. (Rationale: a monoflop masks the real availability signal
instead of reacting to it; prefer detecting the actual event.) The maintainer
keeps this trade-off in view from experience; it is recorded here so a future
reader does not mistake "no timer" for an absolute ban.

### Open question (sketch only — not resolved now)

How does dp-coupler learn which connection flag belongs to which source?

- **Auto-discovery:** derive the adapter instance from the source ID prefix
  (`<adapter>.<instance>.…`) and watch its `alive` and/or conventional
  `info.connection`. Zero config, but relies on a convention not all adapters
  honor.
- **Configuration:** an optional field (per entry or adapter-wide) naming the
  connection state ID to watch. Robust, but adds config surface.
- **Likely hybrid:** auto-derive `alive` as a baseline signal, with an optional
  configured connection-indicator override for adapters that expose a meaningful
  device-link flag.

To be detailed when C is actually scheduled.
