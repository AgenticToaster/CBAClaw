import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintInitialWorkOrder, __testing as binderTesting } from "./binder.js";
import {
  DEFAULT_DUTY_CONSTRAINTS,
  type DutyConstraint,
  type EAATriggerResult,
} from "./eaa-triggers.js";
import {
  runElevatedActionAnalysis,
  __testing,
  type ActionAlternative,
  type EAAEvaluation,
  type EAAInferenceFn,
  type EAAReasoningRecord,
  type EAARunParams,
  type RiskSeverity,
} from "./eaa.js";
import type {
  ConsentRecord,
  EAAOutcome,
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
  __testing.setNow(() => FIXED_TIME);
  __testing.setGenerateId(() => `eaa-${++eaaIdCounter}`);
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

function makeTriggerResult(
  categories: EAATriggerResult["categories"] = ["standing-ambiguity"],
  severity = 0.5,
): EAATriggerResult {
  return {
    triggered: categories.length > 0,
    categories,
    severity,
    summary: categories.length > 0 ? categories.join(", ") : "No EAA triggers detected",
  };
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

function makeInfer(evaluation?: Partial<EAAEvaluation>): EAAInferenceFn {
  return async () => makeEvaluation(evaluation);
}

function makeFailingInfer(errorMsg: string): EAAInferenceFn {
  return async () => {
    throw new Error(errorMsg);
  };
}

function makeParams(overrides?: Partial<EAARunParams>): EAARunParams {
  const po = overrides?.po ?? createTestPO();
  const wo = overrides?.activeWO ?? mintTestWO(po);
  const { po: _po, activeWO: _wo, ...rest } = overrides ?? {};
  return {
    po,
    activeWO: wo,
    toolName: "test-tool",
    toolProfile: createTestProfile(["read"]),
    triggerResult: makeTriggerResult(),
    consentRecords: [],
    eaaRecords: [],
    dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
    infer: makeInfer(),
    ...rest,
  };
}

beforeEach(() => {
  setupDeterministicEnv();
});

afterEach(() => {
  binderTesting.restore();
  __testing.restore();
  idCounter = 0;
  eaaIdCounter = 0;
});

// ---------------------------------------------------------------------------
// Step 1: classifyAction
// ---------------------------------------------------------------------------

describe("Step 1: classifyAction", () => {
  it("classifies a read-only tool as routine with only requestor affected", () => {
    const po = createTestPO();
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["read"]),
      po,
      triggerResult: makeTriggerResult([], 0),
    });

    expect(result.actionCategory).toBe("routine");
    expect(result.primaryEffects).toEqual(["read"]);
    expect(result.affectedParties).toHaveLength(1);
    expect(result.affectedParties[0].role).toBe("requestor");
  });

  it("classifies disclose effects as sensitive with third-party affected", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["disclose"]),
      po: createTestPO(),
      triggerResult: makeTriggerResult(["duty-collision"], 0.5),
    });

    expect(result.actionCategory).toBe("sensitive");
    expect(result.affectedParties.some((p) => p.role === "named-third-party")).toBe(true);
  });

  it("classifies audience-expand as including bystanders", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["audience-expand", "disclose"]),
      po: createTestPO(),
      triggerResult: makeTriggerResult(["duty-collision"], 0.7),
    });

    expect(result.affectedParties.some((p) => p.role === "bystander")).toBe(true);
  });

  it("classifies exec+physical as high-risk with unknown affected parties", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["exec", "physical"]),
      po: createTestPO(),
      triggerResult: makeTriggerResult(["duty-collision"], 0.8),
    });

    expect(result.actionCategory).toBe("high-risk");
    expect(result.affectedParties.some((p) => p.role === "unknown")).toBe(true);
  });

  it("classifies emergency-time-pressure trigger as emergency", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["physical"]),
      po: createTestPO({ requestText: "emergency help needed" }),
      triggerResult: makeTriggerResult(["emergency-time-pressure"], 1.0),
    });

    expect(result.actionCategory).toBe("emergency");
  });

  it("derives requestor interests from effects", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["persist", "disclose", "exec"]),
      po: createTestPO(),
      triggerResult: makeTriggerResult(["duty-collision"], 0.7),
    });

    const requestor = result.affectedParties.find((p) => p.role === "requestor")!;
    expect(requestor.affectedInterests).toContain("property");
    expect(requestor.affectedInterests).toContain("privacy");
    expect(requestor.affectedInterests).toContain("safety");
  });

  it("falls back to autonomy when no specific interests match", () => {
    const result = __testing.classifyAction({
      toolProfile: createTestProfile(["read", "compose"]),
      po: createTestPO(),
      triggerResult: makeTriggerResult([], 0),
    });

    const requestor = result.affectedParties.find((p) => p.role === "requestor")!;
    expect(requestor.affectedInterests).toEqual(["autonomy"]);
  });
});

