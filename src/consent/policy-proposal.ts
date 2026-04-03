/**
 * Self-Minted Policy Proposal (Phase 5e)
 *
 * Analyzes recent consent records for repeated grant patterns that suggest a
 * standing policy would reduce friction without compromising safety. Uses
 * the consent record store for pattern detection and the policy store's
 * vector similarity for semantic conflict/overlap detection.
 *
 * Three entry points:
 *   1. `analyzeForPolicyProposals` — full analysis: find repeated grant
 *      patterns, check for overlapping policies, build proposals
 *   2. `createSelfMintedPolicy` — persist a proposal as a pending policy
 *   3. `checkCOForPolicyPromotion` — check if a single CO should become
 *      a standing policy
 *
 * Safety constraints:
 *   - Never auto-propose policies covering HIGH_RISK_EFFECTS without
 *     escalation rules that trigger EAA
 *   - Self-minted policies always start as "pending-confirmation"
 *   - Maximum expiry of 30 days (configurable)
 *   - Maximum 100 uses before re-confirmation required
 */

import { randomUUID } from "node:crypto";
import type { PolicyEmbedder } from "./binder.js";
import type { ConsentRecordStore } from "./consent-store.js";
import type { PolicyStore } from "./policy-store.js";
import type { EscalationRule, StandingPolicy } from "./policy.js";
import { buildPolicyEmbeddingText } from "./policy.js";
import type { ConsentRecord, EffectClass } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Effects that require escalation rules when auto-proposed. */
const HIGH_RISK_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "irreversible",
  "elevated",
  "disclose",
  "audience-expand",
  "exec",
  "physical",
]);

const DEFAULT_SELF_MINTED_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_SELF_MINTED_MAX_USES = 100;
const DEFAULT_CO_PROMOTION_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type PolicyProposalParams = {
  consentRecordStore: ConsentRecordStore;
  /** Policy store with embedding support for conflict detection. */
  policyStore: PolicyStore;
  /** Embedder for generating policy description embeddings. */
  embedder?: PolicyEmbedder;
  /** Minimum number of times the same effect set must be granted before proposal. */
  minRepetitions: number;
  /** Time window to look back for repeated grants (ms). */
  lookbackMs: number;
  /** Current agent and context for policy scoping. */
  agentId: string;
  channel?: string;
  /** Maximum expiry for self-minted policies (ms). Default: 30 days. */
  maxExpiryMs?: number;
  /** Maximum uses before re-confirmation. Default: 100. */
  maxUses?: number;
};

export type PolicyProposal = {
  suggestedPolicy: StandingPolicy;
  /** Evidence: the consent records that motivated this proposal. */
  evidenceRecordIds: string[];
  /** Human-readable rationale for the user. */
  rationale: string;
  /** Existing policies that semantically overlap (conflict detection). */
  overlappingPolicies: Array<{ policy: StandingPolicy; distance: number }>;
};

export type CheckCOPromotionParams = {
  coEffectDescription: string;
  coEffects: EffectClass[];
  policyStore: PolicyStore;
  embedder: PolicyEmbedder;
  threshold?: number;
};

export type COPromotionResult = {
  shouldPromote: boolean;
  existingMatch?: { policy: StandingPolicy; distance: number };
};

// ---------------------------------------------------------------------------
// analyzeForPolicyProposals
// ---------------------------------------------------------------------------

/**
 * Analyze recent consent records for repeated grant patterns that suggest a
 * standing policy would reduce friction without compromising safety.
 *
 * Algorithm:
 *   1. Fetch all granted consent records within the lookback window
 *   2. Group by canonicalized effect set (sorted, joined)
 *   3. Filter groups with >= minRepetitions
 *   4. For each qualifying group, build a candidate policy
 *   5. Run semantic conflict detection against existing policies
 *   6. Apply safety constraints (skip high-risk without escalation)
 *   7. Return proposals with evidence and overlap info
 */
