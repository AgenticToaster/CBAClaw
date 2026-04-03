# CBA Phase 5 Implementation Summary

Token-optimized handoff for Phase 6 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phase 0-1 types/binder/scope-chain + Phase 2 integration + Phase 3 consent lifecycle + Phase 4 EAA + Phase 5 standing policies)
- Tests: `npx vitest run src/consent/` — 557 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`, `plans/phase-3-summary.md`, `plans/phase-4-summary.md`

## Files Delivered (Phase 5a–5i)

### New Files

```
src/consent/
  policy.ts                # Standing policy type system, utilities, defaults (554 LOC)
  policy.test.ts           # 108 tests
  policy-store.ts          # SQLite + sqlite-vec persistent policy store (554 LOC)
  policy-store.test.ts     # 35 tests
  policy-proposal.ts       # Self-minted policy proposal system (386 LOC)
  policy-proposal.test.ts  # 24 tests
```

### Modified Files

```
src/consent/
  binder.ts          # evaluatePoliciesForGrants, dual-path retrieval, Phase 5f enforcement
  binder.test.ts     # 79 new tests (Phase 5c/5d/5f)
  integration.ts     # Policy-loaded initializeConsentForRun (Phase 5i)
  integration.test.ts # 4 new tests (Phase 5i)
  eaa-integration.ts # Policy bypass in handleConsentFailure, policy threading (Phase 5i)
  index.ts           # Barrel updated with Phase 5a–5f exports

src/config/
  types.openclaw.ts  # consent.policies config section (Phase 5h)
  zod-schema.ts      # consent.policies Zod validation (Phase 5h)
```

## Phase 5a Architecture: Standing Policy Type System

```
StandingPolicy
├── id: string (UUID)
├── class: PolicyClass ("system" | "user" | "self-minted")
├── effectScope: EffectClass[]
├── applicability: PolicyApplicabilityPredicate
│     ├── channels?: string[]
│     ├── chatTypes?: ("dm" | "group" | "public")[]
│     ├── senderIds?: string[]
│     ├── requireOwner?: boolean
│     ├── timeWindow?: { startHour, endHour }
│     ├── toolNames?: string[]
│     └── minTrustTier?: TrustTier
├── escalationRules: EscalationRule[]
│     └── { condition: EscalationCondition, action, description }
│           Conditions: effect-combination, audience-exceeds,
│                       frequency-exceeds, trust-tier-below, custom
├── expiry: PolicyExpiry
│     ├── expiresAt?: number
│     ├── maxUses?: number
│     └── currentUses: number
├── revocationSemantics: "immediate" | "after-current-slice"
├── provenance: PolicyProvenance
│     ├── author: string
│     ├── createdAt: number
│     ├── confirmedAt?: number
│     └── sourceRef?: string
├── description: string
└── status: PolicyStatus ("active" | "pending-confirmation" | "revoked" | "expired")
```

### policy.ts

#### Exported Types

- **`StandingPolicy`**: full standing policy with bounding-box semantics
- **`PolicyClass`**: `"user" | "self-minted" | "system"`
- **`PolicyStatus`**: `"active" | "pending-confirmation" | "revoked" | "expired"`
- **`PolicyApplicabilityPredicate`**: optional filters (empty = universal match)
- **`EscalationRule`**: `{ condition: EscalationCondition, action: "require-co" | "trigger-eaa" | "refuse", description }`
- **`EscalationCondition`**: discriminated union on `kind`: `effect-combination`, `audience-exceeds`, `frequency-exceeds`, `trust-tier-below`, `custom`
- **`EscalationContext`**: `{ toolName, toolProfile, po, recentInvocationCount }`
- **`PolicyExpiry`**: `{ expiresAt?, maxUses?, currentUses }`
- **`PolicyRevocationSemantics`**: `"immediate" | "after-current-slice"`
- **`PolicyProvenance`**: `{ author, createdAt, confirmedAt?, sourceRef? }`
- **`PolicyMatchContext`**: `{ channel?, chatType?, senderId, senderIsOwner, toolName?, toolTrustTier?, currentHour? }`
- **`ToolSource`**: `"bundled" | "npm" | "mcp" | "unknown"` (Phase 5f)

#### Exported Functions

| Function                    | Signature                                                                         | Description                                           |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `filterApplicablePolicies`  | `(policies, context: PolicyMatchContext) → StandingPolicy[]`                      | Filter active, non-expired policies matching context  |
| `evaluateEscalationRules`   | `(rules: EscalationRule[], ctx: EscalationContext) → EscalationRule \| undefined` | Returns first matching escalation rule                |
| `isExpired`                 | `(expiry: PolicyExpiry) → boolean`                                                | Checks time-based and usage-based expiry              |
| `meetsTrustTier`            | `(actual: TrustTier, minimum: TrustTier) → boolean`                               | Ordered comparison: external < sandboxed < in-process |
| `isFullStandingPolicy`      | `(p: StandingPolicyStub \| StandingPolicy) → p is StandingPolicy`                 | Type guard for full policy vs stub                    |
| `recordAndCheckUsage`       | `(policy: StandingPolicy) → boolean`                                              | Increment usage, return true if still within maxUses  |
| `buildPolicyEmbeddingText`  | `(policy: StandingPolicy) → string`                                               | `[effects: read, persist] description text`           |
| `buildContextEmbeddingText` | `(opts) → string`                                                                 | Matching query-side embedding text                    |
| `deriveTrustTier`           | `(explicitTier?, source: ToolSource) → TrustTier`                                 | Derive trust tier from tool source (Phase 5f)         |

#### Exported Constants

| Constant                  | Type                        | Description                                                            |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `DEFAULT_SYSTEM_POLICIES` | `readonly StandingPolicy[]` | 3 system policies: read-compose baseline, physical-EAA, elevated-owner |

### Trust Tier Derivation Rules (Phase 5f)

| ToolSource | Derived TrustTier | Rationale                               |
| ---------- | ----------------- | --------------------------------------- |
| `bundled`  | `in-process`      | First-party, reviewed workspace plugins |
| `npm`      | `sandboxed`       | Third-party, isolated npm plugins       |
| `mcp`      | `external`        | Remote, untrusted MCP transport tools   |
| `unknown`  | `sandboxed`       | Conservative default                    |

Explicit `trustTier` on `ToolEffectProfile` always takes precedence over derivation.

## Phase 5b Architecture: Policy Store

```
PolicyStore (SQLite + sqlite-vec)
├── policies table
│     ├── id, class, effect_scope, applicability, escalation_rules
│     ├── expiry, revocation_semantics, provenance, description, status
│     └── created_at, updated_at
├── policy_usage table
│     ├── policy_id → policies(id)
│     ├── wo_id, used_at
│     └── PRIMARY KEY (policy_id, wo_id)  ← dedup by policy+WO
└── policy_embeddings vec0 (optional, dim > 0)
      ├── policy_id TEXT PRIMARY KEY
      └── embedding float[dim] distance_metric=cosine
