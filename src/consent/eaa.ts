/**
 * Elevated Action Analysis (EAA) Adjudication Loop — Phase 4b
 *
 * The EAA loop is the agent's structured deliberation for forming commitment
 * under uncertainty. It follows the six-step process from PDF Section V.C:
 *
 *   Step 1: Classify action and affected parties
 *   Step 2: Constrained discovery (deterministic context gathering)
 *   Step 3: Evaluate standing, risk, and duties (LLM inference)
 *   Step 4: Select least invasive sufficient action
 *   Step 5: Choose an explicit outcome
 *   Step 6: Produce accountability artifacts
 *
 * Key invariant: EAA may recommend contract terms, constraints, and a
 * minimal capability bundle. Only the deterministic binder may mint or
 * requalify the Work Order. The separation of reasoning (probabilistic,
 * advisory) from binding (deterministic, authoritative) is absolute.
 *
 * Two output artifacts:
 *   1. EAAAdjudicationResult — bounded schema admissible to the binder
 *   2. EAAReasoningRecord   — full evidence/duty/option analysis for audit
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DutyConstraint, EAATriggerCategory, EAATriggerResult } from "./eaa-triggers.js";
import type {
  ConsentRecord,
  EAAOutcome,
  EAARecord,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WOConstraint,
  WorkOrder,
} from "./types.js";

const log = createSubsystemLogger("consent/eaa");

// ---------------------------------------------------------------------------
// Adjudication Types (Step 1–4)
// ---------------------------------------------------------------------------

/** Step 1 output: action classification and affected parties. */
export type ActionClassification = {
  primaryEffects: EffectClass[];
  affectedParties: AffectedParty[];
  actionCategory: ActionCategory;
};

export type ActionCategory = "routine" | "sensitive" | "high-risk" | "emergency";

export type AffectedParty = {
  role: "requestor" | "named-third-party" | "bystander" | "unknown";
  identifier?: string;
  affectedInterests: string[];
};

/** Step 3 output: LLM-produced evaluation of standing, risk, and duties. */
export type EAAEvaluation = {
  standingAssessment: {
    confidence: number;
    concerns: string[];
  };
  riskAssessment: {
    likelihood: number;
    severity: RiskSeverity;
    mitigatingFactors: string[];
    aggravatingFactors: string[];
  };
  dutyAnalysis: {
    applicableDuties: string[];
    conflicts: DutyConflict[];
  };
  confidenceGating: {
    overallConfidence: number;
    insufficientEvidenceAreas: string[];
  };
};

export type RiskSeverity = "negligible" | "minor" | "moderate" | "serious" | "critical";

export type DutyConflict = {
  duty: string;
  conflictsWith: string;
  resolution: string;
};

/** Step 4 output: a ranked action alternative. */
export type ActionAlternative = {
  description: string;
  outcomeType: EAAOutcome;
  effectClasses: EffectClass[];
  constraints: WOConstraint[];
  /** Lower is better: weighted score of harm, intrusion, and irreversibility. */
  invasivenessScore: number;
};

// ---------------------------------------------------------------------------
// Accountability Artifacts (Step 6)
// ---------------------------------------------------------------------------

/** Authoritative input to the binder. Bounded schema only. */
export type EAAAdjudicationResult = {
  outcome: EAAOutcome;
  /** Effect classes the EAA recommends for the next slice. */
  recommendedEffects: EffectClass[];
  /** Constraints to apply to the successor WO. */
  recommendedConstraints: WOConstraint[];
  /** Verifiable reference to the full reasoning record. */
  eaaRecordRef: string;
};

/** Full reasoning bundle. Opaque to the binder. Persisted for audit. */
export type EAAReasoningRecord = {
  id: string;
  triggerCategories: EAATriggerCategory[];
  triggerSeverity: number;
  classification: ActionClassification;
  discoveryContext: Record<string, unknown>;
  evaluation: EAAEvaluation;
  alternatives: ActionAlternative[];
  selectedAlternative: ActionAlternative;
  justification: string;
  /** Evidence pointers: consent record IDs, policy IDs, tool profiles consulted. */
  evidenceRefs: string[];
  createdAt: number;
};

