# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`iobroker.dp-coupler` is an ioBroker adapter that relays state changes between arbitrary datapoints via a JSON mapping. Runs as a daemon adapter. Supports unidirectional and bidirectional relay with per-entry ACK and change-only filters.

Node.js ≥ 20 required. `.nvmrc` pins Node 20.

## Commands

```bash
# Build (TypeScript → build/)
npm run build

# Watch mode (incremental recompile)
npm run watch

# First-time dev-server setup (also required after deleting .dev-server/)
npm run dev-server:setup

# Start dev-server (browser UI for testing without a full ioBroker install)
npm run dev-server
# or via the wrapper script (sources nvm, forces Node 20):
./dev-server.sh
```

After changing `io-package.json` or any file under `admin/`, the dev-server must be restarted to pick up the changes. `src/main.ts` changes are recompiled automatically in watch mode and picked up by nodemon inside the dev-server.

**nodemon caveat:** the dev-server's nodemon watches `**/*.json` inside the adapter directory. Writing `mappings.json` from `persistMappingsFile()` would trigger a restart loop — prevented by the content-equality check in that function (skips write if content is identical).

### Dev-server process architecture

The dev-server runs **two independent process managers** for dp-coupler simultaneously:

```
dev-server
├── nodemon → PID X  (long-running adapter, "[nodemon] child pid: X")
└── js-controller → bootstrap PIDs  (short-lived, spawned by startInstance)
```

js-controller never owns or tracks PID X. It spawns ephemeral bootstrap processes (each getting a new PID). Every bootstrap immediately finds PID X already registered in Redis and exits with code 7. This is the intended dev-server design — nodemon is the real lifecycle manager.

In **production** there is no nodemon. js-controller is the direct parent of the adapter; it owns the process exclusively.

### Distinguishing dev-server artifacts from real bugs

| Log pattern | Dev-server | Real bug? |
|---|---|---|
| `terminated with code 7 (ADAPTER_ALREADY_RUNNING)` | **Normal** — bootstrap found nodemon's child already running | Would indicate a second instance conflict |
| `terminated with code 11 (ADAPTER_REQUESTED_TERMINATION)` | **Normal** — bootstrap exited after sending TERMINATE_YOURSELF to PID X | Same meaning in production, but there it's PID X itself that exits |
| `Got terminate signal. Checking desired PID: A vs own PID B` (A ≠ B) | **Normal** — adapter's PID doesn't match desired; it will exit with 7 | Same in production, but resolves in one cycle |
| PID X still alive 3–10 s after `terminated with code 11` | **Normal** — nodemon restarted the child immediately | In production: would indicate `process.exit()` not reached |
| ~60 s zombie + EPIPE after config-save | **Normal** — js-controller force-kills after timeout | In production: doesn't happen; adapter exits immediately on callback() |
| Adapter never logs `dp-coupler: ready` after a **clean first start** (no competing PIDs) | — | **Real bug** |
| `info.connection` never becomes `true` after clean start | — | **Real bug** |
| Relay silently stops working (no `[dpc]` filter line explains it) | — | **Real bug** |
| `inFlight` set grows without being cleared | — | **Real bug** |

**Rule of thumb:** If the symptom disappears after the initial ADAPTER_ALREADY_RUNNING churn and the adapter logs `ready`, it is a dev-server startup artifact. If the symptom persists after `ready` or the adapter never reaches `ready`, investigate the adapter code.

Admin UI files are stored (and must be consistent) at `.dev-server/default/iobroker-data/files/dp-coupler.admin/`.

There are no automated tests.

## Architecture

Single TypeScript source file: `src/main.ts` → compiled to `build/main.js`.

Durable design-rationale records (including rejected/deferred options) live under
`docs/design/` — see [`docs/design/README.md`](docs/design/README.md). Consult them
before revisiting a settled design question; add a new record rather than deleting
an old one when a decision is superseded.

### Configuration

`this.config.mappingsRaw` (ioBroker DB) is the single source of truth — persisted automatically by ioBroker, edited via the admin UI table (the JSON itself is a read-only view). Canonical form is a JSON **string**; a natively set JSON **array** is tolerated and self-healed (see below).

