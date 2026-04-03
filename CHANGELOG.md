# CBAClaw Changelog

This changelog tracks changes specific to CBAClaw (Consent-Bound Agency).
For the upstream OpenClaw changelog, see [CHANGELOG.openclaw.md](./CHANGELOG.openclaw.md).

## 0.9.0 — 2026-04-02

Phase 5c–5i: Binder dual-path policy evaluation, default system policies, self-minted policy proposals, dynamic trust tiers, configuration surface, and pipeline integration.

### Phase 5c: Binder Policy Evaluation with Dual-Path Retrieval (`src/consent/binder.ts`)

- `evaluatePoliciesForGrants`: new internal function that evaluates standing policies during WO minting (both initial and successor). Implements dual-path retrieval:
  - **Deterministic path** (always runs): `filterApplicablePolicies` checks status, expiry, and applicability predicates against the runtime `PolicyMatchContext`.
  - **Semantic path** (optional): embeds the current context via `PolicyEmbedder`, calls `findSimilarPolicies` on the policy store, then validates each semantic candidate through the same deterministic gauntlet (no validation gap).
  - Merge + dedup by policy ID. Sorted by class precedence: system → user → self-minted.
- `PolicyEmbedder` type: `(text: string) => Promise<Float32Array>`. Accepted by `BinderMintInput` and `BinderRequalifyInput` via the optional `semanticPolicyCandidates` field. When absent, the binder falls back to deterministic-only retrieval (backward compatible with Phases 0-4).
- Escalation rule evaluation: for each applicable policy, `evaluateEscalationRules` is called against the `EscalationContext`. If any rule fires, the policy is skipped entirely (no partial grants).
- Policy anchor recording: policies only produce `{ kind: "policy", policyId }` consent anchors when they contribute at least one new effect or validate an already-granted effect.

### Phase 5d: Default System Policies (`src/consent/policy.ts`)

- `DEFAULT_SYSTEM_POLICIES`: 3 hardcoded system-class policies loaded at initialization:
  - **read-compose baseline** (`sys-read-compose`): pre-authorizes `read` and `compose` for all contexts. No escalation rules. This ensures the agent can always read and compose responses.
  - **physical-requires-EAA** (`sys-physical-eaa`): covers `physical` effects but forces EAA deliberation via a `trigger-eaa` escalation rule on `effect-combination: [physical]`.
  - **elevated-owner-only** (`sys-elevated-owner`): covers `elevated` effects, restricted to owner-only contexts (`requireOwner: true`). Has a `trust-tier-below: in-process` escalation rule so external tools always trigger EAA for elevated operations.

### Phase 5e: Self-Minted Policy Proposal (`src/consent/policy-proposal.ts`)

- `analyzeForPolicyProposals`: analyzes recent consent records for repeated grant patterns that suggest a standing policy would reduce friction. Algorithm: fetch granted records → group by canonicalized effect set → filter by minRepetitions threshold → build candidate policies with safety constraints → run semantic conflict detection against existing policies.
- Safety constraints:
  - Groups where **all** effects are high-risk (`irreversible`, `elevated`, `disclose`, `audience-expand`, `exec`, `physical`) are skipped entirely — no auto-proposal for pure high-risk sets.
  - Mixed sets (safe + risky) get `trigger-eaa` escalation rules for each high-risk effect, ensuring EAA deliberation is always triggered.
  - Self-minted policies always start as `pending-confirmation` — they cannot be consumed as consent anchors until a human confirms them.
  - Maximum expiry (default 30 days) and maximum uses (default 100) enforce re-confirmation cycles.
- `createSelfMintedPolicy`: persists a `PolicyProposal` as a `pending-confirmation` `StandingPolicy` in the policy store. Stores the policy's embedding if an embedder is provided. Rejects proposals that are not in `pending-confirmation` status.
- `checkCOForPolicyPromotion`: evaluates whether a recently granted CO could be promoted to a standing policy. Embeds the CO's effect description in the same format as policies, searches for existing coverage via `findSimilarPolicies`. Returns `shouldPromote: false` with the matching policy when semantic overlap exists; `shouldPromote: true` when the CO represents genuinely new consent territory.
- `HIGH_RISK_EFFECTS`: set of 6 effects requiring escalation rules in auto-proposals.

### Phase 5f: Dynamic Trust Tiers (`src/consent/policy.ts`, `src/consent/binder.ts`)

- `ToolSource` type: `"bundled" | "npm" | "mcp" | "unknown"` — classifies the origin of a plugin tool for trust tier derivation.
- `deriveTrustTier(explicitTier, source)`: derives a tool's trust tier from its source when not explicitly declared. Bundled → `in-process`, npm → `sandboxed`, MCP → `external`, unknown → `sandboxed` (conservative default). Explicit declarations take precedence.
- **External-tool policy enforcement** in `evaluatePoliciesForGrants`: when a tool's trust tier is `external`, only `system`-class policies may be consumed without a `trust-tier-below` escalation rule. Non-system policies lacking a `trust-tier-below` rule are silently skipped for external tools. This prevents broad user/self-minted policies from being silently consumed by untrusted external tools without the policy author having explicitly considered external trust risks.

### Phase 5h: Configuration Surface (`src/config/types.openclaw.ts`, `src/config/zod-schema.ts`)

- New `consent.policies` config section on `ConsentConfig`:
  - `enabled` (boolean, default `false`): opt-in gate for the standing policy framework.
  - `storePath` (string): explicit path to policy store SQLite database. Default: auto-resolved.
  - `selfMintedMaxExpiryMs` (integer >= 0): maximum expiry for self-minted policies in ms. Default: 30 days.
  - `selfMintedMinRepetitions` (integer >= 1): minimum CO grant repetitions before self-minted policy proposal. Default: 3.
  - `selfMintedLookbackMs` (integer >= 0): lookback window for self-minted policy analysis in ms. Default: 7 days.
  - `embeddingDimension` (integer >= 0): embedding dimension for semantic policy matching. 0 = disabled (deterministic-only retrieval). Default: 0.
