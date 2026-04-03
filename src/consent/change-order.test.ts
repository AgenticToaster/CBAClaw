import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintInitialWorkOrder, __testing as binderTesting } from "./binder.js";
import {
  assessRequestAmbiguity,
  expireChangeOrder,
  findPatternsForEffects,
  generateEffectDescription,
  getAllPendingChangeOrders,
  getPendingChangeOrder,
  requestChangeOrder,
  resolveChangeOrder,
  withdrawChangeOrder,
  __testing as coTesting,
} from "./change-order.js";
import type { ConsentPatternStore, PatternSearchResult } from "./implied-consent-store.js";
import {
  createInitialConsentScopeState,
  getActiveWorkOrder,
  getConsentRecords,
  withConsentScope,
} from "./scope-chain.js";
import type { EffectClass, PurchaseOrder, WorkOrder } from "./types.js";

const FIXED_TIME = 1_700_000_000_000;
let idCounter = 0;

function setupDeterministicBinder(): void {
  binderTesting.setNow(() => FIXED_TIME);
  binderTesting.setGenerateId(() => `test-id-${++idCounter}`);
  binderTesting.setSigningKey(Buffer.alloc(32, 0xab));
}

function createTestPO(overrides?: Partial<PurchaseOrder>): PurchaseOrder {
  return {
    id: "po-1",
    requestText: "Write a test file",
    senderId: "user-1",
    senderIsOwner: true,
    impliedEffects: ["read", "compose"],
    timestamp: FIXED_TIME,
    ...overrides,
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

beforeEach(() => {
  setupDeterministicBinder();
});

afterEach(() => {
  binderTesting.restore();
  coTesting.clearPendingOrders();
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// generateEffectDescription
// ---------------------------------------------------------------------------

describe("generateEffectDescription", () => {
  it("generates description for a single effect", () => {
    const desc = generateEffectDescription(["persist"]);
    expect(desc).toContain("write or modify");
    expect(desc).toContain("permission");
  });

  it("generates description for multiple effects", () => {
    const desc = generateEffectDescription(["persist", "exec"]);
    expect(desc).toContain("write or modify");
    expect(desc).toContain("execute commands");
  });

  it("returns 'no additional effects' for empty array", () => {
    const desc = generateEffectDescription([]);
    expect(desc).toContain("No additional effects");
  });

  it("includes pattern examples when provided", () => {
    const examples: PatternSearchResult[] = [
      {
        pattern: {
          id: 1,
          text: "Delete the test files",
          effects: ["irreversible", "persist"],
          source: "seed",
          confidence: 1.0,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        },
        distance: 0.15,
      },
    ];
    const desc = generateEffectDescription(["irreversible"], examples);
    expect(desc).toContain("Delete the test files");
    expect(desc).toContain("Similar to:");
  });

  it("includes ambiguity warning for high-risk effects", () => {
    const desc = generateEffectDescription(["irreversible"], undefined, {
      ambiguous: true,
      bestDistance: 0.8,
      matchCount: 0,
    });
    expect(desc).toContain("unclear");
    expect(desc).toContain("elevated risk");
  });

  it("skips ambiguity warning for low-risk effects", () => {
    const desc = generateEffectDescription(["read"], undefined, {
      ambiguous: true,
      bestDistance: 0.8,
      matchCount: 0,
    });
    expect(desc).not.toContain("unclear");
  });
});

// ---------------------------------------------------------------------------
// findPatternsForEffects (mock store)
// ---------------------------------------------------------------------------

describe("findPatternsForEffects", () => {
  function createMockStore(
    patterns: { text: string; effects: EffectClass[] }[],
  ): ConsentPatternStore {
    const allPatterns = patterns.map((p, i) => ({
      id: i + 1,
      text: p.text,
      effects: p.effects,
      source: "seed" as const,
      confidence: 1.0,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    }));

    return {
      getAllPatterns: () => allPatterns,
    } as unknown as ConsentPatternStore;
  }

  it("returns patterns matching the requested effects", () => {
    const store = createMockStore([
      { text: "Delete files", effects: ["irreversible", "persist"] },
      { text: "Read a file", effects: ["read"] },
      { text: "Drop the database", effects: ["irreversible"] },
    ]);

    const results = findPatternsForEffects(store, ["irreversible"]);
    expect(results.length).toBe(2);
    expect(results[0].pattern.text).toBe("Delete files");
    expect(results[1].pattern.text).toBe("Drop the database");
  });

  it("respects the limit parameter", () => {
    const store = createMockStore([
      { text: "Pattern 1", effects: ["exec"] },
      { text: "Pattern 2", effects: ["exec"] },
      { text: "Pattern 3", effects: ["exec"] },
    ]);

    const results = findPatternsForEffects(store, ["exec"], 2);
    expect(results.length).toBe(2);
  });

  it("returns empty array when no patterns match", () => {
    const store = createMockStore([{ text: "Read a file", effects: ["read"] }]);

    const results = findPatternsForEffects(store, ["physical"]);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requestChangeOrder
// ---------------------------------------------------------------------------

describe("requestChangeOrder", () => {
  it("creates a pending CO with correct fields", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const result = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["persist"],
      toolName: "write",
      reason: "File write required",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const co = result.changeOrder;
    expect(co.id).toBeTruthy();
    expect(co.currentWoId).toBe(wo.id);
    expect(co.requestContextId).toBe(po.id);
    expect(co.requestedEffects).toEqual(["persist"]);
    expect(co.status).toBe("pending");
    expect(co.effectDescription).toContain("write or modify");
    expect(co.reason).toContain('Tool "write"');
  });

  it("rejects when no missing effects", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const result = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: [],
      toolName: "read",
      reason: "No effects needed",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("No missing effects");
  });

  it("stores the CO as pending and retrievable", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const result = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "Command execution needed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const pending = getPendingChangeOrder(result.changeOrder.id);
    expect(pending).toBeDefined();
    expect(pending?.status).toBe("pending");
  });

  it("lists all pending COs", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "reason 1",
    });
    requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["persist"],
      toolName: "write",
      reason: "reason 2",
    });

    expect(getAllPendingChangeOrders().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveChangeOrder
// ---------------------------------------------------------------------------

describe("resolveChangeOrder", () => {
  it("denies a CO and removes it from pending", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "test",
    });
    expect(coResult.ok).toBe(true);
    if (!coResult.ok) {
      return;
    }

    const scopeState = createInitialConsentScopeState(po, wo);
    const resolveResult = withConsentScope(scopeState, () =>
      resolveChangeOrder({
        changeOrderId: coResult.changeOrder.id,
        decision: "denied",
      }),
    );

    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) {
      return;
    }
    expect(resolveResult.changeOrder.status).toBe("denied");
    expect(resolveResult.changeOrder.resolvedAt).toBeDefined();
    expect(resolveResult.successorWO).toBeUndefined();
    expect(getPendingChangeOrder(coResult.changeOrder.id)).toBeUndefined();
  });

  it("grants a CO, mints successor WO, and transitions scope", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["persist"],
      toolName: "write",
      reason: "test",
    });
    expect(coResult.ok).toBe(true);
    if (!coResult.ok) {
      return;
    }

    const scopeState = createInitialConsentScopeState(po, wo);

    const resolveResult = withConsentScope(scopeState, () => {
      const result = resolveChangeOrder({
        changeOrderId: coResult.changeOrder.id,
        decision: "granted",
      });

      // Verify the scope was transitioned
      const activeWO = getActiveWorkOrder();
      if (result.ok && result.successorWO) {
        expect(activeWO?.id).toBe(result.successorWO.id);
      }

      return result;
    });

    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) {
      return;
    }
    expect(resolveResult.changeOrder.status).toBe("granted");
    expect(resolveResult.changeOrder.successorWoId).toBeDefined();
    expect(resolveResult.successorWO).toBeDefined();
    expect(resolveResult.successorWO!.grantedEffects).toContain("persist");
    expect(resolveResult.successorWO!.grantedEffects).toContain("read");
    expect(resolveResult.successorWO!.grantedEffects).toContain("compose");
  });

  it("creates a consent record on grant", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["persist"],
      toolName: "write",
      reason: "test",
    });
    if (!coResult.ok) {
      return;
    }

    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      resolveChangeOrder({
        changeOrderId: coResult.changeOrder.id,
        decision: "granted",
      });

      const records = getConsentRecords();
      expect(records).toBeDefined();
      expect(records!.length).toBeGreaterThanOrEqual(1);
      const grantRecord = records!.find((r) => r.decision === "granted");
      expect(grantRecord).toBeDefined();
      expect(grantRecord!.effectClasses).toContain("persist");
    });
  });

  it("sets consent record expiry when consentExpiresInMs is provided", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["persist"],
      toolName: "write",
      reason: "test",
    });
    if (!coResult.ok) {
      return;
    }

    const scopeState = createInitialConsentScopeState(po, wo);

    withConsentScope(scopeState, () => {
      resolveChangeOrder({
        changeOrderId: coResult.changeOrder.id,
        decision: "granted",
        consentExpiresInMs: 60_000,
      });

      const records = getConsentRecords();
      expect(records).toBeDefined();
      const grantRecord = records!.find((r) => r.decision === "granted");
      expect(grantRecord).toBeDefined();
      expect(grantRecord!.expiresAt).toBeDefined();
      expect(grantRecord!.expiresAt! - grantRecord!.timestamp).toBe(60_000);
    });
  });

  it("rejects resolving a non-existent CO", () => {
    const result = resolveChangeOrder({
      changeOrderId: "nonexistent",
      decision: "granted",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("not found");
  });

  it("rejects resolving an already resolved CO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "test",
    });
    if (!coResult.ok) {
      return;
    }

    const scopeState = createInitialConsentScopeState(po, wo);
    withConsentScope(scopeState, () => {
      resolveChangeOrder({
        changeOrderId: coResult.changeOrder.id,
        decision: "denied",
      });
    });

    // Try to resolve again (should fail because it's been removed)
    const secondResult = resolveChangeOrder({
      changeOrderId: coResult.changeOrder.id,
      decision: "granted",
    });
    expect(secondResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expireChangeOrder / withdrawChangeOrder
// ---------------------------------------------------------------------------

describe("CO lifecycle transitions", () => {
  it("expires a pending CO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "test",
    });
    if (!coResult.ok) {
      return;
    }

    const expired = expireChangeOrder(coResult.changeOrder.id);
    expect(expired).toBe(true);
    expect(getPendingChangeOrder(coResult.changeOrder.id)).toBeUndefined();
    expect(coTesting.pendingOrderCount).toBe(0);
  });

  it("withdraws a pending CO", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);

    const coResult = requestChangeOrder({
      currentWO: wo,
      po,
      missingEffects: ["exec"],
      toolName: "bash",
      reason: "test",
    });
    if (!coResult.ok) {
      return;
    }

    const withdrawn = withdrawChangeOrder(coResult.changeOrder.id);
    expect(withdrawn).toBe(true);
    expect(getPendingChangeOrder(coResult.changeOrder.id)).toBeUndefined();
  });

  it("cannot expire a non-existent CO", () => {
    expect(expireChangeOrder("nonexistent")).toBe(false);
  });

  it("cannot withdraw a non-existent CO", () => {
    expect(withdrawChangeOrder("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assessRequestAmbiguity
// ---------------------------------------------------------------------------

describe("assessRequestAmbiguity", () => {
  function createMockStoreForAmbiguity(searchResults: PatternSearchResult[]): ConsentPatternStore {
    return {
      searchSimilarPatterns: () => searchResults,
    } as unknown as ConsentPatternStore;
  }

  it("returns not ambiguous when close match found", async () => {
    const store = createMockStoreForAmbiguity([
      {
        pattern: {
          id: 1,
          text: "Delete files",
          effects: ["irreversible"],
          source: "seed",
          confidence: 1.0,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        },
        distance: 0.2,
      },
    ]);

    const result = await assessRequestAmbiguity({
      requestText: "Remove the temp files",
      store,
      embedQuery: async () => Array.from({ length: 384 }, () => 0),
    });

    expect(result.ambiguous).toBe(false);
    expect(result.bestDistance).toBe(0.2);
    expect(result.matchCount).toBe(1);
  });

  it("returns ambiguous when no close match found", async () => {
    const store = createMockStoreForAmbiguity([
      {
        pattern: {
          id: 1,
          text: "Far away pattern",
          effects: ["read"],
          source: "seed",
          confidence: 1.0,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        },
        distance: 0.9,
      },
    ]);

    const result = await assessRequestAmbiguity({
      requestText: "Do something vague",
      store,
      embedQuery: async () => Array.from({ length: 384 }, () => 0),
    });

    expect(result.ambiguous).toBe(true);
    expect(result.bestDistance).toBe(0.9);
  });

  it("returns ambiguous when no results at all", async () => {
    const store = createMockStoreForAmbiguity([]);

    const result = await assessRequestAmbiguity({
      requestText: "Unknown request",
      store,
      embedQuery: async () => Array.from({ length: 384 }, () => 0),
    });

    expect(result.ambiguous).toBe(true);
    expect(result.matchCount).toBe(0);
  });

  it("handles embedding failure gracefully", async () => {
    const store = createMockStoreForAmbiguity([]);

    const result = await assessRequestAmbiguity({
      requestText: "anything",
      store,
      embedQuery: async () => {
        throw new Error("Provider unavailable");
      },
    });

    expect(result.ambiguous).toBe(true);
    expect(result.bestDistance).toBe(2.0);
  });

  it("respects custom ambiguity threshold", async () => {
    const store = createMockStoreForAmbiguity([
      {
        pattern: {
          id: 1,
          text: "Match",
          effects: ["read"],
          source: "seed",
          confidence: 1.0,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        },
        distance: 0.5,
      },
    ]);

    const strictResult = await assessRequestAmbiguity({
      requestText: "test",
      store,
      embedQuery: async () => Array.from({ length: 384 }, () => 0),
      ambiguityThreshold: 0.3,
    });
    expect(strictResult.ambiguous).toBe(true);

    const lenientResult = await assessRequestAmbiguity({
      requestText: "test",
      store,
      embedQuery: async () => Array.from({ length: 384 }, () => 0),
      ambiguityThreshold: 0.7,
    });
    expect(lenientResult.ambiguous).toBe(false);
  });
});
