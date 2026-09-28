# Fan-out (1:n couplings) and coupling identity

**Status:** decided 2026-09-28; implementation pending.
**Scope:** `src/main.ts` — `sourceIndex`/`targetIndex` structure, channel objects and
their IDs, `enabledMap`, `pendingBaseline`, `onStateChange()`, `onSyncTick()`,
`runBaselinePass()`, `normalizeEntry()`; `admin/jsonConfig.json` (new `id` column,
`uniqueColumns`); README changelog for the breaking change.
**Related:** [`admin-ui-mapping-table.md`](admin-ui-mapping-table.md) (the editor this
builds on), [`initial-synchronization-baseline.md`](initial-synchronization-baseline.md)
(the baseline whose bookkeeping changes here).

---

## 1. Problem

Distributing one value to several receivers — a star, or fan-out — is impossible
today. Entering a second coupling with the same source is rejected by the admin
table, and even without that rejection the adapter would silently drop it.

Field case: one measured value that several consumers need.

### Where it actually fails

Two places, both introduced by this project:

- **`admin/jsonConfig.json`:** `"uniqueColumns": ["source"]`. Added with the
  reasoning "the adapter discards duplicates anyway" — a circular justification
  that turned an adapter limitation into a UI rule.
- **`src/main.ts`:** `sourceIndex = new Map<string, MappingEntry>()`. A Map holds
  **one** entry per source ID; `onReady()` detects the second and logs
  `duplicate source … only the first entry is used`.

Neither is a domain constraint. The Map was chosen for O(1) lookup, nothing more.

### What already works, and what does not

- **n:1 works today.** `uniqueColumns` only constrains `source`, so several sources
  writing the *same* target are accepted and relayed. Only *bidirectional* entries
  sharing a target are rejected (`main.ts:309`).
- **Circular references are not detected at all.** `uniqueColumns` never was a cycle
  guard. At runtime only `inFlight` prevents the infinite loop. Deferred by decision
  (§6) — the operator is responsible for now.

---

## 2. Dimension 1 — Granularity of `enabled` / `lastValue`

Today there is one channel per **source**: `channels.<source>.enabled` and
`.lastValue`. With fan-out, several entries would collide on that channel ID.

- **Option (a) — channel stays per source.** `enabled` switches all targets of a
  source together, `lastValue` stays unambiguous. No migration, existing datapoint
  IDs unchanged. **[REJECTED]** — too coarse: the operator wants to disable a single
  branch of the star.
- **Option (b) — channel per coupling. [CHOSEN]** Every table row is treated as a
  1:1 relationship with its own `enabled` switch and its own three filter flags;
  graphically, each row is configured for itself. Cost: all existing
  `channels.<source>.*` datapoints become orphans and need migrating.

Consequence of (b): `enabledMap` is keyed by coupling, not by source, and
`lastValue` exists once per coupling (with identical content for siblings of a
star — accepted for the sake of a uniform channel layout).

---

## 3. Dimension 2 — How a coupling is identified

The channel ID must identify the **coupling**. Options weighed:

| | Form | stable? | readable? | verdict |
|---|---|---|---|---|
| (i) | `<source>__<target>` | yes | yes, but ~60 chars | rejected: unwieldy in the object tree |
| (ii) | row index (`channels.0`) | **no** | no | **rejected** — reordering rows would move `enabled` states onto other couplings, and §5 deliberately makes reordering meaningful |
| (iii) | generated `id` field, adapter-assigned | yes | no | superseded by (iv) |
| (iv) | **short hash / MAC-address-like handle, user-editable [CHOSEN]** | yes | as readable as the operator makes it | see below |

### The chosen mechanism (operator's design, 2026-09-28)

A new optional field `id` on `MappingEntry`:

- **Assigned automatically when a row is created.** A column `defaultFunc` generates
  a short random handle. Verified against the library: `ConfigTable.onAdd()` evaluates
  `defaultFunc` per column when the row is added, so the ID appears immediately.
- **Editable by the operator.** Anyone who prefers a speaking handle may set one and
  is then responsible for uniqueness — the adapter can only *check* it from then on.
- **Character set is constrained**, because the ID becomes part of an ioBroker object
  ID: `^[A-Za-z0-9_-]{1,32}$`. **Dots must be forbidden** — they would create
  hierarchy levels (`channels.ab.cd.enabled`), i.e. sub-channels instead of one
  channel. Enforced twice: as a column `validator` in the UI and in `normalizeEntry()`.
- **Backfilled by the adapter.** The UI only assigns on "+", so existing entries and
  CLI imports would have no ID and therefore no channel. The adapter fills missing
  IDs at startup and writes them into the canonical string, through the existing
  self-heal path. The whole installed base is thereby migrated without touching a row.
- **Collisions drop the later entry** with a logged reason, exactly as duplicate
  sources do today, leaving the configuration untouched so the operator can fix it.
  Silently re-generating was rejected: it would change the configuration behind the
  operator's back, which the "never prune" rule (see CLAUDE.md) exists to prevent.

### Object metadata

The channel carries the informative fields, so they show up in the object tree:

- `common.name` = `"<source> → <target>"`
- `common.desc` = the entry's `_comment`

`uniqueColumns` moves from `source` to `id`: the attribute that blocked fan-out
becomes the one that guards the new identity.