- Zod schema with `.strict()` validation on both the `policies` object and the parent `consent` object. All fields optional with appropriate min/type constraints.

### Phase 5i: Pipeline Integration (`src/consent/integration.ts`, `src/consent/eaa-integration.ts`)

- `initializeConsentForRun` now accepts an optional `policyStore` parameter. When provided:
  - Calls `expireStalePolicies()` to sweep expired/maxUses-exceeded policies.
  - Loads active policies via `getActivePolicies()`.
  - Merges `DEFAULT_SYSTEM_POLICIES` with loaded policies and passes the combined set to `mintInitialWorkOrder`.
  - Exposes `activePolicies` and `policyStore` on `ConsentRunContext` for downstream use.
  - Policy store errors are non-fatal: logged as warnings, initialization continues with empty policies.
- `handleConsentFailure` now implements a **policy bypass** step before consent precedent reuse and EAA evaluation:
  - Filters applicable policies via `filterApplicablePolicies` against the current runtime context.
  - If all missing effects are covered by applicable policies' `effectScope`, mints a successor WO with policy anchors directly — skipping CO/EAA entirely.
  - If policy-based successor minting fails (e.g., system prohibition), falls through to the existing precedent/EAA pipeline.
- `policies` and `systemProhibitions` are threaded through all downstream `mintSuccessorWithAnchor` calls: precedent reuse, EAA `proceed`, EAA `constrained-comply`, and EAA `emergency-act`.
- `HandleConsentFailureParams` extended with optional `policies` and `systemProhibitions` fields.

### Phase 5c–5i: Barrel Exports (`src/consent/index.ts`)

- Phase 5e: `PolicyProposalParams`, `PolicyProposal`, `CheckCOPromotionParams`, `COPromotionResult`, `analyzeForPolicyProposals`, `createSelfMintedPolicy`, `checkCOForPolicyPromotion`.
- Phase 5f: `ToolSource`, `deriveTrustTier`.

### Phase 5c–5i: Tests

- `src/consent/binder.test.ts`: 79 new tests in Phase 5c/5d/5f blocks — dual-path policy evaluation (deterministic path grants, semantic path grants, merge/dedup, class precedence ordering, escalation rule skipping, status/expiry filtering, policy anchor recording, backward compat with empty policies, stub filtering), default system policies in binder (baseline read/compose granting, physical-EAA escalation, elevated-owner restriction), external-tool enforcement (system policy exemption, user policy without trust-tier rule blocked, user policy with trust-tier rule consumed), successor WO policy evaluation.
- `src/consent/policy.test.ts`: 5 new tests — `deriveTrustTier` explicit tiers, bundled/npm/mcp/unknown derivation.
- `src/consent/policy-proposal.test.ts`: 24 tests — `groupByEffectSet` (grouping, cutoff, empty effects), `buildProposalDescription` (safe/risky), `buildRationale` (with/without overlaps), `analyzeForPolicyProposals` (repetition threshold, minRepetitions gate, all-high-risk skip, mixed-set escalation rules, channel scoping, custom expiry/uses, semantic overlap, no-embedder fallback, multiple groups), `createSelfMintedPolicy` (persistence, embedding storage, status guard), `checkCOForPolicyPromotion` (promote when no match, block when match exists, custom threshold), `HIGH_RISK_EFFECTS` constant verification.
- `src/consent/integration.test.ts`: 4 new tests — policy-loaded initialization (active policies passed to binder, no-store backward compat, stale policy expiry, store error graceful handling).
- Full consent test suite: **557 passing, 16 skipped** (skipped require sqlite-vec native extension).

---

## 0.8.0 — 2026-04-02

Phase 5a/5b: Standing policy type system, persistence store with vector similarity.

### Phase 5a: Standing Policy Type System (`src/consent/policy.ts`)

- `StandingPolicy`: full standing policy type with bounding-box semantics — `effectScope`, `applicability`, `escalationRules`, `expiry`, `revocationSemantics`, `provenance`, `description`, and `status`. Replaces `StandingPolicyStub` when the policy framework is active.
- `PolicyApplicabilityPredicate`: optional filters for channels, chat types, sender IDs, owner requirement, time window (with overnight wrap), tool names, and minimum trust tier. Empty predicate matches universally.
- `EscalationRule` + `EscalationCondition`: discriminated union of conditions (`effect-combination`, `audience-exceeds`, `frequency-exceeds`, `trust-tier-below`, `custom`) that force CO/EAA/refusal even when a policy would grant consent.
- `PolicyExpiry`: time-based (`expiresAt`) and usage-based (`maxUses`) expiry with `currentUses` tracking.
- `PolicyProvenance`: audit trail (author, createdAt, confirmedAt, sourceRef).
- `PolicyMatchContext`: runtime context for applicability matching (channel, chatType, senderId, senderIsOwner, toolName, toolTrustTier, currentHour).
- Three policy classes: `system` (inviolable, hardcoded), `user` (operator-created), `self-minted` (agent-proposed, requires confirmation).
- `filterApplicablePolicies`: filters a policy list to active, non-expired policies matching a given context. Handles both `StandingPolicy` and `StandingPolicyStub` inputs (stubs silently skipped).
- `evaluateEscalationRules`: evaluates escalation conditions against tool context. Returns first matching rule or undefined.
- `isExpired`: checks both time-based and usage-based expiry.
- `meetsTrustTier`: ordered trust tier comparison (external < sandboxed < in-process).
- `isFullStandingPolicy`: type guard discriminating `StandingPolicy` from `StandingPolicyStub`.
- `DEFAULT_SYSTEM_POLICIES`: 3 hardcoded system policies — read/compose baseline (always permitted), physical-requires-EAA (always escalates), elevated-owner-only (restricted to owner + in-process).
- `buildPolicyEmbeddingText`: builds composite embedding text from policy effect scope and description (`[effects: read, persist] Allow file operations`).
- `buildContextEmbeddingText`: builds matching query embedding text from runtime context (effects, tool name, description).

