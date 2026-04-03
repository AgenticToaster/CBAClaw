/**
 * Change Order (CO) Lifecycle Manager
 *
 * Handles the explicit consent flow when a tool call requires effects not
 * covered by the active Work Order. The CO bridges the gap between the
 * WO verification failure and the successor WO that expands grants.
 *
 * Flow:
 * 1. verifyToolConsent → effect-not-granted → requestChangeOrder()
 * 2. CO is created with human-readable effect description
 * 3. External surface (UI/gateway) resolves the CO (grant or deny)
 * 4. On grant: binder mints WO' → scope transitions → tool retried
 * 5. On deny: agent must replan within current WO or refuse
 *
 * Includes:
 * - Reverse pattern lookup for generating CO effect descriptions without LLM
 * - Request ambiguity detection via vector distance analysis
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mintSuccessorWorkOrder, verifyConsentAnchorAgainstRecords } from "./binder.js";
import type { ConsentPatternStore, PatternSearchResult } from "./implied-consent-store.js";
import {
  addConsentRecord,
  getConsentRecords,
  getEAARecords,
  requireConsentScope,
  transitionWorkOrder,
} from "./scope-chain.js";
import type {
  ChangeOrder,
  ConsentAnchor,
  ConsentRecord,
  EffectClass,
  PurchaseOrder,
  ToolEffectProfile,
  WOConstraint,
  WorkOrder,
} from "./types.js";

const log = createSubsystemLogger("consent/change-order");

// ---------------------------------------------------------------------------
// Effect Description Generation
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions for each effect class, used to build
 * CO approval prompts without LLM calls.
 */
const EFFECT_DESCRIPTIONS: Record<EffectClass, string> = {
  read: "read data from the filesystem or external sources",
  compose: "create or draft content internally",
  persist: "write or modify files and persistent state",
  disclose: "send information to external recipients or services",
  "audience-expand": "broaden the audience or add new recipients",
  irreversible: "perform actions that cannot be undone (deletion, revocation)",
  exec: "execute commands on the host system",
  network: "make outbound network requests",
  elevated: "perform administrative or privileged operations",
  physical: "actuate physical devices or hardware",
};

/**
 * Risk tiers for effect classes. Higher-risk effects get stronger
 * language in CO descriptions and are more likely to trigger ambiguity
 * warnings.
 */
const HIGH_RISK_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "irreversible",
  "elevated",
  "disclose",
  "audience-expand",
  "exec",
  "physical",
]);

/**
 * Find patterns in the consent pattern store whose effects overlap with the
 * given effect classes. Used to generate grounded CO descriptions by surfacing
 * representative natural-language phrases.
 *
 * This is a SQL-level filter (no vector search needed) on the patterns table.
 */
export function findPatternsForEffects(
  store: ConsentPatternStore,
  effects: EffectClass[],
  limit = 5,
): PatternSearchResult[] {
  const allPatterns = store.getAllPatterns();
  const targetSet = new Set(effects);

  const matching = allPatterns
    .filter((p) => p.effects.some((e) => targetSet.has(e)))
    .slice(0, limit)
    .map((pattern) => ({ pattern, distance: 0 }));

  return matching;
}

/**
 * Generate a human-readable effect description for a Change Order.
 * Combines static effect descriptions with optional pattern store context.
 */
export function generateEffectDescription(
  missingEffects: EffectClass[],
  patternExamples?: PatternSearchResult[],
  ambiguityInfo?: AmbiguityAssessment,
): string {
  if (missingEffects.length === 0) {
    return "No additional effects are needed.";
  }

  const effectParts = missingEffects.map((e) => EFFECT_DESCRIPTIONS[e] ?? e);
  let description = `This action requires permission to: ${effectParts.join("; ")}.`;

  if (patternExamples && patternExamples.length > 0) {
    const examples = patternExamples
      .slice(0, 3)
      .map((r) => `"${r.pattern.text}"`)
      .join(", ");
    description += ` Similar to: ${examples}.`;
  }

  if (ambiguityInfo?.ambiguous) {
    const highRiskMissing = missingEffects.filter((e) => HIGH_RISK_EFFECTS.has(e));
    if (highRiskMissing.length > 0) {
      description +=
        " Note: The intent of your request is unclear, and these effects carry elevated risk.";
    }
  }

  return description;
}

// ---------------------------------------------------------------------------
// Ambiguity Detection
// ---------------------------------------------------------------------------

/** Threshold above which the closest vector match is considered ambiguous. */
const DEFAULT_AMBIGUITY_THRESHOLD = 0.6;

