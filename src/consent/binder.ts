/**
 * Deterministic Contract Binder
 *
 * The binder is the sole authority for minting Work Orders. It is pure,
 * deterministic TypeScript with no LLM calls. Inference may propose and
 * advise, but it must not directly request capabilities.
 *
 * The binder:
 *  - Never accepts raw capability strings from inference
 *  - Verifies consent anchors exist and are valid before granting effects
 *  - Applies system policy prohibitions unconditionally
 *  - Bounds grants to the step's declared effect profile (ceiling check)
 *  - Applies TTL and constraints
 *  - Mints immutable WOs; scope changes produce successor WOs (WO')
 */

import {
  createHmac,
  randomBytes,
  randomUUID as cryptoRandomUUID,
  timingSafeEqual as cryptoTimingSafeEqual,
} from "node:crypto";
import { getToolEffectProfile } from "./effect-registry.js";
import type { PolicyStore } from "./policy-store.js";
import { evaluateEscalationRules, filterApplicablePolicies, isExpired } from "./policy.js";
import type { EscalationContext, PolicyMatchContext, StandingPolicy } from "./policy.js";
import type {
  BinderMintInput,
  BinderRequalifyInput,
  BinderResult,
  ConsentAnchor,
  ConsentRecord,
  EAARecord,
  EffectClass,
  StandingPolicyStub,
  ToolEffectProfile,
  WOConstraint,
  WODecodeResult,
  WOIntegrityResult,
  WOVerificationResult,
  WorkOrder,
} from "./types.js";

// ---------------------------------------------------------------------------
// Phase 5c: Policy Embedder Type
// ---------------------------------------------------------------------------

/**
 * Async function that converts text into a vector embedding.
 * The binder itself is synchronous; the caller invokes the embedder
 * and passes pre-resolved semantic candidates via `semanticPolicyCandidates`.
 */
export type PolicyEmbedder = (text: string) => Promise<Float32Array>;

// ---------------------------------------------------------------------------
// WO Minting: Initial (from PO + implied consent)
// ---------------------------------------------------------------------------

/**
 * Mint the initial Work Order for a new request. The grants are derived from
 * the intersection of (PO implied effects) and (system-allowed effects),
 * augmented by applicable standing policies (Phase 5c).
 *
 * Policy application order: system prohibitions first, then system policies
 * (restrictions/grants), user policies, self-minted policies. Escalation
 * rules can override a policy's grant at evaluation time.
 */
export function mintInitialWorkOrder(input: BinderMintInput): BinderResult {
  const { po, systemProhibitions } = input;

  const prohibited = new Set<EffectClass>(systemProhibitions);
  const implied = po.impliedEffects.filter((e) => !prohibited.has(e));

  // Phase 5c: resolve applicable policies via dual-path retrieval
  const matchContext: PolicyMatchContext = {
    channel: po.channel,
    chatType: po.chatType,
    senderId: po.senderId,
    senderIsOwner: po.senderIsOwner,
  };

  const escalationCtx: EscalationContext = {
    toolName: "",
    toolProfile: { effects: [...po.impliedEffects], trustTier: "in-process" },
    po: {
      senderId: po.senderId,
      senderIsOwner: po.senderIsOwner,
      channel: po.channel,
      chatType: po.chatType,
    },
    recentInvocationCount: 0,
  };

  const { policyGrantedEffects, policyAnchors } = evaluatePoliciesForGrants({
    policies: input.policies,
    semanticCandidates: input.semanticPolicyCandidates,
    matchContext,
    escalationCtx,
    prohibited,
    existingGrants: new Set(implied),
  });

  const granted = [...new Set([...implied, ...policyGrantedEffects])];

  if (granted.length === 0) {
    return {
      ok: false,
      code: "system-prohibited",
      reason: "All implied effects are prohibited by system policy",
    };
  }

  const now = nowMs();
  const expiresAt = now + DEFAULT_WO_TTL_MS;
  const anchors: ConsentAnchor[] = [{ kind: "implied", poId: po.id }, ...policyAnchors];

  const wo = sealWorkOrder({
    id: generateId(),
    requestContextId: po.id,
    grantedEffects: granted,
    constraints: [{ kind: "time-bound", expiresAt }],
    consentAnchors: anchors,
    mintedAt: now,
    expiresAt,
    immutable: true,
    token: "", // placeholder, computed by sealWorkOrder
  });

  return { ok: true, wo };
}

