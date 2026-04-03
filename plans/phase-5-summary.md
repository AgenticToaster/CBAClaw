# CBA Phase 5 Implementation Summary (In Progress)

Token-optimized handoff for remaining Phase 5 and Phase 6 implementation.

## Repo Context

- Repo: CBAClaw (fork of openclaw/openclaw)
- CBA module: `src/consent/` (Phases 0–4 complete + Phase 5a/5b delivered)
- Tests: `npx vitest run src/consent/` — 489 passing, 16 skipped (sqlite-vec not in test env)
- Prior summaries: `plans/phase-0-1-summary.md`, `plans/phase-2-summary.md`, `plans/phase-3-summary.md`, `plans/phase-4-summary.md`

## Phase 5 Status

| Sub-phase | Description                                             | Status    |
| --------- | ------------------------------------------------------- | --------- |
| 5a        | Standing policy type system                             | Completed |
| 5b        | Policy store (persistence + vector similarity)          | Completed |
| 5c        | Binder policy evaluation (dual-path retrieval)          | Pending   |
| 5d        | Default system policies (startup loading)               | Pending   |
| 5e        | Self-minted policy proposal (semantic conflict detect.) | Pending   |
| 5f        | Dynamic trust tiers for plugin tools                    | Pending   |
| 5g        | Pattern store reuse for policy matching                 | Cancelled |
| 5h        | Configuration surface                                   | Pending   |
| 5i        | Pipeline integration                                    | Pending   |

Phase 5g was absorbed into 5b (store), 5c (binder), and 5e (proposal). Vector-based semantic policy retrieval is a first-class capability of the policy store from day one.

## Files Delivered (Phase 5a + 5b)

### New Files

```
src/consent/
  policy.ts              # Policy type system, matching, escalation, defaults, embedding text (476 LOC)
  policy.test.ts         # 103 tests
  policy-store.ts        # SQLite + sqlite-vec policy persistence store (617 LOC)
  policy-store.test.ts   # 35 tests
```

### Modified Files

```
src/consent/
  index.ts               # Barrel updated with Phase 5a + 5b exports
```

## Phase 5a Architecture

```
StandingPolicyStub (Phases 0–4, narrow)
    │
    ▼
StandingPolicy (Phase 5a, full)
    ├── class: "system" | "user" | "self-minted"
    ├── effectScope: EffectClass[]
    ├── applicability: PolicyApplicabilityPredicate
    │     ├── channels?, chatTypes?, senderIds?
    │     ├── requireOwner?, timeWindow?
    │     └── toolNames?, minTrustTier?
    ├── escalationRules: EscalationRule[]
    │     └── EscalationCondition (discriminated union)
    │           ├── effect-combination
    │           ├── audience-exceeds
    │           ├── frequency-exceeds
    │           ├── trust-tier-below
    │           └── custom (runtime-only, not persisted)
    ├── expiry: PolicyExpiry { expiresAt?, maxUses?, currentUses }
    ├── revocationSemantics: "immediate" | "after-current-slice"
    ├── provenance: PolicyProvenance { author, createdAt, confirmedAt?, sourceRef? }
    ├── description: string
    └── status: "active" | "pending-confirmation" | "revoked" | "expired"

Backward Compatibility:
    isFullStandingPolicy(p) → type guard, discriminates StandingPolicy from StandingPolicyStub
    filterApplicablePolicies() accepts both types, silently skips stubs
```

### policy.ts

#### Exported Types

- **`PolicyClass`**: `"user" | "self-minted" | "system"`
- **`PolicyStatus`**: `"active" | "pending-confirmation" | "revoked" | "expired"`
- **`StandingPolicy`**: full policy with all fields
- **`PolicyApplicabilityPredicate`**: optional filter fields (channels, chatTypes, senderIds, requireOwner, timeWindow, toolNames, minTrustTier)
- **`EscalationRule`**: `{ condition: EscalationCondition, action: "require-co" | "trigger-eaa" | "refuse", description }`
- **`EscalationCondition`**: discriminated union (effect-combination, audience-exceeds, frequency-exceeds, trust-tier-below, custom)
- **`EscalationContext`**: runtime context for escalation evaluation (toolName, toolProfile, po subset, recentInvocationCount)
- **`PolicyExpiry`**: `{ expiresAt?, maxUses?, currentUses }`
- **`PolicyRevocationSemantics`**: `"immediate" | "after-current-slice"`
- **`PolicyProvenance`**: `{ author, createdAt, confirmedAt?, sourceRef? }`
- **`PolicyMatchContext`**: `{ channel?, chatType?, senderId, senderIsOwner, toolName?, toolTrustTier?, currentHour? }`

