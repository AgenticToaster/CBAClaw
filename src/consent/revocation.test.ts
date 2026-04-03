import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintInitialWorkOrder, __testing as binderTesting } from "./binder.js";
import type { ConsentRecordStore } from "./consent-store.js";
import { resetConsentSession, revokeConsent, withdrawCommitment } from "./revocation.js";
import {
  addConsentRecord,
  createInitialConsentScopeState,
  getActiveWorkOrder,
  getConsentRecords,
  getWorkOrderChain,
  withConsentScope,
} from "./scope-chain.js";
import type { ConsentRecord, EffectClass, PurchaseOrder, WorkOrder } from "./types.js";

const FIXED_TIME = 1_700_000_000_000;
let idCounter = 0;

function setupDeterministicBinder(): void {
  binderTesting.setNow(() => FIXED_TIME);
  binderTesting.setGenerateId(() => `test-id-${++idCounter}`);
  binderTesting.setSigningKey(Buffer.alloc(32, 0xab));
}

function createTestPO(
  impliedEffects: EffectClass[] = ["read", "compose", "persist", "exec"],
): PurchaseOrder {
  return {
    id: "po-1",
    requestText: "Do some work",
    senderId: "user-1",
    senderIsOwner: true,
    impliedEffects,
    timestamp: FIXED_TIME,
  };
}

function mintTestWO(po: PurchaseOrder): WorkOrder {
  const result = mintInitialWorkOrder({
    po,
    policies: [],
    systemProhibitions: [],
  });
  if (!result.ok) {
    throw new Error(`Failed to mint test WO: ${result.reason}`);
  }
  return result.wo;
}

function createTestConsentRecord(overrides?: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: `cr-${++idCounter}`,
    poId: "po-1",
    woId: "wo-1",
    effectClasses: ["persist"],
    decision: "granted",
    timestamp: FIXED_TIME,
    ...overrides,
  };
}

beforeEach(() => {
  setupDeterministicBinder();
});

afterEach(() => {
  binderTesting.restore();
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// revokeConsent
// ---------------------------------------------------------------------------

describe("revokeConsent", () => {
  it("revokes all effects and transitions to restricted WO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(scopeState, () => {
      return revokeConsent({ scope: "all" });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.restrictedWO).toBeDefined();
    // The restricted WO should only have "read" (since all were prohibited,
    // the new PO has ["read"] and systemProhibitions includes all original effects)
    expect(result.restrictedWO.grantedEffects).toContain("read");
    expect(result.restrictedWO.grantedEffects).not.toContain("persist");
    expect(result.restrictedWO.grantedEffects).not.toContain("exec");
  });

  it("creates a revocation consent record", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      revokeConsent({ scope: "all", reason: "User cancelled" });

      const records = getConsentRecords();
      expect(records).toBeDefined();
      const revocationRecord = records!.find(
        (r) => r.decision === "revoked" && r.metadata?.source === "user-revocation",
      );
      expect(revocationRecord).toBeDefined();
      expect(revocationRecord!.metadata?.reason).toBe("User cancelled");
    });
  });

  it("revokes specific effects only", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(scopeState, () => {
      return revokeConsent({ scope: "effects", effects: ["exec"] });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.restrictedWO.grantedEffects).toContain("read");
    expect(result.restrictedWO.grantedEffects).not.toContain("exec");
  });

  it("marks existing granted records as revoked", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      // Add some granted records first
      addConsentRecord(
        createTestConsentRecord({
          effectClasses: ["persist"],
          decision: "granted",
        }),
      );
      addConsentRecord(
        createTestConsentRecord({
          effectClasses: ["exec"],
          decision: "granted",
        }),
      );

      const result = revokeConsent({ scope: "all" });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.revokedRecordCount).toBe(2);
    });
  });

  it("transitions the scope to the restricted WO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      const result = revokeConsent({ scope: "all" });
      if (!result.ok) {
        return;
      }

      const activeWO = getActiveWorkOrder();
      expect(activeWO?.id).toBe(result.restrictedWO.id);

      const chain = getWorkOrderChain();
      expect(chain).toBeDefined();
      expect(chain!.length).toBe(1); // original WO is now in the chain
      expect(chain![0].id).toBe(wo.id);
    });
  });

  it("fails gracefully when no scope is active", () => {
    const result = revokeConsent({ scope: "all" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("No active consent scope");
  });

  it("fails when targeted revocation has no effects specified", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(scopeState, () => {
      return revokeConsent({ scope: "effects" });
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("No effects specified");
  });

  it("writes to persistent store when provided", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const insertedRecords: ConsentRecord[] = [];
    const updatedDecisions: Array<{ id: string; decision: string }> = [];
    const mockStore = {
      insertConsentRecord: (r: ConsentRecord) => insertedRecords.push(r),
      updateConsentDecision: (id: string, decision: string) => {
        updatedDecisions.push({ id, decision });
        return true;
      },
    } as unknown as ConsentRecordStore;

    withConsentScope(scopeState, () => {
      addConsentRecord(
        createTestConsentRecord({
          effectClasses: ["persist"],
          decision: "granted",
        }),
      );

      const result = revokeConsent({
        scope: "all",
        persistentStore: mockStore,
      });

      expect(result.ok).toBe(true);
      // The revocation audit record should be persisted
      expect(insertedRecords.length).toBe(1);
      expect(insertedRecords[0].decision).toBe("revoked");
      expect(insertedRecords[0].metadata?.source).toBe("user-revocation");
      // The existing granted record should be updated to revoked
      expect(updatedDecisions.length).toBeGreaterThanOrEqual(1);
      expect(updatedDecisions[0].decision).toBe("revoked");
    });
  });
});

