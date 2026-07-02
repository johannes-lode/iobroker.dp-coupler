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

### Configuration

`this.config.mappingsRaw` (ioBroker DB) is the single source of truth — persisted automatically by ioBroker, edited via admin UI jsonEditor. Canonical form is a JSON **string**; a natively set JSON **array** is tolerated and self-healed (see below).

`parseMappings(raw, label)`: tolerant parse+validate helper. A string is `JSON.parse`d; an array/object is taken as-is. Validates `Array.isArray` + filters entries via `isMappingEntry`. Shared by `loadMappings()` and `readSeedMappings()`. Returns validated array or `null` on unrecoverable error.

`loadMappings()`: thin wrapper — `parseMappings(this.config.mappingsRaw, "mappingsRaw")` + logs the loaded count.

`readSeedMappings()` / `consumeSeedFile()`: one-shot seeding for initial deployment without UI access. `readSeedMappings()` reads+validates `mappings.seed.json` (separate from the export file). `consumeSeedFile()` deletes it — called only in the `extendForeignObjectAsync().then()` after a successful config write, so a failed write leaves the seed in place. Non-fatal on delete failure (read-only file = legitimate opt-out; re-seed still blocked by the "config not empty" condition).

`persistMappingsFile(content)`: called after every successful `loadMappings()` with the canonical string. Writes to `mappings.json` in `this.adapterDir` as a convenience export (backup, deployment template). Non-fatal on failure. Content-equality check prevents nodemon restart loops.

**Self-heal / normalization (one write in `onReady()`):** a single `extendForeignObjectAsync("system.adapter.${namespace}", { native: patch })` call combines three concerns (≤ one config restart): (a) `configVersion < 1` → fill missing `NATIVE_DEFAULTS` so the admin UI shows real values, set `configVersion: 1`; (b) native-array `mappingsRaw` → canonical pretty-printed string; (c) seeded mappings → persisted. No early `return` — the tolerant loader relays from the in-memory array even if no restart occurs.

Mass deployment: `iobroker object set system.adapter.dp-coupler.0 native.mappingsRaw="$(jq -Rs . mappings.json)"` (canonical) or `"$(cat mappings.json)"` (native array, self-healed), or paste JSON into the admin UI. See README "Mass deployment" for import/export/seeding.

### `DpCoupler extends utils.Adapter`

- `sourceIndex: Map<string, MappingEntry>` — built in `onReady()`, O(1) forward-direction lookup.
- `targetIndex: Map<string, MappingEntry>` — built in `onReady()` for bidirectional entries only, O(1) reverse-direction lookup.
- `inFlight: Set<string>` — IDs of states dp-coupler itself just wrote; prevents relay cycles.
- `lastState: Map<string, ioBroker.State>` — last known state per source ID; populated at startup via `getForeignStateAsync` and updated on every forward-direction `onStateChange`. Shared cache for periodic sync and future enable-schalter `lastValue` datapoint.
- `syncIntervalMs` — effective sync interval in ms, computed once in `onReady()` from `syncIntervalValue × unitMultiplier`; `0` when sync is disabled.
- `syncTimer` — `setInterval` handle; `null` when periodic sync is disabled.
- `unloading: boolean` — set to `true` in `onUnload()`; checked at the top of each `onSyncTick()` iteration to abort the loop cleanly during shutdown.
- `onReady()`: creates `info` channel and `info.connection` via `setObjectAsync` → calls `loadMappings()` → if the config mapping is empty, attempts `readSeedMappings()` → builds the combined normalization `patch` (configVersion defaults + array self-heal + seeded mappings) and fires the single `extendForeignObjectAsync` write (consumes the seed file on success) → `persistMappingsFile(canonicalRaw)` → builds `sourceIndex` and `targetIndex` → `subscribeForeignStatesAsync(sources + bidir targets)` → pre-populates `lastState` via `getForeignStateAsync` for all sources → starts `syncTimer` if `syncInterval > 0` → sets `info.connection = true`.
- `onStateChange()`: cycle guard (`inFlight`) → direction detection (source or reverse target) → updates `lastState` for forward direction → periodic-only guard (`syncInterval > 0 && !relayOnChange` → return) → `forwardOnAck` filter → `forwardChangesOnly` filter → `inFlight.add(destination)` → resolve `propagateAck` → `setForeignStateAsync`.
- `onSyncTick()`: iterates `sourceIndex`; for each entry with a cached `lastState`, writes target via `setForeignStateAsync` (same `inFlight` guard as normal relay, respects `propagateAck`, bypasses `forwardOnAck`/`forwardChangesOnly` filters by design — heartbeat must always write).
- `onUnload()`: sets `unloading = true` → clears `syncTimer` → fire-and-forget `setStateAsync("info.connection", false)` → calls `callback()` synchronously. **No async operations are awaited** — Redis/IPC ops hang indefinitely when js-controller tears down the connection during adapter restart.

