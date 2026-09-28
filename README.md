# ioBroker dp-coupler Adapter

Relays state changes between arbitrary ioBroker datapoints via a JSON mapping
configuration. When a source datapoint changes, the adapter writes the new
value to the configured target datapoint.

## Status

**Field-test ready.** Unidirectional and bidirectional relay, ACK filter,
change-only filter, periodic sync, and per-channel enable switch with last-value
datapoints are implemented. See Roadmap for remaining items.

## Installation

```bash
iobroker url https://github.com/johannes-lode/iobroker.dp-coupler
```

Then create an instance in the admin UI and configure the mappings.

To update an existing installation, run the same command again. Instance
configuration is preserved (stored in the ioBroker database, not in the
adapter directory).

## How it works

The adapter reads a list of source→target mappings from its instance
configuration (`mappingsRaw`). On startup it subscribes to all source
datapoints (and, for bidirectional entries, their targets too). Whenever a
subscribed state changes, the value is written to the corresponding destination
with `ack: false` (command semantics).

Two filters and one propagation flag control relay behaviour:

- **forwardOnAck** — whether states with `ack: true` (device confirmations)
  trigger a relay. Default `false`: only commands (`ack: false`) are forwarded.
- **forwardChangesOnly** — whether re-writes of the same value are suppressed.
  Default `true`: only actual value changes are relayed.
- **propagateAck** — whether the target write receives `ack: true` when the
  source had `ack: true`. Default `false`: target always receives `ack: false`
  (command semantics).

All three have adapter-level defaults (configurable in the **Defaults** tab)
and can be overridden per mapping entry.

A cycle guard (`inFlight` set) prevents bidirectional relay loops: states
written by dp-coupler itself are never relayed back.

### Initial synchronization (baseline)

Relaying is edge-triggered: only *changes* are forwarded. A datapoint that
rarely or never changes therefore emits no event and — without help — would
never reach its target after a start. To close this gap, on every start the
adapter performs a one-time **baseline transfer**: it brings each target to its
current source value once, so every mapped datapoint is synchronized at least
once per adapter lifetime, independent of change events.

The baseline uses **compare-then-write**: it writes only when the target does
not already equal the source, so it never re-actuates a target that is already
in sync. Sources that are not yet available at start (e.g. an upstream adapter
still connecting) are completed automatically by their first arriving value.
Manually enabling a channel (`enabled` false→true) also pushes the current
source value.

This behaviour is always active and needs no configuration.