#### Exported Functions

| Function                    | Signature                                                               | Description                                         |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| `filterApplicablePolicies`  | `(policies, context: PolicyMatchContext) → StandingPolicy[]`            | Active, non-expired, context-matching policies      |
| `evaluateEscalationRules`   | `(rules: EscalationRule[], context: EscalationContext) → Rule \| undef` | First matching escalation rule                      |
| `isExpired`                 | `(expiry: PolicyExpiry, now?) → boolean`                                | Time-based + usage-based expiry check               |
| `meetsTrustTier`            | `(actual: TrustTier, minimum: TrustTier) → boolean`                     | Ordered trust tier comparison                       |
| `isFullStandingPolicy`      | `(p: StandingPolicyStub \| StandingPolicy) → p is StandingPolicy`       | Type guard for full policy                          |
| `buildPolicyEmbeddingText`  | `(policy: StandingPolicy) → string`                                     | Composite embedding text from effects + description |
| `buildContextEmbeddingText` | `(params: {effects, toolName?, description?}) → string`                 | Query-side embedding text mirroring policy format   |

#### Exported Constants

| Constant                  | Type                        | Description                                                   |
| ------------------------- | --------------------------- | ------------------------------------------------------------- |
| `DEFAULT_SYSTEM_POLICIES` | `readonly StandingPolicy[]` | 3 system policies: read/compose, physical-EAA, elevated-owner |

#### Testing Seam (`__testing`)

`TRUST_TIER_RANK`, `matchesApplicability`, `isInTimeWindow`, `matchesEscalationCondition`

## Phase 5b Architecture

```
PolicyStore (agent-global, persists across sessions)
    │
    ├── SQLite: policies table
    │     ├── id, class, effect_scope (JSON), applicability (JSON)
    │     ├── escalation_rules (JSON, custom stripped), expiry (JSON)
    │     ├── revocation_semantics, provenance (JSON)
    │     ├── description, status, created_at, updated_at
    │     └── indexes: idx_policies_status, idx_policies_class
    │
    ├── SQLite: policy_usage table
    │     ├── policy_id → policies(id), wo_id, used_at
    │     ├── PRIMARY KEY (policy_id, wo_id) — deduplicated
    │     └── index: idx_policy_usage_policy
    │
    └── sqlite-vec: policy_embeddings vec0 table (optional, dim > 0)
          ├── policy_id TEXT PRIMARY KEY
          └── embedding float[<dim>] distance_metric=cosine

Storage: ~/.openclaw/consent/policies.sqlite
PRAGMA: journal_mode=WAL, foreign_keys=ON
Permissions: directory 700, file 600
```

### policy-store.ts

#### Exported Types

- **`PolicyStore`**: interface with all CRUD, lifecycle, embedding, and utility methods
- **`OpenPolicyStoreParams`**: `{ dbPath, embeddingDimension?, injectedDb?, skipVecExtension? }`

#### PolicyStore Interface

| Method                     | Signature                                                                        | Description                                             |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `insertPolicy`             | `(policy: StandingPolicy) → void`                                                | Insert new policy (throws on duplicate PK)              |
| `getPolicy`                | `(id: string) → StandingPolicy \| undefined`                                     | Retrieve by ID, hydrates currentUses from usage table   |
| `getActivePolicies`        | `() → StandingPolicy[]`                                                          | All active policies, ordered by created_at              |
| `getActivePoliciesByClass` | `(policyClass: PolicyClass) → StandingPolicy[]`                                  | Active policies filtered by class                       |
| `updatePolicyStatus`       | `(id, status, updatedAt?) → boolean`                                             | Status transition, returns false if not found           |
| `confirmPolicy`            | `(id, confirmedAt?) → boolean`                                                   | Atomic pending-confirmation → active + sets confirmedAt |
| `recordPolicyUsage`        | `(policyId, woId) → void`                                                        | Record usage (deduplicated by policy+WO pair)           |
| `getPolicyUsageCount`      | `(policyId) → number`                                                            | Count of distinct WOs that used this policy             |
| `expireStalePolicies`      | `(now?) → number`                                                                | Expire active policies past time/usage limits           |
| `upsertPolicyEmbedding`    | `(policyId, embedding: Float32Array) → void`                                     | Store/update embedding (no-op when dim=0)               |
| `deletePolicyEmbedding`    | `(policyId) → void`                                                              | Delete embedding (no-op when dim=0)                     |
| `findSimilarPolicies`      | `(params: {embedding, topK?, threshold?, statusFilter?}) → {policy, distance}[]` | KNN cosine search with status filtering                 |
| `clearAll`                 | `() → void`                                                                      | Remove all data (testing)                               |
| `close`                    | `() → void`                                                                      | Close DB connection (idempotent)                        |
| `db`                       | `readonly DatabaseSync`                                                          | Exposed for testing                                     |

