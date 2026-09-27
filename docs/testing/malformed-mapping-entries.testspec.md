# Test specification — Robustness against malformed mapping entries

**Feature under test:** the hardening added 2026-09-26 — a mapping entry with
missing, empty or implausible mandatory fields must never disturb runtime
behaviour; its only permitted effect is that the entry is dropped with a logged
reason while every other entry keeps working.
**Design context:** [`../design/admin-ui-mapping-table.md`](../design/admin-ui-mapping-table.md) §8
(the hardening is a prerequisite of the table editor, which makes unfilled rows
an everyday occurrence).
**Style:** black-box / behavioural. Assertions are made on observable effects
only — relay writes, created objects, log output — never on internal fields.

---

## 1. Scope

In scope:

- Rejection of entries whose `source`/`target` is missing, not a string, empty,
  whitespace-only, or an implausible state ID.
- Trimming of surrounding whitespace (copy&paste tolerance) instead of rejection.
- Rejection of self-couplings (`source === target` after trimming).
- Tolerant normalization of the optional boolean flags, and the dropping of
  uninterpretable flag values without discarding the entry.
- **Isolation:** one bad entry never prevents the other entries from relaying,
  and never prevents the adapter from reaching `ready` / `info.connection`.
- **No silent pruning:** a rejected entry stays in the stored configuration.

Out of scope: full ioBroker ID validation (deliberately not implemented), the
admin UI table itself, and regression of ordinary relay behaviour beyond the
touch points named above.

---

## 2. Observation model (required harness capabilities)

**Stimulus**
- **S1** Start the adapter with an arbitrary `native.mappingsRaw` — as a JSON
  **string** and, separately, as a native **array**.
- **S2** Set any foreign source state with control over `val`, `ack`, `ts`, `lc`.
- **S3** Place a `mappings.seed.json` in the adapter directory before start.

**Observation**
- **O1** Record every write the adapter issues to a foreign state, in order.
  Must also support the assertion *"no write was issued to X"*.
- **O2** Read `info.connection` and detect that the adapter reached `ready`.
- **O3** Enumerate the adapter's own objects below `channels.` (to assert that
  no channel was created for a rejected entry, and that a malformed ID produced
  no stray object).
- **O4** Capture the adapter's log at `warn` and `info` level, with message text.
- **O5** Read back `system.adapter.dp-coupler.<n>.native.mappingsRaw` after start
  (to assert the configuration was not pruned).

---

## 3. Conventions and default fixture

Unless a case says otherwise:

- Adapter defaults are the io-package defaults; periodic sync is off.
- `GOOD` denotes a valid, working entry
  (`source: "0_userdata.0.test.srcA"`, `target: "0_userdata.0.test.dstA"`),
  used in every case as the **witness** that the rest of the configuration is
  unaffected.
- "relays" means: a change of the source is observed as exactly one write to the
  target (O1).
- Log assertions match on the entry index and the reason, not on exact wording.

---

## 4. Test groups and cases

### Group A — Mandatory fields

| # | Entry under test (besides `GOOD`) | Expected |
|---|---|---|
| A1 | `{ "source": "", "target": "0_userdata.0.x" }` | entry dropped, warning names index; `GOOD` relays; adapter reaches `ready`; `info.connection === true` |
| A2 | `{ "source": "0_userdata.0.x", "target": "" }` | as A1 |
| A3 | `{ "source": "   ", "target": "0_userdata.0.x" }` | as A1 (whitespace-only is empty) |
| A4 | `{ "target": "0_userdata.0.x" }` (no `source`) | as A1 |
| A5 | `{ "source": 42, "target": "0_userdata.0.x" }` | as A1 (wrong type) |
| A6 | `{ "source": null, "target": "0_userdata.0.x" }` | as A1 |
| A7 | `[ { "source": "", "target": "" } ]` **as the only entry** | adapter reaches `ready`, `info.connection === true`, log reports 0 valid mappings; **no** object below `channels.` was created |

**A7 is the regression case for the known failure path:** before the hardening
an empty source produced the object ID `channels.` (trailing dot) inside an
un-guarded `await`, which aborted startup — no `ready`, no relay at all.

### Group B — ID plausibility and trimming

| # | `source` value | Expected |
|---|---|---|
| B1 | `"  0_userdata.0.test.srcB  "` | **accepted**, trimmed; relays normally (copy&paste tolerance) |
| B2 | `"0_userdata.0 test.srcB"` (inner blank) | dropped with warning |
| B3 | `".0_userdata.0.srcB"` (leading dot) | dropped with warning |
| B4 | `"0_userdata.0.srcB."` (trailing dot) | dropped with warning |
| B5 | `"0_userdata..0.srcB"` (double dot) | dropped with warning |
| B6 | `"0_userdata.0.srcB"` referring to a **non-existent** object | **accepted** — a not-yet-existing datapoint is legitimate (it may be created later); no crash, no channel-setup failure |

