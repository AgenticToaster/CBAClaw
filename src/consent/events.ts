/**
 * Consent Scope Chain Event Model (Phase 6a)
 *
 * Defines structured, typed events for the full consent lifecycle:
 * WO minting/expiry/supersession, CO request/grant/deny, EAA start/complete,
 * effect execution, consent revocation/withdrawal, and breach detection.
 *
 * Events are emitted to registered listeners via a lightweight synchronous
 * bus backed by the consent scope's AsyncLocalStorage. The bus is decoupled
 * from the gateway broadcast layer — callers bridge into the gateway event
 * system (or any other transport) by subscribing a forwarding listener.
 *
 * Design:
 *  - Events are immutable, timestamped, and carry enough context for audit
 *    without duplicating full WO/PO payloads (use IDs + summary fields).
 *  - The emitter is fail-safe: listener exceptions are caught and logged,
 *    never propagating into the consent pipeline.
 *  - Listeners can be scoped (per-run via scope state) or global (module-level).
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EAAOutcome, EffectClass, WOConstraint } from "./types.js";

const log = createSubsystemLogger("consent/events");

// ---------------------------------------------------------------------------
// Event Type Taxonomy
// ---------------------------------------------------------------------------

export type ConsentEventType =
  | "wo.minted"
  | "wo.expired"
  | "wo.superseded"
  | "co.requested"
  | "co.granted"
  | "co.denied"
  | "co.expired"
  | "co.withdrawn"
  | "eaa.started"
  | "eaa.completed"
  | "effect.executed"
  | "consent.granted"
  | "consent.revoked"
  | "consent.withdrawn"
  | "policy.applied"
  | "policy.escalated"
  | "policy.proposed"
  | "policy.confirmed"
  | "breach.detected"
  | "breach.contained"
  | "breach.remediated";

// ---------------------------------------------------------------------------
// Event Payload Types
// ---------------------------------------------------------------------------

/** Common fields present on every consent event. */
export type ConsentEventBase = {
  /** Unique event ID. */
  id: string;
  /** Discriminant for the event type. */
  type: ConsentEventType;
  /** Epoch ms when the event was created. */
  timestamp: number;
  /** Purchase Order ID that scopes this event. */
  poId: string;
  /** Agent ID (when available). */
  agentId?: string;
  /** Session key (when available). */
  sessionKey?: string;
};

export type WOMintedEvent = ConsentEventBase & {
  type: "wo.minted";
  woId: string;
  predecessorWoId?: string;
  grantedEffects: readonly EffectClass[];
  constraints: readonly WOConstraint[];
  anchorKinds: string[];
};

export type WOExpiredEvent = ConsentEventBase & {
  type: "wo.expired";
  woId: string;
  grantedEffects: readonly EffectClass[];
  mintedAt: number;
  expiresAt: number;
};

export type WOSupersededEvent = ConsentEventBase & {
  type: "wo.superseded";
  predecessorWoId: string;
  successorWoId: string;
  addedEffects: EffectClass[];
  removedEffects: EffectClass[];
};

export type CORequestedEvent = ConsentEventBase & {
  type: "co.requested";
  coId: string;
  woId: string;
  requestedEffects: EffectClass[];
  toolName: string;
  effectDescription: string;
};

export type COGrantedEvent = ConsentEventBase & {
  type: "co.granted";
  coId: string;
  grantedEffects: EffectClass[];
  successorWoId: string;
};

export type CODeniedEvent = ConsentEventBase & {
  type: "co.denied";
  coId: string;
  deniedEffects: EffectClass[];
};

export type COExpiredEvent = ConsentEventBase & {
  type: "co.expired";
  coId: string;
};

export type COWithdrawnEvent = ConsentEventBase & {
  type: "co.withdrawn";
  coId: string;
};

export type EAAStartedEvent = ConsentEventBase & {
  type: "eaa.started";
  toolName: string;
  triggerCategories: string[];
  severity: number;
};

export type EAACompletedEvent = ConsentEventBase & {
  type: "eaa.completed";
  eaaRecordId: string;
  outcome: EAAOutcome;
  toolName: string;
  /** Duration of the EAA adjudication in ms. */
  durationMs: number;
};

export type EffectExecutedEvent = ConsentEventBase & {
  type: "effect.executed";
  woId: string;
  toolName: string;
  effectClasses: EffectClass[];
  /** Whether the execution succeeded. */
  success: boolean;
};

