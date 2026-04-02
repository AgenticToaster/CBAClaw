# CBAClaw Changelog

This changelog tracks changes specific to CBAClaw (Consent-Bound Agency).
For the upstream OpenClaw changelog, see [CHANGELOG.openclaw.md](./CHANGELOG.openclaw.md).

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