B6 guards the boundary: the check is about *plausibility of the ID form*, not
about existence. A full ioBroker ID validation is explicitly not implemented.

### Group C — Self-coupling

| # | Entry | Expected |
|---|---|---|
| C1 | `source === target` | dropped with warning naming the ID; `GOOD` relays |
| C2 | `source === target` after trimming (`"x "` / `" x"`) | as C1 |

### Group D — Optional flags (tolerant normalization)

The entry is **never** discarded because of an optional flag.

| # | Flag value | Expected |
|---|---|---|
| D1 | `"bidirectional": "true"` | treated as `true` — a change of the target relays back to the source |
| D2 | `"bidirectional": 1` | as D1 |
| D3 | `"bidirectional": "false"` / `0` / `"no"` | treated as `false` — no reverse relay |
| D4 | `"bidirectional": "maybe"` | flag dropped **with a warning**; entry stays active; adapter default applies (no reverse relay) |
| D5 | `"forwardChangesOnly": "no"` | treated as `false` — an unchanged re-write (`lc < ts`) **is** relayed |
| D6 | `"forwardChangesOnly": "nonsense"` | flag dropped with warning; adapter default (`true`) applies — unchanged re-write is **not** relayed |
| D7 | `"propagateAck": "on"` | treated as `true` — target write carries the source `ack` |
| D8 | `"enabled": "false"` | channel starts disabled; no relay until enabled at runtime |
| D9 | flag absent | adapter default applies; **no** warning is logged |

D4/D6 are the substantive cases: before the hardening `"maybe"` read as `false`
for `bidirectional` (strict `=== true`) but as `true` for the other flags
(truthy `??` test) — in both directions the opposite of the configuration, and
silently.

### Group E — Preservation of unknown keys

| # | Stimulus | Expected |
|---|---|---|
| E1 | valid entry carrying `"_comment": "text"` | entry works; `_comment` still present in the stored `mappingsRaw` (O5) |

### Group F — No silent pruning of the configuration

| # | Stimulus | Expected |
|---|---|---|
| F1 | `mappingsRaw` as a **string** containing one bad and one good entry | after start, the stored `mappingsRaw` still contains **both** entries (O5); only the good one relays |
| F2 | `mappingsRaw` as a native **array** containing one bad and one good entry | self-heal rewrites it to a canonical pretty-printed **string** that still contains **both** entries |
| F3 | `mappings.seed.json` containing one bad and one good entry, config empty | configuration is seeded with **both** entries; only the good one relays; seed file consumed |

F2/F3 are the cases the hardening changed: previously the canonical string was
rebuilt from the *filtered* list, so a rejected entry disappeared from the
configuration — invisible to the operator, and in F3 unrecoverable because the
seed file is deleted.

### Group G — Isolation (the guarantee itself)

| # | Stimulus | Expected |
|---|---|---|
| G1 | 1 bad + 3 good entries | all three good entries relay; exactly one warning; `ready` reached |
| G2 | bad entry listed **first** | as G1 — position must not matter |
| G3 | 10 entries, every second one bad | all 5 good ones relay |
| G4 | a mapping whose channel setup fails unexpectedly (harness forces a failure, e.g. by making one `setObject` reject) | that one entry is dropped with a warning; the remaining entries relay; `ready` is reached and `info.connection === true` |

G4 tests the second layer (per-entry error isolation) independently of the
validation: it must hold even for a failure the validation does not foresee.
If the harness cannot force such a failure, this case may be covered by a
targeted unit test of the loop instead — the guarantee is important enough to
warrant an exception from the black-box style.

---

## 5. Coverage matrix

| Behaviour | Cases |
|---|---|
| Mandatory field missing / empty / wrong type | A1–A6 |
| Known startup-abort regression | A7 |
| ID plausibility, trimming, non-existence | B1–B6 |
| Self-coupling | C1, C2 |
| Flag normalization (tolerant) | D1–D3, D5, D7, D8 |
| Uninterpretable flag → drop, not misread | D4, D6 |
| No warning when a flag is simply absent | D9 |
| Unknown keys preserved | E1 |
| Configuration not pruned | F1–F3 |
| Isolation of a bad entry | G1–G4 |

---

## 6. Notes for the implementer

- The **witness entry** (`GOOD`) is what makes these cases meaningful: every
  case must assert not only that the bad entry was dropped, but that the good
  one still relays. A test that only checks the warning would pass even if the
  adapter had stopped relaying entirely.
- Assert **absence** of writes explicitly (O1) — several cases are invisible
  otherwise.
- `ready` and `info.connection` must be asserted in every group-A case; the
  failure this specification exists for manifests precisely as their absence.
- The repository still has no test scaffold. This specification is written ahead
  of it, like the baseline one.