// ---------------------------------------------------------------------------
// EAA Runner Types
// ---------------------------------------------------------------------------

export type EAARunParams = {
  po: PurchaseOrder;
  activeWO: WorkOrder;
  toolName: string;
  toolProfile: ToolEffectProfile;
  triggerResult: EAATriggerResult;
  consentRecords: readonly ConsentRecord[];
  eaaRecords: readonly EAARecord[];
  dutyConstraints: readonly DutyConstraint[];
  /** LLM inference function for the evaluate step (Step 3). */
  infer: EAAInferenceFn;
};

export type EAARunResult =
  | {
      ok: true;
      adjudication: EAAAdjudicationResult;
      reasoning: EAAReasoningRecord;
      eaaRecord: EAARecord;
    }
  | { ok: false; reason: string; fallbackOutcome: EAAOutcome };

/** Typed inference function injected by the caller. */
export type EAAInferenceFn = (params: {
  classification: ActionClassification;
  discoveryContext: Record<string, unknown>;
  triggerCategories: EAATriggerCategory[];
  dutyConstraints: readonly DutyConstraint[];
}) => Promise<EAAEvaluation>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Below this confidence, EAA defaults to request-consent rather than guessing. */
const LOW_CONFIDENCE_THRESHOLD = 0.3;

/** Default TTL for emergency-act WO constraints (5 minutes). */
const EMERGENCY_TTL_MS = 5 * 60 * 1000;

/** Default TTL for constrained-comply WO constraints (15 minutes). */
const CONSTRAINED_COMPLY_TTL_MS = 15 * 60 * 1000;

const HIGH_RISK_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "irreversible",
  "elevated",
  "disclose",
  "audience-expand",
  "exec",
  "physical",
]);

/**
 * Module-level clock for testability.
 */
let _now: () => number = () => Date.now();
let _generateId: () => string = () => randomUUID();

// ---------------------------------------------------------------------------
// Step 1: Classify Action and Affected Parties
// ---------------------------------------------------------------------------

/**
 * Determine the action class and who may be affected. Deterministic —
 * uses effect profiles and PO metadata, no LLM call.
 */
function classifyAction(params: {
  toolProfile: ToolEffectProfile;
  po: PurchaseOrder;
  triggerResult: EAATriggerResult;
}): ActionClassification {
  const { toolProfile, po, triggerResult } = params;
  const effects = toolProfile.effects;

  const parties: AffectedParty[] = [
    {
      role: "requestor",
      identifier: po.senderId,
      affectedInterests: deriveRequestorInterests(effects),
    },
  ];

  if (effects.includes("disclose") || effects.includes("audience-expand")) {
    parties.push({
      role: "named-third-party",
      affectedInterests: ["privacy", "communication"],
    });
  }

  if (effects.includes("audience-expand")) {
    parties.push({
      role: "bystander",
      affectedInterests: ["privacy"],
    });
  }

  if (effects.includes("exec") || effects.includes("physical")) {
    parties.push({
      role: "unknown",
      affectedInterests: ["safety"],
    });
  }

  const category = classifyActionCategory(effects, triggerResult);

  return {
    primaryEffects: [...effects],
    affectedParties: parties,
    actionCategory: category,
  };
}

function deriveRequestorInterests(effects: EffectClass[]): string[] {
  const interests: string[] = [];
  if (effects.some((e) => e === "persist" || e === "irreversible")) {
    interests.push("property");
  }
  if (effects.some((e) => e === "disclose" || e === "network")) {
    interests.push("privacy");
  }
  if (effects.some((e) => e === "exec" || e === "physical")) {
    interests.push("safety");
  }
  if (effects.includes("audience-expand")) {
    interests.push("communication");
  }
  if (interests.length === 0) {
    interests.push("autonomy");
  }
  return interests;
}

