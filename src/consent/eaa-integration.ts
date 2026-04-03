/**
 * EAA Integration into the Orchestration Pipeline (Phase 4c)
 *
 * Wires the EAA adjudication loop into the consent verification pipeline.
 * When verifyToolConsent returns `allowed: false` under enforcement mode,
 * the orchestrator calls `handleConsentFailure` to determine next steps:
 *
 *   verifyToolConsent() → "effect-not-granted"
 *       │
 *       ▼
 *   evaluateEAATriggers()
 *       │
 *       ├── not triggered → requestChangeOrder() (Phase 3b CO flow)
 *       │
 *       └── triggered → runElevatedActionAnalysis()
 *                          │
 *                          ├── proceed       → mint successor WO with EAA anchor → retry tool
 *                          ├── request-consent → requestChangeOrder() with EAA context
 *                          ├── constrained-comply → mint successor WO with constraints
 *                          ├── emergency-act → mint successor WO with time-bounded constraints
 *                          ├── refuse        → structured refusal
 *                          └── escalate      → escalation event, block pending human review
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { mintSuccessorWorkOrder } from "./binder.js";
import type { AmbiguityAssessment } from "./change-order.js";
import { requestChangeOrder } from "./change-order.js";
import type { ConsentRecordStore } from "./consent-store.js";
import type { EAATriggerResult } from "./eaa-triggers.js";
import { evaluateEAATriggers } from "./eaa-triggers.js";
import type { DutyConstraint } from "./eaa-triggers.js";
import type {
  EAAAdjudicationResult,
  EAAInferenceFn,
  EAAReasoningRecord,
  EAARunResult,
} from "./eaa.js";
import { runElevatedActionAnalysis } from "./eaa.js";
import type { ConsentPatternStore } from "./implied-consent-store.js";
import { filterApplicablePolicies } from "./policy.js";
import { addEAARecord, transitionWorkOrder } from "./scope-chain.js";
import type {
  BinderPolicy,
  ChangeOrder,
  ConsentAnchor,
  ConsentRecord,
  EAAOutcome,
  EAARecord,
  EffectClass,
  PurchaseOrder,
  StandingPolicyStub,
  ToolEffectProfile,
  WOConstraint,
  WorkOrder,
} from "./types.js";

const log = createSubsystemLogger("consent/eaa-integration");

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Resolution outcome from the consent failure handler. */
export type ConsentFailureResolution =
  | { action: "co-requested"; changeOrder: ChangeOrder }
  | {
      action: "eaa-resolved";
      outcome: EAAOutcome;
      successorWO?: WorkOrder;
      explanation: string;
      adjudication?: EAAAdjudicationResult;
      reasoning?: EAAReasoningRecord;
    }
  | { action: "refused"; reason: string };

export type HandleConsentFailureParams = {
  toolName: string;
  toolProfile: ToolEffectProfile;
  missingEffects: EffectClass[];
  po: PurchaseOrder;
  activeWO: WorkOrder;
  ambiguity?: AmbiguityAssessment;
  consentRecords: readonly ConsentRecord[];
  eaaRecords: readonly EAARecord[];
  dutyConstraints: readonly DutyConstraint[];
  patternStore?: ConsentPatternStore;
  consentRecordStore?: ConsentRecordStore;
  /** LLM inference function for EAA Step 3. When absent, EAA falls back to refuse. */
  infer?: EAAInferenceFn;
  /** Active standing policies for the binder (Phase 5i). */
  policies?: readonly (StandingPolicyStub | BinderPolicy)[];
  /** System-level prohibited effects. */
  systemProhibitions?: EffectClass[];
};

// ---------------------------------------------------------------------------
// Main Orchestration Entry Point
// ---------------------------------------------------------------------------

/**
 * Handle a consent verification failure. This is the single orchestration
 * entry point called when `verifyToolConsent` returns `allowed: false` and
 * the enforcement mode is `"enforce"`.
 *
 * Steps:
 *   1. Check for consent precedent reuse (Phase 3c)
 *   2. Evaluate EAA triggers
 *   3. If no EAA triggered → standard CO via requestChangeOrder
 *   4. If EAA triggered → run EAA adjudication, process outcome
 */
