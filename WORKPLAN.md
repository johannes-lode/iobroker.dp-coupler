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
- [x] Build/Deploy durch User; **Feldtest auf Vollsystem: Bool↔Zahl-Cast funktioniert auf den
  kritischen Datenpunkten wie gewollt** (2026-07-02). Weitere Tests laufen im Hintergrund.

### Nachgelagert: jsonConfig-Admin-Validierung (2026-07-02)
Beim Öffnen der Instanz-Config meldete der Admin-Adapter `invalid jsonConfig`. Ursache: das
Admin-AJV-Schema meldet `if/then`-Blocker **einzeln**; zwei latente Fehler in der bestehenden
`admin/jsonConfig.json` kamen nacheinander zum Vorschein. Beide behoben (s. CLAUDE.md „Admin UI"):
- [x] `def` → `default` (jsonConfig-Feld-Default heißt `default`; `slider` erzwingt
  `additionalProperties: false` und failte hart auf `def`). Nebeneffekt: UI-Defaults greifen jetzt.
- [x] Wurzel-Property `"i18n": false` ergänzt (neueres Schema verlangt `i18n` explizit; kein
  `admin/i18n/`-Ordner, Labels sind literal).
- [x] **Verifiziert:** nach Öffnen der Config im Admin-UI **keine weitere Fehlermeldung** — vollständig.

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

## Robustheit gegen unvollständige Mapping-Einträge (Beschluss 2026-09-26)

**Vorangestellt als eigener Commit vor der GUI-Arbeit.** Begründung: der „+"-Button der
geplanten Tabelle macht die noch nicht ausgefüllte Zeile zum Alltagsfall; die Härtung muss
vorher stehen, damit die GUI-Erprobung nicht auf einem bekannten Absturzweg stattfindet.

### Leitsatz
Ein Mapping-Eintrag mit fehlenden oder leeren Pflichtfeldern darf **niemals** zu
fehlerhaftem Laufzeitverhalten führen. Zulässige Wirkung ist ausschließlich: Eintrag wird
verworfen, Grund wird protokolliert, **alle übrigen Einträge laufen unverändert weiter**.
Pflichtfelder sind `source` und `target`; alle anderen Felder sind optional und haben
Adapter-Defaults.

### Bekannter Fehlerpfad (Anlass)
`isMappingEntry()` prüft heute nur `typeof === "string"` — der Leerstring besteht diese
Prüfung. Folge einer gespeicherten Leerzeile: `sourceToChannelId("")` liefert `""`, damit
entsteht in `onReady()` ein `setObjectAsync("channels.", …)` — eine Objekt-ID mit Punkt am
Ende — in einem `await` **ohne** try/catch. Wirft dieser Aufruf, bricht `onReady()` ab:
kein `ready`, kein `info.connection`, **gar kein Relay mehr**. Ein einzelner unvollständiger
Eintrag legt damit den gesamten Adapter still — genau das, was der Leitsatz ausschließt.

### Aufgaben
- [ ] **Schicht 1 — Validierung vorne.** `isMappingEntry()` verschärfen: `source`/`target`
  müssen getrimmt nicht leer sein. Die verwerfende Warnung pro Eintrag gibt es in
  `parseMappings()` bereits; sie soll den Grund benennen. Damit enthalten `sourceIndex`
  und `targetIndex` nur noch geprüfte Einträge.
- [ ] **Schicht 2 — Fehlerisolierung (defense in depth).** Den Kanal-Aufbau-Loop in
  `onReady()` pro Eintrag in try/catch fassen: ein unerwarteter Fehler (eine ungültige ID,
  die Schicht 1 nicht erwischt) darf nur diesen einen Eintrag verlieren, nicht `onReady()`
  abbrechen. Das ist der eigentliche Kern des Leitsatzes — Schicht 1 behebt den *bekannten*
  Fall, Schicht 2 auch die unbekannten.
- [ ] **Selbstkopplung** `source === target` verwerfen (schreibt sich selbst; der
  `inFlight`-Guard verhindert zwar die Endlosschleife, der Eintrag ist aber sinnlos).
- [ ] **Typ-Plausibilität der optionalen Flags** — Entscheidung 2026-09-26: **tolerant
  normalisieren**, niemals wegen eines *optionalen* Feldes einen Eintrag verwerfen.
  Anlass: `bidirectional` wird strikt gegen `=== true` getestet, ein String `"true"`
  (wie ihn ein CSV-Import liefert) wirkt also still als `false`; die übrigen Flags gehen
  über `??` in truthy-Tests, ein String `"no"` wirkte damit als `true`. Uninterpretierbare
  Werte werden verworfen (Warnung) → Adapter-Default greift, statt still das Gegenteil.
- [ ] **Self-Heal bereinigt nicht** — Entscheidung 2026-09-26. Heute wird `canonicalRaw`
  bei Seeding und bei nativem Array aus der **gefilterten** Liste erzeugt, im String-Fall
  dagegen unverändert übernommen. Vereinheitlichen auf „nie automatisch bereinigen": die
  Konfiguration behält jeden Eintrag, den der Bediener geschrieben hat — auch den
  abgelehnten, damit er ihn im Editor sieht und korrigieren kann.
- [ ] **Pfadprüfung**: getrimmt nicht leer **plus** minimale ID-Plausibilität (kein
  inneres Leerzeichen, kein führender/abschließender Punkt, kein doppelter Punkt) —
  genau die Formen, die ungültige Objekt-IDs erzeugen. Bewusst **keine** Vollvalidierung
  von ioBroker-IDs. Umgebendes Leerzeichen aus Copy+Paste wird getrimmt, nicht verworfen.
- [ ] `npm run build`, `build/` mitcommitten (Deployment-Konvention), **eigener Commit**.
- [ ] Black-Box-Testspezifikation unter `docs/testing/` analog zum Baseline-Testspec.

## Admin-UI-Tabellen-Editor für Mappings (Beschluss 2026-09-26)

Löst den früheren Feature-Request vom 2026-07-02 ab. Vollständige Optionen-Abwägung
(inkl. verworfener Wege und der offenen Annahmen) im Design-Record
**[`docs/design/admin-ui-mapping-table.md`](docs/design/admin-ui-mapping-table.md)**.

### Festlegungen
- **`mappingsRaw` bleibt kanonisch ein String.** Grund: ein natives Array lässt sich
  nicht zuverlässig per CLI setzen — das ist der Deployment-Pfad dieses Adapters.
  Alles Weitere arbeitet um diese Randbedingung herum.
- **Weg: deklarative jsonConfig-`table`** im bestehenden Mapping-Panel, unterhalb des
  JSON-Editor-Buttons. Eine eigene React-Komponente (`type: "custom"`) bleibt als
  Ausbaustufe offen; eine komplett eigene Admin-Seite (der tatsächliche MODBUS-Weg —
  MODBUS nutzt **kein** jsonConfig) ist verworfen.
- **Kopplung asymmetrisch („Variante α"):** String → Tabelle einmalig beim Öffnen per
  `defaultFunc`; Tabelle → String laufend per `onChange.calculateFunc`. Kein Zyklus,
  weil es in der Rückrichtung keinen stehenden Trigger gibt. Das Hilfsattribut trägt
  `doNotSave: true` → kein neues `native`-Feld, **kein `CONFIG_VERSION`-Bump**.
- **JSON-Editor wird `readOnly`** — bleibt Träger der Berechnung, dient als Anzeige und
  als manueller JSON-**Export** (öffnen, markieren, kopieren). **Import** bleibt vorerst
  CLI + Seed-Datei (+ eingebauter CSV-Import der Tabelle); ein UI-JSON-Import ist dafür
  bewusst keinen Adapter-Code wert.
- **Spalten zunächst nur `source` / `↔` / `target`.** Richtungsumschalter als `select`
  mit **booleschen** Optionswerten („→" / „↔"), damit `bidirectional` boolean bleibt.
  Weitere Felder als Spalten erst, wenn das Grundlayout steht.

### Stufe 1 — Verifikation (risikoarm)
- [ ] `admin/jsonConfig.json`: `mappingsTable` (`table`, `doNotSave`, `defaultFunc`,
  `uniqueColumns: ["source"]`, **nur `export`**) mit den drei Spalten ergänzen;
  `objectId` für die beiden Pfadspalten. Labels englisch wie der Rest der Datei;
  `sort`/`filter` auf den Spalten aus (Sortieren würde die vom Bediener gewählte
  Reihenfolge im gespeicherten Array anfassen).
- [ ] `mappingsRaw` erhält `onChange` (`alsoDependsOn: ["mappingsTable"]`,
  `ignoreOwnChanges`), aber **defensiv**: bei `data.mappingsTable === undefined` den
  gespeicherten String unverändert lassen — eine nie befüllte Tabelle darf die
  Konfiguration nicht leeren.
- [ ] `jsonEditor` in dieser Stufe **noch editierbar** lassen (Notausgang, falls
  `defaultFunc` nicht greift).
- [ ] **Keine Sperre bei unparsbarem `mappingsRaw`, aber eine Anzeige** (Entscheidung
  2026-09-27): wer per CLI einen JSON-String einfügt, trägt die Verantwortung; im GUI
  wird der Fehler als `infoBox` (`boxType: "error"`) gemeldet und darf zum Verlust
  führen, sobald die Tabelle zur Eingabe benutzt wird. Dazu liefert `defaultFunc` bei
  unparsbarem Inhalt bewusst **`undefined`** statt `[]` — sonst hätte allein das Öffnen
  des Dialogs den defekten String durch `"[]"` ersetzt (Verlust ohne Tabellenbenutzung)
  und die Fehlerbox wäre sofort wieder verschwunden.
- [x] Build/Deploy + visuelle Bewertung (User); die offenen Annahmen aus
  Design-Record §7 beantworten. **Stand 2026-09-27:** `defaultFunc` greift beim
  `doNotSave`-`table` (Fundament trägt), die Tabelle **patcht** Zeilen (`_comment`
  überlebt), `doNotSave` hält das Attribut aus `native` heraus, die Datei besteht
  das offizielle AJV-Schema. Korrigiert: JS-Attribute brauchen ein **explizites
  äußeres `return`** (kein IIFE) — siehe CLAUDE.md.
- [x] **Maske galt nach jedem Öffnen als „modifiziert"** — strukturelle Folge des
  Hilfsattributs (`changed` ist ein Volltextvergleich `data` gegen `originalData`;
  ein `doNotSave`-Attribut fehlt dort immer). **Entscheidung 2026-09-27: Option (b)**
  — der Adapter pflegt `native.mappingsTable` als Spiegel des kanonischen Strings,
  `doNotSave` entfällt. Kein `CONFIG_VERSION`-Bump (der Spiegel gehört nicht in
  `NATIVE_DEFAULTS`). Abwägung und Grenzen in Design-Record §7a.
- [x] Restliche Beobachtungen (2026-09-27, alle bestanden): `select`-Spalte
  speichert **echte Booleans**; `objectId`-Zellen bedienbar inkl. Copy+Paste;
  `uniqueColumns` greift; Zeilen anlegen/löschen/verschieben und Reihenfolge im
  JSON korrekt; CSV-Export brauchbar; **Leerzeile bei laufendem Adapter
  unkritisch** (die Härtung trägt im Feld). Nebenbefund: `uniqueColumns` lässt den
  Dialog nach dem **Löschen** der doppelten Zeile im Fehlerzustand hängen —
  Upstream-Defekt in `@iobroker/json-config` (`onDelete` ruft
  `validateUniqueProps()` nicht), Workaround: eine Zelle antippen. Details im
  Design-Record.
- [ ] Verschoben (User): defektes JSON per CLI setzen → Fehlerbox erscheint,
  Tabelle bleibt leer, String bleibt bei Öffnen/Schließen unverändert.

### Stufe 2 — Festzurren
- [ ] `jsonEditor`: `"readOnly": true`.
- [ ] `"debug": true` aus den drei Feldern entfernen (nur Erprobungshilfe).
- [ ] `validator` auf den beiden Pfadspalten (die Adapter-seitige Härtung steht als
  eigener, vorangestellter Abschnitt „Robustheit gegen unvollständige Mapping-Einträge").
- [ ] `io-package.json`: `globalDependencies: [{"admin": ">=7.8.0"}]` und
  `dependencies: [{"js-controller": ">=6.0.11"}]` (Konvention an modbus/hm-rpc geprüft:
  admin gehört in `globalDependencies`).
- [ ] Version-Bump + News-Eintrag (en/de); `npm run build` und `build/` mitcommitten.
- [ ] README (Abschnitt „Mapping tab", Import/Export) und CLAUDE.md (Abschnitt
  „Admin UI" um `doNotSave`/`defaultFunc`/`calculateFunc`/`readOnly` ergänzen)
  aktualisieren.

### Stufe 3 — später
- [ ] **Round-Trip nicht dargestellter Felder erneut bewerten.** Datenverlust bei
  `_comment`, `forwardOnAck`, `forwardChangesOnly`, `propagateAck`, `enabled` ist
  vorerst **bewusst in Kauf genommen** (Entscheidung 2026-09-26); erst am laufenden
  System lernen, ob die Tabellen-Komponente unbekannte Keys einer Zeile erhält oder
  sie beim Edit neu generiert. Danach entscheiden: versteckte Spalten, Konvertierung
  im Adapter (Variante β) oder eigene Komponente. Die repo-eigene `mappings.json`
  enthält `_comment`-Felder, der Fall ist also real.
- [ ] Weitere Spalten (Filter-Flags pro Eintrag, später `transform`/`transformReverse`).
- [ ] **CSV-`import` der Tabelle aktivieren** — bewusst *nach* Stufe 1 und als eigener
  Arbeitsschritt, damit er separat erprobt werden kann (Entscheidung 2026-09-27):
  ein Import ersetzt/ergänzt Zeilen und wäre neben dem noch unverstandenen
  Tabellenverhalten ein zweiter Unsicherheitsfaktor in derselben Erprobung. Dabei
  bewerten, ob der eingebaute CSV-Weg den früheren TSV-Wunsch vollständig abdeckt —
  dann entfällt der Eigenbau. (`export` ist bereits ab Stufe 1 aktiv.)
- [ ] **Reparaturweg für ein defektes `mappingsRaw`** (Entscheidung 2026-09-27):
  eine Möglichkeit, den defekten JSON-String aus dem Dialog heraus zu löschen — z. B.
  als Exit-Option beim Verlassen oder als Haken „defekte Definition löschen". Anlass:
  ist der gespeicherte String nicht parsebar, bleibt die Tabelle leer; spätestens mit
  `readOnly` (Stufe 2) gibt es dann im UI keinen Weg mehr zurück, nur noch das CLI.
- [ ] Bei unbefriedigender Ergonomie: eigene React-Komponente (`type: "custom"`,
  Vite-Build, Bundle committet — der Server baut nicht). Damit entfiele die
  String/Array-Brücke vollständig.

## Initiale Synchronisation / Baseline-Transfer (Beschluss 2026-07-17)

### Problem
Rein flankengetriggerter Relay: Werte, die sich nie/selten ändern (OPC-UA/SPS),
erreichen das Ziel nach dem Adapter-Start nie, weil keine Änderungsflanke auftritt.
Es fehlt ein zustandsgetriggerter Einmal-Transfer (Baseline/Snapshot), der jeden
gekoppelten Datenpunkt mindestens einmal pro Adapter-Leben ans Ziel bringt.

### Design-Dokumentation (dauerhaft, im Repo)
Vollständige Optionen-Abwägung (inkl. verworfener/zurückgestellter Varianten) in
**[`docs/design/initial-synchronization-baseline.md`](docs/design/initial-synchronization-baseline.md)**.
Kurzfassung der Beschlüsse:
- **Verfügbarkeit (Upstream-Race):** Startup-Pass + Vollendung durch erstes Event
  (`pendingBaseline`-Set), kein Timer/Polling. (Option B)
- **Schreib-Semantik:** compare-then-write (nur bei Ungleichheit schreiben),
  Ack-Semantik via `propagateAck` wie im Normalpfad. (Option 2)
- **Konfigurierbarkeit:** immer aktiv, kein Schalter, kein `CONFIG_VERSION`-Bump.
- **Sync-Tick:** bleibt unbedingt (kein Vergleich).
- **Enable-Trigger (Nachschärfung):** `enabled` false→true überträgt, wenn Werte
  ungleich **oder** noch nie baselined dieses Leben (dann `force`-Write). Behebt den
  Fall „deaktiviert beim Start".
- **Erweiterbarkeit (Option C, verschoben):** Startup-Pass als wiederverwendbare
  Methode `runBaselinePass()` bauen → C bleibt additiv (~20–30 Zeilen, entkoppelt).
  C-Trigger bewusst **kein Timer/Monoflop**, sondern Verbindungs-Events (z. B.
  `alive` / `info.connection` des Upstream-Adapters), die auch im Normalbetrieb bei
  Reconnect eine Re-Synchronisation auslösen. Auto-Discovery vs. Konfiguration der
  Flags offen (nur skizziert). Details: Design-Record §5.

### Aufgaben
- [x] `src/main.ts`: Feld `pendingBaseline: Set<string>` (readonly, ephemeral).
- [x] `baselineWrite(entry, sourceVal, q, ack, force)`-Helfer (compare-then-write /
  force); gibt `true` zurück, wenn geschrieben wurde.
- [x] `runBaselinePass()` als wiederverwendbare Methode (C-ready); Startup-Pass in
  `onReady()` nach Subscribe + `lastState`-Vorbefüllung, vor `info.connection = true`;
  Snapshot-Iteration; Log-Zusammenfassung.
- [x] `onStateChange()`: Baseline-Vollendung via erstes Event (nach `enabled`-Check,
  vor den Filtern) + Enable-Trigger im `enabledDpToSource`-Zweig (`force` =
  `pendingBaseline.delete()`).
- [x] Doku: CLAUDE.md (`onReady`/`onStateChange`/`runBaselinePass`/`baselineWrite`/neues
  Feld + Abschnitt „Initial synchronization"), README-Abschnitt „Initial
  synchronization (baseline)".
- [x] Verifikations-Typecheck `tsc --noEmit` sauber.
- [x] Code-unabhängige Testspezifikation (Black-Box) erstellt:
  [`docs/testing/initial-synchronization-baseline.testspec.md`](docs/testing/initial-synchronization-baseline.testspec.md).
  Test-Gerüst + Implementierung in separatem Chat (Repo-Vorgabe „keine Tests"
  gilt bis zum Vorhandensein des Gerüsts).
- [ ] Build/Deploy + Feldtest (User).

## Status

**Implementierung Aufgaben 1–8 abgeschlossen** (Härtung + configVersion + Seeding),
Verifikations-Build sauber, Version auf **0.2.0** gebumpt (io-package + package.json,
News-Eintrag en/de). Code-seitig steht damit alles; im Deployment entfällt das
`jq -Rs`-Escaping für `mappingsRaw` (natives Array wird direkt akzeptiert und self-gehealt).

**Feature A (Typ-Coercion) abgeschlossen und im Feld bestätigt** (2026-07-02): Bool↔Zahl-Cast
läuft auf dem Vollsystem wie gewollt; jsonConfig-Admin-Validierung vollständig sauber
(`def`→`default`, `i18n` ergänzt). Weitere Hintergrund-Tests laufen beim User.

**Offen / als Nächstes:**
- **Aktuelles Thema: Admin-UI-Tabellen-Editor** (Beschluss 2026-09-26), Stufe 1.
  Verfahren: Build und visuelle Bewertung beim User (Admin V7.8.23); Erprobung ggf. in
  einer weiteren, noch nicht produktiv genutzten ioBroker-Instanz mit eigens angelegten
  Test-Datenpunkten.
- Rückmeldung aus den laufenden Hintergrund-Tests abwarten.
- **Feature B (JSONata-Transformation)** ist geplant und die Pipeline-Naht steht — Umsetzung
  erst auf Zuruf. (Anmerkung 2026-09-26: der User hält Konvertierungen auch per ioBroker-Alias
  für abgedeckt — Priorität entsprechend niedrig.)
- (Früher, ggf. bereits erledigt:) Härtungs-Tests Aufgabe 5 Fälle a–f.

Vorheriger Stand: PoC abgeschlossen, Adapter im dev-server verifiziert.
