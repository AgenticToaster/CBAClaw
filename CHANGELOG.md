# CBAClaw Changelog

This changelog tracks changes specific to CBAClaw (Consent-Bound Agency).
For the upstream OpenClaw changelog, see [CHANGELOG.openclaw.md](./CHANGELOG.openclaw.md).

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