export async function handleConsentFailure(
  params: HandleConsentFailureParams,
): Promise<ConsentFailureResolution> {
  const {
    toolName,
    toolProfile,
    missingEffects,
    po,
    activeWO,
    ambiguity,
    consentRecords,
    eaaRecords,
    dutyConstraints,
    patternStore,
    consentRecordStore,
    infer,
    policies = [],
    systemProhibitions = [],
  } = params;

  // Phase 5i: check if active standing policies cover the missing effects
  if (policies.length > 0) {
    const matchContext = {
      channel: po.channel,
      chatType: po.chatType,
      senderId: po.senderId,
      senderIsOwner: po.senderIsOwner,
      toolName,
      toolTrustTier: toolProfile.trustTier,
    };
    const applicable = filterApplicablePolicies(policies, matchContext);
    const policyCoveredEffects = new Set(applicable.flatMap((p) => p.effectScope));
    const allCovered = missingEffects.every((e) => policyCoveredEffects.has(e));

    if (allCovered) {
      log.debug(
        `policy bypass: missing effects [${missingEffects.join(",")}] covered by ` +
          `${applicable.length} active policies`,
      );
      const policyAnchors: ConsentAnchor[] = applicable.map((p) => ({
        kind: "policy" as const,
        policyId: p.id,
      }));
      const successorResult = mintSuccessorWorkOrder({
        currentWO: activeWO,
        po,
        stepEffectProfile: toolProfile,
        newAnchors: policyAnchors,
        additionalEffects: missingEffects,
        policies,
        systemProhibitions,
        toolName,
      });
      if (successorResult.ok) {
        transitionWorkOrder(successorResult.wo);
        return {
          action: "eaa-resolved",
          outcome: "proceed",
          successorWO: successorResult.wo,
          explanation: `Policy bypass: effects covered by standing policies [${applicable.map((p) => p.id).join(", ")}]`,
        };
      }
      log.debug(
        `policy-based successor WO refused: ${successorResult.reason}; ` +
          "falling through to precedent/EAA",
      );
    }
  }

  // Step 1: Consent precedent reuse (Phase 3c)
  if (consentRecordStore) {
    const precedent = consentRecordStore.findConsentPrecedent({ effects: missingEffects });
    if (precedent) {
      log.debug(
        `consent precedent found: record=${precedent.id} ` +
          `effects=[${precedent.effectClasses.join(",")}]`,
      );
      const successorResult = mintSuccessorWithAnchor({
        currentWO: activeWO,
        po,
        toolProfile,
        additionalEffects: missingEffects,
        anchor: { kind: "explicit", consentRecordId: precedent.id },
        policies,
        systemProhibitions,
      });
      if (successorResult.ok) {
        transitionWorkOrder(successorResult.wo);
        return {
          action: "eaa-resolved",
          outcome: "proceed",
          successorWO: successorResult.wo,
          explanation: `Consent precedent reused from record ${precedent.id}`,
        };
      }
      log.debug(
        `precedent-based successor WO refused: ${successorResult.reason}; ` +
          "falling through to trigger evaluation",
      );
    }
  }

  // Step 2: Evaluate EAA triggers
  const triggerResult = evaluateEAATriggers({
    po,
    activeWO,
    toolName,
    toolProfile,
    ambiguity,
    consentRecords,
    dutyConstraints,
  });

  // Step 3: No EAA triggered → standard Change Order
  if (!triggerResult.triggered) {
    return createStandardChangeOrder({
      activeWO,
      po,
      missingEffects,
      toolName,
      toolProfile,
      patternStore,
      ambiguity,
    });
  }

  // Step 4: EAA triggered → run adjudication
  log.debug(
    `EAA triggered: categories=[${triggerResult.categories.join(",")}] ` +
      `severity=${triggerResult.severity.toFixed(2)}`,
  );

  if (!infer) {
    log.warn("EAA triggered but no inference function provided; refusing");
    return {
      action: "refused",
      reason:
        `EAA triggered (${triggerResult.categories.join(", ")}) but no LLM inference ` +
        "function is available. Cannot complete elevated action analysis.",
    };
  }

  const eaaResult = await runElevatedActionAnalysis({
    po,
    activeWO,
    toolName,
    toolProfile,
    triggerResult,
    consentRecords,
    eaaRecords,
    dutyConstraints,
    infer,
  });

  if (!eaaResult.ok) {
    log.warn(`EAA failed: ${eaaResult.reason}; fallback outcome=${eaaResult.fallbackOutcome}`);
    return {
      action: "refused",
      reason: `EAA analysis failed: ${eaaResult.reason}. Fallback: ${eaaResult.fallbackOutcome}.`,
    };
  }

  // Persist the EAA record
  persistEAARecord(eaaResult.eaaRecord, consentRecordStore);

  return processEAAOutcome({
    eaaResult,
    triggerResult,
    po,
    activeWO,
    toolName,
    toolProfile,
    missingEffects,
    patternStore,
    ambiguity,
    policies,
    systemProhibitions,
  });
}

