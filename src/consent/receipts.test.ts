import { describe, expect, it } from "vitest";
import type { ActionReceipt, ActionReport, ActionSummaryEntry, ReceiptError } from "./receipts.js";
import {
  __testing,
  determineDetailLevel,
  formatReceiptAsText,
  generateReceipt,
} from "./receipts.js";
import type {
  ChangeOrder,
  ConsentAnchor,
  ConsentRecord,
  EAARecord,
  EffectClass,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// determineDetailLevel
// ---------------------------------------------------------------------------

describe("determineDetailLevel", () => {
  it("returns 'report' when a breach was detected", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: true,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["read"],
      }),
    ).toBe("report");
  });

  it("returns 'report' when emergency-act was used", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: true,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["physical"],
      }),
    ).toBe("report");
  });

  it("returns 'report' when EAA was invoked", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: true,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["exec"],
      }),
    ).toBe("report");
  });

  it("returns 'receipt' when a change order was resolved", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: true,
        policyApplied: false,
        effectsExercised: ["read"],
      }),
    ).toBe("receipt");
  });

  it("returns 'receipt' when a policy was applied", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: true,
        effectsExercised: ["read"],
      }),
    ).toBe("receipt");
  });

  it("returns 'receipt' when high-risk effects were exercised", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["read", "irreversible"],
      }),
    ).toBe("receipt");
  });

  it("returns 'confirmation' for routine read/compose operations", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["read", "compose"],
      }),
    ).toBe("confirmation");
  });

  it("returns 'confirmation' when no effects exercised", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: [],
      }),
    ).toBe("confirmation");
  });

  it("returns 'confirmation' for persist effect (persist is not high-risk)", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: false,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: false,
        policyApplied: false,
        effectsExercised: ["persist"],
      }),
    ).toBe("confirmation");
  });

  it("prioritizes report over receipt", () => {
    expect(
      determineDetailLevel({
        eaaInvoked: true,
        breachDetected: false,
        emergencyActUsed: false,
        changeOrderResolved: true,
        policyApplied: true,
        effectsExercised: ["exec"],
      }),
    ).toBe("report");
  });
});

// ---------------------------------------------------------------------------
// generateReceipt
// ---------------------------------------------------------------------------