```

Location: `~/.openclaw/consent/policies.sqlite` (agent-global, not per-session).

### policy-store.ts

#### Exported Types

- **`PolicyStore`**: interface with CRUD, status lifecycle, usage tracking, embedding ops, similarity search
- **`OpenPolicyStoreParams`**: `{ dbPath, embeddingDimension?, injectedDb?, skipVecExtension? }`

#### Exported Functions

| Function                        | Signature                         | Description                         |
| ------------------------------- | --------------------------------- | ----------------------------------- |
| `openPolicyStore`               | `(params) → Promise<PolicyStore>` | Opens/creates store, ensures schema |
| `resolveDefaultPolicyStorePath` | `() → Promise<string>`            | Config-based path resolution        |
| `resolvePolicyStorePath`        | `(stateDir) → string`             | Deterministic path from state dir   |

#### PolicyStore Interface

| Method                     | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `insertPolicy`             | Insert new policy                                              |
| `getPolicy`                | Get by ID (hydrates currentUses from usage table)              |
| `getActivePolicies`        | All policies with status="active"                              |
| `getActivePoliciesByClass` | Active policies filtered by class                              |
| `updatePolicyStatus`       | Activate, revoke, expire                                       |
| `confirmPolicy`            | Atomic pending-confirmation → active with confirmedAt          |
| `recordPolicyUsage`        | Deduplicated by policy+WO pair                                 |
| `getPolicyUsageCount`      | Count of usage records                                         |
| `expireStalePolicies`      | Sweep: expires policies past expiresAt or maxUses              |
| `upsertPolicyEmbedding`    | Store/update embedding vector (no-op at dim=0)                 |
| `deletePolicyEmbedding`    | Remove embedding (no-op at dim=0)                              |
| `findSimilarPolicies`      | KNN cosine search with threshold/statusFilter (no-op at dim=0) |
| `clearAll`                 | Remove all data (testing)                                      |
| `close`                    | Close database connection                                      |

## Phase 5c Architecture: Binder Dual-Path Policy Evaluation

```
mintInitialWorkOrder / mintSuccessorWorkOrder
    │
    ├── 1. System prohibitions (effects removed unconditionally)
    │
    ├── 2. evaluatePoliciesForGrants()
    │       │
    │       ├── Deterministic path (always)
    │       │     └── filterApplicablePolicies(policies, matchContext)
    │       │
    │       ├── Semantic path (optional, when semanticPolicyCandidates provided)
    │       │     └── filterApplicablePolicies(semanticCandidates, matchContext)
    │       │
    │       ├── Merge + dedup by policy ID
    │       ├── Sort by class: system → user → self-minted
    │       │
    │       └── For each merged policy:
    │             ├── Skip if status ≠ "active" or expired
    │             ├── Evaluate escalation rules → skip if any fires
    │             ├── Phase 5f: external tool + non-system + no trust-tier rule → skip
    │             └── Grant effects not already granted or prohibited
    │
    └── 3. Seal WO with combined grants + policy anchors