### Phase 5b: Policy Store — Persistence + Vector Similarity (`src/consent/policy-store.ts`)

- Persistent agent-global SQLite + sqlite-vec store for standing policies at `~/.openclaw/consent/policies.sqlite`. Unlike consent records (per-session), policies persist across sessions.
- Schema: `policies` table (id, class, effect_scope, applicability, escalation_rules, expiry, revocation_semantics, provenance, description, status, created_at, updated_at) with CHECK constraints on class/revocation_semantics/status, indexes on status and class. `policy_usage` table for per-WO usage tracking (composite PK for deduplication). `policy_embeddings` vec0 virtual table for cosine KNN search (conditionally created when embeddingDimension > 0).
- Full CRUD: `insertPolicy`, `getPolicy`, `getActivePolicies`, `getActivePoliciesByClass`.
- Status lifecycle: `updatePolicyStatus`, `confirmPolicy` (atomic status + provenance update in a transaction for pending-confirmation → active).
- Usage tracking: `recordPolicyUsage` (deduplicated by policy+WO pair), `getPolicyUsageCount`. `currentUses` hydrated from usage table on read (source of truth is the usage table, not the expiry JSON).
- Expiry sweep: `expireStalePolicies` — scans active policies and expires those past `expiresAt` or exceeding `maxUses`.
- Embedding operations: `upsertPolicyEmbedding`, `deletePolicyEmbedding`, `findSimilarPolicies` (KNN with cosine distance, configurable topK/threshold/statusFilter). All are no-ops when embeddingDimension is 0 (backward compatible).
- Serialization: `EscalationCondition` with `kind: "custom"` carries a function-typed `evaluate` field that is stripped on write. Custom conditions are runtime-only and must be restored from the system policy registry on read.
- `openPolicyStore`: async factory with schema creation, optional sqlite-vec loading, WAL journaling, foreign keys.
- Path resolution: `resolvePolicyStorePath`, `resolveDefaultPolicyStorePath`.

### Phase 5a/5b: Tests

- `src/consent/policy.test.ts`: 103 tests — trust tier ordering, type guard (full policy, stub, partial objects), applicability matching (universal, channel, chatType, senderId, requireOwner, timeWindow with overnight wrap, toolNames, minTrustTier, multiple filters), expiry (time-based, usage-based, both, zero maxUses, no limits), escalation rules (effect-combination, audience-exceeds, frequency-exceeds, trust-tier-below, custom, no match, empty effects), filterApplicablePolicies (active/inactive/revoked/expired filtering, applicability, mixed stubs+policies, empty input, maxUses expiry), default system policies (count, read-compose baseline, physical-EAA escalation, elevated-owner restriction), embedding text builders (policy text with/without effects, context text with effects/tool/description/combinations, empty inputs).
- `src/consent/policy-store.test.ts`: 35 tests — basic CRUD (insert, retrieve, non-existent, duplicate insert PK constraint), serialization round-trips (applicability, provenance, expiry with currentUses hydration, revocationSemantics), escalation rule serialization (standard conditions, custom condition stripping), active policy queries (status filtering, class filtering), status updates (update, non-existent, custom timestamp), policy confirmation (pending → active with confirmedAt, non-existent, already active, revoked), usage tracking (record/count, deduplication, currentUses hydration), expiry sweep (time-based, maxUses, no stale, custom timestamp), embedding no-ops at dim=0 (upsert, delete, findSimilar), clearAll, multi-class coexistence, edge cases (empty effectScope/applicability/escalationRules, all effect classes, idempotent close).

---

## 0.7.0 — 2026-04-02

Phase 4c/4d: EAA orchestration integration and system prompt consent instructions.

### Phase 4c: EAA Integration into Orchestration Pipeline (`src/consent/eaa-integration.ts`)

- `handleConsentFailure`: single orchestration entry point called when `verifyToolConsent` returns `allowed: false` under `enforce` mode. Routes through consent precedent reuse, EAA trigger evaluation, and either standard CO creation or full EAA adjudication.
- Step 1 — **Consent precedent reuse**: checks the `ConsentRecordStore` for a prior granted, non-expired record whose effects cover the missing effects. On hit, mints a successor WO with an `explicit` consent anchor referencing the precedent record and transitions scope immediately.
- Step 2 — **EAA trigger evaluation**: calls `evaluateEAATriggers` with the current tool context. When no triggers fire, falls through to standard CO.
- Step 3 — **Standard Change Order**: when EAA is not triggered, creates a CO via `requestChangeOrder` (Phase 3b) with the missing effects and tool context. Returns `{ action: "co-requested", changeOrder }`.
- Step 4 — **EAA adjudication**: when triggers fire and an `EAAInferenceFn` is available, runs `runElevatedActionAnalysis` (Phase 4b). Processes all six outcomes:
  - `proceed`: mints successor WO with `eaa` consent anchor, transitions scope.
  - `request-consent`: creates an enriched CO with EAA reasoning context in the CO reason field.
  - `constrained-comply`: mints successor WO with recommended constraints and `eaa` anchor.
  - `emergency-act`: mints successor WO with time-bounded constraints and `eaa` anchor.
  - `refuse`: returns structured refusal with EAA reasoning.
  - `escalate`: returns structured escalation with EAA reasoning.
