// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2024 Johannes Lode

/**
 * ioBroker adapter: dp-coupler
 *
 * Relays state changes between arbitrary datapoints via a JSON mapping.
 * Configuration is stored in this.config.mappingsRaw (ioBroker DB, edited
 * via admin UI). On every successful start the config is also written to
 * mappings.json for seeding and export purposes.
 *
 * One-directional for now; bidirectional support is stubbed and can be
 * enabled per mapping entry once the reverse-subscribe logic is wired up.
 *
 * Mapping schema: Array of MappingEntry objects – see type below.
 * Unknown keys (e.g. "_comment") are silently ignored by the type guard.
 */

import * as utils from "@iobroker/adapter-core";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// ioBroker config type
// ---------------------------------------------------------------------------

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            mappingsRaw: string | unknown[]; // canonical: JSON string; tolerated: native array
            mappingsTable?: unknown[];       // adapter-maintained mirror of mappingsRaw, for the admin UI table only
            forwardOnAckDefault: boolean;
            forwardChangesOnlyDefault: boolean;
            propagateAckDefault: boolean;
            syncIntervalValue: number; // numeric part of the sync interval; 0 = disabled
            syncUnit: string;          // unit: "ms" | "s" | "min" | "h"
            relayOnChange: boolean;    // when sync active: also relay on event; irrelevant when sync disabled
            enabledDefault: boolean;   // initial enabled state for per-channel datapoints
            coerceTypesDefault: boolean;   // cast source value to target common.type (bool↔number, C convention)
            coerceStringsDefault: boolean; // additionally interpret strings when coercing; else pass through
            configVersion?: number;    // self-heal/migration marker; missing/< CONFIG_VERSION triggers default normalization
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MappingEntry {
    id: string;                      // coupling handle; becomes the channels.<id> object name
    source: string;
    target: string;
    bidirectional?: boolean;
    forwardOnAck?: boolean;
    forwardChangesOnly?: boolean;
    propagateAck?: boolean;
    // Startup strategy for the channels.<id>.enabled datapoint — NOT a filter flag:
    // true/false force it, "def" forces the adapter default, "keep" (and a missing
    // field) leaves an existing datapoint alone. See normalizeEnabled().
    enabled?: boolean | "def" | "keep";
}

// ---------------------------------------------------------------------------
// Native config defaults
// ---------------------------------------------------------------------------
//
// Mirror of the io-package.json "native" defaults (minus mappingsRaw, which is
// handled separately). Used by the configVersion self-heal in onReady() to fill
// fields that are missing on a fresh or migrated instance, so the admin UI shows
// real values instead of blanks. mappingsRaw is intentionally excluded.

const NATIVE_DEFAULTS: Record<string, unknown> = {
    forwardOnAckDefault:       false,
    forwardChangesOnlyDefault: true,
    propagateAckDefault:       false,
    syncIntervalValue:         0,
    syncUnit:                  "ms",
    relayOnChange:             false,
    enabledDefault:            true,
    coerceTypesDefault:        true,
    coerceStringsDefault:      false,
};

// Current native config schema version. onReady() fills any missing NATIVE_DEFAULTS and
// bumps configVersion to this value whenever the stored version is lower — the forward-
// compatible migration hook (new native fields become visible in the admin UI on upgrade).
const CONFIG_VERSION = 2;

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Normalizes the `enabled` field, which is a four-valued **startup strategy**, not a
 * tri-state filter flag like the others: `true`/`false` force the datapoint at every
 * start, `"def"` forces the adapter default, `"keep"` leaves an existing datapoint
 * untouched (and creates a missing one from the adapter default).
 *
 * A missing, null or empty value means `"keep"` — that is exactly the behaviour
 * before this field became a table column, so existing configurations are unchanged.
 * `"old"`, `"hold"`, `"runtime"` and `"retain"` are accepted as synonyms of `"keep"`,
 * so a hand-written or CLI-set configuration is not tripped up by the wording.
 * Returns null only for a value that cannot be interpreted at all.
 */
function normalizeEnabled(value: unknown): boolean | "def" | "keep" | null {
    if (value === undefined || value === null) return "keep";
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 0) return false;
        if (value === 1) return true;
        return null;
    }
    if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (s === "") return "keep";
        if (s === "def" || s === "default") return "def";
        if (s === "keep" || s === "old" || s === "hold" || s === "runtime" || s === "retain") {
            return "keep";
        }
        if (s === "true"  || s === "1" || s === "yes" || s === "on")  return true;
        if (s === "false" || s === "0" || s === "no"  || s === "off") return false;
        return null;
    }
    return null;
}

/**
 * Minimal plausibility check for a state ID used in a mapping entry. Deliberately
 * NOT a full ioBroker ID validation: it rejects only the forms that would produce
 * an invalid object ID downstream — empty, inner whitespace, leading/trailing dot,
 * double dot. Those are exactly what an unfilled or mistyped editor row produces.
 * Callers trim first, so surrounding whitespace from copy&paste is tolerated.
 */
function isPlausibleStateId(value: string): boolean {
    if (value === "") return false;
    if (/\s/.test(value)) return false;
    if (value.startsWith(".") || value.endsWith(".")) return false;
    return !value.includes("..");
}

/**
 * Checks the two mandatory fields. `id` is deliberately not checked here: it is
 * backfilled by parseMappings() immediately afterwards, which is the only caller.
 */
function isMappingEntry(value: unknown): value is MappingEntry {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj["source"] !== "string" || typeof obj["target"] !== "string") return false;
    return isPlausibleStateId(obj["source"].trim()) && isPlausibleStateId(obj["target"].trim());
}

/**
 * Normalizes an optional boolean flag of a mapping entry. Tolerates the string and
 * number spellings a CSV import or a hand-written mapping produces. Returns
 * `undefined` when the flag is absent (adapter default applies) and `null` when a
 * present value cannot be interpreted — the caller then drops it with a warning.
 *
 * Why this matters: `bidirectional` is tested with `=== true`, so a string "true"
 * would silently read as false, while the other flags go through truthy `??` tests,
 * where a string "no" would silently read as true. Both mean the opposite of what
 * was configured, without any trace in the log.
 */