export async function analyzeForPolicyProposals(
  params: PolicyProposalParams,
): Promise<PolicyProposal[]> {
  const {
    consentRecordStore,
    policyStore,
    embedder,
    minRepetitions,
    lookbackMs,
    agentId,
    channel,
    maxExpiryMs = DEFAULT_SELF_MINTED_MAX_EXPIRY_MS,
    maxUses = DEFAULT_SELF_MINTED_MAX_USES,
  } = params;

  const now = Date.now();
  const cutoff = now - lookbackMs;

  // Step 1: Fetch all granted consent records
  const grantedRecords = consentRecordStore.getConsentRecordsByDecision("granted");

  // Step 2: Filter to lookback window and group by effect set
  const effectGroups = groupByEffectSet(grantedRecords, cutoff);

  // Step 3: Filter to groups meeting repetition threshold
  const qualifyingGroups = [...effectGroups.entries()].filter(
    ([, records]) => records.length >= minRepetitions,
  );

  const proposals: PolicyProposal[] = [];

  for (const [effectKey, records] of qualifyingGroups) {
    const effects = effectKey.split(",") as EffectClass[];

    // Step 6: Safety constraints — skip pure high-risk sets without escalation
    if (effects.every((e) => HIGH_RISK_EFFECTS.has(e))) {
      continue;
    }

    const safeEffects = effects.filter((e) => !HIGH_RISK_EFFECTS.has(e));
    const riskyEffects = effects.filter((e) => HIGH_RISK_EFFECTS.has(e));

    // Build escalation rules for any high-risk effects in the set
    const escalationRules: EscalationRule[] = riskyEffects.map((effect) => ({
      condition: { kind: "effect-combination" as const, effects: [effect] },
      action: "trigger-eaa" as const,
      description: `Auto-escalation: ${effect} is high-risk and requires EAA deliberation.`,
    }));

    const description = buildProposalDescription(safeEffects, riskyEffects, records.length);

    // Step 4: Build candidate policy
    const candidatePolicy: StandingPolicy = {
      id: `self-minted-${randomUUID()}`,
      class: "self-minted",
      effectScope: effects,
      applicability: channel ? { channels: [channel] } : {},
      escalationRules,
      expiry: {
        expiresAt: now + maxExpiryMs,
        maxUses,
        currentUses: 0,
      },
      revocationSemantics: "immediate",
      provenance: {
        author: `agent:${agentId}`,
        createdAt: now,
        sourceRef: `consent-pattern-analysis:${effectKey}`,
      },
      description,
      status: "pending-confirmation",
    };

    // Step 5: Semantic conflict detection
    const overlappingPolicies = await findOverlappingPolicies(
      candidatePolicy,
      policyStore,
      embedder,
    );

    const rationale = buildRationale(effects, records.length, lookbackMs, overlappingPolicies);

    proposals.push({
      suggestedPolicy: candidatePolicy,
      evidenceRecordIds: records.map((r) => r.id),
      rationale,
      overlappingPolicies,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// createSelfMintedPolicy
// ---------------------------------------------------------------------------

/**
 * Convert a policy proposal to a pending self-minted StandingPolicy.
 * Persists the policy with status "pending-confirmation" and stores
 * its embedding if an embedder is provided.
 */
export async function createSelfMintedPolicy(
  proposal: PolicyProposal,
  store: PolicyStore,
  embedder?: PolicyEmbedder,
): Promise<StandingPolicy> {
  const policy = proposal.suggestedPolicy;

  if (policy.status !== "pending-confirmation") {
    throw new Error(
      `Self-minted policy must start as "pending-confirmation", got "${policy.status}"`,
    );
  }

  store.insertPolicy(policy);

  if (embedder) {
    const text = buildPolicyEmbeddingText(policy);
    const embedding = await embedder(text);
    store.upsertPolicyEmbedding(policy.id, embedding);
  }

  return policy;
}

// ---------------------------------------------------------------------------
// checkCOForPolicyPromotion
// ---------------------------------------------------------------------------

/**
 * Check whether a recently granted CO could be promoted to a standing policy.
 * Embeds the CO's effect description and searches for existing policies that
 * already cover it semantically. Only suggests new policy creation if no
 * good match exists (distance > threshold).
 */
export async function checkCOForPolicyPromotion(
  params: CheckCOPromotionParams,
): Promise<COPromotionResult> {
  const {
    coEffectDescription,
    coEffects,
    policyStore,
    embedder,
    threshold = DEFAULT_CO_PROMOTION_THRESHOLD,
  } = params;

  // Build embedding text mirroring policy format for comparable cosine distances
  const queryText =
    coEffects.length > 0
      ? `[effects: ${coEffects.join(", ")}] ${coEffectDescription}`
      : coEffectDescription;

  const queryEmbedding = await embedder(queryText);

  const matches = policyStore.findSimilarPolicies({
    embedding: queryEmbedding,
    topK: 1,
    threshold,
    statusFilter: ["active"],
  });

  if (matches.length > 0) {
    return {
      shouldPromote: false,
      existingMatch: matches[0],
    };
  }

  return { shouldPromote: true };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Group consent records by their canonicalized effect set key.
 * Only includes records within the lookback window.
 */
function groupByEffectSet(
  records: readonly ConsentRecord[],
  cutoffTimestamp: number,
): Map<string, ConsentRecord[]> {
  const groups = new Map<string, ConsentRecord[]>();

  for (const record of records) {
    if (record.timestamp < cutoffTimestamp) {
      continue;
    }
    if (record.effectClasses.length === 0) {
      continue;
    }

    const key = [...record.effectClasses].toSorted().join(",");
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  return groups;
}

/**
 * Find existing policies that semantically overlap with a candidate.
 * Falls back to an empty array when no embedder is provided.
 */
async function findOverlappingPolicies(
  candidate: StandingPolicy,
  policyStore: PolicyStore,
  embedder?: PolicyEmbedder,
): Promise<Array<{ policy: StandingPolicy; distance: number }>> {
  if (!embedder) {
    return [];
  }

  const text = buildPolicyEmbeddingText(candidate);
  const embedding = await embedder(text);

  return policyStore.findSimilarPolicies({
    embedding,
    topK: 5,
    threshold: 0.5,
    statusFilter: ["active", "pending-confirmation"],
  });
}

function buildProposalDescription(
  safeEffects: EffectClass[],
  riskyEffects: EffectClass[],
  recordCount: number,
): string {
  const allEffects = [...safeEffects, ...riskyEffects];
  const base = `Auto-proposed policy for [${allEffects.join(", ")}] based on ${recordCount} repeated grants.`;
  if (riskyEffects.length > 0) {
    return `${base} High-risk effects [${riskyEffects.join(", ")}] require EAA escalation.`;
  }
  return base;
}

function buildRationale(
  effects: EffectClass[],
  count: number,
  lookbackMs: number,
  overlapping: Array<{ policy: StandingPolicy; distance: number }>,
): string {
  const days = Math.round(lookbackMs / (24 * 60 * 60 * 1000));
  const parts = [
    `The effect set [${effects.join(", ")}] was granted ${count} times in the last ${days} day(s).`,
    "Creating a standing policy would reduce repeated consent prompts for this pattern.",
  ];

  if (overlapping.length > 0) {
    const ids = overlapping.map((o) => o.policy.id).join(", ");
    parts.push(
      `Note: ${overlapping.length} existing policy/policies overlap semantically: [${ids}]. ` +
        "Review whether the existing coverage is sufficient before confirming.",
    );
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Testing Seam
// ---------------------------------------------------------------------------

export const __testing = {
  HIGH_RISK_EFFECTS,
  groupByEffectSet,
  findOverlappingPolicies,
  buildProposalDescription,
  buildRationale,
  DEFAULT_SELF_MINTED_MAX_EXPIRY_MS,
  DEFAULT_SELF_MINTED_MAX_USES,
  DEFAULT_CO_PROMOTION_THRESHOLD,
};