- EAA record persistence: dual-writes to both the scope chain (`addEAARecord`) and the persistent `ConsentRecordStore` (`insertEAARecord`). Both writes are fault-tolerant — failures are logged but do not block the resolution.
- Failure handling: when EAA is triggered but no inference function is provided, returns a structured refusal. When `runElevatedActionAnalysis` itself fails, returns a refusal with the failure reason and fallback outcome.
- `ConsentFailureResolution` discriminated union: `co-requested` (with `ChangeOrder`), `eaa-resolved` (with outcome, optional successor WO, explanation, adjudication, and reasoning), or `refused` (with reason).

### Phase 4d: System Prompt Consent Instructions (`src/agents/system-prompt.ts`)

- `buildConsentBoundAgencySection`: new system prompt section gated by `cbaEnabled` parameter (defaults to `false`, excluded in `minimal`/`none` prompt modes). Placed after the Safety section and before OpenClaw CLI Quick Reference.
- **Effect Awareness**: lists all 10 effect classes with human-readable descriptions. Instructs the agent that effects, not tool names, are the unit of consent.
- **Consent Boundary Recognition**: examples of boundary crossings (draft to send, read to persist, compose to publish, search to execute, suggest to modify). Instructs the agent to pause and request a Change Order when a crossing is detected.
- **Change Order Participation**: instructs the agent to frame CO requests in effect language, accept denials gracefully, and never repeat denied requests without new justification.
- **Elevated Action Analysis Awareness**: describes EAA triggers (standing ambiguity, effect ambiguity, duty collisions, novel tools, irreversible actions). Explains the agent's advisory role — honest grounded assessment, not self-granted authority.
- **Refusal as Discretion**: frames refusal as a first-class outcome. Agent must explain why, state what it would need to proceed, and suggest safer alternatives within the current scope.

### Phase 4c/4d: Tests

- `src/consent/eaa-integration.test.ts`: 18 tests — consent precedent reuse (hit with successor WO minting, fallthrough on miss), standard CO path (no EAA triggers), EAA `request-consent` (low confidence triggers enriched CO), EAA `proceed` (high confidence + low risk), EAA `constrained-comply` (moderate confidence + non-critical risk), EAA `refuse` (inviolable duty collision), EAA `emergency-act` (urgency text + physical effects), EAA `escalate` (elevated + physical + low confidence), EAA record persistence to store, refused when no inference function provided, refused when EAA analysis fails. Internal helper tests: `createStandardChangeOrder` (success, empty effects refusal), `mintSuccessorWithAnchor` (EAA anchor, constraints), `persistEAARecord` (store write, no-store safety).
- `src/agents/system-prompt.test.ts`: 9 new CBA tests (57 total) — section inclusion (`cbaEnabled: true`), exclusion (`false`, `undefined`, `minimal` mode), all 10 effect classes listed, boundary crossing examples, EAA trigger descriptions, refusal guidance, section ordering (after Safety, before CLI Reference).

---

## 0.6.0 — 2026-04-02

Phase 4b: Elevated Action Analysis (EAA) adjudication loop.

### Phase 4b: EAA Adjudication Loop (`src/consent/eaa.ts`)

- `runElevatedActionAnalysis`: async 6-step adjudication loop that forms the agent's commitment under uncertainty. Accepts a `PurchaseOrder`, active `WorkOrder`, tool profile, trigger result, consent/EAA history, duty constraints, and an injected `EAAInferenceFn` for the LLM evaluation step. All steps except inference are deterministic.
- Step 1 — **Classify action and affected parties**: determines `ActionCategory` (routine / sensitive / high-risk / emergency) from effect profiles and trigger context. Identifies affected parties (requestor, named-third-party, bystander, unknown) and their interests (property, privacy, safety, communication, autonomy).
- Step 2 — **Constrained discovery**: gathers minimal deterministic context (request metadata, tool profile, WO grants, prior EAA outcomes, granted consent summaries with expiry tracking, active duty constraints). No LLM calls, no effects beyond the active WO.
- Step 3 — **Evaluate standing, risk, and duties**: delegated to the injected `EAAInferenceFn`. Returns a structured `EAAEvaluation` with standing confidence (0–1), risk assessment (likelihood, severity, mitigating/aggravating factors), duty analysis (applicable duties, conflicts with resolutions), and confidence gating (overall confidence, insufficient evidence areas). The loop validates the returned evaluation structurally (numeric bounds, severity enum).
- Step 4 — **Select least invasive sufficient action**: generates ranked `ActionAlternative` candidates scored by invasiveness. Hard rules: inviolable duty collisions block proceed/constrained-comply/request-consent (but NOT emergency-act). Constrained-comply strips irreversible effects when risk is serious. Emergency-act only for emergency classifications. Proceed requires high confidence (>= 0.7) + low risk (negligible/minor) + trigger severity < 0.8.
- Step 5 — **Choose explicit outcome**: deterministic priority ladder: emergency overrides inviolable collision → inviolable collision (non-emergency) → refuse → low confidence (< 0.3) → request-consent → emergency-time-pressure → emergency-act → high confidence + low risk → proceed → moderate confidence → constrained-comply → fallback request-consent → refuse.
- Step 6 — **Produce accountability artifacts**: three cross-referenced outputs sharing the same ID:
  - `EAAAdjudicationResult`: bounded schema for the binder (outcome, recommended effects, recommended constraints, reasoning record reference).
  - `EAAReasoningRecord`: full audit bundle (trigger categories, classification, discovery context, evaluation, all alternatives, selected alternative, justification text, evidence references including tool/consent/duty pointers).
  - `EAARecord`: for the consent store (links to PO/WO, outcome, recommended effects/constraints, serialized reasoning).
