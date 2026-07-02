# Workplan: dp-coupler – Konfig-Robustheit (mappingsRaw String/Array + Self-Heal)

## Ziel

`native.mappingsRaw` soll **beide** Eingabeformen klaglos verarbeiten:

- **kanonisch:** JSON-String (so speichert der Admin-jsonEditor; so steht es im
  io-package-Default `"[]"`),
- **nativ:** ein direkt gesetztes JSON-Array, z. B. via
  `iob object set system.adapter.dp-coupler.0 native.mappingsRaw="$(cat mappings.json)"`.

Zusätzlich soll der Admin-jsonEditor **immer** sauberen Inhalt sehen (kein rotes
„invalid JSON"). Dazu normalisiert der Adapter einen nativ gesetzten Array beim Start
einmalig in die kanonische, pretty-printed String-Form zurück (Self-Heal).

**Hintergrund:** Wird ein natives Array gesetzt, schlägt `JSON.parse(this.config.mappingsRaw)`
fehl (Array → `String(array)` → kein gültiges JSON), und der jsonEditor markiert den Inhalt
rot, bis man manuell ein Zeichen editiert. Beides entfällt mit den Änderungen unten.

## Architektur-Entscheidungen

- **Kanonisches Format bleibt der String.** io-package-Default `"[]"`, jsonEditor speichert
  String, Export liefert String. Der Adapter *toleriert* zusätzlich ein natives Array.
- **Tolerant laden:** `loadMappings()` parst nur, wenn der Wert ein String ist; ein
  Array/Objekt wird direkt übernommen.
- **Self-Heal statt Restart-Abhängigkeit:** ein erkanntes Array wird per
  `extendForeignObjectAsync` als pretty-printed String zurückgeschrieben (löst einen
  Config-Restart aus, konvergiert, da der Wert danach String ist). Bewusst **kein**
  vorzeitiges `return` — der tolerante Loader relayt sofort aus dem In-Memory-Array,
  falls der Restart ausbleibt.
- **Pretty-printed** (`JSON.stringify(arr, null, 2)`) als Self-Heal-/Export-Format —
  gut im jsonEditor lesbar, entspricht dem von Generator-Tools erzeugten Stil.
- **Synergie:** der bereits offene Punkt „configVersion + onReady-Normalisierung"
  (Neu-Instanz-Defaults) nutzt denselben `extendForeignObjectAsync`-Mechanismus; beide
  können denselben Normalisierungs-Pfad teilen.

## Aufgaben (Härtung)

### 1. `src/main.ts` — Loader tolerant
- [x] Umgesetzt als `parseMappings(raw, label)`-Helper: `typeof raw === "string"` → `JSON.parse`,
  sonst Wert direkt übernehmen; danach `Array.isArray`-Check + Type-Guard-Schleife.
  `loadMappings()` ist nun ein dünner Wrapper darüber.

### 2. `src/main.ts` — Self-Heal in `onReady()`
- [x] In `onReady()` (nach `loadMappings()`): natives Array → kanonischer Pretty-String,
  als Teil des kombinierten Normalisierungs-Patches via `extendForeignObjectAsync`.
- [x] Fire-and-forget + weiterlaufen (kein `return`); `log.info` ausgeben.

### 3. `src/main.ts` — Export normalisieren
- [x] `persistMappingsFile(content)` erhält den kanonischen String als Parameter
  (verhindert `[object Object]`-Müll in `mappings.json` bei Array-Werten).

### 4. `src/main.ts` — Typ aufweiten
- [x] `AdapterConfig.mappingsRaw: string | unknown[]`; zusätzlich `configVersion?: number`.

### 5. Build & Test
- [x] `npm run build` fehlerfrei (Verifikations-Build durch Claude; `build/` regeneriert).
- [ ] **In Arbeit (User):** Testfälle (a) String-Import, (b) natives Array-Import → Self-Heal →
  jsonEditor zeigt pretty String, (c) leeres Mapping, (d) invalides JSON → saubere Fehlermeldung,
  (e) Neu-Instanz zeigt echte Default-Werte (configVersion-Bump), (f) Seeding aus
  `mappings.seed.json` inkl. Konsum/Schreibschutz-Fall.

### 6. Doku (README — Import/Export & Quoting)

Generisch, **eine** Shell-Ebene (Bediener arbeitet im Container; keine projektspezifischen
Wrapper). Aufnehmen:

```sh
# Import (kanonisch, robust – aktuell verbindlich, da mappingsRaw ein Stringfeld ist):
iob object set system.adapter.dp-coupler.0 \
    native.mappingsRaw="$(jq -Rs . mappings.json)"
iob restart dp-coupler.0

# Import (nativ – funktioniert NACH dieser Härtung, ohne jq-Escaping):
iob object set system.adapter.dp-coupler.0 \
    native.mappingsRaw="$(cat mappings.json)"

# Export (direkt re-importierbar):
iob object get system.adapter.dp-coupler.0 | jq -r '.native.mappingsRaw' > mappings.json
```

- [x] README-Abschnitt „Mass deployment" mit obigen Befehlen + Begründung
  (Stringfeld vs. natives Array; Self-Heal) ergänzt; zusätzlich Unterabschnitt „Seeding".
  `CLAUDE.md` (Configuration/onReady/Defaults) ebenfalls aktualisiert.

## Erweiterter Scope dieser Sitzung (Entscheidung 2026-06-26)

Beschluss: Härtung 1–6 **plus** configVersion-Normalisierung **plus** Seeding werden
gemeinsam umgesetzt. Begründung: alle drei teilen denselben
`extendForeignObjectAsync`-Schreibpfad; ein kombinierter Normalisierungs-Write löst
höchstens einen Config-Restart aus.

### 7. configVersion + onReady-Normalisierung
- [x] `configVersion: 0` in `io-package.json` `native` (nur io-package, **nicht** jsonConfig).
- [x] `AdapterConfig.configVersion?: number`.
- [x] In `onReady()`: bei `configVersion < 1` alle fehlenden `native`-Defaults
  explizit auffüllen (modulweite `NATIVE_DEFAULTS`-Tabelle) und `configVersion: 1` setzen
  — **im selben** `extendForeignObjectAsync`-Patch wie der mappingsRaw-Self-Heal.
- [x] Ab `configVersion >= 1` überspringen. Primärnutzen: UI-Korrektheit + Migrationspfad.

### 8. Seeding (One-Shot-Datei, konsumierend)
- [x] Trigger: Config-Mapping leer **und** `mappings.seed.json` vorhanden & valide
  → Einträge übernehmen (in denselben Patch schreiben).
- [x] **Konsum:** Datei nach **erfolgreichem** DB-Write (`.then()`) gelöscht (`consumeSeedFile()`) —
  One-Shot, verhindert „Wiederauferstehung". Löschfehler (z. B. schreibgeschützt) nicht fatal:
  warnen und weiter. Schutz gegen Re-Seed ist primär die „Config leer"-Bedingung.
- [x] Bewusst **getrennte** Datei (`mappings.seed.json`, via `seedFilePath()`) vom Export
  (`mappings.json`), damit der Export-Schreibpfad keinen Seed-Feedback-Loop erzeugt.
- [x] `parseMappings()`-Helper aus `loadMappings()` extrahiert (von Config- und Seed-Pfad
  geteilt).

## Übernommene offene Punkte (aus vorherigem WORKPLAN)

### Kurzfristig
- **`forwardChangesOnlyDefault` nicht zuverlässig default-on** bei Neu-Instanz.
  Lösungsvorschlag: invertieren/umbenennen (`forwardChangesOnly` → `forwardAll`,
  default `false`), damit default-off das gewünschte Verhalten ist und das
  ioBroker-Checkbox-Problem entfällt.
- **Konfig-Initialisierung bei Neu-Instanz** → in dieser Sitzung umgesetzt, s. Abschnitt 7.
- **`info.connection`-Granularität** — Fail-Counter pro Eintrag; `info.connection=false`
  oberhalb einer Schwelle.

### Mittelfristig / Backlog
- **Wert-Konvertierung** pro MappingEntry → in dieser Sitzung konkretisiert und in zwei
  geschichtete Features aufgeteilt, s. Abschnitt „Typ-Coercion + Werte-Transformation".
  (Der frühere Zwischenweg „ioBroker-Aliase" stößt an seine Grenzen, sobald über viele
  DP-Paare hinweg ohne Alias-Objekte gekoppelt werden soll — genau der dp-coupler-Zweck.)
- **Zeittakt für Rückwärtsrichtung** bidirektionaler Einträge (der Timer cached aktuell
  nur Vorwärts-Ereignisse). Zuerst als adapterweiter Schalter `syncBidirectional?`.
- **Separate Filter pro Koppelrichtung** (`forwardOnAck`/`forwardChangesOnly` getrennt
  für Vorwärts-/Rückwärtsrichtung). Zurückgestellt bis ausreichend User-Nachfrage.

## Typ-Coercion + Werte-Transformation (Beschluss 2026-07-02)

### Problem (Feldtest)
Kopplung MODBUS-Adapter (nur numerisch, Ausnahme String) ↔ OPC-UA-Adapter (mehr Typen,
u. a. `boolean`). dp-coupler reicht den Wert **verbatim** durch (`src/main.ts:447-451`
Event-Relay, `src/main.ts:475-479` Zeittakt) — ioBroker castet **nicht** implizit.
Ein `boolean true` landet unverändert in einem `number`-DP (und umgekehrt) → Typ-Mismatch.

### Beschluss / Architektur
- Werte-Umrechnung ist im Kern die Wahl von `f` in `write(target, f(read(source)))`.
  Heute `f = identity`.
- **Typ-Cast ist der terminale, parameterfreie Spezialfall** dieser Umrechnung und wird
  durch eine spätere Transformation **nicht** überflüssig — er bleibt der letzte
  Normalisierungs-Schritt (auch ein transformierter Wert muss ggf. in einen Bool-DP
  „einrasten"). Feste Pipeline-Reihenfolge: **read → (später) transform → coerce-to-target → write.**
- **Eine interne Naht** kapselt die Pipeline: `resolveValue(entry, direction, rawVal, destType)`.
  Heute macht sie nur den Cast; Feature B fügt davor den JSONata-Schritt ein, **ohne** die
  Aufrufstellen (Event-Relay + Zeittakt) erneut anzufassen.
- **Transform-Mechanismus = JSONata** (Entscheidung 2026-07-02). Lineare Skalierung
  (`gain`/`offset`) wird bewusst **nicht** eingebaut — die erledigt der MODBUS-Adapter
  upstream. MODBUS ab hier keine Referenz mehr.
- **Bidirektional:** Cast ist pro Richtung natürlich invertierbar (schreibe in Quell- bzw.
  Zieltyp). JSONata ist es **nicht** → Feature B braucht für bidirektionale Einträge zwei
  Ausdrücke (forward/reverse), analog ioBroker-Alias `read`/`write`. Der Cast umgeht das.

### Feature A — Typ-Coercion (jetzt)
Deterministisch, keine neue Dependency. **Adapterweite** Schalter, kein per-Eintrag-Override
(bewusste Vereinfachung: Cast ist No-op auf Typ-Match → per-Eintrag-Steuerung hätte kaum
praktischen Wert; Override bleibt rein additiv nachrüstbar, falls je Bedarf).

- [x] `coerceTypesDefault: true` + `coerceStringsDefault: false` in `io-package.json` `native`,
  `NATIVE_DEFAULTS`, `AdapterConfig`, jsonConfig-Checkboxen (Abschnitt „Type coercion";
  `coerceStrings` per `disabled` an `coerceTypes` gekoppelt).
- [x] Zwei **adapterweite** Schalter (Naht parameterfrei/deterministisch — keine
  konfigurierbaren Wert-Mengen, das bleibt JSONata-Domäne):
  `coerceTypesDefault` (Default **an**, Bool↔Zahl-Kernfall), `coerceStringsDefault`
  (Default **aus**, String-Interpretation opt-in).
- [x] **configVersion 1 → 2** (modulweite `CONFIG_VERSION`-Konstante): Migrations-Hook füllt
  die neuen Defaults auch auf bereits migrierten Instanzen (UI-Korrektheit). Runtime nutzt
  `?? true`/`?? false`-Fallbacks, greift also schon vor dem Migrations-Write.
- [x] Zieltypen gecacht: `destType: Map<destId → common.type>` für alle Sources **und**
  Targets, beim Start via `getForeignObjectAsync` (Ziel-Fetch im vorhandenen Kanal-Loop
  ergänzt; Source-Typ dient der Rückrichtung bidirektionaler Einträge).
- [x] `resolveValue(entry, direction, rawVal, destId)`-Naht + `coerceValue(rawVal, destType)`;
  in **beiden** Schreibpfaden aufgerufen (Event-Relay + Zeittakt). `direction`/`entry` sind
  bereits durchgereicht (reserviert für Feature B, Aufrufstellen bleiben dann unangetastet).
- [x] C-Konvention umgesetzt:
  - `→ boolean`: Zahl `0→false`, sonst `true`. String **nur bei `coerceStrings`**:
    `""`/`"0"`/`"false"`(ci)`→false`, sonst `true`; Unerkanntes durchreichen.
  - `→ number`: Bool `false→0`/`true→1`. String **nur bei `coerceStrings`**: `Number(val)`
    wenn `Number.isFinite`, sonst **durchreichen** (Coercion scheitert nie am String).
  - `→ string`: `String(val)`.
- [x] Leitregel Coercion vs. Transform: *Wert-Wissen* (welcher String heißt was, `"on"→true`)
  → JSONata (Feature B); *Typ-Wissen* (Ziel ist bool/number/string) → Cast.
- [x] Randbedingungen umgesetzt: Zieltyp `"mixed"`/fehlend → Durchreichen; Wert-Typ==Zieltyp
  → No-op; `lastValue` bleibt Roh-Quellwert (nur Ziel-Write gecastet). Kein Skip/Fehlerpfad
  nötig — Coercion scheitert by design nie (verzichtet statt zu werfen).
- [ ] **Verbleibt beim User:** `npm run build` (Verifikations-`tsc --noEmit` durch Claude grün),
  Version/News-Bump, Deploy; danach Feldtest Bool↔Zahl (MODBUS↔OPC-UA).

### Feature B — JSONata-Transformation (später, optional)
Erst umsetzen, wenn Cast im Feld läuft. Pipeline-Naht steht dann bereits.

- [ ] Dependency `jsonata` aufnehmen (async eval; Fehlerbehandlung wie Cast: skip+warn).
- [ ] Schema: `transform?: string` (forward) + `transformReverse?: string` (bidirektional).
  JSONata ist nicht invertierbar → für bidirektionale Kopplungen sind **zwei** Ausdrücke
  nötig (analog ioBroker-Alias `read`/`write`).
- [ ] JSONata-Schritt in `resolveValue()` **vor** dem Cast einhängen; Richtung wählt den
  passenden Ausdruck.
- [ ] Fehlende Richtung = **identity** (Durchreichen, Cast greift weiter), **kein** Fehler:
  bidirektionaler Eintrag ohne `transformReverse` → Rückrichtung unverändert;
  `transformReverse` bei unidirektionalem Eintrag → ignoriert.
- [ ] Round-Trip-Drift: sind forward/reverse keine echten Inversen, kann ein
  bidirektionales Paar driften. Schutz besteht teilweise (`inFlight` fängt das Echo,
  `forwardChangesOnly` stoppt bei Wert-Stillstand); Inversen-Garantie bleibt aber
  **Nutzerverantwortung** → als Warnung in die Doku.
- [ ] README/Doku: Beispiele (Enum-Mapping, Schwellwert Zahl→Bool, String-Parsing) +
  bidirektionale forward/reverse-Warnung.

## Status

**Implementierung Aufgaben 1–8 abgeschlossen** (Härtung + configVersion + Seeding),
Verifikations-Build sauber, Version auf **0.2.0** gebumpt (io-package + package.json,
News-Eintrag en/de). Code-seitig steht damit alles; im Deployment entfällt das
`jq -Rs`-Escaping für `mappingsRaw` (natives Array wird direkt akzeptiert und self-gehealt).

**Offen / als Nächstes:**
- **Manuelle Tests durch User laufen** (Aufgabe 5, Fälle a–f). Bei Auffälligkeiten zurück
  an die Implementierung.
- Danach Release-Commit (inkl. `build/`) + `iobroker url`-Deploy.
- **Feldtest** weiterhin ausstehend.

Vorheriger Stand: PoC abgeschlossen, Adapter im dev-server verifiziert.