Each mapping entry also gets two runtime datapoints in the adapter's own namespace
(see [Channel datapoints](#channel-datapoints) below), allowing individual channels
to be disabled at runtime without changing the configuration.

The `info.connection` state is `true` while at least one mapping is loaded and
subscriptions are active.

On every successful start the current configuration is also written to
`mappings.json` in the adapter's install directory as a convenience export
(backup, deployment template).

## Configuration

### Mapping tab

The **Mapping** tab holds a row-wise table editor — one row per coupling:

| Column | Meaning |
|---|---|
| **ID** | handle of the coupling; names its `channels.<id>` datapoints. Generated when the row is created, editable, must stay unique (letters, digits, `_`, `-`; no dots) |
| **Source** | datapoint to read from; pick it from the object dialog or paste the path |
| **↔** | `→` unidirectional, `↔` bidirectional |
| **Target** | datapoint to write to |
| **Comment** | free text (stored as `_comment`), multi-line |
| **Enabled** | startup strategy for this coupling's switch: `yes`/`no` force it at every start, `(def)` forces the adapter default, `(keep)` leaves the runtime datapoint alone — see [Channel datapoints](#channel-datapoints) |
| **on ACK**, **on change**, **pass ACK** | per-entry filter overrides; `(def)` means "use the adapter default from the Defaults tab" |

Rows can be added, deleted and reordered; the table exports to CSV. Paths are
validated as you type: a path must not be empty, must not contain blanks and
must not start or end with a dot.

**Fan-out (one source, several targets)** is supported: enter one row per target with
the same source. Each row is an independent coupling with its own switch and its own
filter flags. Such branches are relayed **one-directionally** — if you mark a row
bidirectional while its source feeds several targets, the adapter downgrades it to
unidirectional and says so in the log, because a value written back to the star point
could not reach the sibling branches.

Below the table, **Mappings (JSON view)** shows the stored configuration in its
canonical form. It is **read-only** — the table is the editor — and has a copy
button, which is the simplest way to export the configuration. To *import* one,
use the command line (see [Mass deployment](#mass-deployment)) or the seed file.

The stored form is that JSON array, and it remains the single source of truth:



```json
[
  {
    "_comment": "Modbus reading → setpoint; ack=true because Modbus adapter confirms values",
    "source": "modbus.0.holdingRegisters.8",
    "target": "0_userdata.0.battery.powerSetpoint",
    "forwardOnAck": true,
    "propagateAck": true
  },
  {
    "_comment": "Bidirectional setpoint relay; disabled initially",
    "source": "0_userdata.0.setpoint",
    "target": "modbus.0.holdingRegisters.12",
    "bidirectional": true,
    "enabled": false
  },
  {
    "_comment": "Simple relay; all filters from adapter defaults",
    "source": "hm-rpc.0.ABC123.1.TEMPERATURE",
    "target": "0_userdata.0.temp_display"
  }
]
```

| Field               | Required | Default          | Description                                                                        |
|---------------------|----------|------------------|------------------------------------------------------------------------------------|
| `source`            | yes      | —                | Full ioBroker state ID to subscribe to                                             |
| `target`            | yes      | —                | Full ioBroker state ID to write to                                                 |
| `bidirectional`     | no       | `false`          | Also subscribes to `target` and relays changes back to `source`                    |
| `enabled`           | no       | adapter default  | Seed value for `channels.<id>.enabled` — only applied when the datapoint is created for the first time |
| `forwardOnAck`      | no       | adapter default  | Override: trigger relay when source has `ack: true`                                |
| `forwardChangesOnly`| no       | adapter default  | Override: relay only if `val` actually changed (suppress re-writes)                |
| `propagateAck`      | no       | adapter default  | Override: write target with `ack: true` when source had `ack: true`                |

Unknown keys are ignored by the adapter and preserved across edits, so notes you
add by hand survive a round trip through the table.

**Entries that cannot be used are dropped, never fatal.** `source` and `target`
must be non-empty, plausible state IDs (no blanks, no leading/trailing dot, no
`..`), and an entry may not couple a datapoint to itself. A rejected entry is
logged with its reason and skipped; **all other entries keep relaying**, and the
entry stays in the stored configuration so you can see and correct it. Optional
flags are interpreted tolerantly (`true`/`"true"`/`"yes"`/`1` and the negative
spellings; `"def"` — what the table's `(def)` option stores — means "not set"); a
value that cannot be interpreted is ignored with a warning and the adapter default
applies.

**Note for bidirectional entries:** `forwardOnAck`, `forwardChangesOnly`, and
`propagateAck` apply to both relay directions of the same entry.
Per-direction overrides are not currently supported.

### Defaults tab

Sets the adapter-wide defaults used by entries that do not specify their own
value.

| Setting                     | Default | Description                                                   |
|-----------------------------|---------|---------------------------------------------------------------|
| Forward on ACK               | off     | Trigger relay when source has `ack: true`. Enable for polling sources such as Modbus. |
| Forward value changes only   | on      | Suppress re-writes where `val` did not change (polling refreshes). |
| Propagate ACK flag to target | off     | Write target with `ack: true` when source had `ack: true`.    |
| Enable channels by default   | on      | Initial value of `channels.<id>.enabled` when the datapoint is first created. Can be overridden per entry via the `enabled` mapping field. |
| Sync interval                | 0 (off) | Periodically re-write all target datapoints with the last known source value (heartbeat/refresh). Set a value and unit (`ms`/`s`/`min`/`h`); `0` disables the feature. |
| Relay on change              | off     | Only evaluated when sync interval > 0. `on` = event-driven relay in addition to periodic sync. `off` = periodic only (no relay on state change events). |

Save the configuration; the adapter restarts and activates the new mappings.

## Channel datapoints

For every coupling the adapter creates two datapoints in its own namespace:

```
dp-coupler.0.channels.<id>.enabled    boolean, read/write
dp-coupler.0.channels.<id>.lastValue  read-only, type matches source
```

`<id>` is the coupling's **ID column** — one switch per table row, so a source that
feeds several targets can have individual branches switched off. The channel object
itself shows `source → target` as its name and the entry's comment as its
description, so the object tree is readable without opening the configuration.

**`enabled`** controls whether this coupling relays at runtime. Setting it to `false`
stops the adapter from forwarding source changes to that target; `lastValue`
continues to be updated regardless. For bidirectional entries one switch controls
both directions of that coupling. The datapoint persists across adapter restarts.

Channels of couplings that no longer exist are **removed at startup**, so deleting a
row does not leave datapoints behind.

The **Enabled** column of the coupling decides what happens to this datapoint at
**every adapter start**:

| Column value | At every adapter start |
|---|---|
| `yes` / `no` | the datapoint is forced to that value — a runtime change lasts until the next start |
| `(def)` | the datapoint is forced to the *Enable flag default* from the Adapter-Settings tab |
| `(keep)` | an existing datapoint is left untouched — **use this if you want to switch the coupling at runtime** |

A datapoint that does not exist yet is always created from the adapter default,
whatever the column says. An empty cell (entries written before this column existed)
behaves like `(keep)`.

So the column is a *startup strategy*, not a filter: `no` really means off, and
`(keep)` hands the decision to the datapoint.

**`lastValue`** shows the last value received from the source datapoint. It is updated
on every source change regardless of the `enabled` state, so the current source value
is always visible even when the channel is disabled. The datapoint type is read from
the source object definition; the timestamp is preserved from the source state, not
from the adapter's write time.

On every adapter start `lastValue` is pre-populated from the ioBroker state of the
source datapoint (using its original timestamp), so the value is immediately visible
without waiting for the next source change.

## Mass deployment

To deploy the same configuration across multiple ioBroker instances without
using the admin UI. Replace `dp-coupler.0` with the target instance identifier.

`mappingsRaw` is canonically a JSON **string** (that is what the admin UI saves).
The adapter additionally tolerates a natively set JSON **array** and self-heals it
back into the canonical pretty-printed string on the next start (one config
restart), so the JSON view never shows an unparsable value.

The adapter also mirrors the canonical string into `native.mappingsTable`, which
is what the admin table binds to. It is derived state, written by the adapter and
never read at runtime — do not set it by hand; setting `mappingsRaw` is enough.

```bash
# Import (canonical string – always works):
iobroker object set system.adapter.dp-coupler.0 \
    native.mappingsRaw="$(jq -Rs . mappings.json)"
iobroker restart dp-coupler.0

# Import (native array – also accepted; self-healed to a string on next start):
iobroker object set system.adapter.dp-coupler.0 \
    native.mappingsRaw="$(cat mappings.json)"

# Export (directly re-importable):
iobroker object get system.adapter.dp-coupler.0 | jq -r '.native.mappingsRaw' > mappings.json
```

### Seeding (initial deployment without UI access)

For a fresh instance with no mapping yet, place a `mappings.seed.json` file in the
adapter's install directory. On the next start, **if the configured mapping is empty**,
the adapter adopts the seed entries into `mappingsRaw` and then **consumes (deletes)
the seed file** — a one-shot, so emptying the config later cannot resurrect it.

```bash
cp mappings.json <adapter-dir>/mappings.seed.json
iobroker restart dp-coupler.0
```

To keep the seed file around (e.g. a read-only template), make the file or its
directory read-only; the deletion then fails non-fatally (a warning is logged) and
re-seeding is still prevented because the config is no longer empty.

Note: `mappings.seed.json` (seed input, consumed) is deliberately separate from
`mappings.json` (export, rewritten on every start) to avoid a feedback loop.

## Development

```bash
npm install
npm run build              # compile TypeScript → build/
npm run dev-server:setup   # first-time setup of the local ioBroker instance
npm run dev-server         # start dev server with watch mode
```

After changing `io-package.json` or `admin/jsonConfig.json`, restart the
dev-server. Changes to `src/main.ts` are picked up automatically.

Node.js ≥ 20 required.

`build/` is committed to the repository. Before pushing a release, run
`npm run build` and include the updated `build/` in the commit.

## Changelog

### 0.4.2 — periodic sync no longer undoes a write-back

With a **bidirectional** coupling and **periodic sync** active, a change made at the
target was reverted by the next tick: the cached source value was not updated when
the adapter itself wrote the source, so the tick kept re-writing the outdated value
while the source already held the new one.

The cache now tracks the source regardless of who wrote it. Only configurations with
both a bidirectional coupling and a sync interval were affected.

### 0.4.1 — `Enabled` is a startup strategy

The **Enabled** column used to be a *seed* value: it was applied only when the
channel datapoint did not exist yet, and was silently ignored on every later start.
Setting a row to `no` therefore did not switch the coupling off, and the initial
synchronization ran for it as if it were active.

The column now takes effect at **every** adapter start and has a fourth value:

- `yes` / `no` — forced at every start
- `(def)` — forced to the adapter default at every start
- `(keep)` — the runtime datapoint decides (the previous behaviour, and what an
  empty cell means, so existing configurations are unchanged)

Choose `(keep)` for couplings you want to switch through the datapoint at runtime.

### 0.4.0 — fan-out and per-coupling channels

**Breaking:** the channel datapoints are renamed. They were derived from the source
state ID (`channels.modbus_0_holdingRegisters_8.*`); they are now named by the
coupling's new **ID** field (`channels.<id>.*`).

- The old `channels.<source>.*` datapoints are **not migrated** and are **deleted**
  at startup. The new switches therefore start from their seed value — the row's own
  `enabled` field if it has one, otherwise the *Enable flag default* from the
  Adapter-Settings tab. A switch you had turned off is not remembered; check the
  channels once after the upgrade. Anything referencing the old datapoint IDs
  (scripts, VIS, history) must be updated.
- Every mapping entry gains an `id` field. It is assigned automatically — for new
  rows by the admin table, for existing entries and CLI imports by the adapter on
  first start, which writes them into the stored configuration. **No manual step is
  needed**, but the stored JSON will differ from what you imported.
- **New:** one source may feed several targets (fan-out / star). Each row is an
  independent coupling with its own switch and filter flags. Bidirectional rows on a
  multiply used source are downgraded to unidirectional with a log warning.
- **New:** channels of deleted couplings are removed at startup instead of lingering.

Earlier versions were concept studies, so this break was accepted deliberately
rather than carrying a migration path.

### 0.3.0 — table editor

Row-wise table editor for the couplings in the admin UI, with datapoint pickers and
per-entry columns; the JSON became a read-only view with a copy button. Malformed
mapping entries are dropped with a logged reason instead of disturbing the adapter.

### 0.2.0 — configuration robustness

Tolerant `mappingsRaw` (JSON string or native array) with self-heal, config default
normalization via `configVersion`, one-shot seeding from `mappings.seed.json`.

### 0.1.0

Initial proof-of-concept release.

## Roadmap

- **Bidirectional fan-out** — let a value written back by one satellite reach the
  other branches of a star, with the table row order as precedence
  ([design record](docs/design/fan-out-and-coupling-identity.md) §5)
- **Cycle detection** — warn at startup about configurations that couple in a circle
  (`A→B, B→A` and longer chains); `inFlight` already prevents the runaway at runtime
- **Fail counter** — set `info.connection` to `false` after a configurable
  number of consecutive write failures per mapping
- **Value conversion** — optional `transform` expression per mapping entry
  (JSON/JSONata), similar to ioBroker aliases

## License

AGPL-3.0-only — Copyright (c) Johannes Lode