// ---------------------------------------------------------------------------
// WO Requalification: Mint successor WO (WO') after consent expansion
// ---------------------------------------------------------------------------

/**
 * Mint a successor Work Order after a Change Order is granted or an EAA
 * adjudication recommends proceeding. The new WO carries forward the
 * predecessor link for audit and expands grants within policy bounds.
 *
 * Requalification follows three invariants:
 *  1. No mutation -- predecessor WO stays immutable
 *  2. No silent effect expansion -- new effects require consent anchors
 *  3. No capability requests -- binder derives grants from contract terms
 */
export function mintSuccessorWorkOrder(input: BinderRequalifyInput): BinderResult {
  const {
    currentWO,
    po,
    stepEffectProfile,
    newAnchors,
    additionalEffects,
    systemProhibitions,
    constraints,
  } = input;

  // Verify the current WO's integrity before inheriting its grants.
  // The binder is the sole resolver of enforceable grants -- it must not
  // build on a tampered foundation even if the scope chain already checked.
  const currentIntegrity = verifyWorkOrderIntegrity(currentWO);
  if (!currentIntegrity.ok) {
    return {
      ok: false,
      code: "integrity-violation",
      reason: `Cannot requalify: current WO integrity check failed (${currentIntegrity.reason})`,
    };
  }

  const now = nowMs();

  // Verify the current WO hasn't expired
  if (currentWO.expiresAt && currentWO.expiresAt < now) {
    return {
      ok: false,
      code: "expired",
      reason: "Current Work Order has expired; cannot requalify",
    };
  }

  // Validate that new anchors are present for the additional effects
  if (additionalEffects.length > 0 && newAnchors.length === 0) {
    return {
      ok: false,
      code: "no-consent-anchor",
      reason: "Additional effects requested without consent anchors",
    };
  }

  // Validate consent anchors have the required shape
  for (const anchor of newAnchors) {
    const validation = validateConsentAnchor(anchor);
    if (!validation.valid) {
      return {
        ok: false,
        code: "invalid-consent-anchor",
        reason: validation.reason,
      };
    }
  }

  // Build the combined effect set: current grants + additional
  const prohibited = new Set<EffectClass>(systemProhibitions);
  const combinedEffects = new Set<EffectClass>([...currentWO.grantedEffects, ...additionalEffects]);

  // Remove system-prohibited effects
  for (const effect of prohibited) {
    combinedEffects.delete(effect);
  }

  // Phase 5c: evaluate standing policies for additional grants during requalification
  const policyAnchors: ConsentAnchor[] = [];
  if (
    input.policies.length > 0 ||
    (input.semanticPolicyCandidates && input.semanticPolicyCandidates.length > 0)
  ) {
    const matchContext: PolicyMatchContext = {
      channel: po.channel,
      chatType: po.chatType,
      senderId: po.senderId,
      senderIsOwner: po.senderIsOwner,
      toolName: input.toolName,
      toolTrustTier: stepEffectProfile.trustTier,
    };

    const escalationCtx: EscalationContext = {
      toolName: input.toolName ?? "",
      toolProfile: stepEffectProfile,
      po: {
        senderId: po.senderId,
        senderIsOwner: po.senderIsOwner,
        channel: po.channel,
        chatType: po.chatType,
      },
      recentInvocationCount: 0,
    };

    const result = evaluatePoliciesForGrants({
      policies: input.policies,
      semanticCandidates: input.semanticPolicyCandidates,
      matchContext,
      escalationCtx,
      prohibited,
      existingGrants: combinedEffects,
    });

    for (const effect of result.policyGrantedEffects) {
      combinedEffects.add(effect);
    }
    policyAnchors.push(...result.policyAnchors);
  }

  // Ceiling check: bound by step's declared effect profile
  const stepCeiling = new Set<EffectClass>(stepEffectProfile.effects);
  const granted = [...combinedEffects].filter((e) => stepCeiling.has(e));

  if (granted.length === 0) {
    return {
      ok: false,
      code: "ceiling-exceeded",
      reason:
        "No granted effects remain after ceiling check against step profile " +
        `(step declares: [${stepEffectProfile.effects.join(", ")}])`,
    };
  }

  const allAnchors = [...currentWO.consentAnchors, ...newAnchors, ...policyAnchors];
  const expiresAt = now + DEFAULT_WO_TTL_MS;
  const allConstraints: WOConstraint[] = [
    ...(constraints ?? []),
    { kind: "time-bound", expiresAt },
  ];

  const wo = sealWorkOrder({
    id: generateId(),
    predecessorId: currentWO.id,
    requestContextId: po.id,
    grantedEffects: granted,
    constraints: allConstraints,
    stepRef: stepEffectProfile.description,
    consentAnchors: allAnchors,
    mintedAt: now,
    expiresAt,
    immutable: true,
    token: "", // placeholder, computed by sealWorkOrder
  });

  return { ok: true, wo };
}