```

### PolicyEmbedder Type

```typescript
export type PolicyEmbedder = (text: string) => Promise<Float32Array>;
```

Accepted via `BinderMintInput.semanticPolicyCandidates` (pre-resolved by caller). When absent, binder uses deterministic-only retrieval.

### Policy Application Order

1. System prohibitions (from `systemProhibitions` array)
2. System policies (class precedence, sorted first)
3. User policies
4. Self-minted policies (lowest precedence)

Within each class: first applicable policy wins per effect (effects already granted by higher-precedence policies are not re-granted).

### External-Tool Policy Enforcement (Phase 5f)

When `toolTier === "external"` and `policy.class !== "system"`:

- The policy MUST have at least one escalation rule with `condition.kind === "trust-tier-below"`
- Otherwise the policy is skipped (not consumed for this tool invocation)
- System policies are exempt from this requirement

This check runs AFTER escalation rule evaluation. The flow:

1. Escalation rules evaluated → if any fires, policy skipped (for all tools)
2. Phase 5f check → if external tool and no trust-tier rule on non-system policy, skipped
3. Effect grants applied

This means a policy with a `trust-tier-below` rule that FIRES for this tool is skipped at step 1. A policy with a `trust-tier-below` rule that does NOT fire (tool meets threshold) passes both steps and grants effects.

## Phase 5d: Default System Policies

| ID                   | Effect Scope  | Applicability        | Escalation Rules                               | Purpose                                   |
| -------------------- | ------------- | -------------------- | ---------------------------------------------- | ----------------------------------------- |
| `sys-read-compose`   | read, compose | Universal            | None                                           | Baseline: always permit read/compose      |
| `sys-physical-eaa`   | physical      | Universal            | `effect-combination: [physical]` → trigger-eaa | Physical effects always require EAA       |
| `sys-elevated-owner` | elevated      | `requireOwner: true` | `trust-tier-below: in-process` → trigger-eaa   | Elevated restricted to owner + in-process |

## Phase 5e Architecture: Self-Minted Policy Proposals

```
analyzeForPolicyProposals({consentRecordStore, policyStore, embedder?,
                            minRepetitions, lookbackMs, agentId, channel?,
                            maxExpiryMs?, maxUses?})
    │
    ├── 1. Fetch granted consent records from store
    ├── 2. Filter to lookback window, group by canonicalized effect set
    ├── 3. Filter groups by minRepetitions threshold
    │
    └── For each qualifying group:
          ├── 4. Safety gate: skip if ALL effects are HIGH_RISK_EFFECTS
          ├── 5. Build escalation rules for high-risk effects in mixed sets
          ├── 6. Build candidate StandingPolicy (class: self-minted,
          │       status: pending-confirmation, expiry capped)
          ├── 7. Semantic conflict detection via findSimilarPolicies
          └── 8. Build rationale + evidence → PolicyProposal

createSelfMintedPolicy(proposal, store, embedder?)
    ├── Validate status === "pending-confirmation"
    ├── insertPolicy(policy)
    └── upsertPolicyEmbedding(policy.id, embedding) if embedder