- Failure handling:
  - LLM inference failure → `ok: false` with `refuse` fallback and structured explanation.
  - Structurally invalid evaluation → `ok: false` with `refuse` fallback.
  - Low overall confidence (< 0.3) → `request-consent` outcome (ask the user rather than guess).
  - Inviolable duty collision (non-emergency) → `refuse` outcome.
  - Emergency with inviolable collision → `emergency-act` with strict 5-minute time-bounded constraints.
- Constants: `LOW_CONFIDENCE_THRESHOLD` (0.3), `EMERGENCY_TTL_MS` (5 min), `CONSTRAINED_COMPLY_TTL_MS` (15 min).
- Testable clock and ID generation seams for deterministic tests.
- Testing seam exposing all internal step functions, helpers, and constants.

### Phase 4b: Tests

- `src/consent/eaa.test.ts`: 58 tests — Step 1 classification (routine/sensitive/high-risk/emergency categories, requestor/third-party/bystander/unknown affected parties, interest derivation, autonomy fallback), Step 2 discovery context (metadata aggregation, prior EAA summaries, consent expiry tracking), Step 3 validation (well-formed acceptance, all boundary rejections: confidence < 0 / > 1, invalid severity, likelihood > 1, overall confidence > 1), Step 4 alternatives (refuse/escalate always present, request-consent gating, inviolable collision exclusions, proceed eligibility, trigger severity gate, constrained-comply confidence/risk gates, emergency-act classification gate, emergency-act survives inviolable collision, irreversible stripping at serious risk, sort order), Step 5 outcome selection (inviolable non-emergency refuse, emergency overrides inviolable, low confidence request-consent, low confidence refuse fallback, emergency-act selection, high confidence proceed, moderate constrained-comply, fallback request-consent), inviolable duty collision helper, invasiveness scoring, minimal emergency effects, Step 6 artifact production (cross-referenced IDs, evidence refs with tool/consent/duty, serialized reasoning), end-to-end adjudication (proceed, constrained-comply, request-consent, emergency-act with default duties, inviolable refuse), failure cases (inference failure, invalid evaluation), artifact integrity (ID cross-references, serialized reasoning, justification content), testing seam constants.

---

## 0.5.0 — 2026-04-02

Phase 4a: Elevated Action Analysis (EAA) trigger detection.

### Phase 4a: EAA Trigger Detection (`src/consent/eaa-triggers.ts`)

- `evaluateEAATriggers`: main entry point that runs 8 detectors against the current tool invocation context and returns a composite `EAATriggerResult` with fired categories, aggregate severity (0–1), and human-readable summary.
- 7 trigger categories covering the full taxonomy from the Consent-Bound Agency framework (PDF Section V.B):
  - `standing-ambiguity`: fires when the requestor is not the agent owner. Severity escalates for group/public channel context and high-risk effects.
  - `effect-ambiguity`: fires when Phase 3b `assessRequestAmbiguity` flags an underspecified request (best vector distance > 0.6) AND the tool involves high-risk effects. Severity scales with vector distance.
  - `duty-collision`: fires when the tool's effects conflict with registered `DutyConstraint` entries. Severity driven by the highest-criticality colliding duty (advisory 0.5, strong 0.7, inviolable 1.0).
  - `novelty-uncertainty`: fires for external trust-tier tools with risky effects (disclose, irreversible, persist, exec, physical), and unconditionally for tools on the dangerous tool list (`DEFAULT_GATEWAY_HTTP_TOOL_DENY`).
  - `insufficient-evidence`: fires when the tool has high-risk effects but there are no consent records in scope and no ambiguity assessment — the system lacks grounded context for risk judgment.
  - `irreversibility`: fires when tool effects include `irreversible` and no prior explicit, non-expired consent record covers that effect class.
  - `emergency-time-pressure`: fires for physical effects with urgency markers in the request text (emergency, urgent, immediately, ASAP, critical, danger, life-threatening). Severity 1.0 with strict post-hoc accountability requirements.
- `DutyConstraint` type: registered obligations with `protects` (evidence, confidentiality, safety, privacy, oversight), `conflictingEffects`, `criticality` (advisory, strong, inviolable), and human-readable description.
- `DEFAULT_DUTY_CONSTRAINTS`: 5 core system duties — evidence preservation (strong), confidentiality (strong), safety (inviolable), privacy (strong), oversight (strong).
- Dangerous tool detection sourced from `src/security/dangerous-tools.ts` (`DEFAULT_GATEWAY_HTTP_TOOL_DENY`).
- Testable clock seam for deterministic time-dependent logic in `detectIrreversibility`.
- Testing seam exposing individual detector functions and all internal constants.

### Phase 4a: Tests

- `src/consent/eaa-triggers.test.ts`: 55 tests — no-trigger baseline, standing ambiguity (owner/non-owner, group/public context, high-risk escalation, severity cap), effect ambiguity (absent/below-threshold/safe-effects exclusion, severity scaling by distance), duty collision (default duties, custom duties, no-conflict exclusion, multi-duty criticality, collision reporting), novelty uncertainty (external/in-process/sandboxed, safe-effects exclusion), dangerous tool list (exec/gateway/fs_delete, safe tools, unknown tools), insufficient evidence (high-risk without context, suppression by records, suppression by ambiguity, safe-effects exclusion, end-to-end), irreversibility (no consent, prior consent suppression, expired/denied consent, non-expired consent, no irreversible effects), emergency time pressure (urgency keywords, non-urgent physical, urgent non-physical), composite evaluation (multi-trigger, max severity, category deduplication, summary concatenation), default duty constraint validation, testing seam constants.

---

## 0.4.0 — 2026-04-02

Phase 3b/3c/3d: Change Order flow, consent record persistence, and revocation/withdrawal.

