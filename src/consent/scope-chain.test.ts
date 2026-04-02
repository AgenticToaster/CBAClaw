import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./binder.js";
import {
  addConsentRecord,
  addEAARecord,
  createInitialConsentScopeState,
  getActiveWorkOrder,
  getActivePurchaseOrder,
  getConsentRecords,
  getConsentScope,
  getEAARecords,
  getWorkOrderChain,
  requireConsentScope,
  transitionWorkOrder,
  withConsentScope,
} from "./scope-chain.js";
import type { ConsentRecord, EAARecord, PurchaseOrder, WorkOrder } from "./types.js";

function makePO(): PurchaseOrder {
  return {
    id: "po-test",
    requestText: "Test request",
    senderId: "user-1",
    senderIsOwner: true,
    impliedEffects: ["read", "compose"],
    timestamp: Date.now(),
  };
}

/**
 * Create a sealed WorkOrder. Uses the binder's sealWorkOrder so
 * integrity checks in transitionWorkOrder pass.
 */
function makeWO(id = "wo-test"): WorkOrder {
  return __testing.sealWorkOrder({
    id,
    requestContextId: "po-test",
    grantedEffects: ["read", "compose"],
    constraints: [],
    consentAnchors: [{ kind: "implied", poId: "po-test" }],
    mintedAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    immutable: true,
    token: "",
  });
}