#### Exported Functions

| Function                        | Signature                                                | Description                     |
| ------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `openPolicyStore`               | `(params: OpenPolicyStoreParams) → Promise<PolicyStore>` | Async factory with schema + vec |
| `resolvePolicyStorePath`        | `(stateDir: string) → string`                            | Deterministic path from dir     |
| `resolveDefaultPolicyStorePath` | `() → Promise<string>`                                   | Uses config's resolveStateDir   |

#### Serialization Details

**Escalation rules**: `EscalationCondition` with `kind: "custom"` includes a function-typed `evaluate` field that cannot be serialized. Custom conditions are stripped on write (`serializeEscalationRules` filters them out). On read, custom conditions are absent — system policies restore them from the in-memory `DEFAULT_SYSTEM_POLICIES` at startup (Phase 5d).

**currentUses**: The `expiry.currentUses` value stored in the expiry JSON column is ignored on read. All read paths (`getPolicy`, `getActivePolicies`, `getActivePoliciesByClass`) hydrate `currentUses` from the `policy_usage` table COUNT. The usage table is the source of truth.

**JSON columns**: `effect_scope`, `applicability`, `escalation_rules`, `expiry`, and `provenance` are stored as JSON TEXT. Deserialization includes defensive try/catch with sensible fallback defaults.

## Embedding Text Construction

Policies are embedded as composite text built by `buildPolicyEmbeddingText()`:

```
"[effects: read, persist] Allow file read and write operations for the notes tool during work hours"
```

Format: `[effects: <effectScope joined>] <description>`. This gives the embedding vector both semantic intent and effect scope signal.

Query-side context is built by `buildContextEmbeddingText()`:

```
"[effects: read, persist] Save user notes to disk using notes-tool"
```

The store is decoupled from the embedding provider: callers generate the `Float32Array` embedding and call `upsertPolicyEmbedding` separately (same pattern as `consent-store.ts`).

## Default System Policies

| ID                                         | Class  | Effect Scope  | Key Rule                                             |
| ------------------------------------------ | ------ | ------------- | ---------------------------------------------------- |
| `system-policy-read-compose`               | system | read, compose | No escalation — always permitted baseline            |
| `system-policy-no-physical-without-eaa`    | system | physical      | effect-combination[physical] → trigger-eaa           |
| `system-policy-no-elevated-from-non-owner` | system | elevated      | requireOwner + trust-tier-below[in-process] → refuse |

## Test Summary

| File                 | Tests | Skipped | Coverage                                                                                                                                     |
| -------------------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| policy.test.ts       | 103   | 0       | Trust tiers, type guard, applicability, expiry, escalation, filtering, defaults, embeddings                                                  |
| policy-store.test.ts | 35    | 0       | CRUD, serialization, escalation stripping, active queries, status, confirmation, usage, expiry sweep, embedding no-ops, clearAll, edge cases |

**Full consent suite: 489 passing, 16 skipped** (skipped tests require sqlite-vec native extension).

## Design Decisions

### Phase 5a

1. **Policy class as field, not inheritance**: `StandingPolicy.class` is a discriminant string, not a TypeScript class hierarchy. This keeps serialization simple (JSON round-trip) and avoids prototype-based dispatch. The binder evaluates policies in precedence order (system → user → self-minted) without needing `instanceof`.

2. **Applicability as optional filters, not required fields**: An empty `PolicyApplicabilityPredicate` matches universally. This means a policy with `applicability: {}` applies to all channels, all senders, all times. Narrowing is opt-in per-field. Each field that is specified narrows the match (logical AND across fields).

3. **Trust tier ordering is explicit**: `meetsTrustTier` uses a numeric rank map (`external: 1, sandboxed: 2, in-process: 3`). This avoids stringly-typed comparisons and makes the ordering a single source of truth.

4. **Overnight time window handling**: `isInTimeWindow` supports windows that wrap past midnight (e.g., 22:00 to 06:00). When `startHour > endHour`, the window is treated as `hour >= start OR hour < end`.

5. **Escalation rules evaluated in order**: `evaluateEscalationRules` returns the first matching rule. Callers should order rules from most restrictive to least restrictive for correct precedence.

