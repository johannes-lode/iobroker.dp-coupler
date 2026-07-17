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
    source: string;
    target: string;
    bidirectional?: boolean;
    forwardOnAck?: boolean;
    forwardChangesOnly?: boolean;
    propagateAck?: boolean;
    enabled?: boolean;               // seed value for the channels.<id>.enabled datapoint
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

function isMappingEntry(value: unknown): value is MappingEntry {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    return typeof obj["source"] === "string" && typeof obj["target"] === "string";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceToChannelId(source: string): string {
    return source.replace(/\./g, "_");
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
    private readonly sourceIndex       = new Map<string, MappingEntry>();
    private readonly targetIndex       = new Map<string, MappingEntry>();
    private readonly inFlight          = new Set<string>();
    private readonly lastState         = new Map<string, ioBroker.State>();
    private readonly enabledMap        = new Map<string, boolean>();
    private readonly enabledDpToSource = new Map<string, string>();
    private readonly destType          = new Map<string, ioBroker.CommonType>();
    private readonly pendingBaseline   = new Set<string>();
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
        let mappings = this.loadMappings();
        if (mappings === null) {
            // Error already logged inside loadMappings().
            return;
        }

        // Seeding: an empty config plus a present, valid seed file means initial
        // deployment without UI access. Adopt the seed entries; the file is consumed
        // (deleted) after a successful DB write so emptying the config later cannot
        // resurrect them. The "config empty" condition is the primary re-seed guard.
        let seeded = false;
        if (mappings.length === 0) {
            const seedEntries = this.readSeedMappings();
            if (seedEntries !== null) {
                mappings = seedEntries;
                seeded = true;
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
        const canonicalRaw = (typeof this.config.mappingsRaw === "string" && !seeded)
            ? this.config.mappingsRaw
            : JSON.stringify(mappings, null, 2);

        const patch: Record<string, unknown> = {};
        if (needsNativeMigration) {
            const cfg = this.config as unknown as Record<string, unknown>;
            for (const [key, def] of Object.entries(NATIVE_DEFAULTS)) {
                if (cfg[key] === undefined || cfg[key] === null) patch[key] = def;
            }
            patch.configVersion = CONFIG_VERSION;
        }
        if (seeded || Array.isArray(this.config.mappingsRaw)) {
            patch.mappingsRaw = canonicalRaw;
        }
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

        for (const entry of mappings) {
            if (this.sourceIndex.has(entry.source)) {
                this.log.warn(
                    `dp-coupler: duplicate source "${entry.source}" in mappings – ` +
                    `only the first entry is used.`
                );
                continue;
            }
            this.sourceIndex.set(entry.source, entry);

            if (entry.bidirectional === true) {
                if (this.targetIndex.has(entry.target)) {
                    this.log.warn(
                        `dp-coupler: duplicate bidirectional target "${entry.target}" in mappings – ` +
                        `only the first entry is used.`
                    );
                } else {
                    this.targetIndex.set(entry.target, entry);
                }
            }
        }

        // Build per-channel objects (channels.<id>.enabled + .lastValue) for all active entries.
        for (const [sourceId, entry] of this.sourceIndex) {
            const channelId = sourceToChannelId(sourceId);

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

            await this.setObjectAsync(`channels.${channelId}`, {
                type: "channel",
                common: { name: sourceId },
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

            // Seed enabled state only when no value exists yet (first start).
            const existingEnabled = await this.getStateAsync(`channels.${channelId}.enabled`);
            let currentEnabled: boolean;
            if (existingEnabled?.val !== null && existingEnabled?.val !== undefined) {
                currentEnabled = Boolean(existingEnabled.val);
            } else {
                currentEnabled = typeof entry.enabled === "boolean"
                    ? entry.enabled
                    : (this.config.enabledDefault ?? true);
                await this.setStateAsync(`channels.${channelId}.enabled`, { val: currentEnabled, ack: true });
            }
            this.enabledMap.set(sourceId, currentEnabled);
            this.enabledDpToSource.set(`${this.namespace}.channels.${channelId}.enabled`, sourceId);
        }

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
        for (const [sourceId, cached] of this.lastState) {
            const channelId = sourceToChannelId(sourceId);
            try {
                await this.setStateAsync(`channels.${channelId}.lastValue`, {
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
        for (const sourceId of this.sourceIndex.keys()) this.pendingBaseline.add(sourceId);
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

        const biCount = this.targetIndex.size;
        this.log.info(
            `dp-coupler: ready – relaying ${this.sourceIndex.size} datapoint(s)` +
            (biCount > 0 ? `, ${biCount} bidirectional` : ``) + `.`
        );
        await this.setStateAsync("info.connection", { val: true, ack: true });
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
        const enabledSource = this.enabledDpToSource.get(id);
        if (enabledSource !== undefined) {
            const prev   = this.enabledMap.get(enabledSource);
            const newVal = Boolean(state.val);
            this.enabledMap.set(enabledSource, newVal);
            // Enable transition (false→true): push the current source value.
            // force = source was never baselined this life (e.g. disabled at start);
            // otherwise compare-then-write corrects any drift accumulated while disabled.
            // prev === false guards against the ack:true confirmation re-triggering this.
            if (newVal && prev === false) {
                const entry  = this.sourceIndex.get(enabledSource);
                const cached = this.lastState.get(enabledSource);
                if (entry && cached && cached.val !== null && cached.val !== undefined) {
                    const force = this.pendingBaseline.delete(enabledSource);
                    await this.baselineWrite(entry, cached.val, cached.q, cached.ack, force);
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

        // Cycle guard: skip states we ourselves just wrote.
        if (this.inFlight.has(id)) {
            this.inFlight.delete(id);
            dpcLog(`[dpc]   inFlight HIT → skip  inFlight=${ifs()}`);
            return;
        }

        // Determine relay direction and destination.
        const forwardEntry = this.sourceIndex.get(id);
        const entry        = forwardEntry ?? this.targetIndex.get(id);
        if (!entry) return;
        const destination  = forwardEntry ? entry.target : entry.source;
        dpcLog(`[dpc]   ${forwardEntry ? "fwd" : "rev"}  →  ${destination}`);

        // Update last known source state and lastValue DP (forward direction only).
        // Done before the enabled check so the cache and DP always reflect the current
        // source value, even when the channel is disabled.
        if (forwardEntry) {
            this.lastState.set(id, state);
            const channelId = sourceToChannelId(id);
            this.setStateAsync(`channels.${channelId}.lastValue`, {
                val: state.val,
                ack: true,
                ts:  state.ts,
                lc:  state.lc,
                q:   state.q,
            }).catch(() => undefined);
        }

        // Enabled check: skip relay when channel is disabled.
        if (this.enabledMap.get(entry.source) === false) {
            dpcLog(`[dpc]   enabled=false → skip`);
            return;
        }

        // Baseline completion: the first event of a still-pending source fulfills its
        // initial baseline (bypassing the forwardOnAck/forwardChangesOnly filters), so a
        // rarely-changing datapoint is synchronized on its first arrival after start.
        if (forwardEntry && this.pendingBaseline.has(id)) {
            this.pendingBaseline.delete(id);
            dpcLog(`[dpc]   baseline completion via first event`);
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
            dpcLog(`[dpc]   forwardOnAck: ack=T  shouldFwd=${shouldForwardOnAck}  → FILTERED`);
            return;
        }

        // forwardChangesOnly filter: default true — skip re-writes of unchanged values.
        // state.lc (last-change) < state.ts (last-set) means value was re-written unchanged.
        const shouldForwardChangesOnly = entry.forwardChangesOnly ?? this.config.forwardChangesOnlyDefault ?? true;
        if (shouldForwardChangesOnly && state.lc !== state.ts) {
            dpcLog(`[dpc]   forwardChangesOnly: lc<ts(+${state.ts - state.lc}ms)  → FILTERED`);
            return;
        }

        this.inFlight.add(destination);
        dpcLog(`[dpc]   RELAY  inFlight=${ifs()}`);
        try {
            const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
            const outVal = this.resolveValue(entry, forwardEntry ? "forward" : "reverse", state.val, destination);
            await this.setForeignStateAsync(destination, {
                val: outVal,
                ack: shouldPropagateAck ? state.ack : false,
                q:   state.q,
            });
            this.log.debug(`dp-coupler: ${id} → ${destination} = ${outVal}`);
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
        for (const [sourceId, entry] of this.sourceIndex) {
            if (this.unloading) break;
            if (this.enabledMap.get(sourceId) === false) continue;
            const cached = this.lastState.get(sourceId);
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
        for (const sourceId of Array.from(this.pendingBaseline)) {
            if (this.unloading) break;
            if (!this.pendingBaseline.has(sourceId)) continue;          // completed concurrently
            if (this.enabledMap.get(sourceId) === false) continue;      // stays pending
            const cached = this.lastState.get(sourceId);
            if (!cached || cached.val === null || cached.val === undefined) continue; // awaits first event
            const entry = this.sourceIndex.get(sourceId);
            if (!entry) { this.pendingBaseline.delete(sourceId); continue; }
            this.pendingBaseline.delete(sourceId);
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
    private parseMappings(raw: unknown, label: string): MappingEntry[] | null {
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
        for (let i = 0; i < parsed.length; i++) {
            if (isMappingEntry(parsed[i])) {
                valid.push(parsed[i] as MappingEntry);
            } else {
                this.log.warn(
                    `dp-coupler: ${label} entry [${i}] is missing "source" or "target" – skipped.`
                );
            }
        }
        return valid;
    }

    /**
     * Loads and validates the mapping configuration from this.config.mappingsRaw
     * (ioBroker DB, edited via admin UI). Accepts both a JSON string and a native array.
     * Returns the validated array on success, or null on any unrecoverable error.
     */
    private loadMappings(): MappingEntry[] | null {
        const valid = this.parseMappings(this.config.mappingsRaw ?? "[]", "mappingsRaw");
        if (valid !== null) {
            this.log.info(`dp-coupler: loaded ${valid.length} valid mapping(s).`);
        }
        return valid;
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
     * Returns the validated entries, or null if the file is absent, empty, or invalid.
     * Does NOT delete the file — that is done by consumeSeedFile() after a successful
     * config write, so a failed write leaves the seed in place for the next start.
     */
    private readSeedMappings(): MappingEntry[] | null {
        const seedPath = this.seedFilePath();
        let content: string;
        try {
            content = fs.readFileSync(seedPath, "utf-8");
        } catch {
            return null; // No seed file present – nothing to do.
        }

        const entries = this.parseMappings(content, `seed file "${seedPath}"`);
        if (entries === null || entries.length === 0) return null;

        this.log.info(`dp-coupler: seeding ${entries.length} mapping(s) from "${seedPath}".`);
        return entries;
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