export type ConsentGrantedEvent = ConsentEventBase & {
  type: "consent.granted";
  consentRecordId: string;
  effectClasses: EffectClass[];
  source: "change-order" | "precedent" | "policy" | "implied";
};

export type ConsentRevokedEvent = ConsentEventBase & {
  type: "consent.revoked";
  revokedEffects: EffectClass[];
  revokedRecordCount: number;
  reason: string;
};

export type ConsentWithdrawnEvent = ConsentEventBase & {
  type: "consent.withdrawn";
  withdrawalReason: string;
  affectedEffects: EffectClass[];
  explanation: string;
};

export type PolicyAppliedEvent = ConsentEventBase & {
  type: "policy.applied";
  policyId: string;
  policyClass: string;
  grantedEffects: EffectClass[];
  woId: string;
};

export type PolicyEscalatedEvent = ConsentEventBase & {
  type: "policy.escalated";
  policyId: string;
  escalationAction: string;
  reason: string;
};

export type PolicyProposedEvent = ConsentEventBase & {
  type: "policy.proposed";
  policyId: string;
  effectScope: EffectClass[];
  rationale: string;
};

export type PolicyConfirmedEvent = ConsentEventBase & {
  type: "policy.confirmed";
  policyId: string;
  effectScope: EffectClass[];
};

export type BreachDetectedEvent = ConsentEventBase & {
  type: "breach.detected";
  woId: string;
  toolName: string;
  violationType: "effect-not-granted" | "wo-expired" | "constraint-violated" | "integrity-failed";
  details: string;
};

export type BreachContainedEvent = ConsentEventBase & {
  type: "breach.contained";
  breachEventId: string;
  containmentAction: string;
};

export type BreachRemediatedEvent = ConsentEventBase & {
  type: "breach.remediated";
  breachEventId: string;
  remediationAction: string;
};

/** Discriminated union of all consent events. */
export type ConsentEvent =
  | WOMintedEvent
  | WOExpiredEvent
  | WOSupersededEvent
  | CORequestedEvent
  | COGrantedEvent
  | CODeniedEvent
  | COExpiredEvent
  | COWithdrawnEvent
  | EAAStartedEvent
  | EAACompletedEvent
  | EffectExecutedEvent
  | ConsentGrantedEvent
  | ConsentRevokedEvent
  | ConsentWithdrawnEvent
  | PolicyAppliedEvent
  | PolicyEscalatedEvent
  | PolicyProposedEvent
  | PolicyConfirmedEvent
  | BreachDetectedEvent
  | BreachContainedEvent
  | BreachRemediatedEvent;

// ---------------------------------------------------------------------------
// Listener Types
// ---------------------------------------------------------------------------

export type ConsentEventListener = (event: ConsentEvent) => void;

/**
 * Typed listener that receives only events of a specific type.
 * Used with subscribeToEventType for filtered subscriptions.
 */
export type TypedConsentEventListener<T extends ConsentEventType> = (
  event: Extract<ConsentEvent, { type: T }>,
) => void;

// ---------------------------------------------------------------------------
// Event Bus (module-level, global listeners)
// ---------------------------------------------------------------------------

const _globalListeners: Set<ConsentEventListener> = new Set();
const _typedListeners: Map<ConsentEventType, Set<ConsentEventListener>> = new Map();

/**
 * Subscribe a global listener that receives all consent events.
 * Returns an unsubscribe function.
 */
export function subscribeToConsentEvents(listener: ConsentEventListener): () => void {
  _globalListeners.add(listener);
  return () => {
    _globalListeners.delete(listener);
  };
}

/**
 * Subscribe a typed listener that receives only events of the specified type.
 * Returns an unsubscribe function.
 */
export function subscribeToEventType<T extends ConsentEventType>(
  type: T,
  listener: TypedConsentEventListener<T>,
): () => void {
  let set = _typedListeners.get(type);
  if (!set) {
    set = new Set();
    _typedListeners.set(type, set);
  }
  // Cast is safe: the emitter dispatches the correctly narrowed type
  set.add(listener as ConsentEventListener);
  return () => {
    set.delete(listener as ConsentEventListener);
    if (set.size === 0) {
      _typedListeners.delete(type);
    }
  };
}

/**
 * Emit a consent event to all registered listeners. Listener exceptions
 * are caught and logged — they never propagate into the consent pipeline.
 */