// ---------------------------------------------------------------------------
// Phase 5c: Policy Evaluation (Dual-Path Retrieval)
// ---------------------------------------------------------------------------

type PolicyEvalInput = {
  policies: readonly (StandingPolicyStub | StandingPolicy)[];
  semanticCandidates?: readonly StandingPolicy[];
  matchContext: PolicyMatchContext;
  escalationCtx: EscalationContext;
  prohibited: Set<EffectClass>;
  existingGrants: Set<EffectClass>;
};

type PolicyEvalResult = {
  policyGrantedEffects: EffectClass[];
  policyAnchors: ConsentAnchor[];
};

/**
 * Evaluate standing policies and produce additional grants + consent anchors.
 *
 * Dual-path: the deterministic path runs `filterApplicablePolicies` over the
 * full policies array; the semantic path accepts pre-resolved candidates
 * (from embedding search) and validates them through the same gauntlet.
 *
 * Application order (precedence):
 *   1. System policies — grants/restrictions
 *   2. User policies — expand grant set
 *   3. Self-minted policies — expand grant set (only if confirmed/active)
 *
 * Escalation rules on any policy can suppress that policy's grants.
 */
function evaluatePoliciesForGrants(input: PolicyEvalInput): PolicyEvalResult {
  const { policies, semanticCandidates, matchContext, escalationCtx, prohibited, existingGrants } =
    input;

  // --- Deterministic path ---
  const deterministicPolicies = filterApplicablePolicies(policies, matchContext);

  // --- Semantic path: validate each candidate through the full deterministic gauntlet ---
  // Reuse filterApplicablePolicies to ensure applicability, status, and expiry checks
  // are identical for both paths (no validation gap).
  const validatedSemantic = semanticCandidates
    ? filterApplicablePolicies(semanticCandidates, matchContext)
    : [];

  // --- Merge: union of deterministic + validated semantic, dedup by id ---
  const seenIds = new Set<string>();
  const merged: StandingPolicy[] = [];
  for (const p of [...deterministicPolicies, ...validatedSemantic]) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      merged.push(p);
    }
  }

  // Sort by precedence: system → user → self-minted
  const classOrder: Record<string, number> = { system: 0, user: 1, "self-minted": 2 };
  merged.sort((a, b) => (classOrder[a.class] ?? 9) - (classOrder[b.class] ?? 9));

  const grantedEffects: EffectClass[] = [];
  const anchors: ConsentAnchor[] = [];

  for (const policy of merged) {
    // System policies can restrict (handled via systemProhibitions) or grant
    // User / self-minted policies expand the grant set
    if (policy.status !== "active") {
      continue;
    }
    if (isExpired(policy.expiry)) {
      continue;
    }

    // Evaluate escalation rules: if any fires, skip this policy's grants
    const escalated = evaluateEscalationRules(policy.escalationRules, escalationCtx);
    if (escalated) {
      continue;
    }

    // Phase 5f: external tools may only consume policies that carry a
    // trust-tier-aware escalation rule. This prevents external tools from
    // silently consuming broad user/self-minted policies without the policy
    // author having explicitly considered external trust tier risks.
    const toolTier = escalationCtx.toolProfile.trustTier ?? "in-process";
    if (toolTier === "external" && policy.class !== "system") {
      const hasTrustTierRule = policy.escalationRules.some(
        (r) => r.condition.kind === "trust-tier-below",
      );
      if (!hasTrustTierRule) {
        continue;
      }
    }

    let addedNewEffect = false;
    for (const effect of policy.effectScope) {
      if (!prohibited.has(effect) && !existingGrants.has(effect)) {
        grantedEffects.push(effect);
        existingGrants.add(effect);
        addedNewEffect = true;
      }
    }

    // Only record anchor if the policy actually contributed a grant
    // or if it covers effects already in the grant set (validation anchor)
    if (addedNewEffect || policy.effectScope.some((e) => existingGrants.has(e))) {
      anchors.push({ kind: "policy", policyId: policy.id });
    }
  }

  return { policyGrantedEffects: grantedEffects, policyAnchors: anchors };
}