### Phase 3b: Change Order Lifecycle (`src/consent/change-order.ts`)

- `requestChangeOrder`: creates a pending CO with human-readable effect descriptions when a tool call requires effects not covered by the active WO.
- `resolveChangeOrder`: handles grant (mints successor WO, transitions scope) or deny (CO marked denied, agent must replan).
- `generateEffectDescription`: builds CO approval descriptions from static effect descriptions plus optional pattern store examples, without LLM calls.
- `findPatternsForEffects`: reverse pattern lookup — given missing EffectClass values, finds matching patterns in the consent pattern store for grounding CO descriptions.
- `assessRequestAmbiguity`: uses vector search distance as a quantified ambiguity signal. When the closest pattern match exceeds the ambiguity threshold (default 0.6), the request is flagged as underspecified. Feeds into EAA trigger detection (Phase 4).
- CO lifecycle transitions: `expireChangeOrder`, `withdrawChangeOrder`, `getPendingChangeOrder`, `getAllPendingChangeOrders`.
- High-risk effect detection for enriched CO descriptions when ambiguity is present.

### Phase 3c: Consent Record Persistence (`src/consent/consent-store.ts`)

- Persistent SQLite store for consent records and EAA records at `~/.openclaw/agents/<agentId>/consent/consent-records.sqlite`.
- `openConsentRecordStore`: factory with schema creation, optional sqlite-vec for similarity search, WAL journaling.
- Full CRUD: `insertConsentRecord`, `getConsentRecord`, `getConsentRecordsByPO`, `getConsentRecordsByDecision`, `getAllConsentRecords`, `updateConsentDecision`.
- EAA record persistence: `insertEAARecord`, `getEAARecord`, `getAllEAARecords`.
- `findConsentPrecedent`: exact effect-set matching for consent precedent reuse — finds the most recent granted, non-expired record whose effects are a superset of the requested effects.
- `findSimilarConsentPrecedent`: embedding-based similarity search for semantic precedent reuse (requires sqlite-vec). Conservative: requires effect superset, tight distance threshold (0.25), and non-expired record.
- `upsertConsentEmbedding`: stores embeddings for consent records to enable similarity search.
- `clearAll`: clears all records for session reset/revocation.
- Path resolution: `resolveConsentRecordStorePath`, `resolveDefaultConsentRecordStorePath`.

### Phase 3d: Revocation and Withdrawal (`src/consent/revocation.ts`)

- `revokeConsent`: user-initiated consent revocation. Invalidates the active WO and transitions scope to a restricted WO (read-only baseline). Supports full revocation (`scope: "all"`) and targeted revocation (`scope: "effects"` with specific effect classes). Marks existing granted consent records as revoked.
- `withdrawCommitment`: agent-initiated withdrawal from current commitments. Categorized reasons: `constraint-change`, `duty-conflict`, `capability-insufficient`, `safety-concern`, `other`. Produces auditable records and human-readable explanations.
- `resetConsentSession`: clears all in-memory consent and EAA records for session reset. Optionally clears the persistent store. Preserves the active WO (expires naturally via TTL).
- Both revocation and withdrawal preserve "read" as the minimum operational capability so the agent can still communicate refusals.

### Phase 3b/3c/3d: Tests

- `src/consent/change-order.test.ts`: 27 tests — effect description generation (single/multiple/empty/ambiguous), pattern lookup, CO creation/denial/grant/scope transition, consent record creation on grant, CO lifecycle transitions (expire/withdraw), ambiguity assessment (close match/far/empty/failure/custom threshold).
- `src/consent/consent-store.test.ts`: 25 tests — consent record CRUD (insert/retrieve/by-PO/by-decision/all), decision updates, metadata and expiry round-trips, EAA record CRUD, consent precedent matching (exact effect coverage, denied/expired exclusion, most recent match), clearAll.
- `src/consent/revocation.test.ts`: 16 tests — full revocation (scope transition, consent records, restricted WO), targeted revocation (specific effects), record marking, agent withdrawal (all reasons, specific effects, audit records), session reset.

---

## 0.3.0 — 2026-04-02

Phase 3a: Vector-based implied consent derivation with SQLite + sqlite-vec pattern store.

### Phase 3a: Implied Consent Derivation — Vector Store (`src/consent/implied-consent-store.ts`)

- Persistent SQLite + sqlite-vec store for consent pattern matching at `~/.openclaw/consent/consent-patterns.sqlite`.
- Schema: `patterns` table (text, effects JSON, source, confidence, timestamps) with unique text index, `pattern_embeddings` vec0 virtual table for cosine-distance KNN search, `meta` table for schema versioning and embedding dimension tracking.
- Embedding dimension change detection: automatically drops and rebuilds the vec0 table and resets the seeded flag so patterns are re-embedded.
- CRUD operations: `insertPattern`, `upsertPattern` (with dimension validation), `getPatternById`, `getPatternByText`, `getAllPatterns`, `deletePattern`.
- `searchSimilarPatterns`: KNN vector search with configurable k and distance threshold, joins pattern metadata for full results.
- `seedConsentPatternStore`: populate the store with seed data and embeddings, skipping when already seeded.
- Path resolution: `resolveConsentStorePath` (explicit) and `resolveDefaultConsentStorePath` (async, loads from config).

### Phase 3a: Seed Data (`src/consent/implied-consent-seed.ts`)

- 95 curated canonical request patterns covering all 10 EffectClass categories.
- Organized by primary effect: read-only, file writing, communication, shell execution, deletion, network, elevated, audience-expand, and compound multi-effect patterns.

### Phase 3a: Deterministic Heuristic Fallback (`src/consent/implied-consent-heuristic.ts`)

