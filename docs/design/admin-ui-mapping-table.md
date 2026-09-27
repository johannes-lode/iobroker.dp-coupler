# Admin UI: table editor for mapping entries

**Status:** decided 2026-09-26; implementation pending (staged, see §6).
**Scope:** `admin/jsonConfig.json` (primary), `src/main.ts` (one hardening
change to `isMappingEntry`), `io-package.json` (dependency declaration).
**Supersedes:** the sketch "Feature-Request: Admin-UI-Tabellen-Editor für
Einträge (2026-07-02)" in `WORKPLAN.md`, whose open design points are resolved
here.

---

## 1. Problem

Mapping entries are edited today through a single raw `jsonEditor` field bound
to `mappingsRaw`. That is adequate for power users and bulk edits, but it offers
no datapoint picking, no per-row structure, and no protection against malformed
entries. The goal is a **row-wise editor**: source path, coupling direction, and
target path per line, with the paths selectable through the admin object dialog
or pasteable as text.

### The binding constraint

`native.mappingsRaw` **stays a JSON string**. This is not a stylistic
preference: a previous development round established that a natively stored
JSON *array* cannot be set reliably from the CLI
(`iob object set … native.mappingsRaw=…`), which is the deployment path this
adapter is built around. The canonical string form also keeps the `jsonEditor`
display stable. Everything below has to work *around* this constraint rather
than relax it.

The tension this creates: a jsonConfig `table` binds to an **array** attribute.
Table and storage format therefore disagree by construction, and something has
to bridge them.

---

## 2. Dimension 1 — Where does the editor live?

### Option 1 — Declarative jsonConfig `table` **[CHOSEN]**

A `table` field inside the existing Mapping panel. Changes are confined to
`admin/jsonConfig.json`; the working Defaults tab stays untouched; no new build
branch, no bundle in the repository.

Limits accepted: layout freedom is whatever the admin components provide; the
direction switch is a compact dropdown rather than a freely drawn symbol
toggle. With `objectId` columns (picker dialog **and** free text entry) the
functional goal — pick or paste a datapoint path — is nevertheless met.

### Option 2 — jsonConfig plus a `custom` React component **[DEFERRED]**

jsonConfig keeps the frame; only the mapping grid becomes an own React
component (`type: "custom"`, loaded from `admin/custom/…`). Full layout freedom,
and the string/array bridge **disappears entirely** — the component receives
`data.mappingsRaw` as a string, parses it itself, and writes a string back.

Deferred, not rejected: it costs a second build branch (Vite + React +
`@iobroker/adapter-react-v5`) and a committed bundle, and the bundling mechanics
(`bundlerType: "module"`, presumably module federation so React is not bundled
twice) are unverified. This is the designated escalation path if Option 1's
ergonomics disappoint.

### Option 3 — Own admin page, the way MODBUS does it **[REJECTED]**

Investigated because the MODBUS register editor was the stated visual model.
Finding: MODBUS does **not** use jsonConfig at all. It declares
`"adminUI": {"config": "materialize"}` and ships a complete Vite/React
application (`src-admin/`, ~3.2 MB bundle committed under `admin/assets/`).

Rejected because it would require rebuilding the parts that already work (the
Defaults tab, whose jsonConfig schema validation was only recently sorted out)
for no gain over Option 2.

---

## 3. Dimension 2 — Bridging string storage and array table

### Option A — Store a native array after all **[REJECTED]**

Would dissolve the problem, but breaks CLI deployment (see §1). Not available.

### Option B — Bidirectional coupling of two attributes **[REJECTED]**

Helper array attribute with `doNotSave: true`, kept in sync with `mappingsRaw`
in **both** directions via `onChange.calculateFunc`. Rejected as inherently
cyclic (string changes table changes string …). `ignoreOwnChanges` exists and is
presumably meant for exactly this, but the behaviour is undocumented, and a
cycle that misfires inside a configuration dialog corrupts configuration.

### Option C — Asymmetric coupling ("variant α") **[CHOSEN]**

The cycle is broken by making the two directions structurally different rather
than by suppressing feedback:

| Direction | Mechanism | When |
|---|---|---|
| string → table | `defaultFunc` on the `doNotSave` table attribute | once, when the dialog opens (the attribute is never stored, so it is always empty on open and the default applies) |
| table → string | `onChange.calculateFunc` on `mappingsRaw` | on every table edit |

