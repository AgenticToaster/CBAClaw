import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openConsentRecordStore, type ConsentRecordStore } from "./consent-store.js";
import type { ConsentRecord, EAARecord } from "./types.js";

let store: ConsentRecordStore;

function createTestConsentRecord(overrides?: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    poId: "po-1",
    woId: "wo-1",
    effectClasses: ["read", "compose"],
    decision: "granted",
    timestamp: Date.now(),
    ...overrides,
  };
}

function createTestEAARecord(overrides?: Partial<EAARecord>): EAARecord {
  return {
    id: `eaa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    poId: "po-1",
    woId: "wo-1",
    triggerReason: "Standing ambiguous",
    outcome: "proceed",
    recommendedEffects: ["read"],
    recommendedConstraints: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  const db = new DatabaseSync(":memory:");
  store = await openConsentRecordStore({
    dbPath: ":memory:",
    injectedDb: db,
    skipVecExtension: true,
  });
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Consent Record CRUD
// ---------------------------------------------------------------------------

describe("consent record operations", () => {
  it("inserts and retrieves a consent record", () => {
    const record = createTestConsentRecord({ id: "cr-1" });
    store.insertConsentRecord(record);

    const retrieved = store.getConsentRecord("cr-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("cr-1");
    expect(retrieved!.poId).toBe("po-1");
    expect(retrieved!.effectClasses).toEqual(["read", "compose"]);
    expect(retrieved!.decision).toBe("granted");
  });

  it("returns undefined for non-existent record", () => {
    expect(store.getConsentRecord("nonexistent")).toBeUndefined();
  });

  it("retrieves records by PO ID", () => {
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1", poId: "po-1" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-2", poId: "po-1" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-3", poId: "po-2" }));

    const records = store.getConsentRecordsByPO("po-1");
    expect(records.length).toBe(2);
    expect(records.every((r) => r.poId === "po-1")).toBe(true);
  });

  it("retrieves records by decision", () => {
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1", decision: "granted" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-2", decision: "denied" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-3", decision: "granted" }));

    const granted = store.getConsentRecordsByDecision("granted");
    expect(granted.length).toBe(2);

    const denied = store.getConsentRecordsByDecision("denied");
    expect(denied.length).toBe(1);
  });

  it("retrieves all consent records", () => {
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-2" }));

    const all = store.getAllConsentRecords();
    expect(all.length).toBe(2);
  });

  it("updates consent decision", () => {
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1", decision: "granted" }));

    const updated = store.updateConsentDecision("cr-1", "revoked");
    expect(updated).toBe(true);

    const record = store.getConsentRecord("cr-1");
    expect(record!.decision).toBe("revoked");
  });

  it("returns false when updating non-existent record", () => {
    const updated = store.updateConsentDecision("nonexistent", "revoked");
    expect(updated).toBe(false);
  });

  it("preserves metadata through round-trip", () => {
    const record = createTestConsentRecord({
      id: "cr-meta",
      metadata: { changeOrderId: "co-1", source: "change-order" },
    });
    store.insertConsentRecord(record);

    const retrieved = store.getConsentRecord("cr-meta");
    expect(retrieved!.metadata).toEqual({ changeOrderId: "co-1", source: "change-order" });
  });

  it("handles null metadata", () => {
    const record = createTestConsentRecord({ id: "cr-nometa" });
    delete record.metadata;
    store.insertConsentRecord(record);

    const retrieved = store.getConsentRecord("cr-nometa");
    expect(retrieved!.metadata).toBeUndefined();
  });

  it("preserves expiresAt through round-trip", () => {
    const expiresAt = Date.now() + 3600_000;
    const record = createTestConsentRecord({ id: "cr-expiry", expiresAt });
    store.insertConsentRecord(record);

    const retrieved = store.getConsentRecord("cr-expiry");
    expect(retrieved!.expiresAt).toBe(expiresAt);
  });

  it("counts consent records", () => {
    expect(store.getConsentRecordCount()).toBe(0);

    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-2" }));

    expect(store.getConsentRecordCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// EAA Record CRUD
// ---------------------------------------------------------------------------

describe("EAA record operations", () => {
  it("inserts and retrieves an EAA record", () => {
    const record = createTestEAARecord({ id: "eaa-1" });
    store.insertEAARecord(record);

    const retrieved = store.getEAARecord("eaa-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("eaa-1");
    expect(retrieved!.outcome).toBe("proceed");
    expect(retrieved!.triggerReason).toBe("Standing ambiguous");
    expect(retrieved!.recommendedEffects).toEqual(["read"]);
  });

  it("returns undefined for non-existent EAA record", () => {
    expect(store.getEAARecord("nonexistent")).toBeUndefined();
  });

  it("retrieves all EAA records", () => {
    store.insertEAARecord(createTestEAARecord({ id: "eaa-1" }));
    store.insertEAARecord(createTestEAARecord({ id: "eaa-2" }));

    const all = store.getAllEAARecords();
    expect(all.length).toBe(2);
  });

  it("preserves reasoning field", () => {
    store.insertEAARecord(
      createTestEAARecord({ id: "eaa-reason", reasoning: "Risk assessment complete" }),
    );

    const retrieved = store.getEAARecord("eaa-reason");
    expect(retrieved!.reasoning).toBe("Risk assessment complete");
  });

  it("handles null reasoning", () => {
    store.insertEAARecord(createTestEAARecord({ id: "eaa-noreason" }));

    const retrieved = store.getEAARecord("eaa-noreason");
    expect(retrieved!.reasoning).toBeUndefined();
  });

  it("counts EAA records", () => {
    expect(store.getEAARecordCount()).toBe(0);

    store.insertEAARecord(createTestEAARecord({ id: "eaa-1" }));

    expect(store.getEAARecordCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Consent Precedent (exact match)
// ---------------------------------------------------------------------------

describe("findConsentPrecedent", () => {
  it("finds a matching granted precedent", () => {
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-1",
        effectClasses: ["persist", "read"],
        decision: "granted",
      }),
    );

    const precedent = store.findConsentPrecedent({
      effects: ["persist"],
    });

    expect(precedent).toBeDefined();
    expect(precedent!.id).toBe("cr-1");
  });

  it("requires all requested effects to be covered", () => {
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-1",
        effectClasses: ["persist"],
        decision: "granted",
      }),
    );

    const precedent = store.findConsentPrecedent({
      effects: ["persist", "exec"],
    });

    expect(precedent).toBeUndefined();
  });

  it("skips denied records", () => {
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-denied",
        effectClasses: ["persist", "exec"],
        decision: "denied",
      }),
    );

    const precedent = store.findConsentPrecedent({
      effects: ["persist"],
    });

    expect(precedent).toBeUndefined();
  });

  it("skips expired records", () => {
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-expired",
        effectClasses: ["persist", "exec"],
        decision: "granted",
        expiresAt: Date.now() - 1000,
      }),
    );

    const precedent = store.findConsentPrecedent({
      effects: ["persist"],
    });

    expect(precedent).toBeUndefined();
  });

  it("returns undefined when no records exist", () => {
    const precedent = store.findConsentPrecedent({
      effects: ["persist"],
    });

    expect(precedent).toBeUndefined();
  });

  it("returns the most recent matching record", () => {
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-old",
        effectClasses: ["persist", "read"],
        decision: "granted",
        timestamp: Date.now() - 10000,
      }),
    );
    store.insertConsentRecord(
      createTestConsentRecord({
        id: "cr-new",
        effectClasses: ["persist", "read", "compose"],
        decision: "granted",
        timestamp: Date.now(),
      }),
    );

    const precedent = store.findConsentPrecedent({
      effects: ["persist"],
    });

    // Should return the first match (ordered by timestamp DESC)
    expect(precedent).toBeDefined();
    expect(precedent!.id).toBe("cr-new");
  });
});

// ---------------------------------------------------------------------------
// findSimilarConsentPrecedent (without vec0)
// ---------------------------------------------------------------------------

describe("findSimilarConsentPrecedent (no vec0)", () => {
  it("returns undefined when vec0 is not available", () => {
    const precedent = store.findSimilarConsentPrecedent({
      embedding: new Float32Array(384),
      effects: ["persist"],
    });

    expect(precedent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  it("clears all consent and EAA records", () => {
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-1" }));
    store.insertConsentRecord(createTestConsentRecord({ id: "cr-2" }));
    store.insertEAARecord(createTestEAARecord({ id: "eaa-1" }));

    expect(store.getConsentRecordCount()).toBe(2);
    expect(store.getEAARecordCount()).toBe(1);

    store.clearAll();

    expect(store.getConsentRecordCount()).toBe(0);
    expect(store.getEAARecordCount()).toBe(0);
  });
});
