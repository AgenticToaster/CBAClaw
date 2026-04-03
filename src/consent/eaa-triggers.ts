/**
 * EAA Trigger Detection (Phase 4a)
 *
 * Determines when Elevated Action Analysis is warranted for a tool invocation.
 * EAA is the agent's deliberate reasoning mode for forming commitment under
 * uncertainty -- it fires when naive "implied consent plus requalification"
 * is insufficient.
 *
 * Seven trigger categories (from PDF Section V.B):
 *   1. standing-ambiguity    — unclear if requestor has authority
 *   2. effect-ambiguity      — unclear what effects the request implies
 *   3. insufficient-evidence — lacking grounded context for judgment
 *   4. duty-collision        — requested effect conflicts with obligations
 *   5. emergency-time-pressure — action needed before consent obtainable
 *   6. novelty-uncertainty   — dynamic skills / unknown side effects
 *   7. irreversibility       — contemplated action cannot be undone
 *
 * The unifying criterion: the agent cannot confidently determine the proper
 * scope of work from the request and current contract state alone.
 */

import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import type { AmbiguityAssessment } from "./change-order.js";
import type {
  ConsentRecord,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type EAATriggerCategory =
  | "standing-ambiguity"
  | "effect-ambiguity"
  | "insufficient-evidence"
  | "duty-collision"
  | "emergency-time-pressure"
  | "novelty-uncertainty"
  | "irreversibility";

export type EAATriggerResult = {
  /** Whether any trigger fired. */
  triggered: boolean;
  /** Which categories fired. */
  categories: EAATriggerCategory[];
  /** Severity score 0–1 driving EAA depth. Higher = more thorough analysis. */
  severity: number;
  /** Human-readable summary for logging and explainability. */
  summary: string;
};

/**
 * A registered obligation that constrains the agent's behavior.
 * Duty constraints are checked against a tool's effect profile to detect
 * conflicts that require deliberation.
 */
export type DutyConstraint = {
  id: string;
  /** What this duty protects. */
  protects: DutyProtectionTarget;
  /** Effect classes that conflict with this duty. */
  conflictingEffects: EffectClass[];
  /** Inviolable duties cannot be overridden even by explicit consent. */
  criticality: DutyCriticality;
  /** Human-readable description of the duty. */
  description: string;
};

export type DutyProtectionTarget =
  | "evidence"
  | "confidentiality"
  | "safety"
  | "privacy"
  | "oversight";

export type DutyCriticality = "advisory" | "strong" | "inviolable";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Effect classes that pose elevated risk and require careful scrutiny. */
const HIGH_RISK_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "irreversible",
  "elevated",
  "disclose",
  "audience-expand",
  "exec",
  "physical",
]);

/**
 * Ambiguity threshold: when the best pattern-store match exceeds this
 * distance AND high-risk effects are involved, effect-ambiguity fires.
 */
const AMBIGUITY_DISTANCE_THRESHOLD = 0.6;

/**
 * Default severity for each trigger category. Final severity is the max
 * of all fired trigger severities (adjusted by context-specific scaling).
 */
const BASE_SEVERITY: Record<EAATriggerCategory, number> = {
  "standing-ambiguity": 0.5,
  "effect-ambiguity": 0.6,
  "insufficient-evidence": 0.5,
  "duty-collision": 0.7,
  "emergency-time-pressure": 1.0,
  "novelty-uncertainty": 0.6,
  irreversibility: 0.7,
};

/**
 * Tool names considered dangerous regardless of declared effects.
 * Sourced from the security module's gateway HTTP deny list.
 */
const DANGEROUS_TOOL_NAMES: ReadonlySet<string> = new Set(DEFAULT_GATEWAY_HTTP_TOOL_DENY);

/** Severity assigned to dangerous-tool triggers. */
const DANGEROUS_TOOL_SEVERITY = 0.8;

/**
 * Module-level clock for testability. Defaults to Date.now; tests can
 * override via the __testing seam to make time-dependent logic deterministic.
 */
let _now: () => number = () => Date.now();

// ---------------------------------------------------------------------------
// Default Duty Constraints
// ---------------------------------------------------------------------------

/**
 * Core system duties that are always active. These represent non-negotiable
 * obligations the agent must honor regardless of user consent.
 */