// ---------------------------------------------------------------------------
// withdrawCommitment
// ---------------------------------------------------------------------------

describe("withdrawCommitment", () => {
  it("withdraws from all effects", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(scopeState, () => {
      return withdrawCommitment({
        withdrawalReason: "safety-concern",
        explanation: "Detected potential data loss risk.",
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.explanation).toContain("safety");
    expect(result.explanation).toContain("data loss risk");
    expect(result.restrictedWO).toBeDefined();
  });

  it("withdraws from specific effects only", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const result = withConsentScope(scopeState, () => {
      return withdrawCommitment({
        withdrawalReason: "duty-conflict",
        explanation: "Cannot delete while preservation duty active.",
        affectedEffects: ["irreversible", "persist"],
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.restrictedWO.grantedEffects).toContain("read");
    expect(result.restrictedWO.grantedEffects).not.toContain("persist");
  });

  it("records the withdrawal in consent records", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      withdrawCommitment({
        withdrawalReason: "constraint-change",
        explanation: "Constraints changed.",
      });

      const records = getConsentRecords();
      expect(records).toBeDefined();
      const withdrawalRecord = records!.find((r) => r.metadata?.source === "agent-withdrawal");
      expect(withdrawalRecord).toBeDefined();
      expect(withdrawalRecord!.metadata?.withdrawalReason).toBe("constraint-change");
    });
  });

  it("transitions scope to restricted WO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      const result = withdrawCommitment({
        withdrawalReason: "capability-insufficient",
        explanation: "Cannot access external API.",
        affectedEffects: ["network"],
      });
      if (!result.ok) {
        return;
      }

      const activeWO = getActiveWorkOrder();
      expect(activeWO?.id).toBe(result.restrictedWO.id);
    });
  });

  it("writes withdrawal record to persistent store when provided", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    const insertedRecords: ConsentRecord[] = [];
    const mockStore = {
      insertConsentRecord: (r: ConsentRecord) => insertedRecords.push(r),
    } as unknown as ConsentRecordStore;

    const result = withConsentScope(scopeState, () => {
      return withdrawCommitment({
        withdrawalReason: "safety-concern",
        explanation: "Risk detected.",
        persistentStore: mockStore,
      });
    });

    expect(result.ok).toBe(true);
    expect(insertedRecords.length).toBe(1);
    expect(insertedRecords[0].metadata?.source).toBe("agent-withdrawal");
    expect(insertedRecords[0].metadata?.withdrawalReason).toBe("safety-concern");
  });

  it("fails gracefully when no scope is active", () => {
    const result = withdrawCommitment({
      withdrawalReason: "other",
      explanation: "Test withdrawal.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("No active consent scope");
  });

  it("includes structured explanation for each reason", () => {
    const po = createTestPO();

    const reasons = [
      "constraint-change",
      "duty-conflict",
      "capability-insufficient",
      "safety-concern",
      "other",
    ] as const;

    for (const reason of reasons) {
      withConsentScope(createInitialConsentScopeState(po, mintTestWO(po)), () => {
        const result = withdrawCommitment({
          withdrawalReason: reason,
          explanation: "Detail.",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.explanation.length).toBeGreaterThan(10);
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// resetConsentSession
// ---------------------------------------------------------------------------

describe("resetConsentSession", () => {
  it("clears all in-memory consent records", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      addConsentRecord(createTestConsentRecord());
      addConsentRecord(createTestConsentRecord());

      const result = resetConsentSession();

      expect(result.clearedRecords).toBe(2);
      expect(result.clearedEAARecords).toBe(0);
      expect(getConsentRecords()!.length).toBe(0);
    });
  });

  it("returns zeros when no scope is active", () => {
    const result = resetConsentSession();
    expect(result.clearedRecords).toBe(0);
    expect(result.clearedEAARecords).toBe(0);
  });

  it("clears persistent store when provided", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    let clearCalled = false;
    const mockStore = {
      clearAll: () => {
        clearCalled = true;
      },
    } as unknown as ConsentRecordStore;

    withConsentScope(scopeState, () => {
      addConsentRecord(createTestConsentRecord());
      resetConsentSession(mockStore);

      expect(clearCalled).toBe(true);
      expect(getConsentRecords()!.length).toBe(0);
    });
  });

  it("preserves the active WO (it expires via TTL)", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      resetConsentSession();

      const activeWO = getActiveWorkOrder();
      expect(activeWO).toBeDefined();
      expect(activeWO!.id).toBe(wo.id);
    });
  });
});
