import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintInitialWorkOrder, __testing as binderTesting } from "./binder.js";
import {
  evaluateEAATriggers,
  DEFAULT_DUTY_CONSTRAINTS,
  __testing,
  type DutyConstraint,
  type EvaluateEAATriggersParams,
} from "./eaa-triggers.js";
import type {
  ConsentRecord,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WorkOrder,
} from "./types.js";

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
  return {
    effects,
    trustTier: trustTier ?? "in-process",
    description: "test tool profile",
  };
}

function makeParams(overrides?: Partial<EvaluateEAATriggersParams>): EvaluateEAATriggersParams {
  const po = overrides?.po ?? createTestPO();
  const wo = overrides?.activeWO ?? mintTestWO(po);
  const { po: _po, activeWO: _wo, ...rest } = overrides ?? {};
  return {
    po,
    activeWO: wo,
    toolName: "test-tool",
    toolProfile: createTestProfile(["read"]),
    consentRecords: [],
    ...rest,
  };
}

beforeEach(() => {
  setupDeterministicBinder();
  __testing.setNow(() => FIXED_TIME);
});

afterEach(() => {
  binderTesting.restore();
  __testing.restoreNow();
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// No triggers
// ---------------------------------------------------------------------------

describe("evaluateEAATriggers – no triggers", () => {
  it("returns not triggered for owner with safe read-only tool", () => {
    const result = evaluateEAATriggers(makeParams());

    expect(result.triggered).toBe(false);
    expect(result.categories).toEqual([]);
    expect(result.severity).toBe(0);
    expect(result.summary).toBe("No EAA triggers detected");
  });

  it("returns not triggered for owner with compose tool", () => {
    const result = evaluateEAATriggers(makeParams({ toolProfile: createTestProfile(["compose"]) }));
    expect(result.triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trigger 1: Standing ambiguity
// ---------------------------------------------------------------------------

describe("standing-ambiguity trigger", () => {
  it("fires when sender is not owner", () => {
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["read"]),
      }),
    );

    expect(result.triggered).toBe(true);
    expect(result.categories).toContain("standing-ambiguity");
    expect(result.severity).toBeGreaterThanOrEqual(0.5);
    expect(result.summary).toContain("requestor is not the agent owner");
  });

  it("does not fire when sender is owner", () => {
    const result = __testing.detectStandingAmbiguity(
      makeParams({ po: createTestPO({ senderIsOwner: true }) }),
    );
    expect(result).toBeUndefined();
  });

  it("increases severity for group context", () => {
    const base = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["read"]),
      }),
    );
    const group = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false, chatType: "group" }),
        toolProfile: createTestProfile(["read"]),
      }),
    );

    expect(group.severity).toBeGreaterThan(base.severity);
    expect(group.summary).toContain("group/public channel context");
  });

  it("increases severity for public context", () => {
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false, chatType: "public" }),
        toolProfile: createTestProfile(["read"]),
      }),
    );
    expect(result.severity).toBeGreaterThan(0.5);
  });

  it("increases severity further when high-risk effects are involved", () => {
    const lowRisk = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["read"]),
      }),
    );
    const highRisk = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["exec", "irreversible"]),
      }),
    );

    expect(highRisk.severity).toBeGreaterThan(lowRisk.severity);
  });

  it("caps severity at 1.0 with all escalating factors", () => {
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false, chatType: "group" }),
        toolProfile: createTestProfile(["exec", "irreversible"]),
      }),
    );
    expect(result.severity).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// Trigger 2: Effect ambiguity
// ---------------------------------------------------------------------------