6. **Custom escalation conditions are runtime-only**: The `custom` variant of `EscalationCondition` carries a function (`evaluate`). This cannot be serialized to SQLite. Phase 5b strips custom conditions on write; system policies restore them from `DEFAULT_SYSTEM_POLICIES` at startup. User and self-minted policies cannot create custom conditions.

7. **Backward compatibility via type guard**: `isFullStandingPolicy` discriminates on `"applicability" in p && "status" in p`. Existing code passing `StandingPolicyStub[]` continues to work — `filterApplicablePolicies` silently skips stubs. Migration from stubs to full policies is incremental.

8. **Embedding text format mirrors query format**: Both `buildPolicyEmbeddingText` and `buildContextEmbeddingText` produce `[effects: ...] <description>` text. This structural alignment ensures cosine similarity captures both semantic meaning and effect class overlap, rather than treating them as independent signals.

### Phase 5b

9. **Agent-global, not per-session**: Unlike `consent-store.ts` (per-session), the policy store is agent-global. Policies represent long-lived consent posture and survive session resets. The store path is `~/.openclaw/consent/policies.sqlite` (not under `agents/<agentId>/`).

10. **Usage table as source of truth for currentUses**: Rather than maintaining `currentUses` in the expiry JSON (which would require an UPDATE on every usage), the usage table tracks individual (policyId, woId) pairs. `currentUses` is computed as COUNT(\*) on read. This avoids write contention and makes deduplication automatic via the composite primary key.

11. **Embeddings optional from day one**: When `embeddingDimension` is 0 or omitted, the vec0 table is never created and all embedding methods are no-ops. This ensures the store works without sqlite-vec for environments that don't need semantic search, while providing the full vector capability when configured.

12. **confirmPolicy is atomic**: Uses an explicit SQLite transaction (BEGIN/COMMIT/ROLLBACK) to atomically update both `status` (active) and `provenance` (confirmedAt). This prevents a partial update where status changes but provenance doesn't, which would leave the policy in an inconsistent state.

13. **Foreign key ordering in clearAll**: Deletes `policy_usage` before `policies` to respect the foreign key constraint. `policy_embeddings` is cleaned last (vec0 tables don't participate in FK constraints).

14. **Serialization strips custom conditions, doesn't reject them**: Rather than throwing when a policy with custom escalation conditions is inserted, `serializeEscalationRules` silently filters them out. This allows system policies (which have custom conditions in memory) to be inserted into the store for audit and query purposes while keeping the serialized form valid.

## What Remains (Phase 5c–5i)

### Phase 5c: Binder Policy Evaluation (Dual-Path Retrieval)

- Deterministic path: `filterApplicablePolicies` against in-memory + store policies
- Semantic path: embed context → `findSimilarPolicies` → validate candidates against applicability
- Merge/dedup by policy ID, policy application order (system → user → self-minted)
- Escalation rule evaluation before policy used as anchor
- `PolicyEmbedder` type for injected embedding function
- Backward compatible when embeddings disabled

### Phase 5d: Default System Policies (Startup Loading)

- Bulk-load `DEFAULT_SYSTEM_POLICIES` into `PolicyStore` at startup
- Restore custom escalation conditions from in-memory registry on read
- Align with `DEFAULT_DUTY_CONSTRAINTS` loading pattern

### Phase 5e: Self-Minted Policy Proposal

- Consent record pattern analysis for repetition detection
- `proposeSelfMintedPolicy` with high-risk safety constraints
- Pending-confirmation lifecycle and user confirmation prompt
- Semantic overlap check via `findSimilarPolicies` before proposing
- `checkCOForPolicyPromotion` for CO-to-policy promotion

### Phase 5f: Dynamic Trust Tiers

- Manifest declaration of tool trust tier
- Derived tier from plugin source (bundled/npm/MCP)
- Trust-tier impact on policy acceptance and EAA thresholds

### Phase 5h: Configuration Surface

- `consent.policies` config section (enabled, storePath, selfMintedMaxExpiryMs, selfMintedMinRepetitions, embeddingDimension)
- Zod schema, config baseline regeneration

### Phase 5i: Pipeline Integration

- Policy-loaded `initializeConsentForRun`
- Policy bypass in `handleConsentFailure`
- Policies passed to `mintSuccessorWithAnchor`
- Final `index.ts` barrel update

### Phase 6: Observability and Audit

- Scope chain event model
- Action receipts (confirmation/receipt/report)
- Gateway protocol extensions for consent methods
- Metrics tracking