// ---------------------------------------------------------------------------
// EAA Outcome Processing
// ---------------------------------------------------------------------------

type ProcessEAAOutcomeParams = {
  eaaResult: Extract<EAARunResult, { ok: true }>;
  triggerResult: EAATriggerResult;
  po: PurchaseOrder;
  activeWO: WorkOrder;
  toolName: string;
  toolProfile: ToolEffectProfile;
  missingEffects: EffectClass[];
  patternStore?: ConsentPatternStore;
  ambiguity?: AmbiguityAssessment;
  policies?: readonly (StandingPolicyStub | BinderPolicy)[];
  systemProhibitions?: EffectClass[];
};

function processEAAOutcome(params: ProcessEAAOutcomeParams): ConsentFailureResolution {
  const {
    eaaResult,
    po,
    activeWO,
    toolName,
    toolProfile,
    missingEffects,
    patternStore,
    ambiguity,
    policies = [],
    systemProhibitions = [],
  } = params;
  const { adjudication, reasoning, eaaRecord } = eaaResult;
  const outcome = adjudication.outcome;

  switch (outcome) {
    case "proceed": {
      const result = mintSuccessorWithAnchor({
        currentWO: activeWO,
        po,
        toolProfile,
        additionalEffects: adjudication.recommendedEffects,
        anchor: { kind: "eaa", eaaRecordId: eaaRecord.id },
        policies,
        systemProhibitions,
      });
      if (!result.ok) {
        log.warn(`proceed: successor WO refused by binder: ${result.reason}`);
        return {
          action: "refused",
          reason: `EAA recommended proceed but binder refused successor WO: ${result.reason}`,
        };
      }
      transitionWorkOrder(result.wo);
      return {
        action: "eaa-resolved",
        outcome: "proceed",
        successorWO: result.wo,
        explanation: reasoning.justification,
        adjudication,
        reasoning,
      };
    }

    case "request-consent": {
      // Enriched CO with EAA context
      const coResult = requestChangeOrder({
        currentWO: activeWO,
        po,
        missingEffects,
        toolName,
        toolEffectProfile: toolProfile,
        reason: `EAA analysis recommends explicit consent: ${reasoning.justification}`,
        patternStore,
        ambiguity,
      });
      if (!coResult.ok) {
        return {
          action: "refused",
          reason: `EAA recommended request-consent but CO creation failed: ${coResult.reason}`,
        };
      }
      return { action: "co-requested", changeOrder: coResult.changeOrder };
    }

    case "constrained-comply": {
      const constraints = adjudication.recommendedConstraints;
      const result = mintSuccessorWithAnchor({
        currentWO: activeWO,
        po,
        toolProfile,
        additionalEffects: adjudication.recommendedEffects,
        anchor: { kind: "eaa", eaaRecordId: eaaRecord.id },
        constraints,
        policies,
        systemProhibitions,
      });
      if (!result.ok) {
        log.warn(`constrained-comply: successor WO refused by binder: ${result.reason}`);
        return {
          action: "refused",
          reason: `EAA recommended constrained-comply but binder refused: ${result.reason}`,
        };
      }
      transitionWorkOrder(result.wo);
      return {
        action: "eaa-resolved",
        outcome: "constrained-comply",
        successorWO: result.wo,
        explanation: reasoning.justification,
        adjudication,
        reasoning,
      };
    }

    case "emergency-act": {
      const constraints = adjudication.recommendedConstraints;
      const result = mintSuccessorWithAnchor({
        currentWO: activeWO,
        po,
        toolProfile,
        additionalEffects: adjudication.recommendedEffects,
        anchor: { kind: "eaa", eaaRecordId: eaaRecord.id },
        constraints,
        policies,
        systemProhibitions,
      });
      if (!result.ok) {
        log.warn(`emergency-act: successor WO refused by binder: ${result.reason}`);
        return {
          action: "refused",
          reason: `EAA recommended emergency-act but binder refused: ${result.reason}`,
        };
      }
      transitionWorkOrder(result.wo);
      return {
        action: "eaa-resolved",
        outcome: "emergency-act",
        successorWO: result.wo,
        explanation: reasoning.justification,
        adjudication,
        reasoning,
      };
    }

    case "refuse":
      return {
        action: "eaa-resolved",
        outcome: "refuse",
        explanation: reasoning.justification,
        adjudication,
        reasoning,
      };

    case "escalate":
      return {
        action: "eaa-resolved",
        outcome: "escalate",
        explanation: reasoning.justification,
        adjudication,
        reasoning,
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStandardChangeOrder(params: {
  activeWO: WorkOrder;
  po: PurchaseOrder;
  missingEffects: EffectClass[];
  toolName: string;
  toolProfile: ToolEffectProfile;
  patternStore?: ConsentPatternStore;
  ambiguity?: AmbiguityAssessment;
}): ConsentFailureResolution {
  const coResult = requestChangeOrder({
    currentWO: params.activeWO,
    po: params.po,
    missingEffects: params.missingEffects,
    toolName: params.toolName,
    toolEffectProfile: params.toolProfile,
    reason: "Tool requires effects not covered by the active Work Order",
    patternStore: params.patternStore,
    ambiguity: params.ambiguity,
  });

  if (!coResult.ok) {
    return {
      action: "refused",
      reason: `Change order creation failed: ${coResult.reason}`,
    };
  }

  return { action: "co-requested", changeOrder: coResult.changeOrder };
}

type MintSuccessorParams = {
  currentWO: WorkOrder;
  po: PurchaseOrder;
  toolProfile: ToolEffectProfile;
  additionalEffects: EffectClass[];
  anchor: ConsentAnchor;
  constraints?: WOConstraint[];
  /** Standing policies for the binder (Phase 5i). */
  policies?: readonly (StandingPolicyStub | BinderPolicy)[];
  systemProhibitions?: EffectClass[];
};

function mintSuccessorWithAnchor(params: MintSuccessorParams) {
  return mintSuccessorWorkOrder({
    currentWO: params.currentWO,
    po: params.po,
    stepEffectProfile: params.toolProfile,
    newAnchors: [params.anchor],
    additionalEffects: params.additionalEffects,
    policies: params.policies ?? [],
    systemProhibitions: params.systemProhibitions ?? [],
    constraints: params.constraints,
  });
}

function persistEAARecord(eaaRecord: EAARecord, consentRecordStore?: ConsentRecordStore): void {
  try {
    addEAARecord(eaaRecord);
  } catch (err) {
    log.debug(`failed to add EAA record to scope chain: ${String(err)}`);
  }
  if (consentRecordStore) {
    try {
      consentRecordStore.insertEAARecord(eaaRecord);
    } catch (err) {
      log.debug(`failed to persist EAA record to store: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  createStandardChangeOrder,
  mintSuccessorWithAnchor,
  persistEAARecord,
  processEAAOutcome,
};
