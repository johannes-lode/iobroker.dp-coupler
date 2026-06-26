declare global {
    namespace ioBroker {
        interface AdapterConfig {
            mappingsRaw: string | unknown[];
            forwardOnAckDefault: boolean;
            forwardChangesOnlyDefault: boolean;
            propagateAckDefault: boolean;
            syncIntervalValue: number;
            syncUnit: string;
            relayOnChange: boolean;
            enabledDefault: boolean;
            configVersion?: number;
        }
    }
}
export {};
//# sourceMappingURL=main.d.ts.map