There is no standing trigger in the reverse direction, so no cycle can form.

### Option D — Explicit button, conversion in the adapter ("variant β") **[DEFERRED — fallback]**

A `sendTo` button (optionally with `"onLoaded": true`, which fires once when the
dialog opens) sends the conversion to the running instance; an `onMessage`
handler answers, optionally returning the configuration via `useNative`.

Architecturally the most attractive option, because the conversion would run
through the adapter's own `parseMappings()` — **one** validation truth instead
of a second implementation in UI JavaScript. Deferred because it requires a
running instance (the button is dead on a stopped adapter) and new adapter code.

This is the designated fallback if the `defaultFunc` assumption in Option C does
not hold (§7, assumption 1).

---

## 4. Dimension 3 — What happens to the JSON editor

The remaining weakness of an asymmetric coupling is **divergence**: two editing
surfaces, only one of which tracks the other. Removing the second surface
removes the weakness.

- **Delete the `jsonEditor` field [REJECTED].** `onChange.calculateFunc` is an
  attribute *of a field*. With no field for `mappingsRaw`, the table → string
  computation has no carrier and would need a hidden substitute field.
- **Keep it editable [REJECTED as the end state].** Reintroduces divergence.
  Retained only temporarily during stage 1 (§6) as a safety net.
- **Keep it, `"readOnly": true` [CHOSEN].** The editor stays the carrier of the
  computation, becomes a live view of the canonical string, and doubles as the
  manual JSON **export** (open, select, copy). Editing is disabled, so the table
  is the single editing surface.

**Import** is consciously *not* solved in the UI for now: the CLI path
(`iob object set … native.mappingsRaw="$(cat mappings.json)"`) and the seed file
remain the import mechanisms, joined by the table's built-in CSV `import`
button. Decided 2026-09-26: a dedicated JSON import in the UI is not worth
adapter code at this stage.

---

## 5. Dimension 4 — Rendering the direction switch

`bidirectional` is a `boolean` in `MappingEntry` and must stay one.

- **Checkbox [fallback].** Type-clean, but an empty/checked box conveys nothing
  about direction.
- **CSS restyling of the checkbox [REJECTED].** `style`/`darkStyle` can recolour
  and resize a MUI checkbox, not replace its glyphs.
- **`select` with boolean option values [CHOSEN].**
  `[{"label": "→", "value": false}, {"label": "↔", "value": true}]` — the schema
  places no restriction on option value types (its own example uses `1`), so the
  stored value stays boolean while the cell shows an arrow.
- **`"format": "radio"` with `"horizontal": true` [NOT AVAILABLE].** Two
  side-by-side symbol buttons would be nicer still, but the documentation marks
  both `horizontal` and per-option `icon` as available only from admin v8.3.3;
  the target version is 7.8.

---

## 6. Resulting mechanic and staging

```
DB (canonical string)
      │  defaultFunc  (once, on dialog open)
      ▼
  mappingsTable   (doNotSave — never stored in native)
      │  calculateFunc  (on every table edit)
      ▼
  mappingsRaw (string)  ──[Save]──>  DB  ──>  adapter restart
```

The adapter is unaffected: it keeps reading a string, the self-heal keeps its
meaning, no new `native` field is introduced, and therefore **no
`CONFIG_VERSION` bump** is required.

Implementation is staged because assumption 1 of §7 carries a configuration-loss
risk:

- **Stage 1 — verification.** Table added, `jsonEditor` deliberately left
  **editable** as an escape hatch, and `calculateFunc` written defensively so an
  unpopulated table can never overwrite the stored string:
  `data.mappingsTable === undefined ? data.mappingsRaw : JSON.stringify(data.mappingsTable, null, 2)`.
  Field observation answers the open assumptions.
- **Stage 2 — fixing.** `"readOnly": true`, adapter hardening, dependency
  declaration, documentation, version bump.
- **Stage 3 — later.** Further columns, picker refinement, the round-trip
  question (§8), possibly Option 2.

---

## 7. Unverified assumptions (to be answered by field observation)

1. ~~**Does `defaultFunc` apply to a `doNotSave` `table`?**~~ **ANSWERED
   2026-09-27 — yes.** The table fills from the stored string on open; the
   foundation of Option C (§3) holds.