### Mapping schema (`MappingEntry`)

```typescript
interface MappingEntry {
    source: string;              // full ioBroker state ID
    target: string;              // full ioBroker state ID
    bidirectional?: boolean;     // if true, also relays target→source
    forwardOnAck?: boolean;      // override adapter default; default false — trigger relay on ack=true source
    forwardChangesOnly?: boolean; // override adapter default; default true
    propagateAck?: boolean;      // override adapter default; default false — write target with ack=state.ack
}
```

Per-entry fields override adapter-level defaults (`forwardOnAckDefault`, `forwardChangesOnlyDefault`, `propagateAckDefault` in `native` config).

`_comment` and other unknown keys are silently ignored by the type guard.

### Cycle guard (`inFlight`)

When dp-coupler writes state X, it adds X to `inFlight` before the write. When `onStateChange(X)` fires as a result, the guard detects it, removes X from `inFlight`, and returns without relaying. On write failure, X is removed in the `catch` block to prevent permanent blockage.

### Adapter-level defaults

`forwardOnAckDefault` (default `false`): whether a source state with `ack: true` triggers a relay. False means only commands (`ack: false`) trigger a relay.

`forwardChangesOnlyDefault` (default `true`): whether to relay only actual value changes. Uses `state.lc !== state.ts` to detect re-writes of unchanged values (e.g. polling refreshes).

`propagateAckDefault` (default `false`): whether the target write receives `ack: state.ack` from the source. False means the target always receives `ack: false` (command semantics).

`syncIntervalValue` (default `0`) + `syncUnit` (default `"ms"`, options: `ms`/`s`/`min`/`h`): together define the periodic sync interval. `syncIntervalValue = 0` disables the feature. Effective interval in ms is computed once at startup as `syncIntervalValue × unitMultiplier` and stored in `syncIntervalMs`. When active, all target datapoints are re-written at this interval with the last known source value (heartbeat/refresh). Only the forward direction (source → target) is synced — the reverse direction of bidirectional entries is not included in periodic updates.

`configVersion` (default `0`, **io-package native only — not in jsonConfig**): self-heal/migration marker. When `< 1` at startup, `onReady()` fills any missing `NATIVE_DEFAULTS` and bumps it to `1` (via the shared normalization write), so the admin UI shows real values on fresh/migrated instances instead of blanks. Forward-compatible hook for future schema migrations. `NATIVE_DEFAULTS` (module-level const) mirrors the io-package `native` defaults minus `mappingsRaw`.

`relayOnChange` (default `false`): only evaluated when `syncIntervalMs > 0`. `false` = periodic-only mode (no event relay). `true` = both periodic sync and event-driven relay. When `syncInterval === 0`, this flag has no effect — event-driven relay is always active.

### Single-file architecture decision

`src/main.ts` is intentionally kept as a single file. All features share tightly coupled instance state (`sourceIndex`, `targetIndex`, `inFlight`, `lastState`, `config`) — splitting would require passing the adapter instance across module boundaries, which reduces cohesion without adding clarity.

**Revisit when:** (a) a feature introduces a standalone utility with no adapter-instance dependency (e.g., a JSONata transformer wrapping an external library), or (b) `src/main.ts` exceeds ~600–800 lines. At that point, extract the self-contained utility first; keep the adapter class in one file unless a clear seam emerges.

### Admin UI

`admin/jsonConfig.json`: root type is `"tabs"`, containing a panel with a `"jsonEditor"` field (key `mappingsRaw`).

**Critical:** the valid ioBroker jsonConfig type for JSON editing is `"jsonEditor"`. The types `"textarea"` and `"json"` are NOT valid and cause an admin validation error ("dp-coupler has an invalid jsonConfig"). No UI-side validation — validation happens in `loadMappings()` at adapter start.

**Critical:** the jsonConfig attribute for a field's default value is `"default"`, NOT `"def"` (`def` is the state-object `common` key, a different schema). Most field types silently ignore an unknown `def` (defaults then never apply from the UI — they come from `io-package.json` `native` + the configVersion self-heal instead), but `"slider"` enforces `additionalProperties: false` and hard-fails admin validation on `def`. Use `default` for every jsonConfig field.

**Critical:** the newer admin jsonConfig schema **requires** a root-level `"i18n"` property to be explicitly present (`required` in an `if/then` branch — omitting it fails validation even though semantically `false` == omitted). This project uses literal (untranslated) labels and has no `admin/i18n/` folder, so the root declares `"i18n": false`. Set it to `true` only if translation files are added under `admin/i18n/<lang>/translations.json`. Note: the admin schema reports `if/then` errors one blocker at a time — after fixing one root/field violation, re-validate, as the next may surface (this is how the `def` fix revealed the missing `i18n`).

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