function classifyActionCategory(
  effects: EffectClass[],
  triggerResult: EAATriggerResult,
): ActionCategory {
  if (triggerResult.categories.includes("emergency-time-pressure")) {
    return "emergency";
  }
  const highRiskCount = effects.filter((e) => HIGH_RISK_EFFECTS.has(e)).length;
  if (highRiskCount >= 2 || triggerResult.severity >= 0.8) {
    return "high-risk";
  }
  if (highRiskCount === 1 || triggerResult.severity >= 0.5) {
    return "sensitive";
  }
  return "routine";
}

// ---------------------------------------------------------------------------
// Step 2: Constrained Discovery
// ---------------------------------------------------------------------------

/**
 * Gather minimal evidence for duty and context understanding. Deterministic —
 * no LLM calls, no effects beyond what the active WO permits.
 */
function gatherDiscoveryContext(params: {
  po: PurchaseOrder;
  activeWO: WorkOrder;
  toolName: string;
  toolProfile: ToolEffectProfile;
  triggerResult: EAATriggerResult;
  consentRecords: readonly ConsentRecord[];
  eaaRecords: readonly EAARecord[];
  dutyConstraints: readonly DutyConstraint[];
}): Record<string, unknown> {
  const {
    po,
    activeWO,
    toolName,
    toolProfile,
    triggerResult,
    consentRecords,
    eaaRecords,
    dutyConstraints,
  } = params;

  const priorEAAOutcomes = eaaRecords.map((r) => ({
    id: r.id,
    outcome: r.outcome,
    triggerReason: r.triggerReason,
    effects: r.recommendedEffects,
  }));

  const grantedConsentSummary = consentRecords
    .filter((r) => r.decision === "granted")
    .map((r) => ({
      id: r.id,
      effects: r.effectClasses,
      expired: r.expiresAt ? r.expiresAt < _now() : false,
    }));

  return {
    requestText: po.requestText,
    senderId: po.senderId,
    senderIsOwner: po.senderIsOwner,
    channel: po.channel,
    chatType: po.chatType,
    toolName,
    toolEffects: toolProfile.effects,
    toolTrustTier: toolProfile.trustTier ?? "in-process",
    currentWOEffects: [...activeWO.grantedEffects],
    triggerCategories: triggerResult.categories,
    triggerSeverity: triggerResult.severity,
    priorEAAOutcomes,
    grantedConsentSummary,
    dutyCount: dutyConstraints.length,
    activeDuties: dutyConstraints.map((d) => ({
      id: d.id,
      protects: d.protects,
      criticality: d.criticality,
    })),
  };
}

// ---------------------------------------------------------------------------
// Step 3: Evaluate (LLM Inference — delegated to caller)
// ---------------------------------------------------------------------------

// The evaluation step is performed by the injected `EAAInferenceFn`.
// The caller is responsible for providing a validated, schema-conformant
// evaluation result. The EAA loop validates the result structurally.