// ---------------------------------------------------------------------------
// WO Verification: Check a tool call against the active WO
// ---------------------------------------------------------------------------

/**
 * Verify that a tool's effect profile is fully covered by the active WO.
 * Called in the before-tool-call hook. Returns a structured result so the
 * orchestrator can decide how to proceed (requalify, request CO, or refuse).
 */
export function verifyToolAgainstWO(
  toolName: string,
  toolProfile: ToolEffectProfile | undefined,
  activeWO: WorkOrder,
): WOVerificationResult {
  // Integrity check first -- reject tampered WOs before any grant logic
  const integrity = verifyWorkOrderIntegrity(activeWO);
  if (!integrity.ok) {
    return {
      ok: false,
      code: "integrity-failed",
      reason: `WO integrity check failed: ${integrity.reason}`,
      missingEffects: [],
    };
  }

  const now = nowMs();

  // Check WO expiry
  if (activeWO.expiresAt && activeWO.expiresAt < now) {
    return {
      ok: false,
      code: "wo-expired",
      reason: "Active Work Order has expired",
      missingEffects: [],
    };
  }

  const profile = toolProfile ?? getToolEffectProfile(toolName);
  const grantedSet = new Set<EffectClass>(activeWO.grantedEffects);
  const missing: EffectClass[] = [];

  for (const effect of profile.effects) {
    if (!grantedSet.has(effect)) {
      missing.push(effect);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: "effect-not-granted",
      reason:
        `Tool "${toolName}" requires effects [${missing.join(", ")}] ` +
        `not granted by active WO (granted: [${activeWO.grantedEffects.join(", ")}])`,
      missingEffects: missing,
    };
  }

  // Check constraints
  const constraintResult = checkWOConstraints(activeWO);
  if (!constraintResult.ok) {
    return constraintResult;
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Consent Anchor Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a consent anchor has the required structural shape.
 * Full semantic validation (e.g., looking up the record in the consent store)
 * is done separately; this is a fast structural check.
 */
function validateConsentAnchor(
  anchor: ConsentAnchor,
): { valid: true } | { valid: false; reason: string } {
  switch (anchor.kind) {
    case "implied":
      if (!anchor.poId) {
        return { valid: false, reason: "Implied consent anchor missing poId" };
      }
      return { valid: true };
    case "explicit":
      if (!anchor.consentRecordId) {
        return { valid: false, reason: "Explicit consent anchor missing consentRecordId" };
      }
      return { valid: true };
    case "eaa":
      if (!anchor.eaaRecordId) {
        return { valid: false, reason: "EAA consent anchor missing eaaRecordId" };
      }
      return { valid: true };
    case "policy":
      if (!anchor.policyId) {
        return { valid: false, reason: "Policy consent anchor missing policyId" };
      }
      return { valid: true };
    default:
      return {
        valid: false,
        reason: `Unknown consent anchor kind: ${(anchor as ConsentAnchor).kind}`,
      };
  }
}

/**
 * Verify a consent anchor against actual consent/EAA records and policy store.
 * Returns false if the referenced record is missing, denied, expired, or
 * doesn't cover the needed effect classes.
 */
export function verifyConsentAnchorAgainstRecords(
  anchor: ConsentAnchor,
  neededEffects: EffectClass[],
  consentRecords: readonly ConsentRecord[],
  eaaRecords: readonly EAARecord[],
  policyStore?: PolicyStore,
): { valid: true } | { valid: false; reason: string } {
  switch (anchor.kind) {
    case "implied":
      // Implied anchors are valid by construction (tied to PO)
      return { valid: true };

    case "explicit": {
      const record = consentRecords.find((r) => r.id === anchor.consentRecordId);
      if (!record) {
        return { valid: false, reason: `Consent record ${anchor.consentRecordId} not found` };
      }
      if (record.decision !== "granted") {
        return {
          valid: false,
          reason: `Consent record ${anchor.consentRecordId} decision is "${record.decision}", not "granted"`,
        };
      }
      if (record.expiresAt && record.expiresAt < nowMs()) {
        return { valid: false, reason: `Consent record ${anchor.consentRecordId} has expired` };
      }
      const recordEffects = new Set(record.effectClasses);
      const uncovered = neededEffects.filter((e) => !recordEffects.has(e));
      if (uncovered.length > 0) {
        return {
          valid: false,
          reason: `Consent record does not cover effects: [${uncovered.join(", ")}]`,
        };
      }
      return { valid: true };
    }

    case "eaa": {
      const record = eaaRecords.find((r) => r.id === anchor.eaaRecordId);
      if (!record) {
        return { valid: false, reason: `EAA record ${anchor.eaaRecordId} not found` };
      }
      const permittedOutcomes = new Set(["proceed", "constrained-comply", "emergency-act"]);
      if (!permittedOutcomes.has(record.outcome)) {
        return {
          valid: false,
          reason: `EAA outcome "${record.outcome}" does not permit action`,
        };
      }
      return { valid: true };
    }

    case "policy": {
      // Phase 5c: verify the referenced policy exists, is active, and covers needed effects
      if (!policyStore) {
        return { valid: true };
      }

      const policy = policyStore.getPolicy(anchor.policyId);
      if (!policy) {
        return { valid: false, reason: `Policy ${anchor.policyId} not found` };
      }
      if (policy.status !== "active") {
        return { valid: false, reason: `Policy ${anchor.policyId} is ${policy.status}` };
      }
      if (isExpired(policy.expiry)) {
        return { valid: false, reason: `Policy ${anchor.policyId} has expired` };
      }
      const policyEffects = new Set(policy.effectScope);
      const uncovered = neededEffects.filter((e) => !policyEffects.has(e));
      if (uncovered.length > 0) {
        return {
          valid: false,
          reason: `Policy does not cover effects: [${uncovered.join(", ")}]`,
        };
      }
      return { valid: true };
    }

    default:
      return { valid: false, reason: "Unknown consent anchor kind" };
  }
}

// ---------------------------------------------------------------------------
// WO Constraint Checks
// ---------------------------------------------------------------------------

function checkWOConstraints(wo: WorkOrder): WOVerificationResult {
  const now = nowMs();
  for (const constraint of wo.constraints) {
    switch (constraint.kind) {
      case "time-bound":
        if (constraint.expiresAt < now) {
          return {
            ok: false,
            code: "constraint-violated",
            reason: "Time-bound constraint expired",
            missingEffects: [],
          };
        }
        break;
      // Audience and count constraints require runtime context -- verified at
      // invocation time by the tool execution wrapper, not here.
      case "audience":
      case "max-invocations":
      case "custom":
        break;
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// JWS Compact Serialization (HS256): Portable WO Token
// ---------------------------------------------------------------------------
//
// The Work Order token is a standard JWS (RFC 7515) with:
//   Header:    {"alg":"HS256","typ":"wo+jwt"}
//   Payload:   Deterministic JSON of WO content fields
//   Signature: HMAC-SHA256(signingKey, ASCII(header.payload))
//
// Any JWT library in any language can decode the payload and verify
// the signature given the shared signing key.
// ---------------------------------------------------------------------------

const JWT_HEADER = { alg: "HS256", typ: "wo+jwt" };
const ENCODED_HEADER = Buffer.from(JSON.stringify(JWT_HEADER), "utf8").toString("base64url");

/**
 * Signing key for WO tokens. Defaults to a per-process random 256-bit key
 * for single-process development. Production deployments MUST call
 * `configureSigningKey()` with a shared secret so tokens are verifiable
 * across service, MCP, skill, and language boundaries.
 */
let _signingKey: Buffer = randomBytes(32);

/**
 * Configure the shared signing key for WO token creation and verification.
 * Call this at startup before any WOs are minted. The key must be at least
 * 256 bits (32 bytes) per NIST recommendations for HMAC-SHA256.
 *
 * Accepts a raw Buffer or a base64-encoded string (for env var injection).
 * After rotation, tokens minted under the previous key will fail verification.
 *
 * @example
 * // From environment variable
 * configureSigningKey(process.env.CBA_SIGNING_KEY!);
 *
 * // From raw bytes
 * configureSigningKey(crypto.randomBytes(32));
 */
export function configureSigningKey(key: Buffer | string): void {
  const buf = typeof key === "string" ? Buffer.from(key, "base64") : key;
  if (buf.length < 32) {
    throw new Error(`Signing key must be at least 256 bits (32 bytes), got ${buf.length} bytes`);
  }
  _signingKey = buf;
}

/**
 * Extract the WO content fields that form the JWT payload.
 * Excludes `token` (the JWT itself) and `immutable` (TypeScript marker).
 * Only includes optional fields when they have values, so JSON round-trip
 * does not introduce null-vs-undefined divergence.
 */
function extractWOPayloadFields(wo: WorkOrder): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: wo.id,
    requestContextId: wo.requestContextId,
    grantedEffects: wo.grantedEffects,
    constraints: wo.constraints,
    consentAnchors: wo.consentAnchors,
    mintedAt: wo.mintedAt,
  };
  if (wo.predecessorId !== undefined) {
    content.predecessorId = wo.predecessorId;
  }
  if (wo.stepRef !== undefined) {
    content.stepRef = wo.stepRef;
  }
  if (wo.expiresAt !== undefined) {
    content.expiresAt = wo.expiresAt;
  }
  return content;
}

/**
 * Recursively serialize a value with sorted object keys at every level.
 * Ensures identical logical content always produces the same string
 * regardless of property insertion order in nested objects.
 */
function deterministicStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(deterministicStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + deterministicStringify(obj[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * Create a JWS Compact Serialization token from a payload JSON string.
 */
function createJwt(payloadJson: string, key: Buffer): string {
  const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;
  const signature = createHmac("sha256", key).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Verify a JWS Compact Serialization token's signature.
 * Returns the decoded payload JSON on success.
 */
function verifyJwt(
  token: string,
  key: Buffer,
): { valid: true; payloadJson: string } | { valid: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "Invalid JWT format: expected 3 dot-separated parts" };
  }

  const [header, payload, signature] = parts;

  // Verify the header declares HS256
  try {
    const headerJson = Buffer.from(header, "base64url").toString("utf8");
    const headerObj = JSON.parse(headerJson) as Record<string, unknown>;
    if (headerObj.alg !== "HS256") {
      return { valid: false, reason: `Unsupported algorithm: ${String(headerObj.alg)}` };
    }
  } catch {
    return { valid: false, reason: "Malformed JWT header" };
  }

  // Recompute signature and compare (constant-time)
  const signingInput = `${header}.${payload}`;
  const expected = createHmac("sha256", key).update(signingInput).digest("base64url");

  const sigBuf = Buffer.from(signature, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !cryptoTimingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "JWT signature verification failed" };
  }

  // Decode payload
  try {
    const payloadJson = Buffer.from(payload, "base64url").toString("utf8");
    JSON.parse(payloadJson); // validate it's parseable
    return { valid: true, payloadJson };
  } catch {
    return { valid: false, reason: "Malformed JWT payload" };
  }
}

/**
 * Seal a Work Order: produce its JWT token and deep-freeze the object.
 * This is the only code path that produces a valid, tamper-evident WO.
 */
function sealWorkOrder(draft: WorkOrder): WorkOrder {
  const payloadFields = extractWOPayloadFields(draft);
  const payloadJson = deterministicStringify(payloadFields);
  const token = createJwt(payloadJson, _signingKey);

  const sealed: WorkOrder = { ...draft, token };

  deepFreezeWorkOrder(sealed);
  return sealed;
}

/**
 * Deep-freeze a WorkOrder and all its mutable sub-structures so no
 * in-process code can silently mutate grants, constraints, or anchors.
 */
function deepFreezeWorkOrder(wo: WorkOrder): void {
  Object.freeze(wo.grantedEffects);
  Object.freeze(wo.constraints);
  for (const c of wo.constraints) {
    if (c.kind === "audience") {
      Object.freeze(c.allowedTargets);
    } else if (c.kind === "custom") {
      deepFreezeObject(c.payload);
    }
    Object.freeze(c);
  }
  Object.freeze(wo.consentAnchors);
  for (const a of wo.consentAnchors) {
    Object.freeze(a);
  }
  Object.freeze(wo);
}

/**
 * Recursively freeze an arbitrary JSON-serializable object graph.
 * Used for WOCustomConstraint.payload which has unknown structure.
 */
function deepFreezeObject(obj: Record<string, unknown>): void {
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      if (Array.isArray(val)) {
        Object.freeze(val);
      } else {
        deepFreezeObject(val as Record<string, unknown>);
      }
    }
  }
  Object.freeze(obj);
}

/**
 * Verify a Work Order's token against its in-memory content fields.
 * Checks two things:
 *   1. The JWT signature is valid (the token was minted with the current key)
 *   2. The token's payload matches the WO's current content fields
 *      (detects in-memory mutation even if Object.freeze was bypassed)
 */
export function verifyWorkOrderIntegrity(wo: WorkOrder): WOIntegrityResult {
  if (!wo.token) {
    return { ok: false, reason: "Work Order missing token" };
  }

  const jwtResult = verifyJwt(wo.token, _signingKey);
  if (!jwtResult.valid) {
    return { ok: false, reason: jwtResult.reason };
  }

  // Compare the token's payload against the WO's current in-memory fields
  const currentPayload = deterministicStringify(extractWOPayloadFields(wo));
  if (currentPayload !== jwtResult.payloadJson) {
    return {
      ok: false,
      reason: "Work Order content does not match token payload (in-memory tampering detected)",
    };
  }

  return { ok: true };
}

/**
 * Decode a WO JWT token received from an external boundary (service, MCP,
 * skill, or another language runtime). Verifies the signature, parses the
 * payload, and returns a fully typed, frozen WorkOrder.
 *
 * The receiver only needs the shared signing key (configured via
 * `configureSigningKey()`) and this function. No other binder state required.
 *
 * @example
 * // Python MCP server sends wo.token in a tool result
 * const result = decodeWorkOrderToken(incomingTokenString);
 * if (!result.ok) throw new Error(result.reason);
 * const wo = result.wo;  // fully typed, frozen WorkOrder
 */
export function decodeWorkOrderToken(token: string): WODecodeResult {
  const jwtResult = verifyJwt(token, _signingKey);
  if (!jwtResult.valid) {
    return { ok: false, reason: jwtResult.reason };
  }

  try {
    const parsed = JSON.parse(jwtResult.payloadJson) as Record<string, unknown>;

    // Structural validation: all required fields must be present and correctly typed.
    // The JWT signature proves the payload was minted by a holder of the signing key,
    // but we still validate shape to guard against key-compromise or cross-version drift.
    if (typeof parsed.id !== "string" || !parsed.id) {
      return { ok: false, reason: "Token payload missing required field: id" };
    }
    if (typeof parsed.requestContextId !== "string" || !parsed.requestContextId) {
      return { ok: false, reason: "Token payload missing required field: requestContextId" };
    }
    if (!Array.isArray(parsed.grantedEffects)) {
      return { ok: false, reason: "Token payload missing required field: grantedEffects" };
    }
    if (!Array.isArray(parsed.constraints)) {
      return { ok: false, reason: "Token payload missing required field: constraints" };
    }
    if (!Array.isArray(parsed.consentAnchors)) {
      return { ok: false, reason: "Token payload missing required field: consentAnchors" };
    }
    if (typeof parsed.mintedAt !== "number") {
      return { ok: false, reason: "Token payload missing required field: mintedAt" };
    }

    const wo: WorkOrder = {
      id: parsed.id,
      requestContextId: parsed.requestContextId,
      grantedEffects: parsed.grantedEffects as EffectClass[],
      constraints: parsed.constraints as WOConstraint[],
      consentAnchors: parsed.consentAnchors as ConsentAnchor[],
      mintedAt: parsed.mintedAt,
      immutable: true,
      token,
      ...(typeof parsed.predecessorId === "string" && {
        predecessorId: parsed.predecessorId,
      }),
      ...(typeof parsed.stepRef === "string" && {
        stepRef: parsed.stepRef,
      }),
      ...(typeof parsed.expiresAt === "number" && {
        expiresAt: parsed.expiresAt,
      }),
    };

    deepFreezeWorkOrder(wo);
    return { ok: true, wo };
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to reconstruct WorkOrder from token payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Defaults and Injectable Seams
// ---------------------------------------------------------------------------

/** Default Work Order time-to-live: 30 minutes. */
const DEFAULT_WO_TTL_MS = 30 * 60 * 1000;

/**
 * Injectable clock and ID generation. Tests can override these to make
 * binder behavior fully deterministic.
 */
let _nowMs: () => number = () => Date.now();
let _generateId: () => string = () => cryptoRandomUUID();

function nowMs(): number {
  return _nowMs();
}

function generateId(): string {
  return _generateId();
}

/** @internal Testing seam for deterministic binder behavior. */
export const __testing = {
  DEFAULT_WO_TTL_MS,
  /** Override the clock used by all binder functions. Resets on restore. */
  setNow(fn: () => number): void {
    _nowMs = fn;
  },
  /** Override UUID generation. Resets on restore. */
  setGenerateId(fn: () => string): void {
    _generateId = fn;
  },
  /** Override the signing key. */
  setSigningKey(key: Buffer): void {
    _signingKey = key;
  },
  /** Restore default clock, ID generation, and signing key. */
  restore(): void {
    _nowMs = () => Date.now();
    _generateId = () => cryptoRandomUUID();
    _signingKey = randomBytes(32);
  },
  /** Expose sealWorkOrder for creating sealed WOs in tests. */
  sealWorkOrder,
  /** Expose payload extraction for testing canonical content. */
  extractWOPayloadFields,
  /** Expose deterministicStringify for testing canonical content. */
  deterministicStringify,
};