export function emitConsentEvent(event: ConsentEvent): void {
  for (const listener of _globalListeners) {
    try {
      listener(event);
    } catch (err) {
      log.debug(`consent event listener error (global): ${String(err)}`);
    }
  }

  const typed = _typedListeners.get(event.type);
  if (typed) {
    for (const listener of typed) {
      try {
        listener(event);
      } catch (err) {
        log.debug(`consent event listener error (typed/${event.type}): ${String(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event Factory Helpers
// ---------------------------------------------------------------------------

/**
 * Build the common base fields for a consent event. Callers spread
 * this into the event-specific payload.
 */
export function buildEventBase<T extends ConsentEventType>(
  type: T,
  poId: string,
  opts?: { agentId?: string; sessionKey?: string },
): ConsentEventBase & { type: T } {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    poId,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
  };
}

/**
 * Emit a wo.minted event.
 */
export function emitWOMinted(params: {
  poId: string;
  woId: string;
  predecessorWoId?: string;
  grantedEffects: readonly EffectClass[];
  constraints: readonly WOConstraint[];
  anchorKinds: string[];
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("wo.minted", params.poId, params),
    woId: params.woId,
    predecessorWoId: params.predecessorWoId,
    grantedEffects: params.grantedEffects,
    constraints: params.constraints,
    anchorKinds: params.anchorKinds,
  });
}

/**
 * Emit a wo.superseded event.
 */
export function emitWOSuperseded(params: {
  poId: string;
  predecessorWoId: string;
  successorWoId: string;
  addedEffects: EffectClass[];
  removedEffects: EffectClass[];
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("wo.superseded", params.poId, params),
    predecessorWoId: params.predecessorWoId,
    successorWoId: params.successorWoId,
    addedEffects: params.addedEffects,
    removedEffects: params.removedEffects,
  });
}

/**
 * Emit a co.requested event.
 */
export function emitCORequested(params: {
  poId: string;
  coId: string;
  woId: string;
  requestedEffects: EffectClass[];
  toolName: string;
  effectDescription: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("co.requested", params.poId, params),
    coId: params.coId,
    woId: params.woId,
    requestedEffects: params.requestedEffects,
    toolName: params.toolName,
    effectDescription: params.effectDescription,
  });
}

/**
 * Emit a co.granted event.
 */
export function emitCOGranted(params: {
  poId: string;
  coId: string;
  grantedEffects: EffectClass[];
  successorWoId: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("co.granted", params.poId, params),
    coId: params.coId,
    grantedEffects: params.grantedEffects,
    successorWoId: params.successorWoId,
  });
}

/**
 * Emit a co.denied event.
 */
export function emitCODenied(params: {
  poId: string;
  coId: string;
  deniedEffects: EffectClass[];
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("co.denied", params.poId, params),
    coId: params.coId,
    deniedEffects: params.deniedEffects,
  });
}

/**
 * Emit an eaa.started event.
 */
export function emitEAAStarted(params: {
  poId: string;
  toolName: string;
  triggerCategories: string[];
  severity: number;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("eaa.started", params.poId, params),
    toolName: params.toolName,
    triggerCategories: params.triggerCategories,
    severity: params.severity,
  });
}

/**
 * Emit an eaa.completed event.
 */
export function emitEAACompleted(params: {
  poId: string;
  eaaRecordId: string;
  outcome: EAAOutcome;
  toolName: string;
  durationMs: number;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("eaa.completed", params.poId, params),
    eaaRecordId: params.eaaRecordId,
    outcome: params.outcome,
    toolName: params.toolName,
    durationMs: params.durationMs,
  });
}

/**
 * Emit an effect.executed event.
 */
export function emitEffectExecuted(params: {
  poId: string;
  woId: string;
  toolName: string;
  effectClasses: EffectClass[];
  success: boolean;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("effect.executed", params.poId, params),
    woId: params.woId,
    toolName: params.toolName,
    effectClasses: params.effectClasses,
    success: params.success,
  });
}

/**
 * Emit a consent.revoked event.
 */
export function emitConsentRevoked(params: {
  poId: string;
  revokedEffects: EffectClass[];
  revokedRecordCount: number;
  reason: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("consent.revoked", params.poId, params),
    revokedEffects: params.revokedEffects,
    revokedRecordCount: params.revokedRecordCount,
    reason: params.reason,
  });
}

/**
 * Emit a consent.withdrawn event.
 */
export function emitConsentWithdrawn(params: {
  poId: string;
  withdrawalReason: string;
  affectedEffects: EffectClass[];
  explanation: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("consent.withdrawn", params.poId, params),
    withdrawalReason: params.withdrawalReason,
    affectedEffects: params.affectedEffects,
    explanation: params.explanation,
  });
}

/**
 * Emit a wo.expired event.
 */
export function emitWOExpired(params: {
  poId: string;
  woId: string;
  grantedEffects: readonly EffectClass[];
  mintedAt: number;
  expiresAt: number;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("wo.expired", params.poId, params),
    woId: params.woId,
    grantedEffects: params.grantedEffects,
    mintedAt: params.mintedAt,
    expiresAt: params.expiresAt,
  });
}

/**
 * Emit a co.expired event.
 */
export function emitCOExpired(params: {
  poId: string;
  coId: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("co.expired", params.poId, params),
    coId: params.coId,
  });
}

/**
 * Emit a co.withdrawn event.
 */
export function emitCOWithdrawn(params: {
  poId: string;
  coId: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("co.withdrawn", params.poId, params),
    coId: params.coId,
  });
}

/**
 * Emit a consent.granted event.
 */
export function emitConsentGranted(params: {
  poId: string;
  consentRecordId: string;
  effectClasses: EffectClass[];
  source: ConsentGrantedEvent["source"];
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("consent.granted", params.poId, params),
    consentRecordId: params.consentRecordId,
    effectClasses: params.effectClasses,
    source: params.source,
  });
}

/**
 * Emit a policy.applied event.
 */
export function emitPolicyApplied(params: {
  poId: string;
  policyId: string;
  policyClass: string;
  grantedEffects: EffectClass[];
  woId: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("policy.applied", params.poId, params),
    policyId: params.policyId,
    policyClass: params.policyClass,
    grantedEffects: params.grantedEffects,
    woId: params.woId,
  });
}

/**
 * Emit a policy.escalated event.
 */
export function emitPolicyEscalated(params: {
  poId: string;
  policyId: string;
  escalationAction: string;
  reason: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("policy.escalated", params.poId, params),
    policyId: params.policyId,
    escalationAction: params.escalationAction,
    reason: params.reason,
  });
}

/**
 * Emit a policy.proposed event.
 */
export function emitPolicyProposed(params: {
  poId: string;
  policyId: string;
  effectScope: EffectClass[];
  rationale: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("policy.proposed", params.poId, params),
    policyId: params.policyId,
    effectScope: params.effectScope,
    rationale: params.rationale,
  });
}

/**
 * Emit a policy.confirmed event.
 */
export function emitPolicyConfirmed(params: {
  poId: string;
  policyId: string;
  effectScope: EffectClass[];
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("policy.confirmed", params.poId, params),
    policyId: params.policyId,
    effectScope: params.effectScope,
  });
}

/**
 * Emit a breach.detected event.
 */
export function emitBreachDetected(params: {
  poId: string;
  woId: string;
  toolName: string;
  violationType: BreachDetectedEvent["violationType"];
  details: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("breach.detected", params.poId, params),
    woId: params.woId,
    toolName: params.toolName,
    violationType: params.violationType,
    details: params.details,
  });
}

/**
 * Emit a breach.contained event.
 */
export function emitBreachContained(params: {
  poId: string;
  breachEventId: string;
  containmentAction: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("breach.contained", params.poId, params),
    breachEventId: params.breachEventId,
    containmentAction: params.containmentAction,
  });
}

/**
 * Emit a breach.remediated event.
 */
export function emitBreachRemediated(params: {
  poId: string;
  breachEventId: string;
  remediationAction: string;
  agentId?: string;
  sessionKey?: string;
}): void {
  emitConsentEvent({
    ...buildEventBase("breach.remediated", params.poId, params),
    breachEventId: params.breachEventId,
    remediationAction: params.remediationAction,
  });
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  clearAllListeners(): void {
    _globalListeners.clear();
    _typedListeners.clear();
  },
  get globalListenerCount(): number {
    return _globalListeners.size;
  },
  get typedListenerCount(): number {
    let count = 0;
    for (const set of _typedListeners.values()) {
      count += set.size;
    }
    return count;
  },
};
