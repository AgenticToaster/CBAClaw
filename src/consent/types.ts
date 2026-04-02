/**
 * Consent-Bound Agency: Core Type Definitions
 *
 * Implements the contract vocabulary from the Consent-Bound Agency framework:
 * Purchase Orders (PO), Work Orders (WO), Change Orders (CO), consent records,
 * effect classifications, and Elevated Action Analysis (EAA) artifacts.
 *
 * All effectful operations in the agent are governed by Work Orders minted
 * by the deterministic binder. Inference may advise but never directly
 * requests capabilities.
 */

// ---------------------------------------------------------------------------
// Phase 0: Effect Class Taxonomy
// ---------------------------------------------------------------------------

/**
 * Closed set of effect classes that categorize what a tool or action does
 * in terms of real-world impact. Effects are the unit of consent -- requestors
 * consent to effects, not to implementation details.
 */
export type EffectClass =
  | "read"
  | "compose"
  | "persist"
  | "disclose"
  | "audience-expand"
  | "irreversible"
  | "exec"
  | "network"
  | "elevated"
  | "physical";

/** All valid effect class values for runtime validation. */
export const EFFECT_CLASSES: readonly EffectClass[] = [
  "read",
  "compose",
  "persist",
  "disclose",
  "audience-expand",
  "irreversible",
  "exec",
  "network",
  "elevated",
  "physical",
] as const;

/**
 * Declares the effect footprint and trust posture of a tool.
 * Attached to tool registrations so the binder can compute ceiling checks.
 */
export type ToolEffectProfile = {
  effects: EffectClass[];
  trustTier?: TrustTier;
  /** Human-legible summary of what effects this tool produces. */
  description?: string;
};

export type TrustTier = "in-process" | "sandboxed" | "external";

// ---------------------------------------------------------------------------
// Phase 1: Contract Artifacts
// ---------------------------------------------------------------------------

/**
 * Purchase Order -- formalizes the request context that initiates a consent
 * contract. Derived from the incoming message/session at agent run start.
 * The PO captures who is asking, what they asked, and what effects are
 * reasonably implied by the request.
 */
export type PurchaseOrder = {
  id: string;
  requestText: string;
  senderId: string;
  senderIsOwner: boolean;
  channel?: string;
  chatType?: string;
  sessionKey?: string;
  agentId?: string;
  /** Effects reasonably implied by the request text (conservative derivation). */
  impliedEffects: EffectClass[];
  timestamp: number;
};

/**
 * Constraint on a Work Order that bounds what the granted effects may do.
 * Constraints are checked by the binder at mint time and can be verified
 * at enforcement time.
 */
export type WOConstraint =
  | WOTimeConstraint
  | WOAudienceConstraint
  | WOCountConstraint
  | WOCustomConstraint;

export type WOTimeConstraint = {
  kind: "time-bound";
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
};

export type WOAudienceConstraint = {
  kind: "audience";
  /** Allowed recipient/target identifiers. */
  allowedTargets: string[];
};

export type WOCountConstraint = {
  kind: "max-invocations";
  /** Maximum number of tool invocations under this WO. */
  maxInvocations: number;
};

export type WOCustomConstraint = {
  kind: "custom";
  label: string;
  /** Opaque, JSON-serializable constraint payload. */
  payload: Record<string, unknown>;
};

/**
 * Reference to a consent decision or EAA adjudication that justifies
 * a grant in a Work Order. The binder verifies anchors before minting.
 */
export type ConsentAnchor =
  | { kind: "implied"; poId: string }
  | { kind: "explicit"; consentRecordId: string }
  | { kind: "eaa"; eaaRecordId: string }
  | { kind: "policy"; policyId: string };

/**
 * Work Order -- the agent's scope-of-work contract for a bounded execution
 * slice. Immutable once minted. Scope changes produce a successor WO (WO')
 * with the predecessor linked via `predecessorId`.
 *
 * The WO is the continuity artifact carried through AsyncLocalStorage and
 * verified before every effectful tool invocation.
 */
export type WorkOrder = {
  id: string;
  /** Links to the predecessor WO when this is a requalification (WO'). */
  predecessorId?: string;
  /** Links back to the originating Purchase Order. */
  requestContextId: string;
  /** Effect classes this slice is permitted to cause. */
  grantedEffects: readonly EffectClass[];
  /** Operational bounds on the grants. */
  constraints: readonly WOConstraint[];
  /** Tool or skill identity for ceiling check. */
  stepRef?: string;
  /** References to consent decisions that justify the grants. */
  consentAnchors: readonly ConsentAnchor[];
  mintedAt: number;
  expiresAt?: number;
  /** Marker field -- WOs are immutable once created. */
  immutable: true;
  /**
   * JWS Compact Serialization (HS256, typ "wo+jwt") of the WO content.
   *
   * This is a standard JWT: `base64url(header).base64url(payload).base64url(signature)`
   * where the payload contains all WO content fields and the signature is
   * HMAC-SHA256 keyed by a configurable shared secret.
   *
   * Portable across service, MCP, skill, and language boundaries. Any
   * standard JWT library in any language can decode the payload and verify
   * the signature given the shared signing key. Use `decodeWorkOrderToken()`
   * on the receiving side, or any JWT library with HS256 + the shared key.
   */
  token: string;
};

/**
 * Change Order -- request to expand the consent boundary beyond what the
 * current WO permits. Generalizes the existing exec/plugin approval flow
 * into consent-level elicitation.
 */