export const DEFAULT_DUTY_CONSTRAINTS: readonly DutyConstraint[] = [
  {
    id: "duty-evidence-preservation",
    protects: "evidence",
    conflictingEffects: ["irreversible", "persist"],
    criticality: "strong",
    description:
      "Preserve audit trails and evidence. Deletion of logs, records, " +
      "or consent artifacts requires explicit justification.",
  },
  {
    id: "duty-confidentiality",
    protects: "confidentiality",
    conflictingEffects: ["disclose", "audience-expand"],
    criticality: "strong",
    description:
      "Protect confidential information. Disclosure to external parties " +
      "or broadening of audience requires verified authorization.",
  },
  {
    id: "duty-safety",
    protects: "safety",
    conflictingEffects: ["exec", "physical", "irreversible"],
    criticality: "inviolable",
    description:
      "Prevent actions that could cause physical harm or irreversible " +
      "damage to critical systems without verified authorization.",
  },
  {
    id: "duty-privacy",
    protects: "privacy",
    conflictingEffects: ["disclose", "persist", "network"],
    criticality: "strong",
    description:
      "Protect personal data and privacy. Collection, storage, or " +
      "transmission of personal information requires justified purpose.",
  },
  {
    id: "duty-oversight",
    protects: "oversight",
    conflictingEffects: ["elevated", "exec"],
    criticality: "strong",
    description:
      "Maintain human oversight over administrative and system-level " +
      "operations. Privileged actions require traceable authorization.",
  },
];

// ---------------------------------------------------------------------------
// Evaluator Input
// ---------------------------------------------------------------------------

export type EvaluateEAATriggersParams = {
  po: PurchaseOrder;
  activeWO: WorkOrder;
  toolName: string;
  toolProfile: ToolEffectProfile;
  /** Ambiguity assessment from Phase 3b pattern store vector search. */
  ambiguity?: AmbiguityAssessment;
  /** Current consent records in scope. */
  consentRecords: readonly ConsentRecord[];
  /** Known system duty constraints (evidence preservation, confidentiality, etc.). */
  dutyConstraints?: readonly DutyConstraint[];
};

// ---------------------------------------------------------------------------
// Individual Trigger Detectors
// ---------------------------------------------------------------------------

type TriggerDetection = {
  category: EAATriggerCategory;
  severity: number;
  reason: string;
};

/**
 * Trigger 1: Standing / role ambiguity.
 *
 * Fires when the requestor's authority over the affected interests is unclear:
 * - Sender is not the owner
 * - Channel context is group or public
 * - Combined with high-risk effects → higher severity
 */
function detectStandingAmbiguity(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { po, toolProfile } = params;

  if (po.senderIsOwner) {
    return undefined;
  }

  const hasHighRisk = toolProfile.effects.some((e) => HIGH_RISK_EFFECTS.has(e));
  const isGroupContext = po.chatType === "group" || po.chatType === "public";

  let severity = BASE_SEVERITY["standing-ambiguity"];
  const reasons: string[] = ["requestor is not the agent owner"];

  if (isGroupContext) {
    severity = Math.min(severity + 0.15, 1.0);
    reasons.push(`group/public channel context (${po.chatType})`);
  }
  if (hasHighRisk) {
    severity = Math.min(severity + 0.15, 1.0);
    reasons.push("high-risk effects involved");
  }

  return {
    category: "standing-ambiguity",
    severity,
    reason: `Standing ambiguity: ${reasons.join("; ")}`,
  };
}

/**
 * Trigger 2: Effect ambiguity.
 *
 * Fires when the Phase 3b ambiguity assessment indicates the request is
 * underspecified AND the derived effects cross into high-risk territory.
 * Severity scales with vector distance (further = more uncertain).
 */
function detectEffectAmbiguity(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { ambiguity, toolProfile } = params;

  if (!ambiguity?.ambiguous) {
    return undefined;
  }

  if (ambiguity.bestDistance <= AMBIGUITY_DISTANCE_THRESHOLD) {
    return undefined;
  }

  const highRiskEffects = toolProfile.effects.filter((e) => HIGH_RISK_EFFECTS.has(e));
  if (highRiskEffects.length === 0) {
    return undefined;
  }

  // Scale severity by distance: 0.6 at threshold, approaching 1.0 at max distance
  const distanceFactor = Math.min((ambiguity.bestDistance - AMBIGUITY_DISTANCE_THRESHOLD) / 1.4, 1);
  const severity = Math.min(BASE_SEVERITY["effect-ambiguity"] + distanceFactor * 0.4, 1.0);

  return {
    category: "effect-ambiguity",
    severity,
    reason:
      `Effect ambiguity: request underspecified (distance=${ambiguity.bestDistance.toFixed(3)}, ` +
      `matches=${ambiguity.matchCount}) with high-risk effects [${highRiskEffects.join(", ")}]`,
  };
}

