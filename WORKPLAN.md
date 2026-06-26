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
- [ ] `loadMappings()`: `typeof raw === "string" ? JSON.parse(raw) : raw` (Array/Objekt
  direkt übernehmen; danach unverändert `Array.isArray`-Check + Type-Guard-Schleife).

### 2. `src/main.ts` — Self-Heal in `onReady()`
- [ ] Früh (vor `loadMappings()`): wenn `Array.isArray(this.config.mappingsRaw)`, den Wert
  per `extendForeignObjectAsync("system.adapter.${this.namespace}", { native: { mappingsRaw:
  JSON.stringify(arr, null, 2) } })` zurückschreiben.
- [ ] Fire-and-forget + weiterlaufen (kein `return`); `log.info` ausgeben.

### 3. `src/main.ts` — Export normalisieren
- [ ] `persistMappingsFile()`: `content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)`
  (verhindert `[object Object]`-Müll in `mappings.json`, wenn der Wert ein Array ist).

### 4. `src/main.ts` — Typ aufweiten
- [ ] `AdapterConfig.mappingsRaw: string` → `string | unknown[]`.

### 5. Build & Test
- [ ] `npm run build` fehlerfrei.
- [ ] Testfälle: (a) String-Import, (b) natives Array-Import → Self-Heal → jsonEditor zeigt
  pretty String, (c) leeres Mapping, (d) invalides JSON → saubere Fehlermeldung.

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

- [ ] README-Abschnitt „Deployment / Import & Export" mit obigen Befehlen + Begründung
  (Stringfeld vs. natives Array; Self-Heal) ergänzen.

## Erweiterter Scope dieser Sitzung (Entscheidung 2026-06-26)

Beschluss: Härtung 1–6 **plus** configVersion-Normalisierung **plus** Seeding werden
gemeinsam umgesetzt. Begründung: alle drei teilen denselben
`extendForeignObjectAsync`-Schreibpfad; ein kombinierter Normalisierungs-Write löst
höchstens einen Config-Restart aus.

### 7. configVersion + onReady-Normalisierung
- [ ] `configVersion: 0` in `io-package.json` `native` (nur io-package, **nicht** jsonConfig).
- [ ] `AdapterConfig.configVersion?: number`.
- [ ] In `onReady()` früh: bei `configVersion < 1` alle fehlenden `native`-Defaults
  explizit auffüllen (modulweite `NATIVE_DEFAULTS`-Tabelle) und `configVersion: 1` setzen
  — **im selben** `extendForeignObjectAsync`-Patch wie der mappingsRaw-Self-Heal.
- [ ] Ab `configVersion >= 1` überspringen. Primärnutzen: UI-Korrektheit + Migrationspfad.

### 8. Seeding (One-Shot-Datei, konsumierend)
- [ ] Trigger: Config-Mapping leer **und** `mappings.seed.json` vorhanden & valide
  → Einträge übernehmen (in denselben Patch schreiben).
- [ ] **Konsum:** Datei nach **erfolgreichem** DB-Write (`.then()`) löschen — One-Shot,
  verhindert „Wiederauferstehung". Löschfehler (z. B. schreibgeschützt) ist nicht fatal:
  warnen und weiter. Schutz gegen Re-Seed ist primär die „Config leer"-Bedingung.
- [ ] Bewusst **getrennte** Datei (`mappings.seed.json`) vom Export (`mappings.json`),
  damit der Export-Schreibpfad keinen Seed-Feedback-Loop erzeugt.
- [ ] `parseMappings()`-Helper aus `loadMappings()` extrahieren (von Config- und Seed-Pfad
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
- **Wert-Konvertierung (`transform` via JSON/JSONata)** pro MappingEntry. Vorerst werden
  ioBroker-Aliase genutzt; eigene Implementierung erst, wenn der Alias-Weg an seine
  Grenzen stößt.
- **Zeittakt für Rückwärtsrichtung** bidirektionaler Einträge (der Timer cached aktuell
  nur Vorwärts-Ereignisse). Zuerst als adapterweiter Schalter `syncBidirectional?`.
- **Separate Filter pro Koppelrichtung** (`forwardOnAck`/`forwardChangesOnly` getrennt
  für Vorwärts-/Rückwärtsrichtung). Zurückgestellt bis ausreichend User-Nachfrage.

## Status

PoC abgeschlossen, Adapter im dev-server verifiziert; **Feldtest steht aus.**
Nächster Schritt: Härtung (Aufgaben 1–6) an einem dedizierten Vormittag, **vor** der
Entwicklung der vollen Deployment-Automation. Danach entfällt im Deployment das
`jq -Rs`-Escaping für `mappingsRaw` (natives Array wird direkt akzeptiert und
self-gehealt).