- 8 keyword/regex rules covering execution, file writing, deletion, communication, audience expansion, network, elevated, and physical effects.
- Always includes `read` + `compose` as baseline when any rule matches.
- Acts as primary fallback when vector search is unavailable and as augmenter in "both" mode.

### Phase 3a: Orchestrator (`src/consent/implied-consent.ts`)

- `deriveImpliedEffects`: main entry point supporting three modes — `vector` (vector search only), `heuristic` (keyword rules only), `both` (union of vector + heuristic, default).
- Graceful degradation: vector failure falls back to heuristic; heuristic failure falls back to `["read", "compose"]`.
- Singleton store lifecycle with lazy initialization and one-time seeding.
- Embedding provider resolution via `listMemoryEmbeddingProviders` with auto-selection or explicit provider ID.
- Dimension probing: embeds a probe string to determine dimension before opening the store.

### Phase 3a: Configuration (`src/config/types.openclaw.ts`, `src/config/zod-schema.ts`)

- New `consent.impliedEffects` config section with `provider`, `model`, `threshold`, `topK`, and `mode` options.
- Zod validation for all config keys with sensible defaults (threshold: 0.35, topK: 5, mode: "both").

### Phase 3a: Integration (`src/consent/integration.ts`)

- `initializeConsentForRun` is now async; dynamically imports `deriveImpliedEffects` when no explicit `impliedEffects` are provided.
- Loads `consent.impliedEffects` config from the main config and passes it to the orchestrator.
- `FALLBACK_IMPLIED_EFFECTS` (`["read", "compose"]`) used when both vector search and heuristic derivation fail.

### Phase 3a: Tests

- `src/consent/implied-consent-heuristic.test.ts`: 15 tests — keyword detection for all effect categories, compound requests, case insensitivity, baseline inclusion, deduplication.
- `src/consent/implied-consent-store.test.ts`: 13 tests — schema creation, insert/upsert/delete/get, vector similarity search, distance thresholding, dimension validation, metadata, unique constraints, seed population. Guarded with `describe.runIf` for sqlite-vec availability.
- `src/consent/implied-consent.test.ts`: 8 tests — end-to-end vector derivation, mode merging, heuristic fallback on provider failure, heuristic-only mode, effect merging, default effects. Guarded with `describe.runIf` for sqlite-vec availability.

---

## 0.2.0 — 2026-04-02

Phase 2: Wire consent verification into the tool execution pipeline.

### Phase 2: WO Minting at Agent Run Start (`src/consent/integration.ts`)

- `createPurchaseOrder`: factory that builds a PO from agent run context (request text, sender identity, channel, session, agent ID, implied effects).
- `initializeSigningKey`: one-shot initialization from `CBA_SIGNING_KEY` environment variable; falls back to per-process random key.
- `initializeConsentForRun`: full consent context initialization — derives implied effects, creates PO, mints initial WO via the binder, builds scope state. Returns `undefined` on binder refusal for graceful degradation.
- `ConsentEnforcementMode`: `log` (default, debug-level), `warn`, `enforce` — resolved from `CBA_ENFORCEMENT` env var.

### Phase 2: Before-Tool-Call WO Verification (`src/consent/integration.ts`)

- `verifyToolConsent`: reads the active WO from `AsyncLocalStorage`, looks up the tool's effect profile (from argument or registry), and verifies all tool effects are covered by WO grants.
- When no consent scope is active, returns `allowed: true` (opt-in enforcement).
- Enforcement mode governs failure behavior: `log` and `warn` modes allow execution; `enforce` mode blocks with a structured refusal containing the verification result.

### Phase 2: Plugin Tool Effect Profile Registration

- Extended `OpenClawPluginToolOptions` in `src/plugins/types.ts` with optional `effectProfile` field.
- Extended `PluginToolRegistration` in `src/plugins/registry.ts` with optional `effectProfile` field.
- `src/plugins/bundled-capability-runtime.ts`: propagates `effectProfile` from tool objects to registry entries.

### Phase 2: Scope Entry in Agent Run (`src/agents/pi-embedded-runner/run/attempt.ts`)

- Calls `initializeConsentForRun` at agent run start and binds the consent scope via `enterConsentScope` for the duration of the run.

### Phase 2: Tests

- `src/consent/integration.test.ts`: 16 tests — PO creation (defaults, optional fields, explicit effects, defensive copies), enforcement mode resolution (all modes, invalid values), consent initialization (full context, binder refusal, signing key configuration, explicit vs derived effects), tool verification (no scope, covered effects, log/warn/enforce modes, registry fallback, unknown tools), enterConsentScope (ALS binding, verifyToolConsent visibility), end-to-end flow (initialize + verify within scope, log-mode passthrough).

---

## 0.1.0 — 2026-04-02

Initial implementation of the Consent-Bound Agency (CBA) framework, Phase 0 and Phase 1.
Based on the Consent-Bound Agency conceptual document and the Scope-as-Contract (SaC)
architecture plan.

### Phase 0: Effect Class Taxonomy (`src/consent/types.ts`, `src/consent/effect-registry.ts`)

- Define closed `EffectClass` union: `read`, `compose`, `persist`, `disclose`, `audience-expand`, `irreversible`, `exec`, `network`, `elevated`, `physical`.
- Define `ToolEffectProfile` type with effects, trust tier, and description.
- Define `TrustTier` union: `in-process`, `sandboxed`, `external`.
- Create `CORE_EFFECT_REGISTRY` with 30+ core tool mappings (read-only, compose, persist, disclose, network, exec, irreversible, elevated, session orchestration tools).
- Conservative default profile for unregistered tools (`read`, `compose`, `persist`, `network` at `external` tier).
- Registry accessor functions: `getToolEffectProfile`, `isToolInRegistry`, `getAllRegisteredProfiles` (all return defensive copies).

### Phase 0: Contract Vocabulary (`src/consent/types.ts`)