checkCOForPolicyPromotion({coEffectDescription, coEffects, policyStore, embedder, threshold?})
    ├── Build query embedding in policy-compatible format
    ├── findSimilarPolicies(embedding, topK=1, threshold, statusFilter=["active"])
    └── Return shouldPromote: true if no match, false with existingMatch if overlap
```

### policy-proposal.ts

#### Constants

| Constant                            | Value                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `HIGH_RISK_EFFECTS`                 | Set of 6: irreversible, elevated, disclose, audience-expand, exec, physical |
| `DEFAULT_SELF_MINTED_MAX_EXPIRY_MS` | 2592000000 (30 days)                                                        |
| `DEFAULT_SELF_MINTED_MAX_USES`      | 100                                                                         |
| `DEFAULT_CO_PROMOTION_THRESHOLD`    | 0.4                                                                         |

#### Exported Types

- **`PolicyProposalParams`**: `{ consentRecordStore, policyStore, embedder?, minRepetitions, lookbackMs, agentId, channel?, maxExpiryMs?, maxUses? }`
- **`PolicyProposal`**: `{ suggestedPolicy: StandingPolicy, evidenceRecordIds: string[], rationale: string, overlappingPolicies: {policy, distance}[] }`
- **`CheckCOPromotionParams`**: `{ coEffectDescription, coEffects, policyStore, embedder, threshold? }`
- **`COPromotionResult`**: `{ shouldPromote: boolean, existingMatch?: {policy, distance} }`

#### Exported Functions

| Function                    | Signature                                                       | Description                                     |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| `analyzeForPolicyProposals` | `(params: PolicyProposalParams) → Promise<PolicyProposal[]>`    | Full pattern analysis + conflict detection      |
| `createSelfMintedPolicy`    | `(proposal, store, embedder?) → Promise<StandingPolicy>`        | Persist proposal as pending-confirmation policy |
| `checkCOForPolicyPromotion` | `(params: CheckCOPromotionParams) → Promise<COPromotionResult>` | Check if CO should become standing policy       |

### Safety Constraints for Self-Minted Proposals

| Constraint                 | Rule                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| All-high-risk effect sets  | Skipped entirely, no proposal generated                           |
| Mixed sets with high-risk  | `trigger-eaa` escalation rule added per high-risk effect          |
| Initial status             | Always `pending-confirmation` — requires human confirmation       |
| Maximum expiry             | Capped at `maxExpiryMs` (default 30 days)                         |
| Maximum uses               | Capped at `maxUses` (default 100) before re-confirmation required |
| Semantic overlap detection | Existing active/pending policies checked via embedding similarity |

## Phase 5h: Configuration Surface

```yaml
consent:
  impliedEffects: # (Phase 3a, unchanged)
    provider: "auto"
    model: null
    threshold: 0.35
    topK: 5
    mode: "both"
  policies: # (Phase 5h, new)
    enabled: false # Opt-in gate
    storePath: null # Auto-resolved if omitted
    selfMintedMaxExpiryMs: 2592000000 # 30 days
    selfMintedMinRepetitions: 3
    selfMintedLookbackMs: 604800000 # 7 days
    embeddingDimension: 0 # 0 = disabled
```

Zod validation: `.strict()` on both `policies` and parent `consent` objects. All fields optional.

## Phase 5i Architecture: Pipeline Integration

```
initializeConsentForRun({..., policyStore?})
    │
    ├── initializeSigningKey()
    ├── resolveConsentEnforcementMode()
    ├── deriveImpliedEffects() (Phase 3a)
    │
    ├── if policyStore:
    │     ├── expireStalePolicies()
    │     ├── getActivePolicies()
    │     └── allPolicies = [...DEFAULT_SYSTEM_POLICIES, ...activePolicies]
    │
    ├── createPurchaseOrder()
    ├── mintInitialWorkOrder({ po, policies: allPolicies, systemProhibitions: [] })
    │
    └── ConsentRunContext { scopeState, po, wo, enforcement, activePolicies, policyStore }

handleConsentFailure({..., policies?, systemProhibitions?})
    │
    ├── Phase 5i: Policy bypass (NEW, runs first)
    │     ├── filterApplicablePolicies(policies, matchContext)
    │     ├── Check: all missingEffects covered by applicable policies?
    │     ├── yes → mintSuccessorWorkOrder(policyAnchors) → transitionWorkOrder → proceed
    │     └── no / refused → fall through
    │
    ├── Step 1: Consent precedent reuse (Phase 3c, passes policies through)
    ├── Step 2: evaluateEAATriggers (Phase 4a)
    ├── Step 3: No EAA → requestChangeOrder (Phase 3b)
    └── Step 4: EAA → runElevatedActionAnalysis (Phase 4b, passes policies through)