/**
 * Trigger 3: Duty collision.
 *
 * Fires when the tool's effects conflict with registered duty constraints.
 * Severity depends on the criticality of the conflicting duty.
 */
function detectDutyCollision(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { toolProfile, dutyConstraints } = params;
  const duties = dutyConstraints ?? DEFAULT_DUTY_CONSTRAINTS;

  const toolEffects = new Set(toolProfile.effects);
  const collisions: Array<{ duty: DutyConstraint; conflicting: EffectClass[] }> = [];

  for (const duty of duties) {
    const overlapping = duty.conflictingEffects.filter((e) => toolEffects.has(e));
    if (overlapping.length > 0) {
      collisions.push({ duty, conflicting: overlapping });
    }
  }

  if (collisions.length === 0) {
    return undefined;
  }

  // Severity is driven by the most critical colliding duty
  const criticalityScores: Record<DutyCriticality, number> = {
    advisory: 0.5,
    strong: 0.7,
    inviolable: 1.0,
  };

  const maxCriticality = Math.max(...collisions.map((c) => criticalityScores[c.duty.criticality]));

  const collisionSummaries = collisions.map(
    (c) => `${c.duty.protects} (${c.duty.criticality}): [${c.conflicting.join(", ")}]`,
  );

  return {
    category: "duty-collision",
    severity: maxCriticality,
    reason: `Duty collision: ${collisionSummaries.join("; ")}`,
  };
}

/**
 * Trigger 4: External trust tier / novelty uncertainty.
 *
 * Fires when the tool runs outside the agent's enforcement boundary
 * (external trust tier) and involves risky effects. Out-of-band execution
 * cannot be fully constrained by contract mechanisms.
 */
function detectNoveltyUncertainty(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { toolProfile } = params;

  if (toolProfile.trustTier !== "external") {
    return undefined;
  }

  const riskyEffects: ReadonlySet<EffectClass> = new Set<EffectClass>([
    "disclose",
    "irreversible",
    "persist",
    "exec",
    "physical",
  ]);
  const externalRiskyEffects = toolProfile.effects.filter((e) => riskyEffects.has(e));

  if (externalRiskyEffects.length === 0) {
    return undefined;
  }

  return {
    category: "novelty-uncertainty",
    severity: BASE_SEVERITY["novelty-uncertainty"],
    reason:
      `Novelty/trust uncertainty: external tool with effects ` +
      `[${externalRiskyEffects.join(", ")}]`,
  };
}

/**
 * Trigger 5: Dangerous tool list.
 *
 * Fires unconditionally when the tool is in the dangerous tools set,
 * regardless of its declared effect profile.
 */
function detectDangerousTool(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { toolName } = params;

  if (!DANGEROUS_TOOL_NAMES.has(toolName)) {
    return undefined;
  }

  return {
    category: "novelty-uncertainty",
    severity: DANGEROUS_TOOL_SEVERITY,
    reason: `Dangerous tool: "${toolName}" is on the restricted tool list`,
  };
}

/**
 * Trigger 6: Insufficient evidence.
 *
 * Fires when the system lacks grounded context for making a
 * safety/proportionality judgment: the tool involves high-risk effects
 * but there are no consent records in scope AND no ambiguity assessment
 * was provided. Without either signal, the agent cannot gauge risk.
 */
function detectInsufficientEvidence(
  params: EvaluateEAATriggersParams,
): TriggerDetection | undefined {
  const { toolProfile, consentRecords, ambiguity } = params;

  const hasHighRisk = toolProfile.effects.some((e) => HIGH_RISK_EFFECTS.has(e));
  if (!hasHighRisk) {
    return undefined;
  }

  // If there are consent records or an ambiguity assessment, the system has
  // some grounded context to reason about risk.
  if (consentRecords.length > 0 || ambiguity !== undefined) {
    return undefined;
  }

  return {
    category: "insufficient-evidence",
    severity: BASE_SEVERITY["insufficient-evidence"],
    reason:
      "Insufficient evidence: high-risk effects with no consent history " +
      "and no ambiguity assessment available for risk judgment",
  };
}