- Define `PurchaseOrder` (PO): request context with sender identity, implied effects, channel metadata.
- Define `WorkOrder` (WO): immutable scope-of-work contract with granted effects, constraints, consent anchors, predecessor link, JWS token.
- Define `ChangeOrder` (CO): consent boundary expansion request with status lifecycle.
- Define `WOConstraint` discriminated union: `time-bound`, `audience`, `max-invocations`, `custom`.
- Define `ConsentAnchor` discriminated union: `implied`, `explicit`, `eaa`, `policy`.
- Define `ConsentRecord`: persisted consent decision for anchor verification and audit.
- Define `EAARecord`: Elevated Action Analysis adjudication result with outcome codes (`proceed`, `request-consent`, `constrained-comply`, `emergency-act`, `refuse`, `escalate`).
- Define `ConsentScopeState`: AsyncLocalStorage-carried state (PO, active WO, WO chain, records).
- Define binder I/O types: `BinderMintInput`, `BinderRequalifyInput`, `BinderResult`, `BinderRefusalCode`.
- Define verification types: `WOVerificationResult`, `WOVerificationFailureCode`, `WOIntegrityResult`, `WODecodeResult`.
- Define `StandingPolicyStub` for Phase 5 forward compatibility.

### Phase 1: Deterministic Contract Binder (`src/consent/binder.ts`)

- `mintInitialWorkOrder`: derive grants from PO implied effects minus system prohibitions, attach default 30-minute TTL, seal with JWS token.
- `mintSuccessorWorkOrder`: requalify with expanded grants after CO grant or EAA adjudication. Validates consent anchors, applies system prohibitions, performs ceiling check against step effect profile. Verifies current WO integrity before inheriting grants.
- `verifyToolAgainstWO`: pre-tool-call verification — integrity check first, then expiry, effect coverage, and constraint checks.
- `verifyConsentAnchorAgainstRecords`: semantic validation of consent anchors against consent and EAA record stores (implied, explicit, eaa, policy kinds).
- `checkWOConstraints`: runtime constraint enforcement for `time-bound` constraints.
- `validateConsentAnchor`: structural validation of anchor shape (fast-path, no store lookup).

### Phase 1: JWS Compact Serialization — Portable WO Tokens (`src/consent/binder.ts`)

- WO tokens are standard JWS (RFC 7515) with `{"alg":"HS256","typ":"wo+jwt"}` header.
- `configureSigningKey`: set shared HMAC-SHA256 signing key (minimum 256-bit), accepts Buffer or base64 string. Defaults to per-process random key for single-process development.
- `sealWorkOrder`: extract payload fields, deterministic JSON stringify, create JWS, deep-freeze the WO and all nested structures.
- `verifyWorkOrderIntegrity`: two-step verification — (1) JWT signature valid, (2) in-memory WO content matches token payload. Detects both external forgery and in-memory tampering.
- `decodeWorkOrderToken`: cross-boundary token decode with signature verification, structural payload validation (rejects missing/wrong-typed required fields), and frozen WO reconstruction. Usable from any service, MCP, or skill boundary.
- `deterministicStringify`: recursive JSON serialization with sorted object keys at every nesting level, ensuring identical logical content always produces the same string regardless of property insertion order.
- `deepFreezeWorkOrder`: recursive freeze of WO and all mutable sub-structures including `WOAudienceConstraint.allowedTargets` arrays and `WOCustomConstraint.payload` objects.
- `createJwt` / `verifyJwt`: JWS HS256 creation and verification with `crypto.timingSafeEqual` for constant-time signature comparison.

### Phase 1: Consent Scope Chain (`src/consent/scope-chain.ts`)

- `AsyncLocalStorage`-based scope carrying `ConsentScopeState` through agent execution.
- Singleton ALS instance via `resolveGlobalSingleton` (survives module reloads).
- `withConsentScope`: run work under a consent scope (created at agent run start).
- `requireConsentScope`: throw if not inside a consent-scoped context.
- `transitionWorkOrder`: replace active WO with successor, verifying integrity of both outgoing and incoming WOs (hard security boundary — throws on tamper detection). Appends predecessor to immutable WO chain.
- `addConsentRecord` / `addEAARecord`: append records to scope for anchor verification.
- Query helpers: `getActiveWorkOrder`, `getActivePurchaseOrder`, `getWorkOrderChain`, `getConsentRecords`, `getEAARecords`.
- `createInitialConsentScopeState`: factory for initial scope from PO and binder-minted WO.

### Phase 1: Public API (`src/consent/index.ts`)

- Barrel re-exports: all types, effect registry functions, binder functions, and scope chain functions.

### Tests

- `src/consent/effect-registry.test.ts`: 11 tests — registry lookups, default profiles, defensive copies, dangerous tool coverage, effect class validation.
- `src/consent/binder.test.ts`: 63 tests — initial minting, system prohibitions, requalification, ceiling checks, consent anchor validation (implied, explicit, EAA, policy), JWT token integrity (3-part format, header/payload content, tamper detection, signature forgery, missing tokens, in-memory divergence), deep freeze (top-level arrays, audience constraint arrays, custom constraint payloads), cross-boundary decode (round-trip, frozen output, integrity verification, invalid/malformed/wrong-key tokens, optional field preservation, missing required fields), signing key configuration (Buffer, base64, minimum length, rotation), interoperability (raw HMAC verification simulating non-TS consumer), deterministic serialization.
- `src/consent/scope-chain.test.ts`: 28 tests — scope lifecycle, isolation, nesting, requireConsentScope, WO transitions (chain building, multi-transition), consent/EAA record management, query helpers, async continuity (setTimeout, Promise.all), integrity checks (tampered outgoing, unsealed incoming, properly sealed transitions).