`parseMappings(raw, label)`: tolerant parse+validate helper. A string is `JSON.parse`d; an array/object is taken as-is. Validates `Array.isArray`, filters entries via `isMappingEntry`, **backfills missing coupling ids**, normalizes each survivor via `normalizeEntry()`, and rejects duplicate ids and duplicate `(source, target)` pairs. Shared by `loadMappings()` and `readSeedMappings()`. Returns `{ valid, parsed, idsAssigned }` — `parsed` is the **unfiltered** array (so the self-heal never prunes the stored configuration, and so it carries the backfilled ids) — or `null` on unrecoverable error.

**Coupling ids.** `MappingEntry.id` names the entry's channel objects (`channels.<id>`), so every table row is an independently switchable coupling. `isPlausibleCouplingId()` enforces `^[A-Za-z0-9_-]{1,32}$` — **dots are forbidden**, they would create sub-channels. The admin table assigns an id when a row is created (column `defaultFunc`); `parseMappings()` backfills anything else (CLI imports, entries predating the field) and `onReady()` persists the result, otherwise the channels would be renamed on every start. Rationale: `docs/design/fan-out-and-coupling-identity.md` §3.

`isMappingEntry(value)` / `isPlausibleStateId(id)`: `source`/`target` must be strings that, trimmed, pass a **minimal** ID plausibility check — non-empty, no inner whitespace, no leading/trailing dot, no double dot. Deliberately *not* a full ioBroker ID validation: it rejects exactly the forms that would produce an invalid object ID downstream (an unfilled editor row produces `channels.` — a trailing-dot ID — which would abort `onReady()`).

