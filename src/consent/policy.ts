/**
 * Standing Policy Type System (Phase 5a)
 *
 * Standing policies are persistent, reusable consent postures that reduce
 * friction for routine operations while maintaining strict boundaries on
 * high-risk actions. A policy grants pre-authorized consent for a bounded
 * set of effects under specific conditions. The binder verifies policies
 * are valid, non-expired, and applicable before using them as consent anchors.
 *
 * Three policy classes:
 *   1. System   — inviolable, hardcoded or loaded from config
 *   2. User     — created by agent owner/operator, confirmed before first use
 *   3. Self-minted — proposed by agent from patterns, requires user confirmation
 *
 * Key invariant (from PDF Section IV): standing policies are bounding boxes,
 * not blank checks. The binder evaluates policies at mint time and never
 * accepts them as raw capability grants.
 */

import type { EffectClass, StandingPolicyStub, ToolEffectProfile, TrustTier } from "./types.js";

// ---------------------------------------------------------------------------
// Core Policy Types
// ---------------------------------------------------------------------------

export type PolicyClass = "user" | "self-minted" | "system";

export type PolicyStatus = "active" | "pending-confirmation" | "revoked" | "expired";

/**
 * Full standing policy with bounding-box semantics, applicability predicates,
 * escalation rules, expiry, and provenance. Replaces the StandingPolicyStub
 * used throughout Phases 0–4 when the policy framework is enabled.
 */
export type StandingPolicy = {
  id: string;
  /** Policy class determines precedence and override behavior. */
  class: PolicyClass;
  /** Which effects this policy pre-authorizes. */
  effectScope: EffectClass[];
  /** When this policy applies (channel, time, chat type, etc.). */
  applicability: PolicyApplicabilityPredicate;
  /** Rules for when to escalate despite the policy granting consent. */
  escalationRules: EscalationRule[];
  /** Expiry conditions — policies are not eternal. */
  expiry: PolicyExpiry;
  /** What happens to in-flight work when the policy is revoked. */
  revocationSemantics: PolicyRevocationSemantics;
  /** Audit trail: who created this, when, and when confirmed. */
  provenance: PolicyProvenance;
  /** Human-readable description of what this policy permits. */
  description: string;
  /** Whether this policy is currently active and usable as a consent anchor. */
  status: PolicyStatus;
};

export type PolicyRevocationSemantics = "immediate" | "after-current-slice";

// ---------------------------------------------------------------------------
// Applicability Predicate
// ---------------------------------------------------------------------------

/**
 * Determines when a standing policy applies. All fields are optional filters;
 * an empty predicate matches all contexts (universal policy).
 */
export type PolicyApplicabilityPredicate = {
  /** Restrict to specific channels. Empty/undefined = all channels. */
  channels?: string[];
  /** Restrict to specific chat types. Empty/undefined = all types. */
  chatTypes?: Array<"dm" | "group" | "public">;
  /** Restrict to specific sender IDs. Empty/undefined = any sender. */
  senderIds?: string[];
  /** Only apply when sender is owner. */
  requireOwner?: boolean;
  /** Time-of-day window (24h format, agent-local timezone). */
  timeWindow?: { startHour: number; endHour: number };
  /** Only apply to specific tools. Empty/undefined = all tools with matching effects. */
  toolNames?: string[];
  /** Only apply to tools at or above this trust tier. */
  minTrustTier?: TrustTier;
};

// ---------------------------------------------------------------------------
// Escalation Rules
// ---------------------------------------------------------------------------

/**
 * Forces escalation (CO, EAA, or refusal) even when the policy would grant
 * consent. Checked before a policy is used as a consent anchor.
 */
export type EscalationRule = {
  condition: EscalationCondition;
  /** What to do on escalation. */
  action: "require-co" | "trigger-eaa" | "refuse";
  description: string;
};

/**
 * Discriminated union of conditions that trigger escalation.
 * The "custom" variant carries a runtime-only evaluate function
 * that is not persisted to SQLite (Phase 5b serialization strips it).
 */