---

## 4. Dimension 3 — Bookkeeping that must follow

Not choices, but correctness consequences:

- **`sourceIndex` / `targetIndex` become `Map<string, MappingEntry[]>`.** Affected:
  index building, channel creation, per-entry error isolation, direction detection,
  the enable branch, baseline completion, sync tick, baseline pass.
- **`pendingBaseline` is keyed per coupling**, not per source. Today it is a set of
  source IDs; with fan-out the baseline would count as done after the first target
  and the remaining targets would never receive an initial value.
- **Duplicate `(source, target)` pairs** remain an error and are dropped in
  `parseMappings()`. `uniqueColumns` cannot express this (it checks single columns).
- **Orphan cleanup** — a pre-existing gap that fan-out makes acute: today a channel
  survives the deletion of its coupling and nobody removes it. With one channel per
  coupling many more accumulate. The adapter shall delete `channels.*` objects that
  no current coupling claims.

### Breaking the old channel layout (operator decision 2026-09-28)

Compatibility with earlier versions may be broken — they were concept studies. That
turns what looked like the largest piece of this package into the smallest:

- **No `CONFIG_VERSION` bump, no one-off migration path.** The old
  `channels.<source>.*` datapoints are not migrated; their `enabled` values are not
  carried over. Each new switch starts from its seed instead — `entry.enabled` when
  the row has one, otherwise the adapter's `enabledDefault` (which is itself
  configurable, so "comes back on" is not guaranteed either way).
- **The orphan cleanup covers it as a side effect.** Because it is a *permanent*
  mechanism rather than a migration step, the old channels disappear on the first
  start after the upgrade without any special-case code. Two lasting mechanisms
  instead of one special case — the self-healing approach the operator asked to keep.
- **ID backfilling stays**, for the same reason: it is permanent self-healing, not
  migration, and it covers CLI imports just as well as the installed base.
- The break is to be documented as such in the README changelog (a section that does
  not exist yet and needs creating).

---

## 5. Dimension 4 — Bidirectional couplings in a star

`S ↔ T1` and `S ↔ T2`: T1 writes back to S, and the `inFlight` guard necessarily
discards the resulting S event — that is its job. **T2 never learns of the change.**

- **Phase 1 [CHOSEN for this package]: fan-out is unidirectional.** As soon as a
  source appears more than once, `bidirectional` is **downgraded** for those entries
  with a clear log warning, rather than discarding the entry. The distribution keeps
  working; only the problematic reverse direction falls away.
- **Phase 2 [DEFERRED — the "royal" solution]:** the reverse direction must trigger
  the distribution **in code** rather than through the event, e.g.
  `relayFrom(source, value, exceptTarget)`, so every satellite of the star sees a
  value written back by one of them.

  The open problem there is **simultaneity**: two satellites changing at nearly the
  same moment, where the second overwrites the first. The operator's proposal is to
  use the **order of the table rows** as priority — today it carries no meaning, but
  it is operator-defined and the table can reorder. That requires a notion of
  precedence *and* a time window ("how long does precedence hold?"), which is its own
  design with its own record, not an appendix to this one.

  Groundwork already in place: `sort` is switched off on all columns, so the stored
  array order really is the operator's order.

#### Prerequisite discovered while discussing phase 2 (2026-09-28)

Asked whether the periodic sync could close the gap — a satellite's write-back being
picked up on the next tick — the answer turned out to be no, and worse: the tick made
it actively harmful. `lastState` was updated *behind* the cycle guard, so an echo of
our own write-back left the cache stale, and the tick then wrote the outdated value
back over the very change that had just been made. The cache update now precedes the
guard (`lastState` means "last known value of the source", whoever wrote it), which
- fixes the same fault for a plain bidirectional coupling with periodic sync, a
  defect independent of fan-out that only stayed hidden because the field
  configuration runs without the tick, and
- makes the tick a *usable* (if delayed) convergence path for a bidirectional star,
  should it ever be allowed.

What remains unfixable this way: `inFlight` is a Set without a counter, so two
satellites writing the star point in quick succession make the propagation
**non-deterministic** — the first echo clears the entry, the second is taken for a
foreign event and distributes to everyone. Any real bidirectional star therefore
needs precedence between satellites, not just a correct cache.

A smaller, deterministic middle step was sketched (not decided): let **only the first
bidirectional row of a star keep its reverse direction** — one designated writing
satellite, the rest receive-only. No time window, no precedence logic, and it covers
the common case of one control element plus several displays.

---

## 6. Deliberate limits and deferrals

- **Cycle detection stays out** (operator decision 2026-09-28): a startup check for
  `A→B, B→A` and longer chains goes to the backlog. `inFlight` prevents the runaway
  at runtime; detecting the configuration mistake is a convenience, and for now the
  operator carries it.
- **`lastValue` is duplicated across the branches of a star.** Same content in every
  sibling channel. Accepted in exchange for a uniform channel layout; a shared
  per-source value datapoint would reintroduce the two-level channel scheme that
  option (a) was rejected for.
- **`bidirectional` in a star is silently degraded, not refused.** The entry keeps
  relaying forward. The warning is the only signal, so it must name the entry.
- This is the first change that **renames existing datapoints** — permitted as a
  breaking change (§4) because the earlier versions were concept studies. Everything
  before this was additive.