function validateEvaluation(evaluation: EAAEvaluation): { ok: boolean; reason?: string } {
  if (
    typeof evaluation.standingAssessment?.confidence !== "number" ||
    evaluation.standingAssessment.confidence < 0 ||
    evaluation.standingAssessment.confidence > 1
  ) {
    return { ok: false, reason: "standingAssessment.confidence must be a number 0–1" };
  }
  if (
    typeof evaluation.riskAssessment?.likelihood !== "number" ||
    evaluation.riskAssessment.likelihood < 0 ||
    evaluation.riskAssessment.likelihood > 1
  ) {
    return { ok: false, reason: "riskAssessment.likelihood must be a number 0–1" };
  }
  const validSeverities = ["negligible", "minor", "moderate", "serious", "critical"];
  if (!validSeverities.includes(evaluation.riskAssessment?.severity)) {
    return {
      ok: false,
      reason: `riskAssessment.severity must be one of: ${validSeverities.join(", ")}`,
    };
  }
  if (
    typeof evaluation.confidenceGating?.overallConfidence !== "number" ||
    evaluation.confidenceGating.overallConfidence < 0 ||
    evaluation.confidenceGating.overallConfidence > 1
  ) {
    return { ok: false, reason: "confidenceGating.overallConfidence must be a number 0–1" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 4: Select Least Invasive Sufficient Action
// ---------------------------------------------------------------------------

/**
 * Generate candidate alternatives and rank them by invasiveness.
 * Deterministic given the evaluation and trigger context.
 */
function selectAlternatives(params: {
  evaluation: EAAEvaluation;
  classification: ActionClassification;
  triggerResult: EAATriggerResult;
  toolProfile: ToolEffectProfile;
  dutyConstraints: readonly DutyConstraint[];
}): ActionAlternative[] {
  const { evaluation, classification, triggerResult, toolProfile, dutyConstraints } = params;
  const alternatives: ActionAlternative[] = [];
  const now = _now();

  const hasInviolableDutyCollision = checkInviolableDutyCollision(
    toolProfile.effects,
    dutyConstraints,
  );

  // Refuse: always available as the safest option
  alternatives.push({
    description: "Refuse the action and explain why",
    outcomeType: "refuse",
    effectClasses: [],
    constraints: [],
    invasivenessScore: 0,
  });

  // Escalate: route to human governance
  alternatives.push({
    description: "Escalate to human governance for review",
    outcomeType: "escalate",
    effectClasses: [],
    constraints: [],
    invasivenessScore: 0.1,
  });

  // Request-consent: ask the user explicitly
  if (!hasInviolableDutyCollision) {
    alternatives.push({
      description: "Request explicit consent from the user",
      outcomeType: "request-consent",
      effectClasses: [...toolProfile.effects],
      constraints: [],
      invasivenessScore: 0.2,
    });
  }

  // Constrained-comply: proceed with additional constraints
  if (
    !hasInviolableDutyCollision &&
    evaluation.confidenceGating.overallConfidence >= LOW_CONFIDENCE_THRESHOLD &&
    evaluation.riskAssessment.severity !== "critical"
  ) {
    const constrainedEffects = computeConstrainedEffects(toolProfile.effects, evaluation);
    alternatives.push({
      description: "Proceed with additional time and scope constraints",
      outcomeType: "constrained-comply",
      effectClasses: constrainedEffects,
      constraints: [{ kind: "time-bound", expiresAt: now + CONSTRAINED_COMPLY_TTL_MS }],
      invasivenessScore: computeInvasivenessScore(constrainedEffects, evaluation),
    });
  }

  // Emergency-act: available for emergency classifications even when inviolable
  // duty collisions exist. Emergency-act IS the resolution path for inviolable
  // conflicts in genuine emergencies — minimal action with strict time bounds
  // and mandatory post-hoc accountability. (Plan: "If a duty collision is
  // inviolable and *cannot be resolved*, EAA always returns refuse." Emergency-act
  // is a resolution.)
  if (classification.actionCategory === "emergency") {
    alternatives.push({
      description: "Act minimally under emergency implied consent with strict time bounds",
      outcomeType: "emergency-act",
      effectClasses: computeMinimalEmergencyEffects(toolProfile.effects),
      constraints: [{ kind: "time-bound", expiresAt: now + EMERGENCY_TTL_MS }],
      invasivenessScore: 0.9,
    });
  }

  // Proceed: only when confidence is high, risk is manageable, and no duty collision
  if (
    !hasInviolableDutyCollision &&
    evaluation.confidenceGating.overallConfidence >= 0.7 &&
    (evaluation.riskAssessment.severity === "negligible" ||
      evaluation.riskAssessment.severity === "minor") &&
    triggerResult.severity < 0.8
  ) {
    alternatives.push({
      description: "Proceed — action is justified under current consent and duties",
      outcomeType: "proceed",
      effectClasses: [...toolProfile.effects],
      constraints: [],
      invasivenessScore: computeInvasivenessScore(toolProfile.effects, evaluation),
    });
  }

  alternatives.sort((a, b) => a.invasivenessScore - b.invasivenessScore);
  return alternatives;
}

function checkInviolableDutyCollision(
  effects: EffectClass[],
  dutyConstraints: readonly DutyConstraint[],
): boolean {
  const effectSet = new Set(effects);
  return dutyConstraints.some(
    (d) => d.criticality === "inviolable" && d.conflictingEffects.some((e) => effectSet.has(e)),
  );
}

function computeConstrainedEffects(
  effects: EffectClass[],
  evaluation: EAAEvaluation,
): EffectClass[] {
  // If risk is serious, drop irreversible effects from the recommended set
  if (evaluation.riskAssessment.severity === "serious") {
    return effects.filter((e) => e !== "irreversible");
  }
  return [...effects];
}

function computeMinimalEmergencyEffects(effects: EffectClass[]): EffectClass[] {
  // Keep only the effects strictly needed for emergency response
  const emergencyRelevant: ReadonlySet<EffectClass> = new Set(["physical", "exec", "read"]);
  const minimal = effects.filter((e) => emergencyRelevant.has(e));
  if (minimal.length === 0) {
    return [...effects];
  }
  return minimal;
}

function computeInvasivenessScore(effects: EffectClass[], evaluation: EAAEvaluation): number {
  const highRiskCount = effects.filter((e) => HIGH_RISK_EFFECTS.has(e)).length;
  const severityWeights: Record<RiskSeverity, number> = {
    negligible: 0,
    minor: 0.1,
    moderate: 0.3,
    serious: 0.6,
    critical: 1.0,
  };
  const riskWeight = severityWeights[evaluation.riskAssessment.severity];
  const effectWeight = Math.min(highRiskCount * 0.15, 0.6);
  return Math.min(0.3 + riskWeight + effectWeight, 1.0);
}

// ---------------------------------------------------------------------------
// Step 5: Choose Outcome
// ---------------------------------------------------------------------------

/**
 * Select the best alternative considering confidence, duty constraints,
 * and the trigger context. Deterministic given the alternatives and evaluation.
 */
function chooseOutcome(params: {
  alternatives: ActionAlternative[];
  evaluation: EAAEvaluation;
  triggerResult: EAATriggerResult;
  dutyConstraints: readonly DutyConstraint[];
  toolProfile: ToolEffectProfile;
}): ActionAlternative {
  const { alternatives, evaluation, triggerResult, dutyConstraints, toolProfile } = params;

  const hasInviolable = checkInviolableDutyCollision(toolProfile.effects, dutyConstraints);

  // Emergency overrides inviolable collision: emergency-act IS the resolution
  // path (minimal action with strict time bounds and post-hoc accountability).
  if (triggerResult.categories.includes("emergency-time-pressure")) {
    const emergency = alternatives.find((a) => a.outcomeType === "emergency-act");
    if (emergency) {
      return emergency;
    }
  }

  // Hard rule: inviolable duty collision that cannot be resolved → refuse
  if (hasInviolable) {
    return alternatives.find((a) => a.outcomeType === "refuse")!;
  }

  // Low confidence: ask the user rather than guess
  if (evaluation.confidenceGating.overallConfidence < LOW_CONFIDENCE_THRESHOLD) {
    return (
      alternatives.find((a) => a.outcomeType === "request-consent") ??
      alternatives.find((a) => a.outcomeType === "refuse")!
    );
  }

  // High confidence + low risk: allow proceed
  if (
    evaluation.confidenceGating.overallConfidence >= 0.7 &&
    (evaluation.riskAssessment.severity === "negligible" ||
      evaluation.riskAssessment.severity === "minor")
  ) {
    const proceed = alternatives.find((a) => a.outcomeType === "proceed");
    if (proceed) {
      return proceed;
    }
  }

  // Moderate confidence: constrained-comply if available
  const constrained = alternatives.find((a) => a.outcomeType === "constrained-comply");
  if (constrained) {
    return constrained;
  }

  // Fallback: request consent from user
  return (
    alternatives.find((a) => a.outcomeType === "request-consent") ??
    alternatives.find((a) => a.outcomeType === "refuse")!
  );
}

// ---------------------------------------------------------------------------
// Step 6: Produce Artifacts
// ---------------------------------------------------------------------------

function produceArtifacts(params: {
  selectedAlternative: ActionAlternative;
  alternatives: ActionAlternative[];
  classification: ActionClassification;
  discoveryContext: Record<string, unknown>;
  evaluation: EAAEvaluation;
  triggerResult: EAATriggerResult;
  po: PurchaseOrder;
  activeWO: WorkOrder;
  toolName: string;
  consentRecords: readonly ConsentRecord[];
  dutyConstraints: readonly DutyConstraint[];
}): { adjudication: EAAAdjudicationResult; reasoning: EAAReasoningRecord; eaaRecord: EAARecord } {
  const {
    selectedAlternative,
    alternatives,
    classification,
    discoveryContext,
    evaluation,
    triggerResult,
    po,
    activeWO,
    toolName,
    consentRecords,
    dutyConstraints,
  } = params;

  const reasoningId = _generateId();
  const now = _now();

  const reasoning: EAAReasoningRecord = {
    id: reasoningId,
    triggerCategories: [...triggerResult.categories],
    triggerSeverity: triggerResult.severity,
    classification,
    discoveryContext,
    evaluation,
    alternatives,
    selectedAlternative,
    justification: buildJustification(selectedAlternative, evaluation, triggerResult),
    evidenceRefs: buildEvidenceRefs(toolName, consentRecords, dutyConstraints),
    createdAt: now,
  };

  const adjudication: EAAAdjudicationResult = {
    outcome: selectedAlternative.outcomeType,
    recommendedEffects: [...selectedAlternative.effectClasses],
    recommendedConstraints: [...selectedAlternative.constraints],
    eaaRecordRef: reasoningId,
  };

  const eaaRecord: EAARecord = {
    id: reasoningId,
    poId: po.id,
    woId: activeWO.id,
    triggerReason: triggerResult.summary,
    outcome: selectedAlternative.outcomeType,
    recommendedEffects: [...selectedAlternative.effectClasses],
    recommendedConstraints: [...selectedAlternative.constraints],
    createdAt: now,
    reasoning: JSON.stringify(reasoning),
  };

  return { adjudication, reasoning, eaaRecord };
}

function buildJustification(
  selected: ActionAlternative,
  evaluation: EAAEvaluation,
  triggerResult: EAATriggerResult,
): string {
  const parts: string[] = [];

  parts.push(`Outcome: ${selected.outcomeType}.`);
  parts.push(
    `Standing confidence: ${evaluation.standingAssessment.confidence.toFixed(2)}, ` +
      `risk severity: ${evaluation.riskAssessment.severity}, ` +
      `overall confidence: ${evaluation.confidenceGating.overallConfidence.toFixed(2)}.`,
  );

  if (evaluation.dutyAnalysis.conflicts.length > 0) {
    const conflicts = evaluation.dutyAnalysis.conflicts
      .map((c) => `${c.duty} vs ${c.conflictsWith}`)
      .join("; ");
    parts.push(`Duty conflicts: ${conflicts}.`);
  }

  parts.push(`Trigger severity: ${triggerResult.severity.toFixed(2)}.`);
  parts.push(selected.description);

  return parts.join(" ");
}

function buildEvidenceRefs(
  toolName: string,
  consentRecords: readonly ConsentRecord[],
  dutyConstraints: readonly DutyConstraint[],
): string[] {
  const refs: string[] = [`tool:${toolName}`];
  for (const r of consentRecords) {
    refs.push(`consent:${r.id}`);
  }
  for (const d of dutyConstraints) {
    refs.push(`duty:${d.id}`);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run the full 6-step Elevated Action Analysis adjudication loop.
 *
 * Returns either a successful result with all three artifacts (adjudication
 * result for the binder, reasoning record for audit, EAA record for the
 * consent store), or a failure with a fallback outcome.
 *
 * The LLM inference step (Step 3) is delegated to the injected `infer`
 * function. All other steps are deterministic.
 */
export async function runElevatedActionAnalysis(params: EAARunParams): Promise<EAARunResult> {
  const {
    po,
    activeWO,
    toolName,
    toolProfile,
    triggerResult,
    consentRecords,
    eaaRecords,
    dutyConstraints,
    infer,
  } = params;

  log.debug(
    `EAA started: tool=${toolName} triggers=[${triggerResult.categories.join(",")}] ` +
      `severity=${triggerResult.severity.toFixed(2)}`,
  );

  // Step 1: Classify
  const classification = classifyAction({ toolProfile, po, triggerResult });

  // Step 2: Constrained discovery
  const discoveryContext = gatherDiscoveryContext({
    po,
    activeWO,
    toolName,
    toolProfile,
    triggerResult,
    consentRecords,
    eaaRecords,
    dutyConstraints,
  });

  // Step 3: Evaluate (LLM inference)
  let evaluation: EAAEvaluation;
  try {
    evaluation = await infer({
      classification,
      discoveryContext,
      triggerCategories: triggerResult.categories,
      dutyConstraints,
    });
  } catch (err) {
    log.debug(`EAA inference failed, falling back to refuse: ${String(err)}`);
    return {
      ok: false,
      reason: `LLM inference failed: ${String(err)}`,
      fallbackOutcome: "refuse",
    };
  }

  // Validate the evaluation structurally
  const validation = validateEvaluation(evaluation);
  if (!validation.ok) {
    log.debug(`EAA evaluation invalid: ${validation.reason}`);
    return {
      ok: false,
      reason: `Invalid evaluation from inference: ${validation.reason}`,
      fallbackOutcome: "refuse",
    };
  }

  // Step 4: Select alternatives
  const alternatives = selectAlternatives({
    evaluation,
    classification,
    triggerResult,
    toolProfile,
    dutyConstraints,
  });

  // Step 5: Choose outcome
  const selectedAlternative = chooseOutcome({
    alternatives,
    evaluation,
    triggerResult,
    dutyConstraints,
    toolProfile,
  });

  // Step 6: Produce artifacts
  const artifacts = produceArtifacts({
    selectedAlternative,
    alternatives,
    classification,
    discoveryContext,
    evaluation,
    triggerResult,
    po,
    activeWO,
    toolName,
    consentRecords,
    dutyConstraints,
  });

  log.debug(
    `EAA completed: outcome=${artifacts.adjudication.outcome} ` +
      `effects=[${artifacts.adjudication.recommendedEffects.join(",")}] ` +
      `reasoning=${artifacts.reasoning.id}`,
  );

  return {
    ok: true,
    adjudication: artifacts.adjudication,
    reasoning: artifacts.reasoning,
    eaaRecord: artifacts.eaaRecord,
  };
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  LOW_CONFIDENCE_THRESHOLD,
  EMERGENCY_TTL_MS,
  CONSTRAINED_COMPLY_TTL_MS,

  setNow(fn: () => number): void {
    _now = fn;
  },
  setGenerateId(fn: () => string): void {
    _generateId = fn;
  },
  restore(): void {
    _now = () => Date.now();
    _generateId = () => randomUUID();
  },

  classifyAction,
  gatherDiscoveryContext,
  validateEvaluation,
  selectAlternatives,
  chooseOutcome,
  produceArtifacts,
  buildJustification,
  checkInviolableDutyCollision,
  computeInvasivenessScore,
  computeConstrainedEffects,
  computeMinimalEmergencyEffects,
};