// ---------------------------------------------------------------------------
// Step 2: gatherDiscoveryContext
// ---------------------------------------------------------------------------

describe("Step 2: gatherDiscoveryContext", () => {
  it("includes request, tool, and WO metadata", () => {
    const po = createTestPO({ channel: "telegram", chatType: "group" });
    const wo = mintTestWO(po);
    const ctx = __testing.gatherDiscoveryContext({
      po,
      activeWO: wo,
      toolName: "send-message",
      toolProfile: createTestProfile(["disclose"]),
      triggerResult: makeTriggerResult(["duty-collision"], 0.7),
      consentRecords: [],
      eaaRecords: [],
      dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
    });

    expect(ctx.requestText).toBe("Do some work");
    expect(ctx.channel).toBe("telegram");
    expect(ctx.chatType).toBe("group");
    expect(ctx.toolName).toBe("send-message");
    expect(ctx.toolEffects).toEqual(["disclose"]);
    expect(ctx.triggerCategories).toEqual(["duty-collision"]);
    expect(ctx.dutyCount).toBe(5);
  });

  it("summarizes prior EAA records", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const eaaRecord: EAARecord = {
      id: "eaa-prior",
      poId: po.id,
      woId: wo.id,
      triggerReason: "test",
      outcome: "constrained-comply",
      recommendedEffects: ["read"],
      recommendedConstraints: [],
      createdAt: FIXED_TIME - 10_000,
    };

    const ctx = __testing.gatherDiscoveryContext({
      po,
      activeWO: wo,
      toolName: "test-tool",
      toolProfile: createTestProfile(["read"]),
      triggerResult: makeTriggerResult(),
      consentRecords: [],
      eaaRecords: [eaaRecord],
      dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
    });

    const priorOutcomes = ctx.priorEAAOutcomes as Array<{ outcome: string }>;
    expect(priorOutcomes).toHaveLength(1);
    expect(priorOutcomes[0].outcome).toBe("constrained-comply");
  });

  it("summarizes granted consent and marks expired records", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const activeConsent: ConsentRecord = {
      id: "cr-active",
      poId: po.id,
      woId: wo.id,
      effectClasses: ["read"],
      decision: "granted",
      timestamp: FIXED_TIME - 5_000,
      expiresAt: FIXED_TIME + 600_000,
    };
    const expiredConsent: ConsentRecord = {
      id: "cr-expired",
      poId: po.id,
      woId: wo.id,
      effectClasses: ["exec"],
      decision: "granted",
      timestamp: FIXED_TIME - 100_000,
      expiresAt: FIXED_TIME - 1,
    };
    const deniedConsent: ConsentRecord = {
      id: "cr-denied",
      poId: po.id,
      woId: wo.id,
      effectClasses: ["disclose"],
      decision: "denied",
      timestamp: FIXED_TIME - 5_000,
    };

    const ctx = __testing.gatherDiscoveryContext({
      po,
      activeWO: wo,
      toolName: "test-tool",
      toolProfile: createTestProfile(["read"]),
      triggerResult: makeTriggerResult(),
      consentRecords: [activeConsent, expiredConsent, deniedConsent],
      eaaRecords: [],
      dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
    });

    // Only granted records appear in the summary
    const summary = ctx.grantedConsentSummary as Array<{ id: string; expired: boolean }>;
    expect(summary).toHaveLength(2);
    const active = summary.find((s) => s.id === "cr-active")!;
    const expired = summary.find((s) => s.id === "cr-expired")!;
    expect(active.expired).toBe(false);
    expect(expired.expired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 3: validateEvaluation
// ---------------------------------------------------------------------------

describe("Step 3: validateEvaluation", () => {
  it("accepts a well-formed evaluation", () => {
    expect(__testing.validateEvaluation(makeEvaluation()).ok).toBe(true);
  });

  it("rejects standing confidence < 0", () => {
    const result = __testing.validateEvaluation(
      makeEvaluation({ standingAssessment: { confidence: -0.1, concerns: [] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("standingAssessment.confidence");
  });

  it("rejects standing confidence > 1", () => {
    const result = __testing.validateEvaluation(
      makeEvaluation({ standingAssessment: { confidence: 1.5, concerns: [] } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects invalid risk severity", () => {
    const result = __testing.validateEvaluation(
      makeEvaluation({
        riskAssessment: {
          likelihood: 0.5,
          severity: "extreme" as RiskSeverity,
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("riskAssessment.severity");
  });

  it("rejects risk likelihood > 1", () => {
    const result = __testing.validateEvaluation(
      makeEvaluation({
        riskAssessment: {
          likelihood: 2.0,
          severity: "minor",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("riskAssessment.likelihood");
  });

  it("rejects overall confidence > 1", () => {
    const result = __testing.validateEvaluation(
      makeEvaluation({
        confidenceGating: { overallConfidence: 1.1, insufficientEvidenceAreas: [] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("confidenceGating.overallConfidence");
  });
});

// ---------------------------------------------------------------------------
// Step 4: selectAlternatives
// ---------------------------------------------------------------------------

describe("Step 4: selectAlternatives", () => {
  function callSelect(overrides?: {
    evaluation?: Partial<EAAEvaluation>;
    effects?: EffectClass[];
    triggerSeverity?: number;
    triggerCategories?: EAATriggerResult["categories"];
    dutyConstraints?: readonly DutyConstraint[];
  }) {
    const effects = overrides?.effects ?? ["read"];
    return __testing.selectAlternatives({
      evaluation: makeEvaluation(overrides?.evaluation),
      classification: __testing.classifyAction({
        toolProfile: createTestProfile(effects),
        po: createTestPO(),
        triggerResult: makeTriggerResult(
          overrides?.triggerCategories ?? [],
          overrides?.triggerSeverity ?? 0.5,
        ),
      }),
      triggerResult: makeTriggerResult(
        overrides?.triggerCategories ?? [],
        overrides?.triggerSeverity ?? 0.5,
      ),
      toolProfile: createTestProfile(effects),
      dutyConstraints: overrides?.dutyConstraints ?? DEFAULT_DUTY_CONSTRAINTS,
    });
  }

  it("always includes refuse and escalate", () => {
    const alts = callSelect();
    expect(alts.some((a) => a.outcomeType === "refuse")).toBe(true);
    expect(alts.some((a) => a.outcomeType === "escalate")).toBe(true);
  });

  it("includes request-consent for non-inviolable scenarios", () => {
    const alts = callSelect({ effects: ["read"] });
    expect(alts.some((a) => a.outcomeType === "request-consent")).toBe(true);
  });

  it("excludes request-consent when inviolable duty collision exists", () => {
    // exec conflicts with inviolable duty-safety
    const alts = callSelect({ effects: ["exec", "physical"] });
    expect(alts.some((a) => a.outcomeType === "request-consent")).toBe(false);
  });

  it("includes proceed when confidence is high and risk is low", () => {
    const alts = callSelect({
      effects: ["read", "compose"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.1,
          severity: "negligible",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
      triggerSeverity: 0.3,
    });
    expect(alts.some((a) => a.outcomeType === "proceed")).toBe(true);
  });

  it("excludes proceed when trigger severity >= 0.8", () => {
    const alts = callSelect({
      effects: ["read"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.1,
          severity: "minor",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
      triggerSeverity: 0.8,
    });
    expect(alts.some((a) => a.outcomeType === "proceed")).toBe(false);
  });

  it("includes constrained-comply when confidence >= 0.3 and risk < critical", () => {
    const alts = callSelect({
      effects: ["read"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.5, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.3,
          severity: "moderate",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
    });
    expect(alts.some((a) => a.outcomeType === "constrained-comply")).toBe(true);
  });

  it("excludes constrained-comply when confidence < 0.3", () => {
    const alts = callSelect({
      effects: ["read"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.2, insufficientEvidenceAreas: [] },
      },
    });
    expect(alts.some((a) => a.outcomeType === "constrained-comply")).toBe(false);
  });

  it("excludes constrained-comply when risk is critical", () => {
    const alts = callSelect({
      effects: ["read"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.8, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.9,
          severity: "critical",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
    });
    expect(alts.some((a) => a.outcomeType === "constrained-comply")).toBe(false);
  });

  it("includes emergency-act only for emergency action categories", () => {
    // Non-emergency: no emergency-act
    const nonEmergency = callSelect({ effects: ["read"] });
    expect(nonEmergency.some((a) => a.outcomeType === "emergency-act")).toBe(false);

    // Emergency classification requires physical + emergency trigger
    const emergency = callSelect({
      effects: ["physical"],
      triggerCategories: ["emergency-time-pressure"],
      triggerSeverity: 1.0,
      dutyConstraints: [],
    });
    expect(emergency.some((a) => a.outcomeType === "emergency-act")).toBe(true);
  });

  it("includes emergency-act even when inviolable duty collision exists", () => {
    const alts = callSelect({
      effects: ["physical"],
      triggerCategories: ["emergency-time-pressure"],
      triggerSeverity: 1.0,
      dutyConstraints: DEFAULT_DUTY_CONSTRAINTS, // includes inviolable duty-safety
    });
    expect(alts.some((a) => a.outcomeType === "emergency-act")).toBe(true);
    // But other expansive outcomes remain blocked
    expect(alts.some((a) => a.outcomeType === "proceed")).toBe(false);
    expect(alts.some((a) => a.outcomeType === "request-consent")).toBe(false);
    expect(alts.some((a) => a.outcomeType === "constrained-comply")).toBe(false);
  });

  it("constrained-comply strips irreversible effects when risk is serious", () => {
    const alts = callSelect({
      effects: ["read", "irreversible"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.5, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.6,
          severity: "serious",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
      dutyConstraints: [], // avoid inviolable collision
    });
    const constrained = alts.find((a) => a.outcomeType === "constrained-comply");
    expect(constrained).toBeDefined();
    expect(constrained!.effectClasses).not.toContain("irreversible");
    expect(constrained!.effectClasses).toContain("read");
  });

  it("returns alternatives sorted by invasivenessScore ascending", () => {
    const alts = callSelect({
      effects: ["read", "compose"],
      evaluation: {
        confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.1,
          severity: "negligible",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      },
      triggerSeverity: 0.3,
    });
    for (let i = 1; i < alts.length; i++) {
      expect(alts[i].invasivenessScore).toBeGreaterThanOrEqual(alts[i - 1].invasivenessScore);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 5: chooseOutcome
// ---------------------------------------------------------------------------

describe("Step 5: chooseOutcome", () => {
  function buildAlternatives(types: EAAOutcome[]): ActionAlternative[] {
    return types.map((t, i) => ({
      description: t,
      outcomeType: t,
      effectClasses: [],
      constraints: [],
      invasivenessScore: i * 0.2,
    }));
  }

  it("refuses when inviolable duty collision exists (non-emergency)", () => {
    const alts = buildAlternatives(["refuse", "proceed", "request-consent"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation(),
      triggerResult: makeTriggerResult([], 0.5),
      dutyConstraints: [
        {
          id: "d-inviolable",
          protects: "safety",
          conflictingEffects: ["exec"],
          criticality: "inviolable",
          description: "test",
        },
      ],
      toolProfile: createTestProfile(["exec"]),
    });
    expect(chosen.outcomeType).toBe("refuse");
  });

  it("selects emergency-act over inviolable duty refuse in emergency", () => {
    const alts = buildAlternatives(["refuse", "escalate", "emergency-act"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation(),
      triggerResult: makeTriggerResult(["emergency-time-pressure"], 1.0),
      dutyConstraints: [
        {
          id: "d-inviolable",
          protects: "safety",
          conflictingEffects: ["physical"],
          criticality: "inviolable",
          description: "test",
        },
      ],
      toolProfile: createTestProfile(["physical"]),
    });
    expect(chosen.outcomeType).toBe("emergency-act");
  });

  it("selects request-consent when confidence is below threshold", () => {
    const alts = buildAlternatives(["refuse", "escalate", "request-consent", "proceed"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation({
        confidenceGating: { overallConfidence: 0.2, insufficientEvidenceAreas: ["risk"] },
      }),
      triggerResult: makeTriggerResult(),
      dutyConstraints: [],
      toolProfile: createTestProfile(["read"]),
    });
    expect(chosen.outcomeType).toBe("request-consent");
  });

  it("falls back to refuse when low confidence and no request-consent available", () => {
    const alts = buildAlternatives(["refuse", "escalate"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation({
        confidenceGating: { overallConfidence: 0.1, insufficientEvidenceAreas: [] },
      }),
      triggerResult: makeTriggerResult(),
      dutyConstraints: [],
      toolProfile: createTestProfile(["read"]),
    });
    expect(chosen.outcomeType).toBe("refuse");
  });

  it("selects emergency-act for emergency-time-pressure triggers", () => {
    const alts = buildAlternatives(["refuse", "escalate", "emergency-act", "proceed"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation(),
      triggerResult: makeTriggerResult(["emergency-time-pressure"], 1.0),
      dutyConstraints: [],
      toolProfile: createTestProfile(["physical"]),
    });
    expect(chosen.outcomeType).toBe("emergency-act");
  });

  it("selects proceed when confidence is high and risk is low", () => {
    const alts = buildAlternatives(["refuse", "escalate", "constrained-comply", "proceed"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation({
        confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.1,
          severity: "negligible",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
      triggerResult: makeTriggerResult([], 0.3),
      dutyConstraints: [],
      toolProfile: createTestProfile(["read"]),
    });
    expect(chosen.outcomeType).toBe("proceed");
  });

  it("selects constrained-comply as moderate-confidence fallback", () => {
    const alts = buildAlternatives(["refuse", "escalate", "request-consent", "constrained-comply"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation({
        confidenceGating: { overallConfidence: 0.5, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.3,
          severity: "moderate",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
      triggerResult: makeTriggerResult([], 0.5),
      dutyConstraints: [],
      toolProfile: createTestProfile(["read"]),
    });
    expect(chosen.outcomeType).toBe("constrained-comply");
  });

  it("falls back to request-consent when no better option is available", () => {
    const alts = buildAlternatives(["refuse", "escalate", "request-consent"]);
    const chosen = __testing.chooseOutcome({
      alternatives: alts,
      evaluation: makeEvaluation({
        confidenceGating: { overallConfidence: 0.5, insufficientEvidenceAreas: [] },
        riskAssessment: {
          likelihood: 0.5,
          severity: "moderate",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
      triggerResult: makeTriggerResult([], 0.5),
      dutyConstraints: [],
      toolProfile: createTestProfile(["read"]),
    });
    expect(chosen.outcomeType).toBe("request-consent");
  });
});

// ---------------------------------------------------------------------------
// checkInviolableDutyCollision
// ---------------------------------------------------------------------------

describe("checkInviolableDutyCollision", () => {
  it("returns true when effects conflict with inviolable duty", () => {
    const result = __testing.checkInviolableDutyCollision(["exec"], DEFAULT_DUTY_CONSTRAINTS);
    expect(result).toBe(true);
  });

  it("returns false when effects only conflict with strong duties", () => {
    const result = __testing.checkInviolableDutyCollision(["disclose"], DEFAULT_DUTY_CONSTRAINTS);
    expect(result).toBe(false);
  });

  it("returns false for effects with no duty collisions", () => {
    const result = __testing.checkInviolableDutyCollision(
      ["read", "compose"],
      DEFAULT_DUTY_CONSTRAINTS,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeInvasivenessScore
// ---------------------------------------------------------------------------

describe("computeInvasivenessScore", () => {
  it("scores higher for more high-risk effects", () => {
    const eval_ = makeEvaluation();
    const lowScore = __testing.computeInvasivenessScore(["read"], eval_);
    const highScore = __testing.computeInvasivenessScore(
      ["exec", "irreversible", "physical"],
      eval_,
    );
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("scores higher for more severe risk assessment", () => {
    const minor = __testing.computeInvasivenessScore(
      ["read"],
      makeEvaluation({
        riskAssessment: {
          likelihood: 0.2,
          severity: "minor",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
    );
    const critical = __testing.computeInvasivenessScore(
      ["read"],
      makeEvaluation({
        riskAssessment: {
          likelihood: 0.9,
          severity: "critical",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
    );
    expect(critical).toBeGreaterThan(minor);
  });

  it("caps at 1.0", () => {
    const score = __testing.computeInvasivenessScore(
      ["exec", "irreversible", "physical", "disclose", "elevated"],
      makeEvaluation({
        riskAssessment: {
          likelihood: 1.0,
          severity: "critical",
          mitigatingFactors: [],
          aggravatingFactors: [],
        },
      }),
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeMinimalEmergencyEffects
// ---------------------------------------------------------------------------

describe("computeMinimalEmergencyEffects", () => {
  it("keeps only emergency-relevant effects", () => {
    const effects = __testing.computeMinimalEmergencyEffects([
      "physical",
      "exec",
      "disclose",
      "read",
    ]);
    expect(effects).toContain("physical");
    expect(effects).toContain("exec");
    expect(effects).toContain("read");
    expect(effects).not.toContain("disclose");
  });

  it("returns all effects if none are emergency-relevant", () => {
    const effects = __testing.computeMinimalEmergencyEffects(["disclose", "persist"]);
    expect(effects).toEqual(["disclose", "persist"]);
  });
});

// ---------------------------------------------------------------------------
// Step 6: produceArtifacts
// ---------------------------------------------------------------------------

describe("Step 6: produceArtifacts", () => {
  it("produces correctly linked adjudication, reasoning, and eaaRecord", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const evaluation = makeEvaluation();
    const triggerResult = makeTriggerResult(["standing-ambiguity"], 0.5);
    const classification = __testing.classifyAction({
      toolProfile: createTestProfile(["read"]),
      po,
      triggerResult,
    });
    const selected: ActionAlternative = {
      description: "Proceed",
      outcomeType: "proceed",
      effectClasses: ["read"],
      constraints: [],
      invasivenessScore: 0.3,
    };

    const { adjudication, reasoning, eaaRecord } = __testing.produceArtifacts({
      selectedAlternative: selected,
      alternatives: [selected],
      classification,
      discoveryContext: { toolName: "test" },
      evaluation,
      triggerResult,
      po,
      activeWO: wo,
      toolName: "test-tool",
      consentRecords: [],
      dutyConstraints: DEFAULT_DUTY_CONSTRAINTS,
    });

    // All three artifacts reference the same ID
    expect(adjudication.eaaRecordRef).toBe(reasoning.id);
    expect(eaaRecord.id).toBe(reasoning.id);

    // Adjudication reflects selected alternative
    expect(adjudication.outcome).toBe("proceed");
    expect(adjudication.recommendedEffects).toEqual(["read"]);

    // EAA record links to PO and WO
    expect(eaaRecord.poId).toBe(po.id);
    expect(eaaRecord.woId).toBe(wo.id);
    expect(eaaRecord.outcome).toBe("proceed");

    // Reasoning has full context
    expect(reasoning.triggerCategories).toEqual(["standing-ambiguity"]);
    expect(reasoning.evaluation).toBe(evaluation);
    expect(reasoning.createdAt).toBe(FIXED_TIME);
  });

  it("includes evidence refs for consent records and duty constraints", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const consent: ConsentRecord = {
      id: "cr-1",
      poId: po.id,
      woId: wo.id,
      effectClasses: ["read"],
      decision: "granted",
      timestamp: FIXED_TIME,
    };
    const duties: DutyConstraint[] = [
      {
        id: "d-1",
        protects: "safety",
        conflictingEffects: ["exec"],
        criticality: "inviolable",
        description: "test",
      },
    ];

    const { reasoning } = __testing.produceArtifacts({
      selectedAlternative: {
        description: "Refuse",
        outcomeType: "refuse",
        effectClasses: [],
        constraints: [],
        invasivenessScore: 0,
      },
      alternatives: [],
      classification: {
        primaryEffects: ["read"],
        affectedParties: [],
        actionCategory: "routine",
      },
      discoveryContext: {},
      evaluation: makeEvaluation(),
      triggerResult: makeTriggerResult(),
      po,
      activeWO: wo,
      toolName: "my-tool",
      consentRecords: [consent],
      dutyConstraints: duties,
    });

    expect(reasoning.evidenceRefs).toContain("tool:my-tool");
    expect(reasoning.evidenceRefs).toContain("consent:cr-1");
    expect(reasoning.evidenceRefs).toContain("duty:d-1");
  });

  it("serializes reasoning into eaaRecord.reasoning", () => {
    const po = createTestPO();
    const wo = mintTestWO(po);
    const { eaaRecord, reasoning } = __testing.produceArtifacts({
      selectedAlternative: {
        description: "Refuse",
        outcomeType: "refuse",
        effectClasses: [],
        constraints: [],
        invasivenessScore: 0,
      },
      alternatives: [],
      classification: { primaryEffects: [], affectedParties: [], actionCategory: "routine" },
      discoveryContext: {},
      evaluation: makeEvaluation(),
      triggerResult: makeTriggerResult(),
      po,
      activeWO: wo,
      toolName: "test-tool",
      consentRecords: [],
      dutyConstraints: [],
    });

    const parsed = JSON.parse(eaaRecord.reasoning!) as EAAReasoningRecord;
    expect(parsed.id).toBe(reasoning.id);
  });
});

// ---------------------------------------------------------------------------
// runElevatedActionAnalysis — end-to-end
// ---------------------------------------------------------------------------

describe("runElevatedActionAnalysis — happy path", () => {
  it("completes a full adjudication and returns ok:true with all artifacts", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        toolProfile: createTestProfile(["read"]),
        triggerResult: makeTriggerResult(["standing-ambiguity"], 0.5),
        infer: makeInfer({
          confidenceGating: { overallConfidence: 0.9, insufficientEvidenceAreas: [] },
          riskAssessment: {
            likelihood: 0.1,
            severity: "negligible",
            mitigatingFactors: ["low exposure"],
            aggravatingFactors: [],
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.adjudication.outcome).toBe("proceed");
    expect(result.reasoning.triggerCategories).toEqual(["standing-ambiguity"]);
    expect(result.eaaRecord.poId).toBe("po-1");
    expect(result.eaaRecord.outcome).toBe("proceed");
  });

  it("selects constrained-comply for moderate confidence", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        toolProfile: createTestProfile(["read", "persist"]),
        triggerResult: makeTriggerResult(["duty-collision"], 0.6),
        dutyConstraints: [], // avoid inviolable collision
        infer: makeInfer({
          confidenceGating: { overallConfidence: 0.5, insufficientEvidenceAreas: [] },
          riskAssessment: {
            likelihood: 0.3,
            severity: "moderate",
            mitigatingFactors: [],
            aggravatingFactors: [],
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.adjudication.outcome).toBe("constrained-comply");
    expect(result.adjudication.recommendedConstraints.length).toBeGreaterThan(0);
    expect(result.adjudication.recommendedConstraints[0].kind).toBe("time-bound");
  });

  it("selects request-consent when confidence is low", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        triggerResult: makeTriggerResult(["standing-ambiguity"], 0.5),
        dutyConstraints: [],
        infer: makeInfer({
          confidenceGating: { overallConfidence: 0.2, insufficientEvidenceAreas: ["everything"] },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.adjudication.outcome).toBe("request-consent");
  });

  it("selects emergency-act for emergency triggers (even with default inviolable duties)", async () => {
    // Uses DEFAULT_DUTY_CONSTRAINTS which include inviolable duty-safety
    // conflicting with "physical". Emergency-act overrides this.
    const result = await runElevatedActionAnalysis(
      makeParams({
        toolProfile: createTestProfile(["physical"]),
        triggerResult: makeTriggerResult(["emergency-time-pressure"], 1.0),
        po: createTestPO({ requestText: "emergency help needed" }),
        infer: makeInfer({
          confidenceGating: { overallConfidence: 0.8, insufficientEvidenceAreas: [] },
          riskAssessment: {
            likelihood: 0.8,
            severity: "serious",
            mitigatingFactors: [],
            aggravatingFactors: [],
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.adjudication.outcome).toBe("emergency-act");
    const constraint = result.adjudication.recommendedConstraints[0];
    expect(constraint.kind).toBe("time-bound");
    if (constraint.kind === "time-bound") {
      expect(constraint.expiresAt).toBe(FIXED_TIME + __testing.EMERGENCY_TTL_MS);
    }
  });

  it("selects refuse when inviolable duty collision exists", async () => {
    // exec + physical conflict with the inviolable duty-safety
    const result = await runElevatedActionAnalysis(
      makeParams({
        toolProfile: createTestProfile(["exec", "physical"]),
        triggerResult: makeTriggerResult(["duty-collision"], 0.9),
        infer: makeInfer({
          confidenceGating: { overallConfidence: 0.95, insufficientEvidenceAreas: [] },
          riskAssessment: {
            likelihood: 0.1,
            severity: "negligible",
            mitigatingFactors: [],
            aggravatingFactors: [],
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.adjudication.outcome).toBe("refuse");
  });
});

describe("runElevatedActionAnalysis — failure cases", () => {
  it("returns ok:false with refuse fallback when inference fails", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        infer: makeFailingInfer("LLM timeout"),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("LLM inference failed");
    expect(result.reason).toContain("LLM timeout");
    expect(result.fallbackOutcome).toBe("refuse");
  });

  it("returns ok:false when evaluation is structurally invalid", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        infer: async () =>
          makeEvaluation({
            standingAssessment: { confidence: -5, concerns: [] },
          }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("Invalid evaluation");
    expect(result.fallbackOutcome).toBe("refuse");
  });
});

describe("runElevatedActionAnalysis — artifact integrity", () => {
  it("all three artifacts share the same ID and are cross-referenced", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        infer: makeInfer(),
        dutyConstraints: [],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const { adjudication, reasoning, eaaRecord } = result;
    expect(adjudication.eaaRecordRef).toBe(reasoning.id);
    expect(eaaRecord.id).toBe(reasoning.id);
    expect(adjudication.outcome).toBe(eaaRecord.outcome);
    expect(adjudication.recommendedEffects).toEqual(eaaRecord.recommendedEffects);
    expect(adjudication.recommendedConstraints).toEqual(eaaRecord.recommendedConstraints);
  });

  it("eaaRecord.reasoning contains full JSON-serialized reasoning", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        infer: makeInfer(),
        dutyConstraints: [],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const parsed = JSON.parse(result.eaaRecord.reasoning!) as EAAReasoningRecord;
    expect(parsed.id).toBe(result.reasoning.id);
    expect(parsed.justification).toBeTruthy();
    expect(parsed.createdAt).toBe(FIXED_TIME);
  });

  it("reasoning.justification includes outcome, confidence, and severity data", async () => {
    const result = await runElevatedActionAnalysis(
      makeParams({
        infer: makeInfer(),
        dutyConstraints: [],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.reasoning.justification).toContain("Outcome:");
    expect(result.reasoning.justification).toContain("Standing confidence:");
    expect(result.reasoning.justification).toContain("Trigger severity:");
  });
});

// ---------------------------------------------------------------------------
// Testing seam constants
// ---------------------------------------------------------------------------

describe("testing seam constants", () => {
  it("exposes expected constant values", () => {
    expect(__testing.LOW_CONFIDENCE_THRESHOLD).toBe(0.3);
    expect(__testing.EMERGENCY_TTL_MS).toBe(5 * 60 * 1000);
    expect(__testing.CONSTRAINED_COMPLY_TTL_MS).toBe(15 * 60 * 1000);
  });
});