/**
 * Trigger 7: Irreversibility without prior explicit consent.
 *
 * Fires when the tool's effects include "irreversible" and no prior
 * explicit consent record in the current scope covers that effect class.
 */
function detectIrreversibility(params: EvaluateEAATriggersParams): TriggerDetection | undefined {
  const { toolProfile, consentRecords } = params;

  if (!toolProfile.effects.includes("irreversible")) {
    return undefined;
  }

  const now = _now();
  const hasExplicitIrreversibleConsent = consentRecords.some(
    (r) =>
      r.decision === "granted" &&
      r.effectClasses.includes("irreversible") &&
      (!r.expiresAt || r.expiresAt > now),
  );

  if (hasExplicitIrreversibleConsent) {
    return undefined;
  }

  return {
    category: "irreversibility",
    severity: BASE_SEVERITY.irreversibility,
    reason:
      "Irreversibility: action cannot be undone and no prior explicit " +
      "consent covers irreversible effects",
  };
}

/**
 * Trigger 8: Emergency time pressure.
 *
 * Fires when the tool's effects include "physical" AND the context
 * metadata indicates time-critical conditions. This trigger still invokes
 * EAA, but the loop should select the emergency-act outcome with strict
 * post-hoc accountability requirements.
 */
function detectEmergencyTimePressure(
  params: EvaluateEAATriggersParams,
): TriggerDetection | undefined {
  const { toolProfile, po } = params;

  if (!toolProfile.effects.includes("physical")) {
    return undefined;
  }

  // Time-critical signals: request text contains urgency markers or
  // PO metadata explicitly flags emergency conditions
  const urgencyPatterns =
    /\b(emergency|urgent|immediately|asap|critical|danger|life.?threatening)\b/i;
  const isTimeCritical = urgencyPatterns.test(po.requestText);

  if (!isTimeCritical) {
    return undefined;
  }

  return {
    category: "emergency-time-pressure",
    severity: BASE_SEVERITY["emergency-time-pressure"],
    reason:
      "Emergency time pressure: physical effects with time-critical context; " +
      "requires immediate action with strict post-hoc accountability",
  };
}

// ---------------------------------------------------------------------------
// Main Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate all EAA trigger conditions against the current tool invocation
 * context. Returns a composite result indicating whether EAA is warranted,
 * which categories fired, an aggregate severity, and a human-readable summary.
 *
 * The overall severity is the maximum across all fired triggers -- this
 * drives how thorough the EAA adjudication loop should be.
 */
export function evaluateEAATriggers(params: EvaluateEAATriggersParams): EAATriggerResult {
  const detectors = [
    detectStandingAmbiguity,
    detectEffectAmbiguity,
    detectDutyCollision,
    detectNoveltyUncertainty,
    detectDangerousTool,
    detectInsufficientEvidence,
    detectIrreversibility,
    detectEmergencyTimePressure,
  ];

  const fired: TriggerDetection[] = [];
  for (const detect of detectors) {
    const result = detect(params);
    if (result) {
      fired.push(result);
    }
  }

  if (fired.length === 0) {
    return {
      triggered: false,
      categories: [],
      severity: 0,
      summary: "No EAA triggers detected",
    };
  }

  // Deduplicate categories (dangerous-tool and novelty can both fire as novelty-uncertainty)
  const categorySet = new Set(fired.map((f) => f.category));
  const categories = [...categorySet];

  const severity = Math.max(...fired.map((f) => f.severity));
  const reasons = fired.map((f) => f.reason);

  return {
    triggered: true,
    categories,
    severity,
    summary: reasons.join(". ") + ".",
  };
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  HIGH_RISK_EFFECTS,
  AMBIGUITY_DISTANCE_THRESHOLD,
  BASE_SEVERITY,
  DANGEROUS_TOOL_NAMES,
  DANGEROUS_TOOL_SEVERITY,

  setNow(fn: () => number): void {
    _now = fn;
  },
  restoreNow(): void {
    _now = () => Date.now();
  },

  detectStandingAmbiguity,
  detectEffectAmbiguity,
  detectDutyCollision,
  detectNoveltyUncertainty,
  detectDangerousTool,
  detectInsufficientEvidence,
  detectIrreversibility,
  detectEmergencyTimePressure,
};