describe("scope-chain", () => {
  afterEach(() => {
    __testing.restore();
  });

  describe("withConsentScope / getConsentScope", () => {
    it("provides scope state inside the run callback", () => {
      const po = makePO();
      const wo = makeWO();
      const state = createInitialConsentScopeState(po, wo);

      withConsentScope(state, () => {
        const scope = getConsentScope();
        expect(scope).toBeDefined();
        expect(scope!.po).toBe(po);
        expect(scope!.activeWO).toBe(wo);
        expect(scope!.woChain).toEqual([]);
        expect(scope!.consentRecords).toEqual([]);
        expect(scope!.eaaRecords).toEqual([]);
      });
    });

    it("returns undefined outside a scope", () => {
      expect(getConsentScope()).toBeUndefined();
    });

    it("scopes are isolated between nested runs", () => {
      const state1 = createInitialConsentScopeState(makePO(), makeWO("wo-outer"));
      const state2 = createInitialConsentScopeState(
        { ...makePO(), id: "po-inner" },
        makeWO("wo-inner"),
      );

      withConsentScope(state1, () => {
        expect(getActiveWorkOrder()!.id).toBe("wo-outer");

        withConsentScope(state2, () => {
          expect(getActiveWorkOrder()!.id).toBe("wo-inner");
        });

        // Outer scope restored
        expect(getActiveWorkOrder()!.id).toBe("wo-outer");
      });
    });
  });

  describe("requireConsentScope", () => {
    it("throws when no scope is active", () => {
      expect(() => requireConsentScope()).toThrow("Consent scope not available");
    });

    it("returns state when scope is active", () => {
      const state = createInitialConsentScopeState(makePO(), makeWO());
      withConsentScope(state, () => {
        const scope = requireConsentScope();
        expect(scope.po.id).toBe("po-test");
      });
    });
  });

  describe("transitionWorkOrder", () => {
    it("replaces activeWO and appends predecessor to chain", () => {
      const wo1 = makeWO("wo-1");
      const wo2 = makeWO("wo-2");
      const state = createInitialConsentScopeState(makePO(), wo1);

      withConsentScope(state, () => {
        transitionWorkOrder(wo2);

        const scope = requireConsentScope();
        expect(scope.activeWO).toBe(wo2);
        expect(scope.woChain).toHaveLength(1);
        expect(scope.woChain[0]).toBe(wo1);
      });
    });

    it("builds a chain of predecessors across multiple transitions", () => {
      const wo1 = makeWO("wo-1");
      const wo2 = makeWO("wo-2");
      const wo3 = makeWO("wo-3");
      const state = createInitialConsentScopeState(makePO(), wo1);

      withConsentScope(state, () => {
        transitionWorkOrder(wo2);
        transitionWorkOrder(wo3);

        const scope = requireConsentScope();
        expect(scope.activeWO).toBe(wo3);
        expect(scope.woChain).toHaveLength(2);
        expect(scope.woChain[0]).toBe(wo1);
        expect(scope.woChain[1]).toBe(wo2);
      });
    });

    it("throws outside a scope", () => {
      expect(() => transitionWorkOrder(makeWO())).toThrow("Consent scope not available");
    });
  });

  describe("addConsentRecord", () => {
    it("appends records to the scope", () => {
      const state = createInitialConsentScopeState(makePO(), makeWO());
      const record: ConsentRecord = {
        id: "cr-1",
        poId: "po-test",
        woId: "wo-test",
        effectClasses: ["disclose"],
        decision: "granted",
        timestamp: Date.now(),
      };

      withConsentScope(state, () => {
        addConsentRecord(record);
        const records = getConsentRecords();
        expect(records).toHaveLength(1);
        expect(records![0]).toBe(record);
      });
    });
  });

  describe("addEAARecord", () => {
    it("appends EAA records to the scope", () => {
      const state = createInitialConsentScopeState(makePO(), makeWO());
      const record: EAARecord = {
        id: "eaa-1",
        poId: "po-test",
        woId: "wo-test",
        triggerReason: "test",
        outcome: "proceed",
        recommendedEffects: ["read"],
        recommendedConstraints: [],
        createdAt: Date.now(),
      };

      withConsentScope(state, () => {
        addEAARecord(record);
        const records = getEAARecords();
        expect(records).toHaveLength(1);
        expect(records![0]).toBe(record);
      });
    });
  });

  describe("query helpers", () => {
    it("getActiveWorkOrder returns undefined outside scope", () => {
      expect(getActiveWorkOrder()).toBeUndefined();
    });

    it("getActivePurchaseOrder returns PO inside scope", () => {
      const po = makePO();
      const state = createInitialConsentScopeState(po, makeWO());
      withConsentScope(state, () => {
        expect(getActivePurchaseOrder()).toBe(po);
      });
    });

    it("getWorkOrderChain returns chain inside scope", () => {
      const state = createInitialConsentScopeState(makePO(), makeWO());
      withConsentScope(state, () => {
        expect(getWorkOrderChain()).toEqual([]);
      });
    });

    it("getConsentRecords returns undefined outside scope", () => {
      expect(getConsentRecords()).toBeUndefined();
    });

    it("getEAARecords returns undefined outside scope", () => {
      expect(getEAARecords()).toBeUndefined();
    });
  });

  describe("createInitialConsentScopeState", () => {
    it("creates scope state with empty collections", () => {
      const po = makePO();
      const wo = makeWO();
      const state = createInitialConsentScopeState(po, wo);

      expect(state.po).toBe(po);
      expect(state.activeWO).toBe(wo);
      expect(state.woChain).toEqual([]);
      expect(state.consentRecords).toEqual([]);
      expect(state.eaaRecords).toEqual([]);
    });
  });

  describe("async continuity", () => {
    it("preserves scope across async boundaries", async () => {
      const po = makePO();
      const wo = makeWO();
      const state = createInitialConsentScopeState(po, wo);

      await withConsentScope(state, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const scope = getConsentScope();
        expect(scope).toBeDefined();
        expect(scope!.activeWO.id).toBe("wo-test");
      });
    });

    it("preserves scope across Promise.all", async () => {
      const state = createInitialConsentScopeState(makePO(), makeWO());

      await withConsentScope(state, async () => {
        const results = await Promise.all([
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(getActiveWorkOrder()!.id), 5);
          }),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(getActivePurchaseOrder()!.id), 5);
          }),
        ]);

        expect(results[0]).toBe("wo-test");
        expect(results[1]).toBe("po-test");
      });
    });
  });

  describe("transitionWorkOrder integrity checks", () => {
    it("rejects transition with tampered outgoing WO", () => {
      const wo1 = makeWO("wo-1");
      const wo2 = makeWO("wo-2");
      const state = createInitialConsentScopeState(makePO(), wo1);

      withConsentScope(state, () => {
        // Tamper with the active WO: keep the original token but change the effects
        const scope = requireConsentScope();
        scope.activeWO = {
          ...wo1,
          grantedEffects: ["read", "compose", "exec", "physical"],
          token: wo1.token,
        };

        expect(() => transitionWorkOrder(wo2)).toThrow("outgoing WO integrity check failed");
      });
    });

    it("rejects transition with unsealed incoming WO", () => {
      const wo1 = makeWO("wo-1");
      const state = createInitialConsentScopeState(makePO(), wo1);

      const forgery: WorkOrder = {
        id: "wo-forgery",
        requestContextId: "po-test",
        grantedEffects: ["read", "exec", "physical"],
        constraints: [],
        consentAnchors: [{ kind: "implied", poId: "po-test" }],
        mintedAt: Date.now(),
        immutable: true,
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IndvK2p3dCJ9.eyJmYWtlIjp0cnVlfQ.invalid",
      };

      withConsentScope(state, () => {
        expect(() => transitionWorkOrder(forgery)).toThrow(
          "incoming successor WO integrity check failed",
        );
      });
    });

    it("accepts transition with properly sealed WOs", () => {
      const wo1 = makeWO("wo-1");
      const wo2 = makeWO("wo-2");
      const state = createInitialConsentScopeState(makePO(), wo1);

      withConsentScope(state, () => {
        transitionWorkOrder(wo2);
        const scope = requireConsentScope();
        expect(scope.activeWO.id).toBe("wo-2");
        expect(scope.woChain).toHaveLength(1);
      });
    });
  });
});