2. ~~Do `defaultFunc` / `calculateFunc` accept an IIFE with `try/catch`?~~
   **ANSWERED 2026-09-27 — no, and the failure is silent.** `ConfigGeneric.execute()`
   wraps a JS attribute as `fun.includes('return') ? fun : ´return ${fun}´`. An IIFE
   contains the word `return` inside itself, so it is used as the function *body*:
   the IIFE runs, its value is discarded, the attribute evaluates to `undefined`.
   Observed effect in the first field run: fill-in never happened (`defaultFunc`
   → `undefined`, table empty) and the error box was always visible (`hidden`
   → `undefined` → falsy) — while `calculateFunc`, the one expression *without*
   the word `return`, worked correctly and produced a valid stored string.
   **Rule: always use an explicit outer `return`.** Recorded in CLAUDE.md.
3. ~~Does the table component **preserve unknown keys** of a row object?~~
   **ANSWERED 2026-09-27 — yes, it patches.** A `_comment` written in the JSON
   editor survived a direction change made in the table. The data loss accepted
   in §8 does not occur.
4. ~~Does a `select` column accept **boolean** option values?~~ **ANSWERED
   2026-09-27 — yes**, the stored value is a real boolean (verified in the JSON
   editor), so `MappingEntry` stays type-clean.
5. ~~Is a plain string accepted for a column `title` when the root declares
   `"i18n": false`?~~ **ANSWERED — yes**, the file validates against the official
   AJV schema (see CLAUDE.md for how to run that check locally).
6. ~~Is `objectId` usable inside a table cell?~~ **ANSWERED 2026-09-27 — yes**,
   picker dialog and copy&paste both work, width is fine.

### 7b. Columns cannot be hidden — no simple/expert view (2026-09-27)

Requested: a plain view (source, direction, target, comment) and a full one for
the optional per-entry flags, switched by a toggle. **Not achievable with the
`table` type.** Field observation plus source inspection:

- `ConfigTable` filters `schema.items` only through `isHostAllowed` (os/notOs/
  docker). `expertMode` and `hidden` on a column are evaluated when the **cell**
  renders, while the header row is built from the unfiltered `items` — so the
  cells go empty but the column and its heading stay.
- Two table fields bound to one attribute are impossible: `ConfigPanel` passes
  `attr: attr` from the item key, so an explicit `attr` in a panel item is ignored.
- An own view flag (`doNotSave` or a native field) changes nothing about this —
  it would hide the same cells and leave the same headings.

Taken instead: compact columns. The four flags carry short titles (`On`, `ACK`,
`Δ only`, `→ACK`) with `tooltip` explanations at 7 % each, so they cost 28 %
instead of 38 %, and source/target/comment share the rest with no fixed width.

This is the **second** argument for Option 2 (§2), next to §7a. A real two-view
editor needs an own component.

### Upstream defect found on the way (2026-09-27)

`uniqueColumns` leaves the dialog stuck in the error state after the offending
row is **deleted**. Cause (`ConfigTable.js`): `validateUniqueProps()` reports the
error at *column* level (`onError(uniqueCol, …)` plus `state.errorMessage`) and
is the only place that clears it — but it is called only on init and on a *cell
change*, never from `onDelete`, which merely cleans up the row-level
`tableErrors`. A defect of `@iobroker/json-config`, not of this configuration.
Workaround: touch any cell (that triggers the validation) or reopen the dialog.
`uniqueColumns` is kept regardless, because the alternative is that a duplicate
source shows up only as a log warning nobody reads — the adapter itself already
handles duplicates defined (warn, first entry wins).
7. ~~Does `doNotSave` keep the helper attribute out of `native`?~~ **ANSWERED —
   yes**, by code inspection: `JsonConfig.js` keeps such attributes in the dialog
   state but excludes them from the `native` it writes.

---

## 7a. Open issue — the dialog always reports "modified" (2026-09-27)

Observed in the first successful field run: **every** opening of the instance
configuration leaves the mask in the changed state, so closing always asks to
discard. The operator can no longer tell whether they actually changed anything.

Cause (source inspection, not speculation): `JsonConfigComponent` computes
`changed` as `JSON.stringify(data) !== originalData` — a whole-object
comparison. `originalData` is loaded from `native`, where the `doNotSave` helper
attribute by definition never appears; as soon as `defaultFunc` fills
`mappingsTable` into `data`, the two differ permanently. (After a save,
`JsonConfig.js` sets `originalData` to `{...native, ...doNotSaveAttributes}`,
which is why the mask is clean until the dialog is reopened.)