export type ChangeOrder = {
  id: string;
  /** The WO that was active when the boundary was hit. */
  currentWoId: string;
  requestContextId: string;
  /** Additional effect classes being requested. */
  requestedEffects: EffectClass[];
  /** Human-legible explanation of why the expansion is needed. */
  reason: string;
  /** What the expansion will enable, phrased in effect terms. */
  effectDescription: string;
  status: ChangeOrderStatus;
  /** Timestamp when the CO was created. */
  createdAt: number;
  /** Timestamp when the CO was resolved (granted/denied). */
  resolvedAt?: number;
  /** ID of the successor WO minted if the CO was granted. */
  successorWoId?: string;
};

export type ChangeOrderStatus = "pending" | "granted" | "denied" | "expired" | "withdrawn";

// ---------------------------------------------------------------------------
// Consent Records
// ---------------------------------------------------------------------------

/**
 * Persisted record of a consent decision. Used by the binder to verify
 * consent anchors and for audit/explainability.
 */
export type ConsentRecord = {
  id: string;
  poId: string;
  woId: string;
  effectClasses: EffectClass[];
  decision: ConsentDecision;
  timestamp: number;
  expiresAt?: number;
  /** Free-form metadata for audit (e.g. who approved, via what surface). */
  metadata?: Record<string, unknown>;
};

export type ConsentDecision = "granted" | "denied" | "revoked" | "expired";

// ---------------------------------------------------------------------------
// Elevated Action Analysis (EAA) Records
// ---------------------------------------------------------------------------

/** Outcome code from an EAA adjudication. Closed set for deterministic routing. */
export type EAAOutcome =
  | "proceed"
  | "request-consent"
  | "constrained-comply"
  | "emergency-act"
  | "refuse"
  | "escalate";

/**
 * Formal result of an Elevated Action Analysis. Fed into the binder as an
 * advisory consent anchor. The binder independently verifies the outcome
 * before granting effects.
 */
export type EAARecord = {
  id: string;
  poId: string;
  woId: string;
  triggerReason: string;
  outcome: EAAOutcome;
  /** Effect classes the EAA recommends granting (advisory to binder). */
  recommendedEffects: EffectClass[];
  /** Constraints the EAA recommends applying. */
  recommendedConstraints: WOConstraint[];
  createdAt: number;
  /** Opaque reasoning record for audit -- not consumed by the binder. */
  reasoning?: string;
};

// ---------------------------------------------------------------------------
// Consent Scope State (carried via AsyncLocalStorage)
// ---------------------------------------------------------------------------

/**
 * The consent scope state carried through the agent execution via
 * AsyncLocalStorage. Created at agent run start and accessed by the
 * before-tool-call hook and binder.
 */
export type ConsentScopeState = {
  po: PurchaseOrder;
  activeWO: WorkOrder;
  /** Immutable chain of predecessor WOs for audit. */
  woChain: readonly WorkOrder[];
  consentRecords: ConsentRecord[];
  eaaRecords: EAARecord[];
};

// ---------------------------------------------------------------------------
// Binder Types
// ---------------------------------------------------------------------------

/** Input to the deterministic binder when minting an initial WO. */
export type BinderMintInput = {
  po: PurchaseOrder;
  /** Active standing policies (Phase 5, stubbed for now). */
  policies: readonly StandingPolicyStub[];
  /** System-level prohibited effects that override all consent. */
  systemProhibitions: EffectClass[];
};

/** Input to the deterministic binder when requalifying (minting WO'). */
export type BinderRequalifyInput = {
  currentWO: WorkOrder;
  po: PurchaseOrder;
  /** The tool/step about to execute. */
  stepEffectProfile: ToolEffectProfile;
  /** Consent anchors justifying the expanded grants. */
  newAnchors: ConsentAnchor[];
  /** Additional effects being granted via CO or EAA. */
  additionalEffects: EffectClass[];
  policies: readonly StandingPolicyStub[];
  systemProhibitions: EffectClass[];
  constraints?: WOConstraint[];
};

/**
 * Result of a binder operation. Discriminated on `ok` so callers use
 * pattern matching rather than exception handling for expected refusals.
 */
export type BinderResult =
  | { ok: true; wo: WorkOrder }
  | { ok: false; code: BinderRefusalCode; reason: string };

export type BinderRefusalCode =
  | "system-prohibited"
  | "no-consent-anchor"
  | "invalid-consent-anchor"
  | "ceiling-exceeded"
  | "expired"
  | "integrity-violation";

/**
 * Verification result when checking a tool call against the active WO.
 */
export type WOVerificationResult =
  | { ok: true }
  | { ok: false; code: WOVerificationFailureCode; reason: string; missingEffects: EffectClass[] };

export type WOVerificationFailureCode =
  | "effect-not-granted"
  | "wo-expired"
  | "constraint-violated"
  | "integrity-failed";

/**
 * Result of a Work Order integrity check. The JWT signature is verified
 * and the token payload is compared against the in-memory WO fields.
 */
export type WOIntegrityResult = { ok: true } | { ok: false; reason: string };

/**
 * Result of decoding a WO JWT token from an external boundary.
 * On success, returns a fully typed, frozen WorkOrder.
 */
export type WODecodeResult = { ok: true; wo: WorkOrder } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Standing Policy (stub for Phase 5 -- minimal shape for binder interface)
// ---------------------------------------------------------------------------

/**
 * Minimal standing policy shape so the binder interface is complete.
 * Full StandingPolicy type with bounding boxes ships in Phase 5.
 */
export type StandingPolicyStub = {
  id: string;
  policyClass: "user" | "self-minted" | "system";
  effectScope: EffectClass[];
};