`normalizeEntry(entry, label)`: returns a normalized copy — trimmed IDs, tolerant boolean flags (`normalizeFlag()` accepts `true`/`"true"`/`"yes"`/`"on"`/`1` and the negative spellings; `""`, `"def"` and `"default"` mean "not set", the latter two being the admin table's placeholder — see Admin UI for why it cannot be the empty string). Unknown keys (`_comment`) are preserved. Returns `null` only for a self-coupling (`source === target`). An uninterpretable *optional* flag is never fatal — it is dropped with a warning so the adapter default applies, instead of silently meaning the opposite (`bidirectional` is tested with `=== true`, the other flags via truthy `??`).

`loadMappings()`: thin wrapper — `parseMappings(this.config.mappingsRaw, "mappingsRaw")` + logs the loaded and skipped counts.

`readSeedMappings()` / `consumeSeedFile()`: one-shot seeding for initial deployment without UI access. `readSeedMappings()` reads+validates `mappings.seed.json` (separate from the export file). `consumeSeedFile()` deletes it — called only in the `extendForeignObjectAsync().then()` after a successful config write, so a failed write leaves the seed in place. Non-fatal on delete failure (read-only file = legitimate opt-out; re-seed still blocked by the "config not empty" condition).

`persistMappingsFile(content)`: called after every successful `loadMappings()` with the canonical string. Writes to `mappings.json` in `this.adapterDir` as a convenience export (backup, deployment template). Non-fatal on failure. Content-equality check prevents nodemon restart loops.

**Self-heal / normalization (one write in `onReady()`):** a single `extendForeignObjectAsync("system.adapter.${namespace}", { native: patch })` call combines three concerns (≤ one config restart): (a) `configVersion < 1` → fill missing `NATIVE_DEFAULTS` so the admin UI shows real values, set `configVersion: 1`; (b) native-array `mappingsRaw` → canonical pretty-printed string; (c) seeded mappings → persisted. No early `return` — the tolerant loader relays from the in-memory array even if no restart occurs.

**`mappingsTable` — adapter-maintained mirror (admin UI only).** The jsonConfig table binds to an *array* attribute while the canonical form is a *string*. The adapter therefore mirrors the canonical string as an array into `native.mappingsTable`, as part of the same normalization patch. Runtime never reads it — `mappingsRaw` remains the single source of truth. Its purpose is the dialog's "changed" flag: `JsonConfigComponent` computes it as `JSON.stringify(data) !== originalData`, and a table attribute that exists only in the dialog (`doNotSave`) is always absent from `originalData`, so every opening of the configuration would report unsaved modifications. Written only on divergence (no extra config restart on a UI save) and mirroring the *unfiltered* content. Deliberately **not** declared in the io-package `native` defaults: a default of `[]` would suppress the jsonConfig `defaultFunc` fallback, so a fresh instance configured via CLI would show an empty table until the adapter had run once. Rationale and the alternatives weighed: `docs/design/admin-ui-mapping-table.md` §7a.

**The canonical string is never pruned.** `canonicalRaw` is built from the *unfiltered* input (the stored string as-is, the raw native array, or the raw seed content) — never from the validated list. A rejected entry therefore stays in the configuration and remains visible and fixable in the admin editor, rather than vanishing silently; in the seed case it would otherwise be unrecoverable, because the seed file is consumed.

Mass deployment: `iobroker object set system.adapter.dp-coupler.0 native.mappingsRaw="$(jq -Rs . mappings.json)"` (canonical) or `"$(cat mappings.json)"` (native array, self-healed), or enter the couplings in the admin UI table. See README "Mass deployment" for import/export/seeding.

### `DpCoupler extends utils.Adapter`

- `couplings: MappingEntry[]` — all active couplings in operator order (the table's row order). The iteration base for channel building, the sync tick and the baseline.
- `sourceIndex: Map<string, MappingEntry[]>` — built in `onReady()`, O(1) forward-direction lookup. A **list**, because one source may feed several targets (fan-out).
- `targetIndex: Map<string, MappingEntry[]>` — built in `onReady()` for bidirectional entries only, O(1) reverse-direction lookup.
- `enabledMap` / `pendingBaseline` are keyed by **coupling id**, not by source: with fan-out a per-source key would switch all branches together and would count the baseline as done after the first target.
- `inFlight: Set<string>` — IDs of states dp-coupler itself just wrote; prevents relay cycles.
- `lastState: Map<string, ioBroker.State>` — last known state per source ID; populated at startup via `getForeignStateAsync` and updated on every forward-direction `onStateChange`. Shared cache for periodic sync and future enable-schalter `lastValue` datapoint.
- `syncIntervalMs` — effective sync interval in ms, computed once in `onReady()` from `syncIntervalValue × unitMultiplier`; `0` when sync is disabled.
- `syncTimer` — `setInterval` handle; `null` when periodic sync is disabled.
- `unloading: boolean` — set to `true` in `onUnload()`; checked at the top of each `onSyncTick()`/`runBaselinePass()` iteration to abort the loop cleanly during shutdown.
- `pendingBaseline: Set<string>` — source IDs whose initial baseline transfer is still outstanding **in this adapter life** (ephemeral, not persisted). Populated with all sources in `onReady()`; an id is removed once its baseline is written or skipped-as-equal. Doubles as the "never transferred this life" flag for the enable trigger. See `docs/design/initial-synchronization-baseline.md`.
- `onReady()`: creates `info` channel and `info.connection` via `setObjectAsync` → calls `loadMappings()` → if the config mapping is empty, attempts `readSeedMappings()` → builds the combined normalization `patch` (configVersion defaults + array self-heal + seeded mappings) and fires the single `extendForeignObjectAsync` write (consumes the seed file on success) → `persistMappingsFile(canonicalRaw)` → builds `sourceIndex` and `targetIndex` → builds the per-channel objects **with per-entry error isolation** → `subscribeForeignStatesAsync(sources + bidir targets)` → pre-populates `lastState` via `getForeignStateAsync` for all sources → fills `pendingBaseline` with all sources and runs `runBaselinePass()` (initial baseline transfer) → starts `syncTimer` if `syncInterval > 0` → sets `info.connection = true`.
- **Per-entry error isolation in the channel-building loop:** each entry's setup runs inside a try/catch; a failure drops only that entry (removed from `sourceIndex`/`targetIndex`/`destType`/`enabledMap`/`enabledDpToSource` after the loop) and is logged as a warning. Without it a single rejected `await` aborts `onReady()` entirely — no `ready`, no `info.connection`, no relay at all. Defense in depth: validation rejects the *known* malformed entries, this catches the unforeseen ones.
- `onStateChange()`: own-`enabled`-DP branch (updates `enabledMap` for that coupling; on a false→true transition triggers `baselineWrite` — forced if still pending, else compare-then-write) → collects **all** couplings the state feeds (`sourceIndex` as forwards, `targetIndex` as reverses; a state can be both) → updates `lastState` and every forward coupling's `lastValue` → **cycle guard** (`inFlight`) → hands each coupling to `relayCoupling()`. The guard sits after the cache update on purpose — see "Cycle guard" below.
- `relayCoupling(entry, direction, state)`: the per-coupling half of the relay — `enabled` check → **baseline-completion** (if still in `pendingBaseline`, `baselineWrite` with filters bypassed, then return) → periodic-only guard (`syncInterval > 0 && !relayOnChange`) → `forwardOnAck` filter → `forwardChangesOnly` filter → `inFlight.add(destination)` → resolve `propagateAck` → `setForeignStateAsync`. Split out because with fan-out one event drives several couplings, each with its own flags.
- `dropCoupling(entry)`: removes a coupling from every runtime structure (used when its channel setup failed). `destType` entries are kept — they are per state ID and a sibling coupling may still need them.
- `removeOrphanChannels()`: deletes `channels.*` objects no current coupling claims. Permanent housekeeping, not a migration step — which is why it also clears the pre-0.4.0 per-source channels on the first start after the upgrade, without special-case code. Non-fatal throughout.
- `onSyncTick()`: iterates `sourceIndex`; for each entry with a cached `lastState`, writes target via `setForeignStateAsync` (same `inFlight` guard as normal relay, respects `propagateAck`, bypasses `forwardOnAck`/`forwardChangesOnly` filters **and** the baseline compare by design — heartbeat must always write).
- `runBaselinePass()`: iterates a snapshot of `pendingBaseline`; for each still-pending, enabled source with a cached value, calls `baselineWrite(..., force=false)` and drops it from `pendingBaseline`. Disabled / not-yet-available sources stay pending (completed later by first event or enable). Reusable by design — a future connection-driven re-check re-invokes it (design record §5).
- `baselineWrite(entry, sourceVal, q, ack, force)`: level-triggered forward write. Unless `force`, reads the target and skips when the coerced values are already equal (no needless re-actuation); `force` (manual enable of a never-baselined channel) writes unconditionally. Shares `inFlight`/coercion/`propagateAck` with the relay path; bypasses the `forwardOnAck`/`forwardChangesOnly` filters. Returns true iff a write was issued.
- `onUnload()`: sets `unloading = true` → clears `syncTimer` → fire-and-forget `setStateAsync("info.connection", false)` → calls `callback()` synchronously. **No async operations are awaited** — Redis/IPC ops hang indefinitely when js-controller tears down the connection during adapter restart.

### Mapping schema (`MappingEntry`)

```typescript
interface MappingEntry {
    id: string;                  // coupling handle; names the channels.<id> objects
    source: string;              // full ioBroker state ID
    target: string;              // full ioBroker state ID
    bidirectional?: boolean;     // if true, also relays target→source
    forwardOnAck?: boolean;      // override adapter default; default false — trigger relay on ack=true source
    forwardChangesOnly?: boolean; // override adapter default; default true
    propagateAck?: boolean;      // override adapter default; default false — write target with ack=state.ack
    enabled?: boolean | "def" | "keep";  // startup strategy for channels.<id>.enabled — not a filter
}
```

**`enabled` is a four-valued startup strategy, not a tri-state filter flag.** Applied in the channel-building loop at **every** start: `true`/`false` force the datapoint, `"def"` forces `enabledDefault`, `"keep"` leaves an existing datapoint untouched (a missing one is always created from `enabledDefault`). A missing field means `"keep"` — the behaviour before this became a table column, so old configurations are unchanged. Normalized by `normalizeEnabled()`, **not** `normalizeFlag()`, which would read `"keep"` as uninterpretable and `"def"` as "not set"; `"old"`/`"hold"`/`"runtime"`/`"retain"` are accepted synonyms of `"keep"`. Why it changed: as a seed value the column only had an effect on first creation, so a row set to `no` did not switch the coupling off and the initial baseline ran for it.

Per-entry fields override adapter-level defaults (`forwardOnAckDefault`, `forwardChangesOnlyDefault`, `propagateAckDefault` in `native` config).

`_comment` and other unknown keys are ignored by the type guard and **preserved** by `normalizeEntry()`, so they survive a load/self-heal round trip.

Validation rules (see `isMappingEntry` / `normalizeEntry` above): `source` and `target` are mandatory and must be plausible state IDs; they are trimmed. `source === target` is rejected, as are duplicate `id`s and duplicate `(source, target)` pairs. Optional flags are normalized tolerantly and never cause the entry to be discarded.

**Fan-out (1:n).** The same `source` may appear in several entries — one row per target, each an independent coupling. Only the *pair* must be unique. A `bidirectional` entry whose source feeds several targets is **downgraded to unidirectional** with a warning: its reverse write lands on the star point, where `inFlight` necessarily swallows the resulting event, so the sibling branches would never see the value. Full analysis including the deferred bidirectional-star design: `docs/design/fan-out-and-coupling-identity.md` §5.

### Cycle guard (`inFlight`)

When dp-coupler writes state X, it adds X to `inFlight` before the write. When `onStateChange(X)` fires as a result, the guard detects it, removes X from `inFlight`, and returns without relaying. On write failure, X is removed in the `catch` block to prevent permanent blockage.

**The guard sits *after* the `lastState`/`lastValue` update, not before.** `lastState` means "the last known value of the source", regardless of who wrote it. When the reverse direction of a bidirectional coupling writes the source, the resulting event is our own echo — but the value is genuinely new. With the cache update behind the guard it stayed stale, and the periodic sync then wrote the outdated value back, **undoing the change just made at the target** (a fault independent of fan-out; it only stayed hidden because the field configuration runs without periodic sync). The guard still runs for *every* incoming id, including ones no coupling claims, because it must clear the `inFlight` entry — leaving it behind would swallow the next genuine event.

**Known limit:** `inFlight` is a Set without a counter. If two couplings write the same destination in quick succession, the first echo clears the entry and the second echo is treated as a foreign event. Relevant for n:1 and for the deferred bidirectional star (`docs/design/fan-out-and-coupling-identity.md` §5), where it makes the propagation non-deterministic.

### Adapter-level defaults

`forwardOnAckDefault` (default `false`): whether a source state with `ack: true` triggers a relay. False means only commands (`ack: false`) trigger a relay.

`forwardChangesOnlyDefault` (default `true`): whether to relay only actual value changes. Uses `state.lc !== state.ts` to detect re-writes of unchanged values (e.g. polling refreshes).

`propagateAckDefault` (default `false`): whether the target write receives `ack: state.ack` from the source. False means the target always receives `ack: false` (command semantics).

`syncIntervalValue` (default `0`) + `syncUnit` (default `"ms"`, options: `ms`/`s`/`min`/`h`): together define the periodic sync interval. `syncIntervalValue = 0` disables the feature. Effective interval in ms is computed once at startup as `syncIntervalValue × unitMultiplier` and stored in `syncIntervalMs`. When active, all target datapoints are re-written at this interval with the last known source value (heartbeat/refresh). Only the forward direction (source → target) is synced — the reverse direction of bidirectional entries is not included in periodic updates.

`configVersion` (default `0`, **io-package native only — not in jsonConfig**): self-heal/migration marker. When `< 1` at startup, `onReady()` fills any missing `NATIVE_DEFAULTS` and bumps it to `1` (via the shared normalization write), so the admin UI shows real values on fresh/migrated instances instead of blanks. Forward-compatible hook for future schema migrations. `NATIVE_DEFAULTS` (module-level const) mirrors the io-package `native` defaults minus `mappingsRaw`.

`relayOnChange` (default `false`): only evaluated when `syncIntervalMs > 0`. `false` = periodic-only mode (no event relay). `true` = both periodic sync and event-driven relay. When `syncInterval === 0`, this flag has no effect — event-driven relay is always active.

### Initial synchronization (baseline transfer)

Because relaying is edge-triggered (change-only), a datapoint that rarely or never changes emits no event and would never reach its target after start. The **baseline transfer** closes this gap: a level-triggered one-shot per adapter life that brings every target to its current source value. Always active (no config switch, no `CONFIG_VERSION` bump); state is ephemeral (`pendingBaseline`), re-evaluated on every start.

Completion has three triggers: (1) the startup `runBaselinePass()` for sources already available; (2) the first arriving event of a still-pending source (`onStateChange`); (3) a manual `enabled` false→true transition. Write policy is **compare-then-write** (skip when target already equals source) except on a manual enable of a never-baselined channel, which **forces** the write. Full option analysis (including deferred Option C: connection-event-driven re-check, timer only as last resort) in [`docs/design/initial-synchronization-baseline.md`](docs/design/initial-synchronization-baseline.md).

### Single-file architecture decision

`src/main.ts` is intentionally kept as a single file. All features share tightly coupled instance state (`sourceIndex`, `targetIndex`, `inFlight`, `lastState`, `config`) — splitting would require passing the adapter instance across module boundaries, which reduces cohesion without adding clarity.

**Revisit when:** (a) a feature introduces a standalone utility with no adapter-instance dependency (e.g., a JSONata transformer wrapping an external library), or (b) `src/main.ts` exceeds ~600–800 lines. At that point, extract the self-contained utility first; keep the adapter class in one file unless a clear seam emerges.

### Admin UI

`admin/jsonConfig.json`: root type is `"tabs"`. The **Mapping** panel contains, in this order:

1. `info_invalid_json` — an `infoBox` that appears only when `mappingsRaw` is not a parsable JSON array (`hidden` JS function).
2. `mappingsTable` — the `table` editor, bound to the adapter-maintained mirror (see Configuration). Columns: `id` / `source` / `bidirectional` / `target` / `_comment` / `enabled` / `forwardOnAck` / `forwardChangesOnly` / `propagateAck`. `uniqueColumns` is `["id"]` — **not** `source`, which must be free for fan-out; the `id` column carries the `defaultFunc` that assigns a handle to a new row and a `validator` mirroring `isPlausibleCouplingId()`. `defaultFunc` fills it from `mappingsRaw` when no mirror exists yet, returning `undefined` (not `[]`) on unparsable input so opening the dialog cannot destroy a broken string.
3. `legend_columns` — `staticText` legend (column headings have no tooltips, see below).
4. `mappingsRaw` — `type: "text"` with `readOnly`, `copyToClipboard`, `minRows`/`maxRows`: the canonical string as a read-only view and the export path. Its `onChange.calculateFunc` writes the table back into the string, guarded by `data.mappingsTable === undefined` so an unpopulated table cannot empty the configuration.

The coupling is deliberately asymmetric (string → table once on open, table → string on every edit), which is what prevents a feedback cycle. Full rationale: `docs/design/admin-ui-mapping-table.md`.

**The `enabled` column has four values** — `"keep"`, `"def"`, `true`, `false` — because it is a startup strategy (see Mapping schema), not a filter. The other three are three-valued.

**Three-valued flag columns:** `forwardOnAck`/`forwardChangesOnly`/`propagateAck` are `select`s with `"def"` = "(def)", `true`, `false` — a checkbox could not distinguish "not set" from "off" and would silently override the adapter defaults on every new row. `normalizeFlag("def")` yields "not set" and `normalizeEntry()` drops the key.

**Critical: never use `""` (or any falsy value) as a `select` option value next to `false`.** `ConfigSelect.renderItem()` matches the stored value against the options with a deliberately loose `==` (`selectOptions.find(it => it.value == value)`), and `"" == false` is `true` in JavaScript — an entry stored as `false` would display the **first** loosely-equal option instead of its own. Observed symptom: selecting "no" stored `false` correctly but the cell immediately showed "(def)". Hence the placeholder is the string `"def"` (`Number("def")` is NaN, so it matches neither boolean). A second, unavoidable effect of the same design: `value: value || '_'` turns a stored `false` into the placeholder, so in the *opened* dropdown no option is highlighted — the closed cell is correct. This is also why the schema only sanctions `number|string` for table column option values.

*Fallback if that residual glitch ever matters (option D, not implemented):* let the adapter emit string flags into the `mappingsTable` mirror (UI-friendly) while normalizing `mappingsRaw` to real booleans (canonical). Correct in every direction, at the cost of one more normalization step and a format divergence between store and mirror.

**Critical:** the valid ioBroker jsonConfig type for a JSON *editor* is `"jsonEditor"` — `"textarea"` and `"json"` are NOT valid and cause an admin validation error ("dp-coupler has an invalid jsonConfig"). UI-side validation exists only as column `validator`s; the authoritative validation stays in `parseMappings()` at adapter start.

**Critical:** the jsonConfig attribute for a field's default value is `"default"`, NOT `"def"` (`def` is the state-object `common` key, a different schema). Most field types silently ignore an unknown `def` (defaults then never apply from the UI — they come from `io-package.json` `native` + the configVersion self-heal instead), but `"slider"` enforces `additionalProperties: false` and hard-fails admin validation on `def`. Use `default` for every jsonConfig field.

**Critical:** the newer admin jsonConfig schema **requires** a root-level `"i18n"` property to be explicitly present (`required` in an `if/then` branch — omitting it fails validation even though semantically `false` == omitted). This project uses literal (untranslated) labels and has no `admin/i18n/` folder, so the root declares `"i18n": false`. Set it to `true` only if translation files are added under `admin/i18n/<lang>/translations.json`. Note: the admin schema reports `if/then` errors one blocker at a time — after fixing one root/field violation, re-validate, as the next may surface (this is how the `def` fix revealed the missing `i18n`).

**Critical:** JS-function attributes (`hidden`, `disabled`, `validator`, `defaultFunc`, `onChange.calculateFunc`, `confirm.condition`) must use an **explicit outer `return`** — never an IIFE. `ConfigGeneric.execute()` decides with the crude heuristic `fun.includes('return') ? fun : ´return ${fun}´`: a plain expression is wrapped, but an expression that merely *contains* the word `return` (e.g. inside an IIFE) is used as the function **body**. An IIFE then executes and its result is discarded — the attribute silently evaluates to `undefined`. Symptom: `hidden` always false (element always visible), `defaultFunc` never applies. Write `try { … return x; } catch (e) { return y; }` instead.

**No tooltips on column headings.** `renderOneFilter()` renders the heading as plain text in a `<span>` (React-escaped, so no HTML can be smuggled in) and never reads `headCell.tooltip`. A column's `tooltip` does reach the *cell* — `ConfigGeneric` puts it on the field's container as a native `title` — but the heading must speak for itself. Use self-explanatory titles plus a `staticText` legend next to the table.

**Critical: `table` columns cannot be hidden.** `ConfigTable` filters `schema.items` only by host/OS (`isHostAllowed`); `expertMode` and `hidden` on a column are evaluated when rendering the **cell**, while the header row is built from the unfiltered `items`. Setting either therefore empties the cells but leaves the column and its heading in place. Two table fields sharing one attribute are impossible as well — `ConfigPanel` derives `attr` from the item key (`attr: attr`), so an explicit `attr` in a panel item is ignored. Consequence: a "simple vs. expert" view of one table is not achievable with jsonConfig; use compact columns with `tooltip`, or an own component.

**`jsonEditor` cannot be relabelled.** `ConfigJsonEditor` renders a button with the hard-coded `I18n.t('jc_JSON editor')`; the field's `label` only titles the modal. For a read-only JSON view prefer `type: "text"` with `readOnly`, `minRows`/`maxRows` and `copyToClipboard` (the schema allows the copy button only on a disabled or read-only field) — own label, visible without a click, and a real export button instead of select-and-copy.

**Diagnosis:** any field accepts `"debug": true` — `ConfigGeneric.debugLog()` then logs function text, result and the current `data` to the browser console (`[jsonConfig]` prefix) for every evaluation. The fastest way to see what a JS attribute actually returns. Remove it once a field is understood.

**Validation before deployment:** the official AJV schema is at
`https://raw.githubusercontent.com/ioBroker/ioBroker.admin/master/packages/jsonConfig/schemas/jsonConfig.json`
and can be run against `admin/jsonConfig.json` locally with `ajv` — considerably cheaper than discovering a violation through the admin's one-blocker-at-a-time reporting.

`doNotSave: true` is honoured at save time (`JsonConfig.js`: such attributes are kept in the dialog's state but excluded from the `native` written to the DB), so a helper attribute does not pollute the instance config.

### Debug trace

`DPC_DEBUG` (module-level `const`, default `false`) controls the `[dpc]` trace output in `onStateChange()`. Set to `true` and rebuild to enable. `dpcLog()` is a thin wrapper around `console.log` gated by this flag — all `[dpc]` lines go through it.

### Deployment

`build/` is committed to the repository. Release workflow: `npm run build` → commit `build/` together with source changes → push → `iobroker url <github-url>` on the server. The server runs only `npm install`, no build step.

### Module export pattern

When `require.main !== module`: exports a factory function (used by dev-server). When run directly: self-instantiates.

## Naming conventions (mandatory)

- All identifiers CamelCase; underscores only for physical units (`_kPa`, `_mV`).
- Types, namespaces, constants: uppercase start — `MappingEntry`, `DpCoupler`.
- Member functions, member variables, free variables: lowercase start — `loadMappings()`, `sourceIndex`.
- Template parameters: `T` + CamelCase — `TValue`, `TKey`.
- Parameter conflicting with a member name: prefix `a` — `aIsrSlot`.

## Toolchain directory

`Toolchain/` contains cross-build container tooling (`xbc*` scripts) shared across NAEXT projects. The `ccode-session.sh` / `ccode-keepalive.sh` / `ccode-stop.sh` scripts manage a Claude Code container session. These are project-infrastructure scripts, not part of the adapter logic.
