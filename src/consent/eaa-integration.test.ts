import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintInitialWorkOrder, __testing as binderTesting } from "./binder.js";
import type { ConsentRecordStore } from "./consent-store.js";
import {
  handleConsentFailure,
  __testing,
  type HandleConsentFailureParams,
} from "./eaa-integration.js";
import { DEFAULT_DUTY_CONSTRAINTS } from "./eaa-triggers.js";
import type { EAAInferenceFn, EAAEvaluation } from "./eaa.js";
import { __testing as eaaTesting } from "./eaa.js";
import { createInitialConsentScopeState, withConsentScope } from "./scope-chain.js";
import type {
  ConsentRecord,
  EAARecord,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test Infrastructure
// ---------------------------------------------------------------------------

const FIXED_TIME = 1_700_000_000_000;
let idCounter = 0;
let eaaIdCounter = 0;

function setupDeterministicEnv(): void {
  binderTesting.setNow(() => FIXED_TIME);
  binderTesting.setGenerateId(() => `test-id-${++idCounter}`);
  binderTesting.setSigningKey(Buffer.alloc(32, 0xab));
  eaaTesting.setNow(() => FIXED_TIME);
  eaaTesting.setGenerateId(() => `eaa-${++eaaIdCounter}`);
}

function createTestPO(overrides?: Partial<PurchaseOrder>): PurchaseOrder {
  return {
    id: "po-1",
    requestText: "Do some work",
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

function createTestProfile(
  effects: EffectClass[],
  trustTier?: "in-process" | "sandboxed" | "external",
): ToolEffectProfile {
  return { effects, trustTier: trustTier ?? "in-process", description: "test tool" };
}

function makeEvaluation(overrides?: Partial<EAAEvaluation>): EAAEvaluation {
  return {
    standingAssessment: { confidence: 0.8, concerns: [] },
    riskAssessment: {
      likelihood: 0.2,
      severity: "minor",
      mitigatingFactors: ["low exposure"],
      aggravatingFactors: [],
    },
    dutyAnalysis: { applicableDuties: ["duty-safety"], conflicts: [] },
    confidenceGating: { overallConfidence: 0.8, insufficientEvidenceAreas: [] },
    ...overrides,
  };
}

function makeInfer(evaluation?: EAAEvaluation): EAAInferenceFn {
  return async () => evaluation ?? makeEvaluation();
}

function createMockConsentRecordStore(
  precedent?: ConsentRecord,
): ConsentRecordStore & { _insertEAARecord: ReturnType<typeof vi.fn> } {
  const insertEAARecord = vi.fn();
  return {
    insertConsentRecord: vi.fn(),
    getConsentRecord: vi.fn(),
    getConsentRecordsByPO: vi.fn(() => []),
    getConsentRecordsByDecision: vi.fn(() => []),
    getAllConsentRecords: vi.fn(() => []),
    updateConsentDecision: vi.fn(() => false),
    insertEAARecord,
    getEAARecord: vi.fn(),
    getAllEAARecords: vi.fn(() => []),
    findConsentPrecedent: vi.fn(() => precedent),
    findSimilarConsentPrecedent: vi.fn(() => undefined),
    upsertConsentEmbedding: vi.fn(),
    getConsentRecordCount: vi.fn(() => 0),
    getEAARecordCount: vi.fn(() => 0),
    clearAll: vi.fn(),
    close: vi.fn(),
    db: {} as ConsentRecordStore["db"],
    _insertEAARecord: insertEAARecord,
  };
}

function makeBaseParams(
  po: PurchaseOrder,
  wo: WorkOrder,
  overrides?: Partial<HandleConsentFailureParams>,
): HandleConsentFailureParams {
  return {
    toolName: "my-tool",
    toolProfile: createTestProfile(["network"]),
    missingEffects: ["network"],
    po,
    activeWO: wo,
    consentRecords: [],
    eaaRecords: [],
    dutyConstraints: [],
    ...overrides,
  };
}

/** Run an async callback inside a consent scope. */
async function withScope<T>(po: PurchaseOrder, wo: WorkOrder, fn: () => Promise<T>): Promise<T> {
  const state = createInitialConsentScopeState(po, wo);
  return withConsentScope(state, fn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleConsentFailure", () => {
  beforeEach(() => {
    idCounter = 0;
    eaaIdCounter = 0;
    setupDeterministicEnv();
  });

  afterEach(() => {
    binderTesting.restore();
    eaaTesting.restore();
  });

  // -----------------------------------------------------------------------
  // Step 1: Consent precedent reuse
  // -----------------------------------------------------------------------

  describe("consent precedent reuse (Step 1)", () => {
    it("reuses consent precedent when one covers the missing effects", async () => {
      const po = createTestPO();
      const wo = mintTestWO(po);
      const precedent: ConsentRecord = {
        id: "cr-existing",
        poId: po.id,
        woId: wo.id,
        effectClasses: ["network", "read"],
        decision: "granted",
        timestamp: FIXED_TIME - 1000,
      };
      const store = createMockConsentRecordStore(precedent);

      const result = await withScope(po, wo, () =>
        handleConsentFailure(makeBaseParams(po, wo, { consentRecordStore: store })),
      );

      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(result.outcome).toBe("proceed");
        expect(result.successorWO).toBeDefined();
        expect(result.explanation).toContain("Consent precedent reused");
      }
    });

    it("falls through when no precedent exists", async () => {
      const po = createTestPO();
      const wo = mintTestWO(po);
      const store = createMockConsentRecordStore(undefined);

      const result = await handleConsentFailure(
        makeBaseParams(po, wo, { consentRecordStore: store }),
      );

      // No precedent + no EAA triggers (owner, in-process, no duty collisions) → CO
      expect(result.action).toBe("co-requested");
    });
  });

  // -----------------------------------------------------------------------
  // Step 3: Standard CO when EAA not triggered
  // -----------------------------------------------------------------------

  describe("standard CO path (no EAA triggers)", () => {
    it("creates a standard CO when no EAA triggers fire", async () => {
      const po = createTestPO();
      const wo = mintTestWO(po);

      // Use network effect with empty duty constraints → no EAA triggers
      const result = await handleConsentFailure(makeBaseParams(po, wo));

      expect(result.action).toBe("co-requested");
      if (result.action === "co-requested") {
        expect(result.changeOrder.requestedEffects).toEqual(["network"]);
        expect(result.changeOrder.status).toBe("pending");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Step 4: EAA triggered → adjudication
  // -----------------------------------------------------------------------

  describe("EAA triggered path", () => {
    it("refuses when EAA triggered but no infer function provided", async () => {
      const po = createTestPO({ senderIsOwner: false, chatType: "group" });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "disclose"], "external");

      const result = await handleConsentFailure(
        makeBaseParams(po, wo, {
          toolProfile: profile,
          missingEffects: ["persist", "disclose"],
          dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
          infer: undefined,
        }),
      );

      expect(result.action).toBe("refused");
      if (result.action === "refused") {
        expect(result.reason).toContain("no LLM inference");
      }
    });

    it("resolves to proceed when EAA returns proceed", async () => {
      // Non-owner triggers standing-ambiguity (severity 0.5) but in-process +
      // non-high-risk effects keep combined severity < 0.8 so the proceed
      // alternative is generated by selectAlternatives.
      const po = createTestPO({ senderIsOwner: false });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "network"]);
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.9, concerns: [] },
          confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["persist", "network"],
            infer,
          }),
        ),
      );

      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(result.outcome).toBe("proceed");
        expect(result.successorWO).toBeDefined();
        expect(result.adjudication).toBeDefined();
        expect(result.reasoning).toBeDefined();
      }
    });

    it("resolves to request-consent when confidence is below threshold", async () => {
      const po = createTestPO({ senderIsOwner: false });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "network"]);
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.2, concerns: ["unclear authority"] },
          riskAssessment: {
            likelihood: 0.4,
            severity: "moderate",
            mitigatingFactors: [],
            aggravatingFactors: [],
          },
          confidenceGating: { overallConfidence: 0.2, insufficientEvidenceAreas: ["scope"] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["persist", "network"],
            infer,
          }),
        ),
      );

      expect(result.action).toBe("co-requested");
      if (result.action === "co-requested") {
        expect(result.changeOrder.requestedEffects).toEqual(["persist", "network"]);
        expect(result.changeOrder.reason).toContain("EAA analysis recommends explicit consent");
      }
    });

    it("resolves to constrained-comply with moderate confidence and non-critical risk", async () => {
      const po = createTestPO({ senderIsOwner: false });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "network"]);
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.6, concerns: ["moderate uncertainty"] },
          riskAssessment: {
            likelihood: 0.5,
            severity: "moderate",
            mitigatingFactors: [],
            aggravatingFactors: ["persistence"],
          },
          confidenceGating: { overallConfidence: 0.6, insufficientEvidenceAreas: [] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["persist", "network"],
            infer,
          }),
        ),
      );

      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(result.outcome).toBe("constrained-comply");
        expect(result.successorWO).toBeDefined();
        expect(result.adjudication).toBeDefined();
      }
    });

    it("resolves to refuse when EAA returns refuse (inviolable duty collision)", async () => {
      const po = createTestPO({ senderIsOwner: false, chatType: "group" });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["physical", "irreversible"], "external");

      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.3, concerns: ["no authority"] },
          riskAssessment: {
            likelihood: 0.9,
            severity: "critical",
            mitigatingFactors: [],
            aggravatingFactors: ["physical harm risk"],
          },
          confidenceGating: { overallConfidence: 0.3, insufficientEvidenceAreas: ["all"] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["physical", "irreversible"],
            infer,
            dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
          }),
        ),
      );

      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(result.outcome).toBe("refuse");
        expect(result.successorWO).toBeUndefined();
      }
    });

    it("returns refused when EAA analysis itself fails", async () => {
      const po = createTestPO({ senderIsOwner: false, chatType: "group" });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "disclose"], "external");

      const failingInfer: EAAInferenceFn = async () => {
        throw new Error("LLM unavailable");
      };

      const result = await handleConsentFailure(
        makeBaseParams(po, wo, {
          toolProfile: profile,
          missingEffects: ["persist", "disclose"],
          infer: failingInfer,
          dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
        }),
      );

      expect(result.action).toBe("refused");
      if (result.action === "refused") {
        expect(result.reason).toContain("EAA analysis failed");
      }
    });

    it("persists EAA record to store when EAA succeeds", async () => {
      const po = createTestPO({ senderIsOwner: false, chatType: "group" });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["persist", "disclose"], "external");
      const store = createMockConsentRecordStore(undefined);
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.9, concerns: [] },
          confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        }),
      );

      await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["persist", "disclose"],
            consentRecordStore: store,
            infer,
          }),
        ),
      );

      expect(store._insertEAARecord).toHaveBeenCalled();
    });

    it("resolves to emergency-act when EAA returns emergency-act", async () => {
      const po = createTestPO({
        senderIsOwner: false,
        requestText: "EMERGENCY: immediately stop the device",
      });
      const wo = mintTestWO(po);
      const profile = createTestProfile(["physical"], "external");
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.7, concerns: ["emergency context"] },
          riskAssessment: {
            likelihood: 0.8,
            severity: "serious",
            mitigatingFactors: ["time-critical"],
            aggravatingFactors: ["physical action"],
          },
          confidenceGating: { overallConfidence: 0.7, insufficientEvidenceAreas: [] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["physical"],
            infer,
            dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
          }),
        ),
      );

      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(result.outcome).toBe("emergency-act");
        expect(result.successorWO).toBeDefined();
        expect(result.adjudication).toBeDefined();
      }
    });

    it("resolves escalate without minting successor WO", async () => {
      const po = createTestPO({ senderIsOwner: false, chatType: "group" });
      const wo = mintTestWO(po);
      // Use elevated + physical to trigger escalation path
      const profile = createTestProfile(["elevated", "physical"], "external");
      const infer = makeInfer(
        makeEvaluation({
          standingAssessment: { confidence: 0.4, concerns: ["no authority"] },
          riskAssessment: {
            likelihood: 0.7,
            severity: "serious",
            mitigatingFactors: [],
            aggravatingFactors: ["elevated + physical"],
          },
          confidenceGating: { overallConfidence: 0.4, insufficientEvidenceAreas: ["scope"] },
        }),
      );

      const result = await withScope(po, wo, () =>
        handleConsentFailure(
          makeBaseParams(po, wo, {
            toolProfile: profile,
            missingEffects: ["elevated", "physical"],
            infer,
            dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
          }),
        ),
      );

      // escalate or refuse are valid here since duty-safety is inviolable
      expect(result.action).toBe("eaa-resolved");
      if (result.action === "eaa-resolved") {
        expect(["refuse", "escalate"]).toContain(result.outcome);
        expect(result.successorWO).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  describe("createStandardChangeOrder", () => {
    it("creates a CO with correct effect and tool info", () => {
      const po = createTestPO();
      const wo = mintTestWO(po);

      const result = __testing.createStandardChangeOrder({
        activeWO: wo,
        po,
        missingEffects: ["disclose"],
        toolName: "my-tool",
        toolProfile: createTestProfile(["disclose"]),
      });

      expect(result.action).toBe("co-requested");
      if (result.action === "co-requested") {
        expect(result.changeOrder.requestedEffects).toEqual(["disclose"]);
      }
    });

    it("returns refused when CO creation fails (empty effects)", () => {
      const po = createTestPO();
      const wo = mintTestWO(po);

      const result = __testing.createStandardChangeOrder({
        activeWO: wo,
        po,
        missingEffects: [],
        toolName: "my-tool",
        toolProfile: createTestProfile([]),
      });

      expect(result.action).toBe("refused");
    });
  });

  describe("mintSuccessorWithAnchor", () => {
    it("mints a successor WO with an EAA anchor", () => {
      const po = createTestPO({ impliedEffects: ["read", "compose", "persist"] });
      const wo = mintTestWO(po);

      const result = __testing.mintSuccessorWithAnchor({
        currentWO: wo,
        po,
        toolProfile: createTestProfile(["persist"]),
        additionalEffects: ["persist"],
        anchor: { kind: "eaa", eaaRecordId: "eaa-1" },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.wo.consentAnchors).toContainEqual({
          kind: "eaa",
          eaaRecordId: "eaa-1",
        });
      }
    });

    it("mints with constraints", () => {
      const po = createTestPO({ impliedEffects: ["read", "compose", "persist"] });
      const wo = mintTestWO(po);

      const result = __testing.mintSuccessorWithAnchor({
        currentWO: wo,
        po,
        toolProfile: createTestProfile(["persist"]),
        additionalEffects: ["persist"],
        anchor: { kind: "eaa", eaaRecordId: "eaa-1" },
        constraints: [{ kind: "time-bound", expiresAt: FIXED_TIME + 60_000 }],
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("persistEAARecord", () => {
    it("inserts into consent record store when available", () => {
      const store = createMockConsentRecordStore();
      const eaaRecord: EAARecord = {
        id: "eaa-test-1",
        poId: "po-1",
        woId: "wo-1",
        triggerReason: "test trigger",
        outcome: "proceed",
        recommendedEffects: ["persist"],
        recommendedConstraints: [],
        createdAt: FIXED_TIME,
      };

      __testing.persistEAARecord(eaaRecord, store);

      expect(store._insertEAARecord).toHaveBeenCalledWith(eaaRecord);
    });

    it("does not throw when store is undefined", () => {
      const eaaRecord: EAARecord = {
        id: "eaa-test-2",
        poId: "po-1",
        woId: "wo-1",
        triggerReason: "test trigger",
        outcome: "proceed",
        recommendedEffects: [],
        recommendedConstraints: [],
        createdAt: FIXED_TIME,
      };

      expect(() => __testing.persistEAARecord(eaaRecord)).not.toThrow();
    });
  });
});