describe("generateReceipt", () => {
  const baseWO = makeTestWO("wo-1", ["read", "compose"], [{ kind: "implied", poId: "po-1" }]);

  it("generates a confirmation receipt for routine operations", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("read_file", ["read"], true, "Read config.json")],
      consentRecords: [],
      eaaRecords: [],
    });

    expect(receipt.level).toBe("confirmation");
    expect(receipt.poId).toBe("po-1");
    expect(receipt.finalWoId).toBe("wo-1");
    expect(receipt.actionsSummary).toHaveLength(1);
    expect(receipt.effectsExercised).toEqual(["read"]);
    expect(receipt.consentChain).toHaveLength(1);
    expect(receipt.consentChain[0].kind).toBe("implied");
  });

  it("generates a receipt for operations with a change order", () => {
    const co: ChangeOrder = {
      id: "co-1",
      currentWoId: "wo-1",
      requestContextId: "po-1",
      requestedEffects: ["exec"],
      reason: "Need to run build",
      effectDescription: "Execute build command",
      status: "granted",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
      successorWoId: "wo-2",
    };

    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("exec", ["exec"], true, "Ran build")],
      consentRecords: [],
      eaaRecords: [],
      changeOrders: [co],
    });

    expect(receipt.level).toBe("receipt");
    const detailed = receipt as ActionReceipt;
    expect(detailed.changeOrders).toHaveLength(1);
    expect(detailed.changeOrders[0].coId).toBe("co-1");
    expect(detailed.changeOrders[0].status).toBe("granted");
  });

  it("generates a report when EAA was invoked", () => {
    const eaaRecord: EAARecord = {
      id: "eaa-1",
      poId: "po-1",
      woId: "wo-1",
      triggerReason: "duty-collision",
      outcome: "constrained-comply",
      recommendedEffects: ["exec"],
      recommendedConstraints: [],
      createdAt: Date.now(),
    };

    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("exec", ["exec"], true, "Ran command")],
      consentRecords: [],
      eaaRecords: [eaaRecord],
    });

    expect(receipt.level).toBe("report");
    const report = receipt as ActionReport;
    expect(report.eaaAdjudications).toHaveLength(1);
    expect(report.eaaAdjudications[0].outcome).toBe("constrained-comply");
    expect(report.breachDetected).toBe(false);
  });

  it("generates a report with breach information", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [],
      consentRecords: [],
      eaaRecords: [],
      breachDetected: true,
      breachActions: ["Halted tool execution", "Revoked WO grants"],
    });

    expect(receipt.level).toBe("report");
    const report = receipt as ActionReport;
    expect(report.breachDetected).toBe(true);
    expect(report.breachActions).toHaveLength(2);
  });

  it("includes errors in the receipt", () => {
    const errors: ReceiptError[] = [
      { source: "exec", message: "Command failed", isConsentViolation: false },
      { source: "consent", message: "Effect not granted", isConsentViolation: true },
    ];

    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [],
      consentRecords: [],
      eaaRecords: [],
      errors,
    });

    expect(receipt.errors).toHaveLength(2);
    expect(receipt.errors[1].isConsentViolation).toBe(true);
  });

  it("respects overrideLevel", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("read_file", ["read"], true, "Read only")],
      consentRecords: [],
      eaaRecords: [],
      overrideLevel: "report",
    });

    expect(receipt.level).toBe("report");
  });

  it("deduplicates exercised effects", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [
        makeAction("read_file", ["read"], true, "Read 1"),
        makeAction("read_dir", ["read"], true, "Read 2"),
        makeAction("write_file", ["read", "persist"], true, "Write"),
      ],
      consentRecords: [],
      eaaRecords: [],
    });

    expect(receipt.effectsExercised).toEqual(["read", "persist"]);
  });

  it("builds WO chain for report level", () => {
    const wo1 = makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]);
    const wo2 = makeTestWO(
      "wo-2",
      ["read", "exec"],
      [
        { kind: "implied", poId: "po-1" },
        { kind: "explicit", consentRecordId: "cr-1" },
      ],
    );

    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: wo2,
      woChain: [wo1],
      actions: [],
      consentRecords: [],
      eaaRecords: [
        {
          id: "eaa-1",
          poId: "po-1",
          woId: "wo-1",
          triggerReason: "test",
          outcome: "proceed",
          recommendedEffects: [],
          recommendedConstraints: [],
          createdAt: Date.now(),
        },
      ],
    }) as ActionReport;

    expect(receipt.woChain).toHaveLength(2);
    expect(receipt.woChain[0].woId).toBe("wo-1");
    expect(receipt.woChain[1].woId).toBe("wo-2");
  });

  it("uses pre-built eaaAdjudications when provided", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("exec", ["exec"], true, "Ran command")],
      consentRecords: [],
      eaaRecords: [
        {
          id: "eaa-1",
          poId: "po-1",
          woId: "wo-1",
          triggerReason: "duty-collision",
          outcome: "constrained-comply",
          recommendedEffects: ["exec"],
          recommendedConstraints: [],
          createdAt: Date.now(),
        },
      ],
      eaaAdjudications: [
        {
          eaaRecordId: "eaa-1",
          outcome: "constrained-comply",
          triggerCategories: ["duty-collision"],
          severity: 0.85,
          toolName: "bash",
        },
      ],
    }) as ActionReport;

    expect(receipt.level).toBe("report");
    expect(receipt.eaaAdjudications).toHaveLength(1);
    expect(receipt.eaaAdjudications[0].severity).toBe(0.85);
    expect(receipt.eaaAdjudications[0].toolName).toBe("bash");
  });

  it("includes applied policies in receipt", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: baseWO,
      woChain: [],
      actions: [makeAction("read_file", ["read"], true, "Read")],
      consentRecords: [],
      eaaRecords: [],
      appliedPolicies: [
        { policyId: "pol-1", policyClass: "user", effectScope: ["read", "persist"] },
      ],
    });

    expect(receipt.level).toBe("receipt");
    const detailed = receipt as ActionReceipt;
    expect(detailed.policiesApplied).toHaveLength(1);
    expect(detailed.policiesApplied[0].policyId).toBe("pol-1");
  });
});

// ---------------------------------------------------------------------------
// formatReceiptAsText
// ---------------------------------------------------------------------------