function normalizeFlag(value: unknown): boolean | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 0) return false;
        if (value === 1) return true;
        return null;
    }
    if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        // "def"/"default" is the admin table's placeholder for "not set". It cannot be
        // the empty string: ConfigSelect matches the stored value against the options
        // with a loose `==`, and `"" == false` is true in JavaScript — an entry set to
        // false would then display the "(def)" option instead of "no".
        if (s === "" || s === "def" || s === "default") return undefined;
        if (s === "true"  || s === "1" || s === "yes" || s === "on")  return true;
        if (s === "false" || s === "0" || s === "no"  || s === "off") return false;
        return null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A coupling id becomes part of an ioBroker object ID (`channels.<id>`), so the
 * character set is constrained. Dots are forbidden above all: they would create
 * hierarchy levels (`channels.a.b.enabled`), i.e. sub-channels instead of one
 * channel. The operator may choose a speaking handle, but not a broken object ID.
 */
function isPlausibleCouplingId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value.trim());
}

/**
 * Generates a short, MAC-address-like handle for a coupling. Only used when an
 * entry has none — the admin table assigns one when a row is created, and this
 * backfills entries that came from a CLI import or predate the id field.
 */
function generateCouplingId(): string {
    return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Debug trace (flip to true + rebuild to enable [dpc] output)
// ---------------------------------------------------------------------------

const DPC_DEBUG = false;
function dpcLog(...args: unknown[]): void {
    if (DPC_DEBUG) console.log(...args);
}

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

class DpCoupler extends utils.Adapter {
    // Both indices map a state ID to *all* couplings that use it in that role — a
    // source may feed several targets (fan-out / star). See
    // docs/design/fan-out-and-coupling-identity.md.
    private readonly sourceIndex         = new Map<string, MappingEntry[]>();
    private readonly targetIndex         = new Map<string, MappingEntry[]>();
    private readonly inFlight            = new Set<string>();
    private readonly lastState           = new Map<string, ioBroker.State>();
    // Keyed by coupling id, not by source: every table row is its own switchable unit.
    private readonly enabledMap          = new Map<string, boolean>();
    private readonly enabledDpToCoupling = new Map<string, MappingEntry>();
    private readonly destType            = new Map<string, ioBroker.CommonType>();
    private readonly pendingBaseline     = new Set<string>();
    private readonly couplings: MappingEntry[] = [];
    private syncTimer: ReturnType<typeof setInterval> | null = null;
    private syncIntervalMs = 0;
    private unloading = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "dp-coupler" });

        this.on("ready",       this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload",      this.onUnload.bind(this));
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    private async onReady(): Promise<void> {
        await this.setObjectAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectAsync("info.connection", {
            type: "state",
            common: {
                role: "indicator.connected",
                name: "Adapter connected and mapping loaded",
                type: "boolean",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        // Load mappings from config (tolerant: accepts a JSON string or a native array).
        const loaded = this.loadMappings();
        if (loaded === null) {
            // Error already logged inside loadMappings().
            return;
        }
        let mappings    = loaded.valid;
        let idsAssigned = loaded.idsAssigned;
        // Carries the backfilled coupling ids; used for the canonical string below.
        let effectiveParsed: unknown[] = loaded.parsed;

        // Seeding: an empty config plus a present, valid seed file means initial
        // deployment without UI access. Adopt the seed entries; the file is consumed
        // (deleted) after a successful DB write so emptying the config later cannot
        // resurrect them. The "config empty" condition is the primary re-seed guard.
        let seeded = false;
        let seededRaw = "";
        if (mappings.length === 0) {
            const seed = this.readSeedMappings();
            if (seed !== null) {
                mappings    = seed.entries;
                seededRaw   = seed.canonical;
                idsAssigned = 0; // the seed's canonical string already carries them
                seeded      = true;
            }
        }

        // Single normalization write (self-heal). Combines three concerns into one
        // extendForeignObjectAsync call → at most one config restart:
        //   (a) configVersion < 1: fill missing native defaults so the admin UI shows
        //       real values instead of blanks (also a forward-compatible migration hook);
        //   (b) a native array in mappingsRaw → canonical pretty-printed string;
        //   (c) seeded mappings → persisted into mappingsRaw.
        // We do NOT return afterwards — the loader is tolerant and relays immediately
        // from the in-memory mappings even if the restart does not occur.
        const needsNativeMigration = (this.config.configVersion ?? 0) < CONFIG_VERSION;

        // The canonical string is never pruned: it keeps every entry the operator wrote,
        // including the ones the loader rejected. A rejected entry stays visible (and
        // fixable) in the admin editor instead of quietly vanishing from the config.
        // Backfilled coupling ids must be persisted, otherwise the channel objects would
        // be renamed on every start. That is an *addition* to the stored entries, so it
        // does not conflict with "never pruned".
        let canonicalRaw: string;
        if (seeded) {
            canonicalRaw = seededRaw;
        } else if (idsAssigned > 0) {
            canonicalRaw = JSON.stringify(effectiveParsed, null, 2);
        } else if (typeof this.config.mappingsRaw === "string") {
            canonicalRaw = this.config.mappingsRaw;
        } else {
            canonicalRaw = JSON.stringify(this.config.mappingsRaw ?? [], null, 2);
        }

        const patch: Record<string, unknown> = {};
        if (needsNativeMigration) {
            const cfg = this.config as unknown as Record<string, unknown>;
            for (const [key, def] of Object.entries(NATIVE_DEFAULTS)) {
                if (cfg[key] === undefined || cfg[key] === null) patch[key] = def;
            }
            patch.configVersion = CONFIG_VERSION;
        }
        if (seeded || idsAssigned > 0 || Array.isArray(this.config.mappingsRaw)) {
            patch.mappingsRaw = canonicalRaw;
            if (idsAssigned > 0) {
                this.log.info(
                    `dp-coupler: assigned ${idsAssigned} missing coupling id(s) – persisted.`
                );
            }
        }

        // Mirror the canonical string as an array into mappingsTable. The admin UI's
        // table binds to an array attribute, while the canonical form is a string —
        // and a *stored* mirror is what keeps the dialog's "changed" flag honest: a
        // table attribute that exists only in the dialog (doNotSave) is always absent
        // from the comparison baseline, so every opening of the configuration would
        // report unsaved modifications. See docs/design/admin-ui-mapping-table.md §7a.
        // Written only on divergence, so a UI save (which writes both consistently)
        // causes no extra config restart. Mirrors the *unfiltered* content, so a
        // rejected entry stays visible and fixable in the table too.
        try {
            const mirror = JSON.parse(canonicalRaw);
            if (Array.isArray(mirror) &&
                JSON.stringify(this.config.mappingsTable) !== JSON.stringify(mirror)) {
                patch.mappingsTable = mirror;
            }
        } catch { /* unparsable canonical string – leave the stored mirror untouched */ }
        if (Object.keys(patch).length > 0) {
            this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: patch })
                .then(() => {
                    this.log.info("dp-coupler: configuration normalized (self-heal).");
                    // Consume the seed file only after the config was persisted, so a
                    // failed write leaves the seed in place for the next start.
                    if (seeded) this.consumeSeedFile();
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    this.log.warn(`dp-coupler: config normalization failed: ${message}`);
                });
        }

        this.persistMappingsFile(canonicalRaw);

        if (mappings.length === 0) {
            this.log.info("dp-coupler: mapping configuration is empty – nothing to relay.");
            return;
        }

        // Fan-out: a source may feed several targets, so both indices hold lists.
        // Duplicate ids and duplicate (source, target) pairs were already rejected in
        // parseMappings(), so every entry here is a distinct coupling.
        const sourceUseCount = new Map<string, number>();
        for (const entry of mappings) {
            sourceUseCount.set(entry.source, (sourceUseCount.get(entry.source) ?? 0) + 1);
        }

        for (const entry of mappings) {
            // Phase 1 of the star design: fan-out is unidirectional. The reverse write of
            // a bidirectional branch lands on the star point, where the inFlight guard
            // necessarily swallows the resulting event — the sibling branches would never
            // see the value. Downgrade instead of discarding, so the distribution keeps
            // working. See docs/design/fan-out-and-coupling-identity.md §5.
            if (entry.bidirectional === true && (sourceUseCount.get(entry.source) ?? 0) > 1) {
                this.log.warn(
                    `dp-coupler: coupling "${entry.id}" (${entry.source} → ${entry.target}) is ` +
                    `bidirectional, but "${entry.source}" feeds several targets – treated as ` +
                    `unidirectional (the reverse direction would not reach the other branches).`
                );
                entry.bidirectional = false;
            }

            this.couplings.push(entry);

            const forwards = this.sourceIndex.get(entry.source);
            if (forwards) forwards.push(entry);
            else this.sourceIndex.set(entry.source, [entry]);

            if (entry.bidirectional === true) {
                const reverses = this.targetIndex.get(entry.target);
                if (reverses) reverses.push(entry);
                else this.targetIndex.set(entry.target, [entry]);
            }
        }

        // Build per-channel objects (channels.<id>.enabled + .lastValue) for all active entries.
        //
        // Per-entry error isolation (defense in depth): the validation above rejects the
        // malformed entries we know about, but an unexpected failure here must still cost
        // only the offending entry. Without the try/catch a single rejected await would
        // abort onReady() — no "ready", no info.connection, no relay at all.
        const brokenCouplings: MappingEntry[] = [];
        for (const entry of this.couplings) {
            const sourceId  = entry.source;
            const channelId = entry.id;
            try {
                // Determine source datapoint type for the lastValue object definition and,
                // together with the target type below, for the coercion cache (destType).
                let sourceType: ioBroker.CommonType = "mixed";
                try {
                    const srcObj = await this.getForeignObjectAsync(sourceId);
                    if (srcObj && srcObj.type === "state" && srcObj.common.type) {
                        sourceType = srcObj.common.type;
                    }
                } catch { /* fallback to mixed */ }

                // Cache declared target/source types for coercion. The reverse direction of a
                // bidirectional entry writes back to the source, so its type is a destination too.
                this.destType.set(sourceId, sourceType);
                try {
                    const tgtObj = await this.getForeignObjectAsync(entry.target);
                    if (tgtObj && tgtObj.type === "state" && tgtObj.common.type) {
                        this.destType.set(entry.target, tgtObj.common.type);
                    }
                } catch { /* leave unset → coercion passes through */ }

                // The channel carries the informative fields, so the object tree shows
                // what the coupling does without a look into the configuration.
                const comment = (entry as unknown as Record<string, unknown>)._comment;
                await this.setObjectAsync(`channels.${channelId}`, {
                    type: "channel",
                    common: {
                        name: `${entry.source} → ${entry.target}`,
                        ...(typeof comment === "string" && comment.trim() !== ""
                            ? { desc: comment.trim() }
                            : {}),
                    },
                    native: {},
                });
                await this.setObjectAsync(`channels.${channelId}.enabled`, {
                    type: "state",
                    common: {
                        role: "switch.enable",
                        name: "Channel enabled",
                        type: "boolean",
                        read: true,
                        write: true,
                        def: true,
                    },
                    native: {},
                });
                await this.setObjectAsync(`channels.${channelId}.lastValue`, {
                    type: "state",
                    common: {
                        role: "state",
                        name: "Last relayed value",
                        type: sourceType,
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                // Apply the entry's startup strategy to the enabled datapoint:
                //   true/false → forced at every start (runtime changes last until the next)
                //   "def"      → the adapter default, forced at every start
                //   "keep"     → an existing datapoint is left alone; a missing one is
                //                created from the adapter default
                // "keep" is what a missing field means, so pre-existing configurations
                // keep behaving as before. A table cell set to no therefore really means
                // off — before this, the column only had an effect on first creation,
                // which was the surprise it was fixed for.
                const existingEnabled = await this.getStateAsync(`channels.${channelId}.enabled`);
                const hasValue  = existingEnabled?.val !== null && existingEnabled?.val !== undefined;
                const strategy  = entry.enabled ?? "keep";
                const adapterDefault = this.config.enabledDefault ?? true;

                let currentEnabled: boolean;
                if (strategy === "keep") {
                    currentEnabled = hasValue ? Boolean(existingEnabled?.val) : adapterDefault;
                } else if (strategy === "def") {
                    currentEnabled = adapterDefault;
                } else {
                    currentEnabled = strategy;
                }
                if (!hasValue || Boolean(existingEnabled?.val) !== currentEnabled) {
                    await this.setStateAsync(`channels.${channelId}.enabled`, { val: currentEnabled, ack: true });
                }
                this.enabledMap.set(entry.id, currentEnabled);
                this.enabledDpToCoupling.set(`${this.namespace}.channels.${channelId}.enabled`, entry);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.log.warn(
                    `dp-coupler: could not set up coupling "${entry.id}" ` +
                    `(${sourceId} → ${entry.target}): ${message} – entry dropped, ` +
                    `all other couplings continue.`
                );
                brokenCouplings.push(entry);
            }
        }

        // Drop the failed couplings entirely, so no half-initialized one stays behind.
        for (const entry of brokenCouplings) {
            this.dropCoupling(entry);
        }

        // Remove channels of couplings that no longer exist. A permanent mechanism, not
        // a migration step — which is why it also clears the pre-0.4.0 per-source
        // channels on the first start after the upgrade, with no special-case code.
        await this.removeOrphanChannels();

        // Subscribe to own enabled datapoints so runtime changes update enabledMap.
        await this.subscribeStatesAsync("channels.*.enabled");

        const subscriptions = Array.from(new Set([
            ...this.sourceIndex.keys(),
            ...this.targetIndex.keys(),
        ]));
        await this.subscribeForeignStatesAsync(subscriptions);

        for (const sourceId of this.sourceIndex.keys()) {
            try {
                const st = await this.getForeignStateAsync(sourceId);
                if (st && st.val !== null && st.val !== undefined)
                    this.lastState.set(sourceId, st);
            } catch { /* non-fatal – cache stays empty for this source */ }
        }

        // Pre-populate lastValue from lastState cache, preserving the original timestamps
        // so the displayed value age reflects the real source event, not the adapter start.
        // One datapoint per coupling: the branches of a star share the same value.
        for (const entry of this.couplings) {
            const cached = this.lastState.get(entry.source);
            if (!cached) continue;
            try {
                await this.setStateAsync(`channels.${entry.id}.lastValue`, {
                    val: cached.val,
                    ack: true,
                    ts:  cached.ts,
                    lc:  cached.lc,
                    q:   cached.q,
                });
            } catch { /* non-fatal */ }
        }

        // Initial baseline transfer (level-triggered): bring every target to its
        // source value once per adapter life, so datapoints that rarely/never change
        // are synchronized at least once. Compare-then-write avoids needless
        // re-actuation. Sources not yet available stay pending and are completed by
        // their first event (see onStateChange) or a manual enable. runBaselinePass()
        // is a reusable method — foresight for a future connection-driven re-check
        // (see docs/design/initial-synchronization-baseline.md).
        // Keyed per coupling: with fan-out a per-source key would count the baseline as
        // done after the first target and leave the siblings without an initial value.
        for (const entry of this.couplings) this.pendingBaseline.add(entry.id);
        await this.runBaselinePass();

        const unitMultipliers: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000 };
        this.syncIntervalMs = (this.config.syncIntervalValue || 0)
            * (unitMultipliers[this.config.syncUnit ?? "ms"] ?? 1);
        if (this.syncIntervalMs > 0) {
            this.syncTimer = setInterval(this.onSyncTick.bind(this), this.syncIntervalMs);
            this.log.info(
                `dp-coupler: periodic sync active, ` +
                `${this.config.syncIntervalValue} ${this.config.syncUnit ?? "ms"} ` +
                `(${this.syncIntervalMs} ms).`
            );
        }

        const biCount    = this.couplings.filter(e => e.bidirectional === true).length;
        const fanOutCount = Array.from(this.sourceIndex.values()).filter(l => l.length > 1).length;
        this.log.info(
            `dp-coupler: ready – relaying ${this.couplings.length} coupling(s) ` +
            `from ${this.sourceIndex.size} source(s)` +
            (biCount > 0 ? `, ${biCount} bidirectional` : ``) +
            (fanOutCount > 0 ? `, ${fanOutCount} source(s) fanned out` : ``) + `.`
        );
        await this.setStateAsync("info.connection", { val: true, ack: true });
    }

    /**
     * Removes a coupling from every runtime structure. Used when its channel setup
     * failed, so no half-initialized coupling stays behind. `destType` entries are
     * kept: they are per state ID and may still be needed by a sibling coupling.
     */
    private dropCoupling(entry: MappingEntry): void {
        const unlist = (map: Map<string, MappingEntry[]>, key: string): void => {
            const list = map.get(key);
            if (!list) return;
            const rest = list.filter(e => e !== entry);
            if (rest.length > 0) map.set(key, rest);
            else map.delete(key);
        };
        unlist(this.sourceIndex, entry.source);
        unlist(this.targetIndex, entry.target);
        const at = this.couplings.indexOf(entry);
        if (at >= 0) this.couplings.splice(at, 1);
        this.enabledMap.delete(entry.id);
        this.pendingBaseline.delete(entry.id);
        this.enabledDpToCoupling.delete(`${this.namespace}.channels.${entry.id}.enabled`);
    }

    /**
     * Deletes `channels.*` objects that no current coupling claims. Permanent
     * housekeeping rather than a migration step: it removes the channels of couplings
     * the operator has deleted, and as a side effect the pre-0.4.0 per-source channels
     * on the first start after the upgrade. Non-fatal throughout — a failure here must
     * never keep the adapter from relaying.
     */
    private async removeOrphanChannels(): Promise<void> {
        const wanted = new Set(this.couplings.map(e => e.id));
        let removed = 0;
        try {
            const objects = await this.getAdapterObjectsAsync();
            const prefix  = `${this.namespace}.channels.`;
            const seen    = new Set<string>();
            for (const id of Object.keys(objects)) {
                if (!id.startsWith(prefix)) continue;
                const channelId = id.slice(prefix.length).split(".")[0];
                if (!channelId || wanted.has(channelId) || seen.has(channelId)) continue;
                seen.add(channelId);
                try {
                    await this.delObjectAsync(`channels.${channelId}`, { recursive: true });
                    removed++;
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.log.warn(
                        `dp-coupler: could not remove stale channel "${channelId}": ${message}`
                    );
                }
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: channel cleanup skipped: ${message}`);
            return;
        }
        if (removed > 0) {
            this.log.info(`dp-coupler: removed ${removed} stale channel(s).`);
        }
    }

    private onUnload(callback: () => void): void {
        this.unloading = true;
        if (this.syncTimer !== null) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        // Fire-and-forget: do not await — any async Redis op hangs when
        // js-controller tears down the connection during adapter restart.
        this.setStateAsync("info.connection", { val: false, ack: true }).catch(() => undefined);
        callback();
    }

    // -----------------------------------------------------------------------
    // State change handler
    // -----------------------------------------------------------------------

    private async onStateChange(
        id: string,
        state: ioBroker.State | null | undefined
    ): Promise<void> {
        if (!state || state.val === null || state.val === undefined) return;

        // Own enabled datapoint changed: update cache and confirm command if needed.
        const enabledCoupling = this.enabledDpToCoupling.get(id);
        if (enabledCoupling !== undefined) {
            const prev   = this.enabledMap.get(enabledCoupling.id);
            const newVal = Boolean(state.val);
            this.enabledMap.set(enabledCoupling.id, newVal);
            // Enable transition (false→true): push the current source value.
            // force = this coupling was never baselined this life (e.g. disabled at start);
            // otherwise compare-then-write corrects any drift accumulated while disabled.
            // prev === false guards against the ack:true confirmation re-triggering this.
            if (newVal && prev === false) {
                const cached = this.lastState.get(enabledCoupling.source);
                if (cached && cached.val !== null && cached.val !== undefined) {
                    const force = this.pendingBaseline.delete(enabledCoupling.id);
                    await this.baselineWrite(enabledCoupling, cached.val, cached.q, cached.ack, force);
                }
            }
            if (!state.ack) {
                // Confirm the write (ioBroker command pattern: adapter acknowledges with ack: true).
                this.setStateAsync(id.slice(this.namespace.length + 1), { val: newVal, ack: true })
                    .catch(() => undefined);
            }
            return;
        }

        const lcTs  = state.lc === state.ts ? `lc=ts(${state.lc})` : `lc<ts(+${state.ts - state.lc}ms lc=${state.lc})`;
        const ifs   = (): string => `[${[...this.inFlight].join(",") || "∅"}]`;
        const ackCh = state.ack ? "T" : "F";
        dpcLog(`[dpc] ${id}  val=${state.val}  ack=${ackCh}  ${lcTs}  inFlight=${ifs()}`);

        // Determine which couplings this state feeds. With fan-out a source can serve
        // several couplings, and a state may even be the source of some couplings and
        // the (bidirectional) target of others — every coupling is served on its own.
        const forwards = this.sourceIndex.get(id) ?? [];
        const reverses = this.targetIndex.get(id) ?? [];
        dpcLog(`[dpc]   ${forwards.length} fwd, ${reverses.length} rev`);

        // Update last known source state and lastValue DPs (forward direction only).
        //
        // Deliberately BEFORE the cycle guard: `lastState` means "the last known value
        // of the source", regardless of *who* wrote it. When the reverse direction of a
        // bidirectional coupling writes the source, the resulting event is our own echo
        // and the guard discards it — but the value is genuinely new. Skipping the cache
        // here left it stale, and the periodic sync then wrote the outdated value back,
        // undoing the change that had just been made at the target.
        // Also before the enabled check, so cache and datapoints always reflect the
        // current source value even when a coupling is disabled.
        if (forwards.length > 0) {
            this.lastState.set(id, state);
            for (const entry of forwards) {
                this.setStateAsync(`channels.${entry.id}.lastValue`, {
                    val: state.val,
                    ack: true,
                    ts:  state.ts,
                    lc:  state.lc,
                    q:   state.q,
                }).catch(() => undefined);
            }
        }

        // Cycle guard: skip relaying states we ourselves just wrote. Runs for *every*
        // incoming id — also for one no coupling claims — because it must clear the
        // inFlight entry; leaving it behind would swallow the next genuine event.
        if (this.inFlight.has(id)) {
            this.inFlight.delete(id);
            dpcLog(`[dpc]   inFlight HIT → skip relay  inFlight=${ifs()}`);
            return;
        }

        if (forwards.length === 0 && reverses.length === 0) return;

        for (const entry of forwards) await this.relayCoupling(entry, "forward", state);
        for (const entry of reverses) await this.relayCoupling(entry, "reverse", state);
    }

    /**
     * Applies one coupling to an incoming source state: enabled check, baseline
     * completion, periodic-only guard, the two filters, then the write. Split out of
     * onStateChange() because with fan-out the same state drives several couplings,
     * each with its own flags — the filters are per coupling, not per event.
     */
    private async relayCoupling(
        entry: MappingEntry,
        direction: "forward" | "reverse",
        state: ioBroker.State,
    ): Promise<void> {
        const destination = direction === "forward" ? entry.target : entry.source;
        const ifs = (): string => `[${[...this.inFlight].join(",") || "∅"}]`;

        // Enabled check: skip relay when this coupling is disabled.
        if (this.enabledMap.get(entry.id) === false) {
            dpcLog(`[dpc]   ${entry.id}: enabled=false → skip`);
            return;
        }

        // Baseline completion: the first event of a still-pending coupling fulfills its
        // initial baseline (bypassing the forwardOnAck/forwardChangesOnly filters), so a
        // rarely-changing datapoint is synchronized on its first arrival after start.
        if (direction === "forward" && this.pendingBaseline.has(entry.id)) {
            this.pendingBaseline.delete(entry.id);
            dpcLog(`[dpc]   ${entry.id}: baseline completion via first event`);
            await this.baselineWrite(entry, state.val, state.q, state.ack, false);
            return;
        }

        // Periodic-only mode: skip event relay when sync is active and relayOnChange is off.
        // Computed inline from this.config so the guard works without an adapter restart when
        // the config changes (this.syncIntervalMs is only updated in onReady()).
        const unitMultipliers: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000 };
        const effectiveMs = (this.config.syncIntervalValue || 0)
            * (unitMultipliers[this.config.syncUnit ?? "ms"] ?? 1);
        if (effectiveMs > 0 && !this.config.relayOnChange) return;

        // forwardOnAck filter: default false — skip ack=true device confirmations.
        const shouldForwardOnAck = entry.forwardOnAck ?? this.config.forwardOnAckDefault ?? false;
        if (state.ack && !shouldForwardOnAck) {
            dpcLog(`[dpc]   ${entry.id}: forwardOnAck: ack=T  shouldFwd=${shouldForwardOnAck}  → FILTERED`);
            return;
        }

        // forwardChangesOnly filter: default true — skip re-writes of unchanged values.
        // state.lc (last-change) < state.ts (last-set) means value was re-written unchanged.
        const shouldForwardChangesOnly = entry.forwardChangesOnly ?? this.config.forwardChangesOnlyDefault ?? true;
        if (shouldForwardChangesOnly && state.lc !== state.ts) {
            dpcLog(`[dpc]   ${entry.id}: forwardChangesOnly: lc<ts(+${state.ts - state.lc}ms)  → FILTERED`);
            return;
        }

        this.inFlight.add(destination);
        dpcLog(`[dpc]   ${entry.id}: RELAY → ${destination}  inFlight=${ifs()}`);
        try {
            const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
            const outVal = this.resolveValue(entry, direction, state.val, destination);
            await this.setForeignStateAsync(destination, {
                val: outVal,
                ack: shouldPropagateAck ? state.ack : false,
                q:   state.q,
            });
            this.log.debug(`dp-coupler: ${entry.id}: → ${destination} = ${outVal}`);
        } catch (err: unknown) {
            this.inFlight.delete(destination);
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: failed to write ${destination}: ${message}`);
            // TODO: per-entry fail-counter; set info.connection = false above threshold.
        }
    }

    // -----------------------------------------------------------------------
    // Periodic sync
    // -----------------------------------------------------------------------

    private async onSyncTick(): Promise<void> {
        for (const entry of this.couplings) {
            if (this.unloading) break;
            if (this.enabledMap.get(entry.id) === false) continue;
            const cached = this.lastState.get(entry.source);
            if (!cached) continue;
            const dest = entry.target;
            this.inFlight.add(dest);
            try {
                const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
                await this.setForeignStateAsync(dest, {
                    val: this.resolveValue(entry, "forward", cached.val, dest),
                    ack: shouldPropagateAck ? cached.ack : false,
                    q:   cached.q,
                });
            } catch (err: unknown) {
                this.inFlight.delete(dest);
                const message = err instanceof Error ? err.message : String(err);
                this.log.warn(`dp-coupler: sync tick failed for ${dest}: ${message}`);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Initial baseline (level-triggered one-shot per adapter life)
    // -----------------------------------------------------------------------

    /**
     * Runs one baseline pass over all sources still pending a baseline this life.
     * For each source with a cached value it aligns the target once (compare-then-
     * write). Sources that are disabled, have no cached value yet, or vanish from the
     * pending set mid-pass (completed by a concurrent event) are left pending and are
     * completed later by their first event or a manual enable.
     *
     * Deliberately a reusable method (not an inline loop in onReady): a future
     * connection-driven re-check (docs/design/initial-synchronization-baseline.md §5)
     * re-invokes it without a refactor.
     */
    private async runBaselinePass(): Promise<void> {
        let written = 0;
        const byId = new Map(this.couplings.map(e => [e.id, e]));
        for (const couplingId of Array.from(this.pendingBaseline)) {
            if (this.unloading) break;
            if (!this.pendingBaseline.has(couplingId)) continue;          // completed concurrently
            if (this.enabledMap.get(couplingId) === false) continue;      // stays pending
            const entry = byId.get(couplingId);
            if (!entry) { this.pendingBaseline.delete(couplingId); continue; }
            const cached = this.lastState.get(entry.source);
            if (!cached || cached.val === null || cached.val === undefined) continue; // awaits first event
            this.pendingBaseline.delete(couplingId);
            if (await this.baselineWrite(entry, cached.val, cached.q, cached.ack, false)) written++;
        }
        this.log.info(
            `dp-coupler: initial baseline – ${written} written, ` +
            `${this.pendingBaseline.size} pending (source not yet available).`
        );
    }

    /**
     * Writes a source value to its target as a baseline transfer. Unless `force` is
     * set, it first reads the target and skips the write when the (coerced) values are
     * already equal — synchronization means "make target equal source", so an equal
     * target needs no write and no re-actuation. `force` (used only on a manual enable
     * of a never-baselined channel) writes unconditionally. Returns true iff a write
     * was issued. Shares the inFlight guard, coercion, and propagateAck semantics with
     * the normal relay path; bypasses the forwardOnAck/forwardChangesOnly filters by
     * design (a baseline is level-triggered).
     */
    private async baselineWrite(
        entry: MappingEntry,
        sourceVal: ioBroker.StateValue,
        q: ioBroker.State["q"],
        ack: ioBroker.State["ack"],
        force: boolean,
    ): Promise<boolean> {
        const dest   = entry.target;
        const outVal = this.resolveValue(entry, "forward", sourceVal, dest);

        if (!force) {
            try {
                const current = await this.getForeignStateAsync(dest);
                if (current && current.val === outVal) {
                    dpcLog(`[dpc]   baseline ${entry.source} → ${dest}: equal (${outVal}) → skip`);
                    return false; // already in sync
                }
            } catch { /* read failed → fall through and write */ }
        }

        this.inFlight.add(dest);
        try {
            const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
            await this.setForeignStateAsync(dest, {
                val: outVal,
                ack: shouldPropagateAck ? (ack ?? false) : false,
                q,
            });
            this.log.debug(`dp-coupler: baseline ${entry.source} → ${dest} = ${outVal}${force ? " (forced)" : ""}`);
            return true;
        } catch (err: unknown) {
            this.inFlight.delete(dest);
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: baseline write to ${dest} failed: ${message}`);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Value pipeline (type coercion now; JSONata transform slots in here later)
    // -----------------------------------------------------------------------

    /**
     * Resolves the value to write to a destination. Single seam shared by both write
     * paths (event relay + periodic sync): read → (Feature B: transform) → coerce-to-target.
     * `direction` selects the forward/reverse transform expression once Feature B lands;
     * coercion itself depends only on the destination type. Feature B hooks in here
     * without touching the call sites.
     */
    private resolveValue(
        entry: MappingEntry,
        direction: "forward" | "reverse",
        rawVal: ioBroker.StateValue,
        destId: string,
    ): ioBroker.StateValue {
        // Feature B (later): apply entry.transform (forward) / entry.transformReverse
        // (reverse) here, before the cast. Params reserved for that step.
        void entry; void direction;
        if (this.config.coerceTypesDefault ?? true) {
            return this.coerceValue(rawVal, this.destType.get(destId));
        }
        return rawVal;
    }

    /**
     * Casts a value to the destination datapoint's declared common.type following C
     * conventions (number 0 ↔ false, non-0 ↔ true; false → 0, true → 1). Deterministic
     * and parameter-free: it never fails on a value, it only declines (passes the value
     * through) when it cannot interpret it. String interpretation is gated by the
     * adapter-wide coerceStrings switch; matching types and "mixed"/unknown pass through.
     */
    private coerceValue(
        rawVal: ioBroker.StateValue,
        destType: ioBroker.CommonType | undefined,
    ): ioBroker.StateValue {
        if (destType === undefined || destType === "mixed") return rawVal;
        const coerceStrings = this.config.coerceStringsDefault ?? false;

        switch (destType) {
            case "boolean":
                if (typeof rawVal === "boolean") return rawVal;
                if (typeof rawVal === "number")  return rawVal !== 0;
                if (typeof rawVal === "string" && coerceStrings) {
                    const s = rawVal.trim().toLowerCase();
                    return !(s === "" || s === "0" || s === "false");
                }
                return rawVal;
            case "number":
                if (typeof rawVal === "number")  return rawVal;
                if (typeof rawVal === "boolean") return rawVal ? 1 : 0;
                if (typeof rawVal === "string" && coerceStrings) {
                    const n = Number(rawVal);
                    return Number.isFinite(n) ? n : rawVal;
                }
                return rawVal;
            case "string":
                return typeof rawVal === "string" ? rawVal : String(rawVal);
            default:
                return rawVal;
        }
    }

    // -----------------------------------------------------------------------
    // Mapping loader
    // -----------------------------------------------------------------------

    /**
     * Parses and validates a raw mapping value. Tolerant: a string is JSON-parsed,
     * an array/object is taken as-is (supports a natively set mappingsRaw array).
     * `label` names the source for log messages (e.g. "mappingsRaw", seed file path).
     * Returns the validated array on success, or null on any unrecoverable error.
     */
    private parseMappings(
        raw: unknown,
        label: string,
    ): { valid: MappingEntry[]; parsed: unknown[]; idsAssigned: number } | null {
        let parsed: unknown;
        if (typeof raw === "string") {
            try {
                parsed = JSON.parse(raw);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.log.error(`dp-coupler: ${label} is not valid JSON: ${message}`);
                return null;
            }
        } else {
            parsed = raw;
        }

        if (!Array.isArray(parsed)) {
            this.log.error(`dp-coupler: ${label} must be a JSON array.`);
            return null;
        }

        const valid: MappingEntry[] = [];
        const seenIds   = new Set<string>();
        const seenPairs = new Set<string>();
        let idsAssigned = 0;

        for (let i = 0; i < parsed.length; i++) {
            const candidate = parsed[i];
            if (!isMappingEntry(candidate)) {
                this.log.warn(
                    `dp-coupler: ${label} entry [${i}] has no usable "source"/"target" ` +
                    `(missing, empty or not a plausible state ID) – skipped.`
                );
                continue;
            }

            // Backfill a missing or unusable coupling id. Written into the *parsed*
            // object, so the caller's canonical string carries the same id the runtime
            // uses — the admin table assigns ids for new rows, this covers CLI imports
            // and entries that predate the field.
            const bagRaw = candidate as unknown as Record<string, unknown>;
            if (!isPlausibleCouplingId(bagRaw.id)) {
                if (bagRaw.id !== undefined && bagRaw.id !== null && bagRaw.id !== "") {
                    this.log.warn(
                        `dp-coupler: ${label} entry [${i}] has an unusable id ` +
                        `(${JSON.stringify(bagRaw.id)}) – replaced by a generated one.`
                    );
                }
                let fresh = generateCouplingId();
                while (seenIds.has(fresh)) fresh = generateCouplingId();
                bagRaw.id = fresh;
                idsAssigned++;
            } else {
                bagRaw.id = (bagRaw.id as string).trim();
            }

            const entry = this.normalizeEntry(candidate, `${label} entry [${i}]`);
            if (entry === null) continue; // reason already logged

            if (seenIds.has(entry.id)) {
                this.log.warn(
                    `dp-coupler: ${label} entry [${i}] repeats the coupling id ` +
                    `"${entry.id}" – skipped (ids must be unique; they name the channel).`
                );
                continue;
            }
            const pair = `${entry.source} ${entry.target}`;
            if (seenPairs.has(pair)) {
                this.log.warn(
                    `dp-coupler: ${label} entry [${i}] repeats the coupling ` +
                    `"${entry.source}" → "${entry.target}" – skipped.`
                );
                continue;
            }

            seenIds.add(entry.id);
            seenPairs.add(pair);
            valid.push(entry);
        }
        return { valid, parsed, idsAssigned };
    }

    /**
     * Returns a normalized copy of an already validated entry: trimmed IDs and
     * tolerant boolean flags. Unknown keys (e.g. "_comment") are preserved.
     *
     * Returns null only when the entry is semantically unusable as a coupling
     * (source === target). An uninterpretable *optional* flag is never fatal — it is
     * dropped with a warning so the adapter default applies, because discarding a
     * whole coupling over a cosmetic field would be the larger surprise.
     */
    private normalizeEntry(entry: MappingEntry, label: string): MappingEntry | null {
        const out: MappingEntry = {
            ...entry,
            source: entry.source.trim(),
            target: entry.target.trim(),
        };

        if (out.source === out.target) {
            this.log.warn(
                `dp-coupler: ${label} couples "${out.source}" to itself – skipped.`
            );
            return null;
        }

        // `enabled` is deliberately not in this list: it is a four-valued startup
        // strategy, and normalizeFlag() would read "keep" as uninterpretable and
        // "def" as "not set".
        const bag = out as unknown as Record<string, unknown>;
        const enabledNorm = normalizeEnabled(bag.enabled);
        if (enabledNorm === null) {
            this.log.warn(
                `dp-coupler: ${label} has an uninterpretable "enabled" value ` +
                `(${JSON.stringify(bag.enabled)}) – treated as "keep" ` +
                `(runtime datapoint decides).`
            );
            out.enabled = "keep";
        } else {
            out.enabled = enabledNorm;
        }

        const flags = [
            "bidirectional", "forwardOnAck", "forwardChangesOnly", "propagateAck",
        ] as const;
        for (const key of flags) {
            const normalized = normalizeFlag(bag[key]);
            if (normalized === null) {
                this.log.warn(
                    `dp-coupler: ${label} has an uninterpretable "${key}" value ` +
                    `(${JSON.stringify(bag[key])}) – ignored, adapter default applies.`
                );
                delete bag[key];
            } else if (normalized === undefined) {
                delete bag[key];
            } else {
                bag[key] = normalized;
            }
        }
        return out;
    }

    /**
     * Loads and validates the mapping configuration from this.config.mappingsRaw
     * (ioBroker DB, edited via admin UI). Accepts both a JSON string and a native array.
     * Returns the validated entries together with the unfiltered parsed array (which
     * carries any backfilled coupling ids, so the caller can persist them) and how
     * many ids were assigned. Null on any unrecoverable error.
     */
    private loadMappings(): { valid: MappingEntry[]; parsed: unknown[]; idsAssigned: number } | null {
        const result = this.parseMappings(this.config.mappingsRaw ?? "[]", "mappingsRaw");
        if (result === null) return null;
        const skipped = result.parsed.length - result.valid.length;
        this.log.info(
            `dp-coupler: loaded ${result.valid.length} valid mapping(s)` +
            (skipped > 0 ? `, ${skipped} skipped (see warnings above)` : ``) + `.`
        );
        return result;
    }

    /**
     * Absolute path of the one-shot seed file used for initial deployment.
     * Kept separate from the export file (mappings.json) to avoid a seed feedback loop.
     */
    private seedFilePath(): string {
        return path.resolve(this.adapterDir, "mappings.seed.json");
    }

    /**
     * Reads and validates the optional one-shot seed file (mappings.seed.json).
     * Returns the validated entries plus the canonical string to store, or null if the
     * file is absent, empty, or invalid. Does NOT delete the file — that is done by
     * consumeSeedFile() after a successful config write, so a failed write leaves the
     * seed in place for the next start.
     *
     * `canonical` is built from the *unfiltered* parsed content: rejected entries are
     * carried into the configuration too, so the operator can see and fix them in the
     * admin editor instead of losing them silently with the consumed seed file.
     */
    private readSeedMappings(): { entries: MappingEntry[]; canonical: string } | null {
        const seedPath = this.seedFilePath();
        let content: string;
        try {
            content = fs.readFileSync(seedPath, "utf-8");
        } catch {
            return null; // No seed file present – nothing to do.
        }

        const result = this.parseMappings(content, `seed file "${seedPath}"`);
        if (result === null || result.valid.length === 0) return null;

        this.log.info(`dp-coupler: seeding ${result.valid.length} mapping(s) from "${seedPath}".`);
        return {
            entries:   result.valid,
            canonical: JSON.stringify(result.parsed, null, 2),
        };
    }

    /**
     * Deletes the consumed seed file (one-shot semantics). Non-fatal on failure:
     * a read-only file/directory is a legitimate way for the operator to keep the
     * seed; re-seeding is still prevented by the "config not empty" condition.
     */
    private consumeSeedFile(): void {
        const seedPath = this.seedFilePath();
        try {
            fs.unlinkSync(seedPath);
            this.log.info(`dp-coupler: consumed (deleted) seed file "${seedPath}".`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: could not delete seed file "${seedPath}": ${message}`);
        }
    }

    /**
     * Writes the canonical mappingsRaw content to mappings.json as a convenience
     * export (backup, deployment template). Non-fatal on failure.
     * Skips the write when the file already contains the same content to avoid
     * triggering file-watcher restarts in dev environments.
     */
    private persistMappingsFile(content: string): void {
        const filePath = path.resolve(this.adapterDir, "mappings.json");

        try {
            const existing = fs.readFileSync(filePath, "utf-8");
            if (existing === content) return;
        } catch {
            // File absent or unreadable – proceed with write.
        }

        try {
            fs.writeFileSync(filePath, content, "utf-8");
            this.log.debug(`dp-coupler: config written to "${filePath}".`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: could not write "${filePath}": ${message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main !== module) {
    // Started as a module (e.g. from tests or dev-server): export factory.
    module.exports = (options: Partial<utils.AdapterOptions>) =>
        new DpCoupler(options);
} else {
    // Started directly via `node build/main.js`.
    (() => new DpCoupler())();
}
