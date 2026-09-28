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

### Feature B — JSONata-Transformation: **bewusst zurückgestellt** (Stand 2026-09-28)

**Nicht mehr geplant, solange kein neuer Anlass auftritt.** Der Feldbetrieb hat gezeigt,
dass **ioBroker-Aliase mit Lese-/Schreib-Formeln** die Umrechnungen besser erledigen:
sie sind pro Datenpunkt konfiguriert, existieren bereits, und der Bediener löst damit
Rundung (Thermostat-Schrittweiten), Enum-Übersetzung (Taster `"single"`/`"double"` →
`true`/`false`) und die geräteabhängige Beschränkung von Modus-Werten. Arbeitsteilung:
**der Koppler verbindet, Aliase rechnen um** — in der README als Leitgedanke
dokumentiert (Abschnitt „What it is good for").

Die Pipeline-Naht `resolveValue()` bleibt bestehen und kostet nichts; der Kommentar
dort spricht noch von „Feature B (later)" und sollte bei der nächsten Code-Änderung an
dieser Stelle auf „falls je nötig" umformuliert werden (kein eigener Commit wert).

Falls es doch je kommt, gilt die untenstehende Planung weiter:

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

### Stufe 1 — Verifikation (risikoarm) — **abgeschlossen 2026-09-27**
- [x] `admin/jsonConfig.json`: `mappingsTable` (`table`, `defaultFunc`,
  `uniqueColumns: ["source"]`, **nur `export`**) mit den drei Spalten ergänzt;
  `objectId` für die beiden Pfadspalten. Labels englisch wie der Rest der Datei;
  `sort`/`filter` auf den Spalten aus (Sortieren würde die vom Bediener gewählte
  Reihenfolge im gespeicherten Array anfassen). `doNotSave` ist mit Option (b)
  wieder entfallen — der Spiegel wird bewusst gespeichert.
- [x] `mappingsRaw` erhält `onChange` (`alsoDependsOn: ["mappingsTable"]`,
  `ignoreOwnChanges`), aber **defensiv**: bei `data.mappingsTable === undefined` den
  gespeicherten String unverändert lassen — eine nie befüllte Tabelle darf die
  Konfiguration nicht leeren.
- [x] `jsonEditor` in dieser Stufe **noch editierbar** gelassen (Notausgang, falls
  `defaultFunc` nicht greift).
- [x] **Keine Sperre bei unparsbarem `mappingsRaw`, aber eine Anzeige** (Entscheidung
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
- [x] JSON-Ansicht read-only. **Nachgeschärft 2026-09-27:** der `jsonEditor`-Knopf
  trägt den fest verdrahteten Text `jc_JSON editor` (das Feld-`label` benennt nur den
  Modal-Titel), war also nicht umbenennbar. Deshalb auf `type: "text"` mit `readOnly`,
  `minRows`/`maxRows` und **`copyToClipboard`** umgestellt: eigenes Label, ohne Klick
  sichtbar, und der JSON-Export ist damit ein echter Kopierknopf statt „markieren und
  kopieren".
- [x] `"debug": true` aus allen Feldern entfernt (nur Erprobungshilfe).
- [x] `validator` auf den beiden Pfadspalten — **bei jeder Eingabe**
  (Entscheidung 2026-09-27; ein Prüf-Button wäre nur als `sendTo` möglich, bräuchte
  also Adapter-Code und eine laufende Instanz, obwohl die Prüfung rein syntaktisch
  ist). Dieselbe Regel wie `isPlausibleStateId()` im Adapter, mit derselben
  Copy+Paste-Toleranz. Ohne `validatorNoSaveOnError`: die Zeile wird rot markiert,
  aber das Speichern anderer Änderungen nicht blockiert — der Adapter verwirft eine
  unbrauchbare Zeile ohnehin mit Warnung.
- [x] **Spalten für die optionalen Eigenschaften** ergänzt: `_comment` (Text),
  `enabled`, `forwardOnAck`, `forwardChangesOnly`, `propagateAck`. Letztere vier sind
  **dreiwertig** — „(default)" = `""`, „yes" = `true`, „no" = `false`. Begründung: eine
  Checkbox könnte „nicht gesetzt" nicht von „ausgeschaltet" unterscheiden und würde beim
  Anlegen einer Zeile stillschweigend die adapterweiten Defaults überschreiben.
  `normalizeFlag("")` liefert „nicht gesetzt", `normalizeEntry()` entfernt den Schlüssel
  — der Default bleibt also wirklich Default. Die Kommentar-Spalte ist nötig, weil
  `_comment` mit dem read-only-JSON-View sonst nur noch per CLI pflegbar wäre.
- [x] **Zwei Ansichten sind mit `table` nicht erreichbar** (Befund 2026-09-27, im
  Feld bestätigt und im Quellcode verifiziert): `expertMode`/`hidden` auf einer Spalte
  leeren nur die Zellen — Spalte und Überschrift bleiben stehen, weil `ConfigTable`
  die `items` ausschließlich nach Host/OS filtert. Zwei Tabellen-Felder auf **ein**
  Attribut sind ebenfalls unmöglich (`ConfigPanel` leitet `attr` aus dem Schlüssel ab).
  Ein eigenes Ansichts-Flag — ob `doNotSave` oder native — hätte genau dasselbe
  Ergebnis; die Frage nach einer Adapter-Einstellung dafür ist damit erledigt.
  **Stattdessen kompakte Spalten:** `expertMode` entfernt, Flag-Spalten auf Kürzel
  (`On`, `ACK`, `Δ only`, `→ACK`) mit `tooltip` und je 7 % — die vier belegen damit
  28 % statt 38 %. Kommentar-Spalte mehrzeilig (`minRows: 2`, `maxRows: 4`);
  Source/Target/Comment ohne feste Breite, sie teilen die verbleibenden 67 %.
- [x] JSON-View **unter** die Tabelle verschoben (Wunsch 2026-09-27). Bewusst ohne
  `expertMode`, damit der Kopier-/Export-Knopf allen Bedienern zur Verfügung steht.
- [x] **Spaltenköpfe haben keine Tooltips** — nicht nachrüstbar: `renderOneFilter()`
  rendert den Titel als reinen Text in einem `<span>` (React escaped, kein
  HTML-Schmuggel) und liest `headCell.tooltip` nicht. Der Spalten-`tooltip` erreicht
  nur die **Zelle** (natives `title` am Feld-Container). Ersatz: sprechende Titel
  (`Enabled`, `on ACK`, `on change`, `pass ACK` statt `On`/`ACK`/`Δ only`/`→ACK`) und
  eine `staticText`-Legende zwischen Tabelle und JSON-View.
- [ ] **Folge für die Wegentscheidung:** zwei Ansichten (einfach/vollständig) bleiben
  ein offener Wunsch und sind nur mit einer eigenen React-Komponente (§2 Option 2 im
  Design-Record) erfüllbar. Damit liegen nun **zwei** Argumente dafür vor (das andere
  ist §7a). Entscheidung offen — erst beurteilen, ob die kompakten Spalten genügen.
- [x] `io-package.json`: `globalDependencies: [{"admin": ">=7.8.0"}]` und
  `dependencies: [{"js-controller": ">=6.0.11"}]` (Konvention an modbus/hm-rpc geprüft:
  admin gehört in `globalDependencies`).
- [x] Version-Bump auf **0.3.0** + News-Eintrag (en/de) in `io-package.json` und
  `package.json`. Kein `npm run build` nötig — `src/` ist gegenüber dem
  Härtungs-Commit unverändert, die Stufe betraf nur `admin/` und `io-package.json`.
- [x] README (Abschnitt „Mapping tab" auf den Tabellen-Editor umgeschrieben,
  Validierungs-/Verwerfungsregeln ergänzt, Mass-deployment um den
  `mappingsTable`-Spiegel ergänzt) und CLAUDE.md (Abschnitt „Admin UI" beschreibt
  jetzt den tatsächlichen Aufbau des Mapping-Panels samt dreiwertiger Flag-Spalten)
  aktualisiert.

### Stufe 2 — abgeschlossen mit Version 0.3.0 (2026-09-27)

### Internationalisierung der Oberfläche (eigenes Paket, Beschluss 2026-09-27)

Bewusst **nach** 0.3.0 als eigener Patch: der Umbau fasst jede Textzeile der
jsonConfig an, und das Admin-Schema verhält sich mit `"i18n": true` anders
(Übersetzungsdateien müssen vorhanden und ladbar sein) — das braucht einen eigenen
Testlauf und soll die Feature-Historie nicht verwässern.

**Festlegungen:** nur **Deutsch und Englisch** (offizielles ioBroker-Repo ist vorerst
kein Ziel; die Community entscheidet das ggf. später). Übersetzt werden die
**Admin-Oberfläche** und `io-package.json` (`titleLang`, `desc`, News). Die
**Log-Meldungen des Adapters bleiben englisch** — ioBroker-Konvention, und es
erleichtert die Suche nach Fehlermeldungen.

**Hintergrund zum heutigen Mischbild:** der Admin schickt *jeden* Text durch
`I18n.t()`. Steht ein Wort zufällig in der globalen Admin-Übersetzungstabelle
(„Source", „Enabled", „Comment"), erscheint es übersetzt, der Rest englisch. Kein
Fehler, aber ein Grund, es sauber zu machen.

- [ ] `admin/i18n/de/translations.json` und `.../en/...` anlegen; alle Labels,
  Hilfetexte, Tooltips, Spaltentitel, die Legende und die Fehlerbox auf Schlüssel
  umstellen; Wurzel-`"i18n"` von `false` auf `true`.
- [ ] Admin-Validierung erneut prüfen (das Schema meldet Blocker einzeln).
- [ ] Prüfen, ob die Spaltentitel nach der Umstellung noch in die Breiten passen —
  deutsche Begriffe sind meist länger („on change" → „nur bei Änderung").
- [ ] Version 0.3.1 (Patch) + News-Eintrag.

## Sternverteilung (1:n) und Kopplungs-Identität — Version 0.4.0 (2026-09-28)

Design-Record: **[`docs/design/fan-out-and-coupling-identity.md`](docs/design/fan-out-and-coupling-identity.md)**,
Testspezifikation: [`docs/testing/fan-out-and-coupling-identity.testspec.md`](docs/testing/fan-out-and-coupling-identity.testspec.md).

- [x] `sourceIndex`/`targetIndex` auf `Map<string, MappingEntry[]>`; neues Feld
  `couplings` als Iterationsbasis in Bediener-Reihenfolge.
- [x] `MappingEntry.id` (Pflichtfeld): Kurz-Handle, vergeben von der Tabelle beim
  Anlegen der Zeile (`defaultFunc`), nachgerüstet vom Adapter für CLI-Import und
  Bestand und **persistiert** (sonst würden die Kanäle bei jedem Start umbenannt).
  Zeichensatz `^[A-Za-z0-9_-]{1,32}$`, Punkte verboten (sonst Unterkanäle).
  Doppelte IDs und doppelte `(source,target)`-Paare werden in `parseMappings()`
  verworfen. `uniqueColumns` von `source` auf `id` umgestellt.
- [x] Kanäle heißen `channels.<id>`; `common.name` = `source → target`,
  `common.desc` = Kommentar. `enabledMap`/`pendingBaseline` pro Kopplung.
- [x] `relayCoupling()` aus `onStateChange()` herausgelöst — ein Ereignis treibt
  mehrere Kopplungen, jede mit eigenen Filtern. Ein Datenpunkt kann gleichzeitig
  Quelle einiger und (bidirektionales) Ziel anderer Kopplungen sein; beide
  Richtungen werden jetzt bedient (vorher gewann die Vorwärtsrichtung).
- [x] `removeOrphanChannels()` — dauerhaftes Aufräumen, kein Migrationsschritt;
  entfernt dadurch auch die Pre-0.4.0-Kanäle beim ersten Start. `dropCoupling()`
  für die Fehlerisolierung.
- [x] Bidirektional + mehrfach genutzte Quelle → Rückstufung auf unidirektional mit
  Warnung (Phase 1, s. Design-Record §5).
- [x] **Brechende Änderung** (Freigabe User 2026-09-28: frühere Versionen waren
  Konzeptstudien): kein `CONFIG_VERSION`-Bump, keine Migration der alten
  `channels.<source>.*`. Die neuen Schalter starten mit ihrem Saatwert
  (`entry.enabled`, sonst Adapter-Default). Dokumentiert im **neuen
  README-Changelog**.
- [x] Version 0.4.0 + News (en/de); Typecheck mit echten ioBroker-Typen sauber,
  jsonConfig gegen das offizielle Schema validiert, ID-Generator und Validator
  gegen die echte Auswertungsmechanik durchgerechnet.
- [ ] **Build/Deploy + Feldtest (User).** `npm run build`, `build/` mitcommitten,
  `iobroker upload dp-coupler`. Erwartung beim ersten Start: Log meldet vergebene
  IDs und entfernte Alt-Kanäle; Kanäle heißen danach `channels.<id>`.

### Feldtest-Befunde 0.4.x

- [x] **`enabled` war nur ein Saatwert** (Fund User 2026-09-28, Version 0.4.1): die
  Tabellenspalte wirkte ausschließlich beim Anlegen des Kanal-Datenpunkts und wurde
  bei jedem späteren Start ignoriert — eine auf „no" gesetzte Zeile schaltete die
  Kopplung nicht ab, und die initiale Synchronisation lief trotzdem. Die Baseline war
  also korrekt, die Spalten-Semantik nicht. **Vier-Wert-Strategie** (Vorschlag User):
  `yes`/`no` erzwingen den Datenpunkt bei jedem Start, `(def)` erzwingt den
  Adapter-Default, `(keep)` lässt einen vorhandenen Datenpunkt unangetastet und legt
  einen fehlenden aus dem Adapter-Default an. Fehlendes Feld = `(keep)` →
  rückwärtskompatibel. `enabled` gehört damit **nicht** mehr zu den Filter-Flags
  (eigene Normalisierung `normalizeEnabled()`, vier statt drei Spaltenoptionen).
  `"old"`/`"hold"`/`"runtime"`/`"retain"` werden als Synonyme für `(keep)` akzeptiert.
- [x] **`lastState` vor dem Zyklusschutz pflegen** (Version 0.4.2). Vorher returnte
  der `inFlight`-Guard **vor** der Cache-Pflege, deshalb behält `lastState` nach einem
  Rückschreiben den alten Wert. Folge: bei **bidirektional + Zeittakt** schreibt der
  Tick den veralteten Wert zurück und **setzt die Änderung des Ziels zurück** — ein
  Fehler, der unabhängig von der Sternverteilung besteht und nur unentdeckt blieb,
  weil die Feldkonfiguration keinen Zeittakt nutzt. `lastState` ist jetzt „letzter
  bekannter Quellwert" — unabhängig davon, wer geschrieben hat. Der Zyklusschutz läuft
  weiterhin für **jede** eingehende ID (auch für solche ohne Kopplung), weil er den
  `inFlight`-Eintrag räumen muss; ein liegengebliebener Eintrag würde das nächste echte
  Ereignis verschlucken. Testfälle: Gruppe F der Fan-out-Testspezifikation.
- [ ] **Verbleibende Grenze:** `inFlight` ist ein Set ohne Zähler. Schreiben zwei
  Kopplungen dasselbe Ziel kurz hintereinander, räumt das erste Echo den Eintrag und
  das zweite gilt als Fremdereignis. Für n:1 harmlos bis unschön, für einen künftigen
  bidirektionalen Stern der Grund, warum Vorrang zwischen Satelliten nötig bleibt
  (Design-Record §5).

- [x] **Bidirektionale Sterne nicht mehr bevormunden** (Version 0.4.3, Entscheidung
  2026-09-28). Die Rückstufung entschied für den Bediener, dass eine unvollständige
  Propagation schlimmer sei als keine — und blockierte genau den treibenden Fall
  (mehrere Heizkörper-Thermostate eines Raums über einen neutralen Hilfsdatenpunkt,
  jedes Gerät darf melden). Ersetzt durch `warnAboutBidirectionalStars()`: eine
  Warnung **pro betroffener Quelle** bei jedem Start, im Wortlaut abhängig davon, ob
  ein Zeittakt aktiv ist (er ändert das Ergebnis grundlegend). Vollständige
  Fallunterscheidung „wer gewinnt" im Design-Record §5.
  Nebenbei: der dreifach duplizierte Intervall-Ausdruck ist zu
  `effectiveSyncIntervalMs()` zusammengefasst (für die Warnung gebraucht).

### Offen / nachgelagert

- [x] **`syncCompare` pro Eintrag — compare-then-write für den Zeittakt** (Version
  0.5.0, umgesetzt 2026-09-28). **Vor Phase 2 gezogen.** Begründung: der Takt hat *zwei*
  Zwecke. Für einen **Heartbeat** ist das unbedingte Schreiben richtig — dort ist der
  Zeitstempel die Information. Für **„halte diese Ziele auf demselben Wert"** ist es
  genau falsch, und bei Funkgeräten (Thermostate!) schädlich: jeder Takt ein
  Funkkommando, Batterie und Latenz. Beide Zwecke können in derselben Konfiguration
  nebeneinander stehen, deshalb **pro Eintrag** und nicht adapterweit — ein globaler
  Schalter würde einen der beiden opfern.
  - Mechanik existiert: `baselineWrite()` macht compare-then-write vollständig; der
    Takt muss diesen Pfad nur benutzen dürfen.
  - Dreiwertig wie die Filter (`(def)`/yes/no) plus `syncCompareDefault` in den
    Adapter-Einstellungen. Es ist ein **Filter des Takts**, gehört also in diese
    Gruppe — nicht zu `enabled`, das seit 0.4.1 eine Startwert-Strategie ist.
  - Name bewusst `syncCompare`, nicht „…Change": `forwardChangesOnly` (Ereignisfilter)
    und `relayOnChange` (adapterweit) sind schon belegt, ein dritter „change"-Begriff
    wäre eine Verwechslungsfalle. Spaltentitel etwa „sync cmp".
  - Mitbedenken: die Last verschiebt sich (ein Lesezugriff pro Kopplung pro Takt) —
    für Funkgeräte klarer Gewinn, für lokale Datenpunkte neutral bis leicht negativ,
    noch ein Grund für die Entscheidung pro Eintrag. Und `baselineWrite()` vergleicht
    mit `===`: bei Fließkommawerten kann eine Darstellungsdifferenz dazu führen, dass
    doch jedes Mal geschrieben wird.
  - **Nachtrag im Baseline-Design-Record** erledigt: dort stand „Sync-Tick: bleibt
    unbedingt (kein Vergleich)" als Festlegung. Sie ist nicht aufgehoben, sondern zur
    Wahl gemacht — inklusive der beiden Eigenschaften (Lastverschiebung, strikter
    `===`-Vergleich).
  - Nebeneffekt: mit `syncCompare = yes` wird der Takt zu einem brauchbaren
    Konvergenz-Mechanismus für den bidirektionalen Stern — ohne Funklast, nur
    latenzbehaftet.
  - `CONFIG_VERSION` 2 → 3 (neues `NATIVE_DEFAULTS`-Feld `syncCompareDefault`, damit
    bestehende Instanzen es in der UI sehen). Default **aus** → bestehende
    Konfigurationen verhalten sich unverändert.
  - Testfälle: Gruppe G der Fan-out-Testspezifikation; G1 ist der Regressionswächter
    für den Heartbeat.
- [ ] **Phase 2: bidirektionaler Stern** — Rückschreiben eines Satelliten muss die
  übrigen Sternteilnehmer erreichen (`relayFrom(..., exceptTarget)`). **Nach**
  `syncCompare`. Der Vorrang-Gedanke (Tabellen-Reihenfolge + Zeitfenster) ist für den
  Thermostat-Fall **nicht** nötig: „wer zuletzt kommt, gewinnt" ist dort genau das
  gewollte Verhalten — die letzte Bedienhandlung zählt. Eigener Design-Record.
  Der skizzierte Zwischenschritt „nur die erste bidirektionale Zeile darf
  zurückschreiben" ist damit erledigt: beim Thermostat-Fall muss **jedes** Gerät
  schreiben dürfen.
- **Wertbasierte Quittungserwartung — Ansatz für einen Spezialfall, kein geplantes
  Feature** (Feldbefund 2026-09-28; architektonische Entscheidung 2026-09-28: ein
  Filter für *ein* Fehlverhalten löst genau dieses, der nächste defekte Gerätetyp
  bringt ein anderes Muster — eine Sammlung gerätespezifischer Notbehelfe gehört nicht
  in einen allgemeinen Koppler, die Ursache gehört in den Geräte-Adapter). Anlass: Zigbee-Thermostate (über
  Zigbee2MQTT) bestätigen einen geschriebenen Sollwert **zuerst mit dem alten Wert**
  (ack:true) und erst danach mit dem neuen. Schritt 2 ist von einer Bedienung am Gerät
  nicht unterscheidbar — gleicher DP, gleiches `ack`, echte Wertänderung, `lc == ts` —
  und nährt sich über zwei gekoppelte Geräte selbst. **Der Fehler liegt nicht im
  Adapter** (Ursache vermutlich Rücklesen nach dem Schreiben in Zigbee2MQTT; wird vom
  Bediener separat verfolgt).
  Denkbarer Mechanismus: beim Schreiben den **erwarteten Wert** merken und eine
  Meldung mit dem *Vorwert* verwerfen, bis die passende Bestätigung eintrifft — keine
  Zeit-Totzeit, sondern eine Quittungserwartung. Braucht aber einen **Timeout als
  Ausfallsicherung**: eine Bestätigung, die nie kommt, dürfte den Datenpunkt nicht
  dauerhaft blockieren. Damit ist die Totzeit nicht vermeidbar, nur anders motiviert —
  und eine Zustandsmaschine pro Ziel, um ein Upstream-Fehlverhalten zu kaschieren, ist
  bewusst zurückgestellt. Zwischenlösung (in der README dokumentiert): Kopplungen
  unidirektional betreiben und den Wert zentral setzen.
- [ ] **Takt pro Eintrag oder Taktgruppen** (aufgekommen 2026-09-28, nicht geplant):
  `syncInterval` ist adapterweit, verschiedene Kadenzen brauchen daher **verschiedene
  Instanzen** — so löst der Bediener es heute (eine Instanz hält den Modus der
  Thermostate zyklisch, eine andere verteilt Messwerte). Das ist ein legitimes Muster
  und in der README als solches dokumentiert; ein Takt pro Eintrag wäre die Alternative,
  falls die Instanz-Zahl je unhandlich wird.
- [x] **Rundungs-Schwingung dokumentieren statt lösen** (Entscheidung 2026-09-28):
  Geräte mit unterschiedlicher Schrittweite können sich endlos gegenseitig korrigieren,
  weil jede Korrektur eine *echte* Wertänderung ist, die kein Filter abfängt. Abhilfe
  außerhalb des Adapters: **ioBroker-Alias mit Lese-/Schreib-Formeln**. In der README
  vermerkt (Abschnitt „Mapping tab"); kein Adapter-Feature dafür.
- [ ] **Zyklus-Erkennung** (Backlog, Entscheidung 2026-09-28): Startup-Prüfung auf
  `A→B, B→A` und längere Ketten. `inFlight` schützt zur Laufzeit; die Erkennung ist
  Komfort, vorerst Sache des Bedieners.

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