export type AmbiguityAssessment = {
  /** Whether the request is considered ambiguous. */
  ambiguous: boolean;
  /** Cosine distance of the closest pattern match (lower = more similar). */
  bestDistance: number;
  /** Number of patterns within the match threshold. */
  matchCount: number;
};

/**
 * Assess request ambiguity using vector search distance as a signal.
 *
 * When the closest pattern match exceeds the ambiguity threshold, the request
 * is flagged as underspecified. This feeds into EAA trigger detection (Phase 4)
 * and CO description enrichment.
 */
export async function assessRequestAmbiguity(params: {
  requestText: string;
  store: ConsentPatternStore;
  embedQuery: (text: string) => Promise<number[]>;
  ambiguityThreshold?: number;
  topK?: number;
}): Promise<AmbiguityAssessment> {
  const threshold = params.ambiguityThreshold ?? DEFAULT_AMBIGUITY_THRESHOLD;
  const topK = params.topK ?? 5;

  try {
    const queryEmbedding = await params.embedQuery(params.requestText);
    const queryVec = new Float32Array(queryEmbedding);

    // Use a generous search threshold to capture even distant matches
    const results = params.store.searchSimilarPatterns(queryVec, topK, 2.0);

    if (results.length === 0) {
      return { ambiguous: true, bestDistance: 2.0, matchCount: 0 };
    }

    const bestDistance = results[0].distance;
    const matchCount = results.filter((r) => r.distance <= threshold).length;

    return {
      ambiguous: bestDistance > threshold,
      bestDistance,
      matchCount,
    };
  } catch (err) {
    log.debug(`ambiguity assessment failed, assuming ambiguous: ${String(err)}`);
    return { ambiguous: true, bestDistance: 2.0, matchCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Change Order Lifecycle
// ---------------------------------------------------------------------------

/** Active COs indexed by ID. Cleared per session. */
const _pendingOrders = new Map<string, ChangeOrder>();

export type RequestChangeOrderParams = {
  /** The active WO that lacks the needed effects. */
  currentWO: WorkOrder;
  /** The PO for this request context. */
  po: PurchaseOrder;
  /** Missing effect classes from the WO verification failure. */
  missingEffects: EffectClass[];
  /** Tool name that triggered the CO. */
  toolName: string;
  /** Tool's effect profile. */
  toolEffectProfile?: ToolEffectProfile;
  /** Why the agent needs these effects. */
  reason: string;
  /** Pattern store for generating grounded descriptions (optional). */
  patternStore?: ConsentPatternStore;
  /** Pre-computed ambiguity assessment (optional). */
  ambiguity?: AmbiguityAssessment;
};

export type RequestChangeOrderResult =
  | { ok: true; changeOrder: ChangeOrder }
  | { ok: false; reason: string };

/**
 * Create a Change Order requesting explicit consent for missing effects.
 * The CO is placed in a pending state awaiting resolution by the user
 * via the gateway/UI surface.
 */
export function requestChangeOrder(params: RequestChangeOrderParams): RequestChangeOrderResult {
  const { currentWO, po, missingEffects, toolName, reason, patternStore, ambiguity } = params;

  if (missingEffects.length === 0) {
    return { ok: false, reason: "No missing effects to request" };
  }

  let patternExamples: PatternSearchResult[] | undefined;
  if (patternStore) {
    try {
      patternExamples = findPatternsForEffects(patternStore, missingEffects);
    } catch (err) {
      log.debug(`pattern lookup for CO description failed: ${String(err)}`);
    }
  }

  const effectDescription = generateEffectDescription(missingEffects, patternExamples, ambiguity);

  const co: ChangeOrder = {
    id: randomUUID(),
    currentWoId: currentWO.id,
    requestContextId: po.id,
    requestedEffects: [...missingEffects],
    reason: `Tool "${toolName}": ${reason}`,
    effectDescription,
    status: "pending",
    createdAt: Date.now(),
  };

  _pendingOrders.set(co.id, co);

  log.debug(
    `change order created: id=${co.id} effects=[${missingEffects.join(",")}] tool=${toolName}`,
  );

  return { ok: true, changeOrder: co };
}

export type ResolveChangeOrderParams = {
  /** The CO being resolved. */
  changeOrderId: string;
  /** Whether the user granted or denied the CO. */
  decision: "granted" | "denied";
  /** Additional constraints to apply if granted. */
  constraints?: WOConstraint[];
  /** Consent record expiry (ms from now). */
  consentExpiresInMs?: number;
};

export type ResolveChangeOrderResult =
  | { ok: true; changeOrder: ChangeOrder; successorWO?: WorkOrder }
  | { ok: false; reason: string };

/**
 * Resolve a pending Change Order. On grant, creates a consent record,
 * mints a successor WO with expanded effects, and transitions the scope.
 * On deny, the CO is marked denied and the agent must replan.
 */
export function resolveChangeOrder(params: ResolveChangeOrderParams): ResolveChangeOrderResult {
  const co = _pendingOrders.get(params.changeOrderId);
  if (!co) {
    return { ok: false, reason: `Change Order ${params.changeOrderId} not found` };
  }

  if (co.status !== "pending") {
    return { ok: false, reason: `Change Order ${co.id} is already ${co.status}` };
  }

  const now = Date.now();

  if (params.decision === "denied") {
    _pendingOrders.delete(co.id);

    log.debug(`change order denied: id=${co.id}`);
    return { ok: true, changeOrder: { ...co, status: "denied", resolvedAt: now } };
  }

  // Grant path: create consent record, mint successor WO, transition scope
  const scope = requireConsentScope();

  const consentRecord: ConsentRecord = {
    id: randomUUID(),
    poId: co.requestContextId,
    woId: co.currentWoId,
    effectClasses: [...co.requestedEffects],
    decision: "granted",
    timestamp: now,
    expiresAt: params.consentExpiresInMs ? now + params.consentExpiresInMs : undefined,
    metadata: { changeOrderId: co.id, source: "change-order" },
  };

  addConsentRecord(consentRecord);

  const newAnchor: ConsentAnchor = { kind: "explicit", consentRecordId: consentRecord.id };

  // Resolve the tool's effect profile for the ceiling check
  const toolProfile: ToolEffectProfile = {
    effects: [...new Set([...scope.activeWO.grantedEffects, ...co.requestedEffects])],
    description: `CO-expanded profile for ${co.reason}`,
  };

  const consentRecords = getConsentRecords() ?? [];
  const eaaRecords = getEAARecords() ?? [];

  // Validate the consent anchor
  const anchorValidation = verifyConsentAnchorAgainstRecords(
    newAnchor,
    co.requestedEffects,
    consentRecords,
    eaaRecords,
  );

  if (!anchorValidation.valid) {
    return {
      ok: false,
      reason: `Consent anchor validation failed: ${anchorValidation.reason}`,
    };
  }

  const mintResult = mintSuccessorWorkOrder({
    currentWO: scope.activeWO,
    po: scope.po,
    stepEffectProfile: toolProfile,
    newAnchors: [newAnchor],
    additionalEffects: co.requestedEffects,
    policies: [],
    systemProhibitions: [],
    constraints: params.constraints,
  });

  if (!mintResult.ok) {
    return {
      ok: false,
      reason: `Failed to mint successor WO: ${mintResult.reason} (code=${mintResult.code})`,
    };
  }

  transitionWorkOrder(mintResult.wo);

  const resolvedCO: ChangeOrder = {
    ...co,
    status: "granted",
    resolvedAt: now,
    successorWoId: mintResult.wo.id,
  };

  _pendingOrders.delete(co.id);

  log.debug(
    `change order granted: id=${co.id} successorWO=${mintResult.wo.id} ` +
      `effects=[${mintResult.wo.grantedEffects.join(",")}]`,
  );

  return { ok: true, changeOrder: resolvedCO, successorWO: mintResult.wo };
}

// ---------------------------------------------------------------------------
// CO Queries
// ---------------------------------------------------------------------------

/** Get a pending Change Order by ID. */
export function getPendingChangeOrder(id: string): ChangeOrder | undefined {
  return _pendingOrders.get(id);
}

/** Get all pending Change Orders. */
export function getAllPendingChangeOrders(): ChangeOrder[] {
  return [..._pendingOrders.values()];
}

/** Expire a pending CO that has exceeded a timeout. */
export function expireChangeOrder(id: string): boolean {
  const co = _pendingOrders.get(id);
  if (!co || co.status !== "pending") {
    return false;
  }
  _pendingOrders.delete(id);
  log.debug(`change order expired: id=${id}`);
  return true;
}

/** Withdraw a pending CO (agent-initiated cancellation). */
export function withdrawChangeOrder(id: string): boolean {
  const co = _pendingOrders.get(id);
  if (!co || co.status !== "pending") {
    return false;
  }
  _pendingOrders.delete(id);
  log.debug(`change order withdrawn: id=${id}`);
  return true;
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  clearPendingOrders(): void {
    _pendingOrders.clear();
  },
  get pendingOrderCount(): number {
    return _pendingOrders.size;
  },
  EFFECT_DESCRIPTIONS,
  HIGH_RISK_EFFECTS,
  DEFAULT_AMBIGUITY_THRESHOLD,
};