This is a structural consequence of the helper attribute, not of having two
editors. Options:

- **(a) Accept it.** Cosmetic, but it destroys the "is there anything to save?"
  signal — the very thing a save button exists for.
- **(b) Mirror attribute maintained by the adapter.** Drop `doNotSave` and let
  the adapter write `native.mappingsTable` alongside the canonical string on
  every start. Then the attribute exists in `originalData`, `defaultFunc` no
  longer fires, and `changed` is correct again. Costs a new native field, a
  `CONFIG_VERSION` bump and adapter code — and it degrades while the instance is
  **stopped**: nobody maintains the mirror, so a CLI change to `mappingsRaw`
  would not show up in the table.
- **(c) Own React component (§2, Option 2).** The problem disappears without a
  remedy: the table's state lives in the component, never in `data`, so nothing
  can differ from `originalData` until the user actually edits something.

**Decided 2026-09-27: (b).** Stage 1 came back clean on everything else — boolean
option values stay boolean, `objectId` cells are usable including copy&paste, the
table patches rows, ordering survives, export works, and the malformed-entry
hardening holds in the field. That left this display defect as Option 2's only
remaining justification, which is not proportional to a rebuild; (b) fixes it
inside the existing frame for about fifteen lines of adapter code. Option 2 stays
the path if more layout freedom is wanted later, and this record keeps the
argument for it.

Implementation notes:

- No `CONFIG_VERSION` bump. The bump exists to fill missing `NATIVE_DEFAULTS`, and
  the mirror — like `mappingsRaw` — deliberately does not belong there; it is set
  by the mirror write itself, independent of the version.
- The mirror is written **only on divergence**, inside the existing normalization
  patch, so a UI save (which writes string and mirror consistently) triggers no
  additional config restart.
- It mirrors the **unfiltered** canonical string, consistent with "never prune"
  (§ Configuration in CLAUDE.md): a rejected entry stays visible in the table too,
  and therefore fixable.
- `defaultFunc` stays in the jsonConfig as the fallback for the first start after
  this change, when no mirror exists yet.
- **The mirror is deliberately *not* declared in `io-package.json` `native`.** A
  default of `[]` would make the attribute exist from the start, `defaultFunc`
  would no longer apply (the value is not `undefined`), and a fresh instance whose
  `mappingsRaw` was filled by CLI would show an **empty** table until the adapter
  had run once. Without the default the table always shows the right content and
  only the "changed" flag stays wrong until the first adapter start — a wrong flag
  is the lesser evil compared to wrong content.
- **Known boundary:** if the stored string is unparsable, `loadMappings()` returns
  null and `onReady()` returns early — the mirror write is never reached and the
  stored mirror stays. The table then shows the last good content while the error
  box reports the broken string. Acceptable: the case requires a faulty CLI import,
  and the operator has the JSON editor and the planned delete option (§ stage 3).

## 8. Deliberate limits and deferrals

- **Loss of undisplayed fields is accepted for now** (decision 2026-09-26). The
  first table shows only `source` / `bidirectional` / `target`. Whether editing a
  row preserves `_comment` and the per-entry filter flags is assumption 3 above —
  to be *learned* rather than designed around. The repository's own
  `mappings.json` contains `_comment` fields, so the case is real. Revisit once
  the behaviour is known; the remedies (hidden columns, or conversion in the
  adapter per Option D) stay open.
- **Hand-made formatting in the JSON string is lost** — the table round-trip
  normalizes to `JSON.stringify(…, null, 2)`, which matches the adapter's own
  self-heal format. Accepted.
- **Empty rows are a real failure path, not cosmetics.** `isMappingEntry()`
  currently tests only `typeof === "string"`, and the empty string passes. The
  "+" button makes an unfilled row a routine occurrence; saving one lets the
  adapter start with `source: ""`, producing `channels.` — an object ID with a
  trailing dot — in an `await` that is not inside a try/catch. If that throws,
  `onReady()` aborts: no `ready`, no relay at all. Hardening the type guard is
  therefore part of this work, independent of the chosen UI path.
- **Admin version.** `doNotSave`, `onChange` and `objectId` columns require a
  reasonably current admin. Declared as `globalDependencies: admin >= 7.8.0`
  (the version the change is developed and tested against), following the
  convention verified on modbus and hm-rpc: admin belongs in
  `globalDependencies`, js-controller in `dependencies`.
- **No JSON import in the UI** — see §4.