```

### ConsentRunContext Changes

```typescript
export type ConsentRunContext = {
  scopeState: ConsentScopeState;
  po: PurchaseOrder;
  wo: WorkOrder;
  enforcement: ConsentEnforcementMode;
  activePolicies: readonly StandingPolicy[]; // NEW (Phase 5i)
  policyStore?: PolicyStore; // NEW (Phase 5i)
};
```

### HandleConsentFailureParams Changes

```typescript
export type HandleConsentFailureParams = {
  // ... existing fields ...
  policies?: readonly (StandingPolicyStub | BinderPolicy)[]; // NEW (Phase 5i)
  systemProhibitions?: EffectClass[]; // NEW (Phase 5i)
};
```

## Test Summary

| File                      | Tests | Skipped | Coverage                                                                                       |
| ------------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------- |
| policy.test.ts            | 108   | 0       | Types, applicability, expiry, escalation, filtering, defaults, embedding text, deriveTrustTier |
| policy-store.test.ts      | 35    | 0       | CRUD, serialization, lifecycle, usage, expiry sweep, embedding ops, edge cases                 |
| binder.test.ts (5c/5d/5f) | 79    | 0       | Dual-path retrieval, merge/dedup, precedence, escalation, defaults, external enforcement       |
| policy-proposal.test.ts   | 24    | 0       | Grouping, safety constraints, conflict detection, CO promotion, HIGH_RISK_EFFECTS              |
| integration.test.ts (5i)  | 4     | 0       | Policy loading, backward compat, expiry sweep, error handling                                  |

**Full consent test suite: 557 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions

### Phase 5a

1. **Bounding-box semantics**: policies pre-authorize bounded effect sets, not blank checks. The `effectScope` field enumerates exactly which effects the policy covers. The binder verifies effects individually.

2. **Three-class hierarchy with fixed precedence**: system → user → self-minted. System policies are inviolable (cannot be overridden by user policies). Self-minted policies are lowest precedence and require human confirmation before activation.

3. **Escalation rules as safety valves**: even when a policy would grant consent, escalation conditions can force CO/EAA/refusal. This provides defense-in-depth against policy overreach.

4. **Empty predicate = universal match**: `PolicyApplicabilityPredicate` with no fields set matches any context. This makes broad policies easy to express while still supporting precise scoping.

5. **Overnight time window wrap**: `timeWindow: { startHour: 22, endHour: 6 }` correctly handles overnight ranges by splitting into two comparisons. The `isInTimeWindow` helper manages this.

### Phase 5b

6. **Agent-global store, not per-session**: policies persist across sessions. The store lives at `~/.openclaw/consent/policies.sqlite`, not under a session directory. This is the key difference from consent records (per-session).

7. **Usage count hydrated from usage table**: `currentUses` is derived from the `policy_usage` table count, not stored in the `expiry` JSON. This prevents stale usage counts if the expiry JSON is edited manually.

8. **Custom escalation condition stripping**: `kind: "custom"` conditions include a function-typed `evaluate` field that cannot be serialized. The store strips custom conditions on write. System policies with custom conditions must be restored from code at load time.

9. **Embedding dimension as creation-time parameter**: the vec0 virtual table dimension is fixed at store creation. Changing dimensions requires store rebuild. When `embeddingDimension` is 0, all embedding methods are no-ops.

### Phase 5c

10. **Dual-path retrieval with shared validation**: the semantic path finds candidates by embedding similarity, but EVERY candidate must pass the same deterministic validation (status, expiry, applicability, escalation) as the deterministic path. There is no validation gap between paths.

11. **Semantic candidates pre-resolved by caller**: the binder does not call the embedding provider or policy store directly. Callers resolve semantic candidates externally and pass them via `semanticPolicyCandidates`. This keeps the binder synchronous and testable.

12. **Policy anchors only for contributing policies**: a policy produces a `{ kind: "policy", policyId }` anchor only when it contributes at least one new effect or validates an already-granted effect. Policies that are skipped (expired, escalated, inapplicable) produce no anchors.

### Phase 5d

13. **read-compose baseline as system policy**: rather than hardcoding read/compose grants in the binder, they are expressed as a system policy (`sys-read-compose`). This makes the baseline visible in policy audit and consistent with the policy evaluation pipeline.

14. **Physical-EAA escalation is unconditional**: the `sys-physical-eaa` policy covers physical effects but always escalates via `trigger-eaa`. This means physical effects are never auto-granted by policy — they always require EAA deliberation.

15. **Elevated-owner uses trust-tier escalation**: the `sys-elevated-owner` policy restricts elevated effects to owner contexts AND requires `in-process` trust tier. External tools attempting elevated operations trigger EAA regardless of owner status.

### Phase 5e

16. **Canonicalized effect keys**: consent records are grouped by `[...effectClasses].sort().join(",")`. This ensures `["read", "persist"]` and `["persist", "read"]` are treated as the same pattern.

17. **All-high-risk rejection**: groups where every effect is high-risk are skipped entirely. Auto-proposing a policy for pure `[exec, physical]` grants would bypass safety-critical consent flows. Mixed sets (e.g., `[read, exec]`) are allowed with mandatory escalation rules on the high-risk effects.

18. **Semantic conflict detection before proposal**: before presenting a proposal to the user, `findSimilarPolicies` checks for existing policies that already cover the same semantic territory. Overlapping policies are reported in the proposal rationale but do not block proposal creation — the user decides.

19. **CO-to-policy promotion via embedding distance**: `checkCOForPolicyPromotion` uses the same embedding format as policies for comparable cosine distances. The default threshold (0.4) is tighter than the conflict detection threshold (0.5) to avoid false promotions.

### Phase 5f

20. **External-tool policy gate in binder**: the Phase 5f check is placed AFTER escalation rule evaluation. This means: (a) if escalation rules fire, the policy is already skipped; (b) the 5f check only runs for policies that survived escalation; (c) external tools can only consume non-system policies that have explicitly acknowledged external trust tier risks via a `trust-tier-below` rule.

21. **System policy exemption from 5f**: system policies are exempt from the external-tool gate. This is intentional — system policies are inviolable and hardcoded, so their behavior is always reviewed. External tools should still receive system policy grants (e.g., read-compose baseline).

### Phase 5h

22. **Opt-in via `consent.policies.enabled`**: the standing policy framework defaults to `false`. This preserves backward compatibility and allows operators to enable policies after validating the consent flow works without them.

23. **`embeddingDimension: 0` as semantic disable**: when set to 0 (default), no vec0 table is created and all embedding operations are no-ops. This provides a clean deterministic-only mode without code branching.

### Phase 5i

24. **Policy bypass before precedent/EAA**: in `handleConsentFailure`, the policy bypass runs first. If active policies cover all missing effects, a successor WO is minted immediately with policy anchors, skipping CO/EAA entirely. This is the primary friction-reduction mechanism for routine operations.

25. **Graceful policy loading failure**: if the policy store throws during `initializeConsentForRun` (e.g., corrupt database), the system continues with empty policies. Policy store errors are non-fatal — they degrade to pre-Phase-5 behavior rather than blocking the agent.

26. **Policy threading through all successor paths**: `policies` and `systemProhibitions` are passed to every `mintSuccessorWorkOrder` call in the consent failure handler — precedent reuse, EAA proceed, EAA constrained-comply, and EAA emergency-act. This ensures the binder always has the full policy context for evaluation.

## Phase 5 Sub-Phase Status

| Sub-Phase | Scope                                   | Status    |
| --------- | --------------------------------------- | --------- |
| 5a        | Standing policy type system             | Completed |
| 5b        | Policy store (persistence + similarity) | Completed |
| 5c        | Binder dual-path policy evaluation      | Completed |
| 5d        | Default system policies                 | Completed |
| 5e        | Self-minted policy proposal             | Completed |
| 5f        | Dynamic trust tiers                     | Completed |
| 5g        | Absorbed into 5b/5c/5e                  | N/A       |
| 5h        | Configuration surface                   | Completed |
| 5i        | Pipeline integration                    | Completed |

## What Remains

### Phase 6: Observability and Audit

- Scope chain event model (structured events for policy grants, escalation triggers, CO resolutions, EAA outcomes)
- Action receipts (confirmation/receipt/report) as durable audit artifacts
- Gateway protocol extensions for consent methods (status queries, policy management, CO resolution via gateway)
- Consent flow metrics (grant rates, escalation rates, policy bypass rates, EAA trigger distribution)
- WO chain visualization for debugging consent flows