export type EscalationCondition =
  | { kind: "effect-combination"; effects: EffectClass[] }
  | { kind: "audience-exceeds"; maxRecipients: number }
  | { kind: "frequency-exceeds"; maxPerHour: number }
  | { kind: "trust-tier-below"; tier: TrustTier }
  | { kind: "custom"; label: string; evaluate: (ctx: EscalationContext) => boolean };

/** Runtime context passed to escalation condition evaluators. */
export type EscalationContext = {
  toolName: string;
  toolProfile: ToolEffectProfile;
  po: { senderId: string; senderIsOwner: boolean; channel?: string; chatType?: string };
  recentInvocationCount: number;
};

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export type PolicyExpiry = {
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt?: number;
  /** Maximum number of times this policy can be used as a consent anchor. */
  maxUses?: number;
  /** Current use count (incremented each time the policy anchors a WO). */
  currentUses: number;
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type PolicyProvenance = {
  /** Who created the policy: user ID, "system", or "agent:<agentId>". */
  author: string;
  createdAt: number;
  /** When a human confirmed the policy (required for self-minted activation). */
  confirmedAt?: number;
  /** Reference to the consent pattern or request that motivated creation. */
  sourceRef?: string;
};

// ---------------------------------------------------------------------------
// Context for Policy Matching
// ---------------------------------------------------------------------------

export type PolicyMatchContext = {
  channel?: string;
  chatType?: string;
  senderId: string;
  senderIsOwner: boolean;
  toolName?: string;
  toolTrustTier?: TrustTier;
  currentHour?: number;
};

// ---------------------------------------------------------------------------
// Trust Tier Ordering
// ---------------------------------------------------------------------------

const TRUST_TIER_RANK: Record<TrustTier, number> = {
  external: 1,
  sandboxed: 2,
  "in-process": 3,
};

/**
 * Returns true when `actual` meets or exceeds the `minimum` trust tier.
 * Ordering: external (1) < sandboxed (2) < in-process (3).
 */
export function meetsTrustTier(actual: TrustTier, minimum: TrustTier): boolean {
  return TRUST_TIER_RANK[actual] >= TRUST_TIER_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

/**
 * Narrow a StandingPolicyStub | StandingPolicy to StandingPolicy.
 * Discriminates on the presence of `applicability` and `status` which
 * only exist on the full type.
 */
export function isFullStandingPolicy(p: StandingPolicyStub | StandingPolicy): p is StandingPolicy {
  return "applicability" in p && "status" in p;
}

// ---------------------------------------------------------------------------
// Applicability Matching
// ---------------------------------------------------------------------------

/**
 * Filter policies whose applicability predicate matches the given context.
 * Only returns full StandingPolicy objects (stubs are silently skipped).
 * Inactive, revoked, and expired policies are excluded.
 */
export function filterApplicablePolicies(
  policies: readonly (StandingPolicyStub | StandingPolicy)[],
  context: PolicyMatchContext,
): StandingPolicy[] {
  const result: StandingPolicy[] = [];

  for (const p of policies) {
    if (!isFullStandingPolicy(p)) {
      continue;
    }
    if (p.status !== "active") {
      continue;
    }
    if (isExpired(p.expiry)) {
      continue;
    }
    if (!matchesApplicability(p.applicability, context)) {
      continue;
    }
    result.push(p);
  }

  return result;
}

/**
 * Test whether a single applicability predicate matches the given context.
 * Every specified filter must pass; unspecified filters are treated as
 * "match any" (open predicate).
 */
function matchesApplicability(
  pred: PolicyApplicabilityPredicate,
  ctx: PolicyMatchContext,
): boolean {
  if (pred.channels && pred.channels.length > 0) {
    if (!ctx.channel || !pred.channels.includes(ctx.channel)) {
      return false;
    }
  }

  if (pred.chatTypes && pred.chatTypes.length > 0) {
    if (!ctx.chatType || !pred.chatTypes.includes(ctx.chatType as "dm" | "group" | "public")) {
      return false;
    }
  }

  if (pred.senderIds && pred.senderIds.length > 0) {
    if (!pred.senderIds.includes(ctx.senderId)) {
      return false;
    }
  }

  if (pred.requireOwner && !ctx.senderIsOwner) {
    return false;
  }

  if (pred.timeWindow) {
    const hour = ctx.currentHour ?? new Date().getHours();
    if (!isInTimeWindow(hour, pred.timeWindow.startHour, pred.timeWindow.endHour)) {
      return false;
    }
  }

  if (pred.toolNames && pred.toolNames.length > 0) {
    if (!ctx.toolName || !pred.toolNames.includes(ctx.toolName)) {
      return false;
    }
  }

  if (pred.minTrustTier) {
    // When tool trust tier is unknown, fail closed (don't match)
    if (!ctx.toolTrustTier) {
      return false;
    }
    if (!meetsTrustTier(ctx.toolTrustTier, pred.minTrustTier)) {
      return false;
    }
  }

  return true;
}

/**
 * Check whether `hour` falls within the [start, end) window.
 * Handles overnight windows (e.g., startHour=22, endHour=6).
 */
function isInTimeWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Overnight window wraps past midnight
  return hour >= startHour || hour < endHour;
}

// ---------------------------------------------------------------------------
// Expiry Check
// ---------------------------------------------------------------------------

/**
 * Check whether a policy's expiry conditions have been met.
 * Returns true if the policy has expired (by time or by max uses).
 */
export function isExpired(expiry: PolicyExpiry, now?: number): boolean {
  if (expiry.expiresAt !== undefined) {
    const ts = now ?? Date.now();
    if (ts >= expiry.expiresAt) {
      return true;
    }
  }

  if (expiry.maxUses !== undefined) {
    if (expiry.currentUses >= expiry.maxUses) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Escalation Rule Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate escalation rules against the current context. Returns the first
 * matching rule, or undefined if no escalation is triggered.
 *
 * The caller checks escalation rules before using a policy as a consent
 * anchor. When a rule matches, the policy's pre-authorized consent is
 * overridden by the rule's action (require-co, trigger-eaa, or refuse).
 */
export function evaluateEscalationRules(
  rules: EscalationRule[],
  context: EscalationContext,
): EscalationRule | undefined {
  for (const rule of rules) {
    if (matchesEscalationCondition(rule.condition, context)) {
      return rule;
    }
  }
  return undefined;
}

function matchesEscalationCondition(
  condition: EscalationCondition,
  ctx: EscalationContext,
): boolean {
  switch (condition.kind) {
    case "effect-combination": {
      const toolEffects = new Set(ctx.toolProfile.effects);
      return condition.effects.every((e) => toolEffects.has(e));
    }

    case "audience-exceeds":
      // Audience count isn't directly in EscalationContext; this condition
      // fires based on recentInvocationCount as a proxy when no direct
      // audience signal is available. For full audience tracking, the caller
      // should set recentInvocationCount to the current audience size.
      return ctx.recentInvocationCount > condition.maxRecipients;

    case "frequency-exceeds":
      return ctx.recentInvocationCount > condition.maxPerHour;

    case "trust-tier-below": {
      const toolTier = ctx.toolProfile.trustTier ?? "in-process";
      return !meetsTrustTier(toolTier, condition.tier);
    }

    case "custom":
      return condition.evaluate(ctx);
  }
}

// ---------------------------------------------------------------------------
// Default System Policies
// ---------------------------------------------------------------------------

/**
 * Hardcoded system policies loaded at startup. These encode the framework's
 * non-negotiable safety boundaries. They supplement (not replace) the
 * DEFAULT_DUTY_CONSTRAINTS from Phase 4a.
 *
 * System policies cannot be overridden by user consent or self-minted policies.
 */
export const DEFAULT_SYSTEM_POLICIES: readonly StandingPolicy[] = [
  {
    id: "system-policy-read-compose",
    class: "system",
    effectScope: ["read", "compose"],
    applicability: {},
    escalationRules: [],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "system", createdAt: 0 },
    description: "Read and compose are always permitted as baseline capabilities.",
    status: "active",
  },
  {
    id: "system-policy-no-physical-without-eaa",
    class: "system",
    effectScope: ["physical"],
    applicability: {},
    escalationRules: [
      {
        condition: { kind: "effect-combination", effects: ["physical"] },
        action: "trigger-eaa",
        description: "Physical effects always require EAA deliberation.",
      },
    ],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "system", createdAt: 0 },
    description: "Physical actuation always triggers EAA regardless of other consent.",
    status: "active",
  },
  {
    id: "system-policy-no-elevated-from-non-owner",
    class: "system",
    effectScope: ["elevated"],
    applicability: { requireOwner: true },
    escalationRules: [
      {
        condition: { kind: "trust-tier-below", tier: "in-process" },
        action: "refuse",
        description: "External tools cannot perform elevated operations.",
      },
    ],
    expiry: { currentUses: 0 },
    revocationSemantics: "immediate",
    provenance: { author: "system", createdAt: 0 },
    description:
      "Elevated operations restricted to owner-initiated requests with in-process tools.",
    status: "active",
  },
];

// ---------------------------------------------------------------------------
// Policy Usage Tracking
// ---------------------------------------------------------------------------

/**
 * Record that a policy was used as a consent anchor for a given WO,
 * then check whether the policy has exceeded its maxUses limit.
 * Returns true if the policy is still valid (usage within limits).
 *
 * This is a convenience wrapper used by the binder after granting
 * policy-anchored effects, ensuring the usage table stays in sync
 * with the WO chain.
 */
export function recordAndCheckUsage(
  policy: StandingPolicy,
  woId: string,
  store: {
    recordPolicyUsage(policyId: string, woId: string): void;
    getPolicyUsageCount(policyId: string): number;
  },
): boolean {
  store.recordPolicyUsage(policy.id, woId);
  if (policy.expiry.maxUses === undefined) {
    return true;
  }
  return store.getPolicyUsageCount(policy.id) <= policy.expiry.maxUses;
}

// ---------------------------------------------------------------------------
// Embedding Text Construction
// ---------------------------------------------------------------------------

/**
 * Build composite text for embedding a policy's description + effect scope.
 * Format: `[effects: read, persist] Human-readable description text`
 *
 * The effect prefix gives the embedding vector both semantic intent and
 * structural effect scope signal so that cosine similarity captures both
 * "what this policy is about" and "what effect classes it covers."
 */
export function buildPolicyEmbeddingText(policy: StandingPolicy): string {
  const effectTag =
    policy.effectScope.length > 0 ? `[effects: ${policy.effectScope.join(", ")}] ` : "";
  return `${effectTag}${policy.description}`;
}

/**
 * Build composite text for embedding a query context at binder/search time.
 * Format mirrors `buildPolicyEmbeddingText` so cosine distance is meaningful:
 * `[effects: read, persist] Save user notes to disk using notes-tool`
 */
export function buildContextEmbeddingText(params: {
  effects: EffectClass[];
  toolName?: string;
  description?: string;
}): string {
  const parts: string[] = [];

  if (params.effects.length > 0) {
    parts.push(`[effects: ${params.effects.join(", ")}]`);
  }

  const descParts: string[] = [];
  if (params.description) {
    descParts.push(params.description);
  }
  if (params.toolName) {
    descParts.push(`using ${params.toolName}`);
  }

  if (descParts.length > 0) {
    parts.push(descParts.join(" "));
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Trust Tier Derivation (Phase 5f)
// ---------------------------------------------------------------------------

/** Source/origin of a plugin tool for trust tier derivation. */
export type ToolSource = "bundled" | "npm" | "mcp" | "unknown";

/**
 * Derive a tool's trust tier from its source when not explicitly declared.
 *
 * Derivation rules:
 *   - Bundled workspace plugins → "in-process" (first-party, reviewed)
 *   - Installed npm plugins     → "sandboxed" (third-party, isolated)
 *   - MCP transport tools       → "external" (remote, untrusted)
 *   - Unknown source            → "sandboxed" (conservative default)
 *
 * When a tool explicitly declares a trustTier in its ToolEffectProfile,
 * the declared value takes precedence over derivation.
 */
export function deriveTrustTier(
  explicitTier: TrustTier | undefined,
  source: ToolSource,
): TrustTier {
  if (explicitTier) {
    return explicitTier;
  }
  switch (source) {
    case "bundled":
      return "in-process";
    case "npm":
      return "sandboxed";
    case "mcp":
      return "external";
    case "unknown":
      return "sandboxed";
  }
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  TRUST_TIER_RANK,
  matchesApplicability,
  isInTimeWindow,
  matchesEscalationCondition,
};