describe("formatReceiptAsText", () => {
  it("formats a confirmation receipt", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]),
      woChain: [],
      actions: [makeAction("read_file", ["read"], true, "Read config.json")],
      consentRecords: [],
      eaaRecords: [],
    });

    const text = formatReceiptAsText(receipt);
    expect(text).toContain("Action Confirmation");
    expect(text).toContain("[OK] read_file");
    expect(text).toContain("Effects exercised: read");
    expect(text).toContain("implied:");
    expect(text).toContain("--- End ---");
  });

  it("formats a receipt with change orders", () => {
    const co: ChangeOrder = {
      id: "co-1",
      currentWoId: "wo-1",
      requestContextId: "po-1",
      requestedEffects: ["exec"],
      reason: "test",
      effectDescription: "test",
      status: "granted",
      createdAt: Date.now(),
    };

    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]),
      woChain: [],
      actions: [makeAction("bash", ["exec"], true, "Ran command")],
      consentRecords: [],
      eaaRecords: [],
      changeOrders: [co],
    });

    const text = formatReceiptAsText(receipt);
    expect(text).toContain("Action Receipt");
    expect(text).toContain("Change Orders:");
    expect(text).toContain("co-1: granted");
  });

  it("formats a report with breach", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]),
      woChain: [],
      actions: [],
      consentRecords: [],
      eaaRecords: [],
      breachDetected: true,
      breachActions: ["Stopped execution"],
    });

    const text = formatReceiptAsText(receipt);
    expect(text).toContain("Action Report");
    expect(text).toContain("BREACH DETECTED");
    expect(text).toContain("Stopped execution");
  });

  it("formats errors including consent violations", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]),
      woChain: [],
      actions: [],
      consentRecords: [],
      eaaRecords: [],
      errors: [{ source: "binder", message: "WO tampered", isConsentViolation: true }],
      breachDetected: true,
    });

    const text = formatReceiptAsText(receipt);
    expect(text).toContain("[CONSENT VIOLATION]");
  });

  it("formats failed actions", () => {
    const receipt = generateReceipt({
      poId: "po-1",
      finalWO: makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]),
      woChain: [],
      actions: [makeAction("exec", ["exec"], false, "Command failed with exit code 1")],
      consentRecords: [],
      eaaRecords: [],
    });

    const text = formatReceiptAsText(receipt);
    expect(text).toContain("[FAILED] exec");
  });
});

// ---------------------------------------------------------------------------
// Internal Helpers (testing seam)
// ---------------------------------------------------------------------------

describe("__testing helpers", () => {
  it("deduplicateEffects removes duplicates", () => {
    expect(__testing.deduplicateEffects(["read", "read", "persist", "read"])).toEqual([
      "read",
      "persist",
    ]);
  });

  it("buildConsentChain maps anchors to chain entries", () => {
    const wo = makeTestWO(
      "wo-1",
      ["read", "exec"],
      [
        { kind: "implied", poId: "po-1" },
        { kind: "explicit", consentRecordId: "cr-1" },
        { kind: "eaa", eaaRecordId: "eaa-1" },
        { kind: "policy", policyId: "pol-1" },
      ],
    );
    const records: ConsentRecord[] = [
      {
        id: "cr-1",
        poId: "po-1",
        woId: "wo-1",
        effectClasses: ["exec"],
        decision: "granted",
        timestamp: Date.now(),
      },
    ];

    const chain = __testing.buildConsentChain(wo, records);
    expect(chain).toHaveLength(4);
    expect(chain[0]).toEqual({ kind: "implied", refId: "po-1", coveredEffects: [] });
    expect(chain[1]).toEqual({ kind: "explicit", refId: "cr-1", coveredEffects: ["exec"] });
    expect(chain[2]).toEqual({ kind: "eaa", refId: "eaa-1", coveredEffects: [] });
    expect(chain[3]).toEqual({ kind: "policy", refId: "pol-1", coveredEffects: [] });
  });

  it("buildWOChain includes chain and final WO", () => {
    const wo1 = makeTestWO("wo-1", ["read"], [{ kind: "implied", poId: "po-1" }]);
    const wo2 = makeTestWO("wo-2", ["read", "exec"], [{ kind: "implied", poId: "po-1" }]);

    const chain = __testing.buildWOChain([wo1], wo2);
    expect(chain).toHaveLength(2);
    expect(chain[0].woId).toBe("wo-1");
    expect(chain[1].woId).toBe("wo-2");
  });
});

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeTestWO(id: string, effects: EffectClass[], anchors: ConsentAnchor[]): WorkOrder {
  return {
    id,
    requestContextId: "po-1",
    grantedEffects: effects,
    constraints: [],
    consentAnchors: anchors,
    mintedAt: Date.now(),
    immutable: true,
    token: "test-token",
  };
}

function makeAction(
  action: string,
  effects: EffectClass[],
  success: boolean,
  outcome: string,
): ActionSummaryEntry {
  return { action, effects, success, outcome };
}