describe("effect-ambiguity trigger", () => {
  it("fires when ambiguity is high and high-risk effects present", () => {
    const result = evaluateEAATriggers(
      makeParams({
        ambiguity: { ambiguous: true, bestDistance: 0.85, matchCount: 0 },
        toolProfile: createTestProfile(["irreversible", "persist"]),
      }),
    );

    expect(result.triggered).toBe(true);
    expect(result.categories).toContain("effect-ambiguity");
    expect(result.summary).toContain("request underspecified");
  });

  it("does not fire when ambiguity is absent", () => {
    const result = __testing.detectEffectAmbiguity(
      makeParams({
        toolProfile: createTestProfile(["irreversible"]),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not fire when ambiguous but distance below threshold", () => {
    const result = __testing.detectEffectAmbiguity(
      makeParams({
        ambiguity: { ambiguous: true, bestDistance: 0.5, matchCount: 3 },
        toolProfile: createTestProfile(["irreversible"]),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not fire when ambiguous and high distance but only safe effects", () => {
    const result = __testing.detectEffectAmbiguity(
      makeParams({
        ambiguity: { ambiguous: true, bestDistance: 0.9, matchCount: 0 },
        toolProfile: createTestProfile(["read", "compose"]),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("scales severity by vector distance", () => {
    const medium = __testing.detectEffectAmbiguity(
      makeParams({
        ambiguity: { ambiguous: true, bestDistance: 0.7, matchCount: 1 },
        toolProfile: createTestProfile(["exec"]),
      }),
    );
    const extreme = __testing.detectEffectAmbiguity(
      makeParams({
        ambiguity: { ambiguous: true, bestDistance: 1.8, matchCount: 0 },
        toolProfile: createTestProfile(["exec"]),
      }),
    );

    expect(medium).toBeDefined();
    expect(extreme).toBeDefined();
    expect(extreme!.severity).toBeGreaterThan(medium!.severity);
  });
});

// ---------------------------------------------------------------------------
// Trigger 3: Duty collision
// ---------------------------------------------------------------------------

describe("duty-collision trigger", () => {
  it("fires when tool effects conflict with default duties", () => {
    const result = evaluateEAATriggers(
      makeParams({
        toolProfile: createTestProfile(["irreversible", "persist"]),
      }),
    );

    expect(result.triggered).toBe(true);
    expect(result.categories).toContain("duty-collision");
    expect(result.summary).toContain("Duty collision");
  });

  it("fires for disclose effects against confidentiality duty", () => {
    const result = __testing.detectDutyCollision(
      makeParams({
        toolProfile: createTestProfile(["disclose"]),
      }),
    );

    expect(result).toBeDefined();
    expect(result!.reason).toContain("confidentiality");
  });

  it("uses custom duty constraints when provided", () => {
    const customDuty: DutyConstraint = {
      id: "custom-duty",
      protects: "safety",
      conflictingEffects: ["compose"],
      criticality: "advisory",
      description: "Custom test duty",
    };

    const result = __testing.detectDutyCollision(
      makeParams({
        toolProfile: createTestProfile(["compose"]),
        dutyConstraints: [customDuty],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.severity).toBe(0.5);
  });

  it("does not fire when no effects conflict", () => {
    const result = __testing.detectDutyCollision(
      makeParams({
        toolProfile: createTestProfile(["read", "compose"]),
        dutyConstraints: [
          {
            id: "no-match",
            protects: "safety",
            conflictingEffects: ["physical"],
            criticality: "inviolable",
            description: "No match",
          },
        ],
      }),
    );
    expect(result).toBeUndefined();
  });

  it("severity reflects highest criticality among collisions", () => {
    const duties: DutyConstraint[] = [
      {
        id: "d1",
        protects: "evidence",
        conflictingEffects: ["persist"],
        criticality: "advisory",
        description: "Advisory duty",
      },
      {
        id: "d2",
        protects: "safety",
        conflictingEffects: ["persist"],
        criticality: "inviolable",
        description: "Inviolable duty",
      },
    ];

    const result = __testing.detectDutyCollision(
      makeParams({
        toolProfile: createTestProfile(["persist"]),
        dutyConstraints: duties,
      }),
    );

    expect(result).toBeDefined();
    expect(result!.severity).toBe(1.0);
  });

  it("reports all colliding duties in reason", () => {
    const result = __testing.detectDutyCollision(
      makeParams({
        toolProfile: createTestProfile(["disclose", "irreversible"]),
      }),
    );

    expect(result).toBeDefined();
    expect(result!.reason).toContain("confidentiality");
    expect(result!.reason).toContain("evidence");
  });
});

// ---------------------------------------------------------------------------
// Trigger 4: Novelty / external trust tier
// ---------------------------------------------------------------------------

describe("novelty-uncertainty trigger", () => {
  it("fires for external tools with risky effects", () => {
    const result = __testing.detectNoveltyUncertainty(
      makeParams({
        toolProfile: createTestProfile(["disclose", "network"], "external"),
      }),
    );

    expect(result).toBeDefined();
    expect(result!.category).toBe("novelty-uncertainty");
    expect(result!.reason).toContain("external tool");
  });

  it("does not fire for in-process tools", () => {
    const result = __testing.detectNoveltyUncertainty(
      makeParams({
        toolProfile: createTestProfile(["disclose"], "in-process"),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not fire for external tools with only safe effects", () => {
    const result = __testing.detectNoveltyUncertainty(
      makeParams({
        toolProfile: createTestProfile(["read", "compose", "network"], "external"),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not fire for sandboxed tools", () => {
    const result = __testing.detectNoveltyUncertainty(
      makeParams({
        toolProfile: createTestProfile(["exec"], "sandboxed"),
      }),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Trigger 5: Dangerous tool list
// ---------------------------------------------------------------------------

describe("dangerous-tool trigger", () => {
  it("fires for tools on the dangerous list", () => {
    const result = __testing.detectDangerousTool(makeParams({ toolName: "exec" }));

    expect(result).toBeDefined();
    expect(result!.severity).toBe(0.8);
    expect(result!.reason).toContain("restricted tool list");
  });

  it("fires for gateway tool", () => {
    const result = __testing.detectDangerousTool(makeParams({ toolName: "gateway" }));
    expect(result).toBeDefined();
  });

  it("fires for fs_delete", () => {
    const result = __testing.detectDangerousTool(makeParams({ toolName: "fs_delete" }));
    expect(result).toBeDefined();
  });

  it("does not fire for safe tools", () => {
    const result = __testing.detectDangerousTool(makeParams({ toolName: "read" }));
    expect(result).toBeUndefined();
  });

  it("does not fire for unknown tools not on the list", () => {
    const result = __testing.detectDangerousTool(makeParams({ toolName: "my_custom_tool" }));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Trigger 6: Insufficient evidence
// ---------------------------------------------------------------------------

describe("insufficient-evidence trigger", () => {
  it("fires when high-risk effects, no consent records, no ambiguity assessment", () => {
    const result = __testing.detectInsufficientEvidence(
      makeParams({
        toolProfile: createTestProfile(["exec", "irreversible"]),
        consentRecords: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.category).toBe("insufficient-evidence");
    expect(result!.reason).toContain("no consent history");
  });

  it("does not fire when consent records exist", () => {
    const record: ConsentRecord = {
      id: "cr-1",
      poId: "po-1",
      woId: "wo-1",
      effectClasses: ["read"],
      decision: "granted",
      timestamp: FIXED_TIME,
    };

    const result = __testing.detectInsufficientEvidence(
      makeParams({
        toolProfile: createTestProfile(["exec"]),
        consentRecords: [record],
      }),
    );

    expect(result).toBeUndefined();
  });

  it("does not fire when ambiguity assessment is provided", () => {
    const result = __testing.detectInsufficientEvidence(
      makeParams({
        toolProfile: createTestProfile(["exec"]),
        consentRecords: [],
        ambiguity: { ambiguous: false, bestDistance: 0.2, matchCount: 5 },
      }),
    );

    expect(result).toBeUndefined();
  });

  it("does not fire for safe effects even without context", () => {
    const result = __testing.detectInsufficientEvidence(
      makeParams({
        toolProfile: createTestProfile(["read", "compose"]),
        consentRecords: [],
      }),
    );

    expect(result).toBeUndefined();
  });

  it("fires via evaluateEAATriggers for high-risk tool without context", () => {
    const result = evaluateEAATriggers(
      makeParams({
        toolProfile: createTestProfile(["elevated"]),
        consentRecords: [],
      }),
    );

    expect(result.triggered).toBe(true);
    expect(result.categories).toContain("insufficient-evidence");
  });
});

// ---------------------------------------------------------------------------
// Trigger 7: Irreversibility
// ---------------------------------------------------------------------------

describe("irreversibility trigger", () => {
  it("fires when effects include irreversible and no prior consent", () => {
    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["irreversible", "persist"]),
        consentRecords: [],
      }),
    );

    expect(result).toBeDefined();
    expect(result!.category).toBe("irreversibility");
    expect(result!.reason).toContain("cannot be undone");
  });

  it("does not fire when prior explicit consent covers irreversible", () => {
    const record: ConsentRecord = {
      id: "cr-1",
      poId: "po-1",
      woId: "wo-1",
      effectClasses: ["irreversible", "persist"],
      decision: "granted",
      timestamp: FIXED_TIME,
    };

    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["irreversible"]),
        consentRecords: [record],
      }),
    );

    expect(result).toBeUndefined();
  });

  it("fires when prior consent exists but is expired", () => {
    const record: ConsentRecord = {
      id: "cr-1",
      poId: "po-1",
      woId: "wo-1",
      effectClasses: ["irreversible"],
      decision: "granted",
      timestamp: FIXED_TIME - 100_000,
      // Expired 1ms before FIXED_TIME (the deterministic "now")
      expiresAt: FIXED_TIME - 1,
    };

    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["irreversible"]),
        consentRecords: [record],
      }),
    );

    expect(result).toBeDefined();
  });

  it("does not fire when prior consent is not yet expired", () => {
    const record: ConsentRecord = {
      id: "cr-1",
      poId: "po-1",
      woId: "wo-1",
      effectClasses: ["irreversible"],
      decision: "granted",
      timestamp: FIXED_TIME - 100_000,
      expiresAt: FIXED_TIME + 600_000,
    };

    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["irreversible"]),
        consentRecords: [record],
      }),
    );

    expect(result).toBeUndefined();
  });

  it("fires when prior consent exists but was denied", () => {
    const record: ConsentRecord = {
      id: "cr-1",
      poId: "po-1",
      woId: "wo-1",
      effectClasses: ["irreversible"],
      decision: "denied",
      timestamp: FIXED_TIME,
    };

    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["irreversible"]),
        consentRecords: [record],
      }),
    );

    expect(result).toBeDefined();
  });

  it("does not fire when effects do not include irreversible", () => {
    const result = __testing.detectIrreversibility(
      makeParams({
        toolProfile: createTestProfile(["persist", "read"]),
      }),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Trigger 7: Emergency time pressure
// ---------------------------------------------------------------------------

describe("emergency-time-pressure trigger", () => {
  it("fires for physical effects with urgency in request text", () => {
    const result = __testing.detectEmergencyTimePressure(
      makeParams({
        po: createTestPO({ requestText: "Emergency: turn off the motor immediately" }),
        toolProfile: createTestProfile(["physical"]),
      }),
    );

    expect(result).toBeDefined();
    expect(result!.category).toBe("emergency-time-pressure");
    expect(result!.severity).toBe(1.0);
    expect(result!.reason).toContain("post-hoc accountability");
  });

  it("fires for various urgency keywords", () => {
    for (const keyword of ["urgent", "ASAP", "critical", "danger", "life-threatening"]) {
      const result = __testing.detectEmergencyTimePressure(
        makeParams({
          po: createTestPO({ requestText: `This is ${keyword}, please act now` }),
          toolProfile: createTestProfile(["physical"]),
        }),
      );
      expect(result).toBeDefined();
    }
  });

  it("does not fire for physical effects without urgency", () => {
    const result = __testing.detectEmergencyTimePressure(
      makeParams({
        po: createTestPO({ requestText: "Turn on the lights please" }),
        toolProfile: createTestProfile(["physical"]),
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not fire for urgent non-physical effects", () => {
    const result = __testing.detectEmergencyTimePressure(
      makeParams({
        po: createTestPO({ requestText: "Emergency: delete all files immediately" }),
        toolProfile: createTestProfile(["irreversible", "persist"]),
      }),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composite trigger evaluation
// ---------------------------------------------------------------------------

describe("composite trigger evaluation", () => {
  it("fires multiple triggers simultaneously", () => {
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolName: "exec",
        toolProfile: createTestProfile(["exec", "irreversible"]),
        ambiguity: { ambiguous: true, bestDistance: 0.9, matchCount: 0 },
      }),
    );

    expect(result.triggered).toBe(true);
    expect(result.categories.length).toBeGreaterThan(1);
    expect(result.categories).toContain("standing-ambiguity");
    expect(result.categories).toContain("effect-ambiguity");
    expect(result.categories).toContain("irreversibility");
  });

  it("severity is the max of all fired triggers", () => {
    // standing-ambiguity: 0.5, duty-collision: up to 1.0 (safety/inviolable)
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["exec", "physical"]),
      }),
    );

    // Safety duty is inviolable (1.0) so overall severity should be 1.0
    expect(result.severity).toBe(1.0);
  });

  it("deduplicates trigger categories", () => {
    // Both novelty-uncertainty and dangerous-tool fire as "novelty-uncertainty"
    const result = evaluateEAATriggers(
      makeParams({
        toolName: "nodes",
        toolProfile: createTestProfile(["exec", "elevated"], "external"),
      }),
    );

    const noveltyCount = result.categories.filter((c) => c === "novelty-uncertainty").length;
    expect(noveltyCount).toBeLessThanOrEqual(1);
  });

  it("summary joins all reasons", () => {
    const result = evaluateEAATriggers(
      makeParams({
        po: createTestPO({ senderIsOwner: false }),
        toolProfile: createTestProfile(["irreversible"]),
      }),
    );

    expect(result.summary).toContain("Standing ambiguity");
    expect(result.summary).toContain("Irreversibility");
    expect(result.summary.endsWith(".")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default duty constraints
// ---------------------------------------------------------------------------

describe("DEFAULT_DUTY_CONSTRAINTS", () => {
  it("contains 5 core duties", () => {
    expect(DEFAULT_DUTY_CONSTRAINTS.length).toBe(5);
  });

  it("covers evidence, confidentiality, safety, privacy, oversight", () => {
    const targets = DEFAULT_DUTY_CONSTRAINTS.map((d) => d.protects);
    expect(targets).toContain("evidence");
    expect(targets).toContain("confidentiality");
    expect(targets).toContain("safety");
    expect(targets).toContain("privacy");
    expect(targets).toContain("oversight");
  });

  it("has at least one inviolable duty", () => {
    const inviolable = DEFAULT_DUTY_CONSTRAINTS.filter((d) => d.criticality === "inviolable");
    expect(inviolable.length).toBeGreaterThanOrEqual(1);
  });

  it("safety duty conflicts with exec and physical", () => {
    const safety = DEFAULT_DUTY_CONSTRAINTS.find((d) => d.protects === "safety");
    expect(safety).toBeDefined();
    expect(safety!.conflictingEffects).toContain("exec");
    expect(safety!.conflictingEffects).toContain("physical");
  });

  it("every duty has a non-empty description", () => {
    for (const duty of DEFAULT_DUTY_CONSTRAINTS) {
      expect(duty.description.length).toBeGreaterThan(0);
    }
  });

  it("every duty has at least one conflicting effect", () => {
    for (const duty of DEFAULT_DUTY_CONSTRAINTS) {
      expect(duty.conflictingEffects.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Testing seam validation
// ---------------------------------------------------------------------------

describe("testing seam constants", () => {
  it("HIGH_RISK_EFFECTS contains expected effects", () => {
    expect(__testing.HIGH_RISK_EFFECTS.has("irreversible")).toBe(true);
    expect(__testing.HIGH_RISK_EFFECTS.has("elevated")).toBe(true);
    expect(__testing.HIGH_RISK_EFFECTS.has("exec")).toBe(true);
    expect(__testing.HIGH_RISK_EFFECTS.has("physical")).toBe(true);
    expect(__testing.HIGH_RISK_EFFECTS.has("read")).toBe(false);
    expect(__testing.HIGH_RISK_EFFECTS.has("compose")).toBe(false);
  });

  it("DANGEROUS_TOOL_NAMES includes core dangerous tools", () => {
    expect(__testing.DANGEROUS_TOOL_NAMES.has("exec")).toBe(true);
    expect(__testing.DANGEROUS_TOOL_NAMES.has("spawn")).toBe(true);
    expect(__testing.DANGEROUS_TOOL_NAMES.has("shell")).toBe(true);
    expect(__testing.DANGEROUS_TOOL_NAMES.has("fs_delete")).toBe(true);
    expect(__testing.DANGEROUS_TOOL_NAMES.has("gateway")).toBe(true);
    expect(__testing.DANGEROUS_TOOL_NAMES.has("read")).toBe(false);
  });
});
